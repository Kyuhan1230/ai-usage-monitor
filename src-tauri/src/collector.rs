use crate::codex_cli::{
    ChildWindow, JobLifetime, ProcessTree, SelectedCodex, SetupSafeErrorCode,
    selected_app_server_command, spawn_in_process_tree,
};
use crate::storage::{append_history_if_changed, home_dir, now_kst_iso, read_json, write_json};
use chrono::{FixedOffset, TimeZone};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MAX_CODEX_APP_SERVER_STDOUT_BYTES: u64 = 1024 * 1024;
const CODEX_READER_JOIN_GRACE: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CodexCaptureError {
    IdentityChanged,
    Spawn,
    Io,
    Protocol,
    Timeout,
    Shutdown,
    Storage,
    CapabilityMissing,
    AuthenticationUnconfirmed,
}

impl CodexCaptureError {
    #[cfg(test)]
    pub(crate) fn kind(self) -> &'static str {
        match self {
            Self::IdentityChanged => "identity",
            Self::Spawn => "spawn",
            Self::Io => "io",
            Self::Protocol => "protocol",
            Self::Timeout => "timeout",
            Self::Shutdown => "shutdown",
            Self::Storage => "storage",
            Self::CapabilityMissing => "capability",
            Self::AuthenticationUnconfirmed => "authentication",
        }
    }

    pub(crate) fn safe_error_code(self) -> SetupSafeErrorCode {
        match self {
            Self::IdentityChanged => SetupSafeErrorCode::CandidateNotExecutable,
            Self::Timeout => SetupSafeErrorCode::UsageCaptureTimeout,
            Self::CapabilityMissing => SetupSafeErrorCode::UsageCapabilityMissing,
            Self::AuthenticationUnconfirmed => SetupSafeErrorCode::LoginUnconfirmed,
            Self::Spawn | Self::Io | Self::Protocol | Self::Shutdown | Self::Storage => {
                SetupSafeErrorCode::UsageCaptureFailed
            }
        }
    }

    pub(crate) fn should_reprobe_auth(self) -> bool {
        matches!(
            self,
            Self::Spawn | Self::Io | Self::Protocol | Self::Timeout
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CliState {
    Ready,
    Missing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthState {
    Authenticated,
    Unauthenticated,
    Unavailable,
    Error,
}

impl AuthState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Authenticated => "authenticated",
            Self::Unauthenticated => "unauthenticated",
            Self::Unavailable => "unavailable",
            Self::Error => "error",
        }
    }
}

#[derive(Clone, Debug)]
pub struct AuthProbe {
    pub state: AuthState,
    pub error: Option<String>,
}

impl CliState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Missing => "missing",
        }
    }
}

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_command: &mut Command) {}

#[cfg(windows)]
fn current_path_values() -> Vec<OsString> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    let mut values = std::env::var_os("PATH").into_iter().collect::<Vec<_>>();
    #[cfg(test)]
    if std::env::var_os("AI_USAGE_MONITOR_TEST_PROCESS_PATH_ONLY").is_some() {
        return values;
    }
    let user = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(environment) = user.open_subkey("Environment")
        && let Ok(path) = environment.get_value::<String, _>("Path")
    {
        values.push(path.into());
    }
    let machine = RegKey::predef(HKEY_LOCAL_MACHINE);
    if let Ok(environment) =
        machine.open_subkey("SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment")
        && let Ok(path) = environment.get_value::<String, _>("Path")
    {
        values.push(path.into());
    }
    values
}

#[cfg(not(windows))]
fn current_path_values() -> Vec<OsString> {
    std::env::var_os("PATH").into_iter().collect()
}

fn path_candidate_names(name: &str) -> Vec<String> {
    if Path::new(name).extension().is_some() {
        vec![name.to_string()]
    } else {
        [
            name.to_string(),
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
        ]
        .into_iter()
        .collect()
    }
}

fn fresh_path_candidates(name: &str) -> Vec<PathBuf> {
    let names = path_candidate_names(name);
    current_path_values()
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .map(|path| PathBuf::from(path.to_string_lossy().trim().trim_matches('"')))
        .filter(|path| !path.as_os_str().is_empty())
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .filter(|path| path.exists())
        .collect()
}

fn command_candidates(name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let mut command = Command::new("where.exe");
    command.arg(name);
    hide_window(&mut command);
    if let Ok(output) = command.output()
        && output.status.success()
    {
        candidates.extend(
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(PathBuf::from),
        );
    }
    candidates.extend(fresh_path_candidates(name));
    let mut seen = HashSet::new();
    candidates.retain(|path| seen.insert(path.to_string_lossy().to_ascii_lowercase()));
    candidates
}

fn is_codex_desktop_candidate(path: &Path) -> bool {
    let normalized = path
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    let packaged_resource = normalized.contains("\\windowsapps\\openai.codex_")
        && normalized.contains("\\app\\resources\\codex");
    let app_execution_alias = normalized.ends_with("\\microsoft\\windowsapps\\codex")
        || normalized.ends_with("\\microsoft\\windowsapps\\codex.exe");
    packaged_resource || app_execution_alias
}

pub fn resolve_command(name: &str) -> Option<PathBuf> {
    command_candidates(name)
        .into_iter()
        .find(|path| path.exists() && !is_codex_desktop_candidate(path))
}

#[cfg(test)]
pub fn resolve_codex_command() -> Option<PathBuf> {
    resolve_command("codex.exe")
        .or_else(|| resolve_command("codex"))
        .or_else(|| {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .map(|path| path.join("Programs/OpenAI/Codex/bin/codex.exe"))
                .filter(|path| path.exists())
        })
        .or_else(|| {
            std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .map(|path| path.join("npm/codex.cmd"))
                .filter(|path| path.exists())
        })
        .or_else(|| {
            let path = home_dir().join(".local/bin/codex.exe");
            path.exists().then_some(path)
        })
}

pub fn resolve_claude_command() -> Option<PathBuf> {
    resolve_command("claude.exe")
        .or_else(|| resolve_command("claude"))
        .or_else(|| {
            let path = home_dir().join(".local/bin/claude.exe");
            path.exists().then_some(path)
        })
        .or_else(|| {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .map(|path| path.join("Microsoft/WinGet/Links/claude.exe"))
                .filter(|path| path.exists())
        })
        .or_else(|| {
            std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .map(|path| path.join("npm/claude.cmd"))
                .filter(|path| path.exists())
        })
        .or_else(|| {
            let path = home_dir().join(".claude/local/claude.exe");
            path.exists().then_some(path)
        })
}

pub fn claude_cli_state() -> CliState {
    if resolve_claude_command().is_some() {
        CliState::Ready
    } else {
        CliState::Missing
    }
}

fn auth_state_from_success(success: bool) -> AuthState {
    if success {
        AuthState::Authenticated
    } else {
        AuthState::Unauthenticated
    }
}

fn probe_auth_command(
    executable: Option<PathBuf>,
    arguments: &[&str],
    timeout: Duration,
) -> AuthProbe {
    let Some(executable) = executable else {
        return AuthProbe {
            state: AuthState::Unavailable,
            error: None,
        };
    };
    let mut command = executable_command(&executable);
    command.args(arguments).stdin(Stdio::null());
    match command_output_with_timeout(command, timeout) {
        Ok(output) => AuthProbe {
            // 계정 이메일이나 조직명이 포함될 수 있는 stdout/stderr는 판정 후 즉시 버립니다.
            state: auth_state_from_success(output.status.success()),
            error: None,
        },
        Err(error) => AuthProbe {
            state: AuthState::Error,
            error: Some(error),
        },
    }
}

#[cfg(test)]
pub fn probe_codex_auth(timeout: Duration) -> AuthProbe {
    probe_auth_command(resolve_codex_command(), &["login", "status"], timeout)
}

pub fn probe_claude_auth(timeout: Duration) -> AuthProbe {
    probe_auth_command(resolve_claude_command(), &["auth", "status"], timeout)
}

fn executable_command(path: &Path) -> Command {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat") {
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/C"]).arg(path);
        command
    } else {
        Command::new(path)
    }
}

fn write_rpc(stdin: &mut impl Write, message: &Value) -> Result<(), CodexCaptureError> {
    let body = serde_json::to_string(message).map_err(|_| CodexCaptureError::Protocol)?;
    writeln!(stdin, "{body}").map_err(|_| CodexCaptureError::Io)?;
    stdin.flush().map_err(|_| CodexCaptureError::Io)
}

fn stop_child(child: &mut Child, process_tree: &ProcessTree) -> bool {
    process_tree.terminate_and_wait(child)
}

fn join_reader_by<T>(handle: thread::JoinHandle<T>, deadline: Instant) -> Option<T> {
    while !handle.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    handle.is_finished().then(|| handle.join().ok()).flatten()
}

fn drain_reader(mut reader: impl Read) -> bool {
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return true,
            Ok(_) => {}
            Err(_) => return false,
        }
    }
}

enum AppServerEvent {
    Line(String),
    ReadFailed,
}

fn rpc_error_is_method_missing(message: &Value) -> bool {
    message
        .get("error")
        .and_then(|error| error.get("code"))
        .and_then(Value::as_i64)
        == Some(-32601)
}

fn clamp_percent(value: f64) -> i64 {
    value.round().clamp(0.0, 100.0) as i64
}

fn reset_text(epoch_seconds: i64) -> Option<String> {
    let offset = FixedOffset::east_opt(9 * 60 * 60)?;
    let date = offset.timestamp_opt(epoch_seconds, 0).single()?;
    Some(format!("resets {}", date.format("%m/%d %H:%M")))
}

fn codex_limit(window: &Value, index: usize) -> Option<Value> {
    let used = window.get("usedPercent")?.as_f64().map(clamp_percent)?;
    let duration = window.get("windowDurationMins").and_then(Value::as_i64);
    let kind = match duration {
        Some(minutes) if minutes <= 6 * 60 => "five_hour",
        Some(minutes) if minutes <= 8 * 24 * 60 => "weekly",
        Some(_) => "monthly",
        None if index == 0 => "five_hour",
        None => "weekly",
    };
    let resets_at = window.get("resetsAt").and_then(Value::as_i64);
    Some(json!({
        "type": kind,
        "used_percent": used,
        "remaining_percent": 100 - used,
        "reset_text": resets_at.and_then(reset_text),
        "resets_at": resets_at,
        "window_duration_mins": duration,
    }))
}

pub fn build_codex_status(rate_result: &Value) -> Value {
    let rate_limits = rate_result.get("rateLimits").and_then(Value::as_object);
    let limits = ["primary", "secondary"]
        .iter()
        .enumerate()
        .filter_map(|(index, key)| {
            rate_limits?
                .get(*key)
                .and_then(|value| codex_limit(value, index))
        })
        .collect::<Vec<_>>();
    let captured_at = now_kst_iso();
    let ok = !limits.is_empty();
    json!({
        "schema_version": 1,
        "captured_at": captured_at,
        "source": "codex_app_server",
        "capture_method": "codex_app_server",
        "parse_status": if ok { "ok" } else { "failed" },
        "limits": limits,
        "raw_status_text": "",
        "rate_limit_reset_credits": rate_result
            .get("rateLimitResetCredits")
            .and_then(Value::as_i64)
            .map(|value| value.max(0)),
        "spend_control_reached": rate_result
            .get("spendControlReached")
            .and_then(Value::as_bool),
        "capture": {
            "state": if ok { "on_demand_ok" } else { "on_demand_failed" },
            "detail": "official Codex app-server account snapshot",
            "heartbeat_at": captured_at,
            "mode": "on_demand"
        }
    })
}

pub(crate) fn capture_codex_with(
    selected: &SelectedCodex,
    status_path: &Path,
    history_dir: &Path,
    timeout: Duration,
) -> Result<Value, CodexCaptureError> {
    let mut command =
        selected_app_server_command(selected).map_err(|_| CodexCaptureError::IdentityChanged)?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !selected.identity_unchanged() {
        return Err(CodexCaptureError::IdentityChanged);
    }
    let (mut child, process_tree) =
        spawn_in_process_tree(command, ChildWindow::Hidden, JobLifetime::KillOnDrop)
            .map_err(|_| CodexCaptureError::Spawn)?;
    let Some(mut stdin) = child.stdin.take() else {
        let _ = stop_child(&mut child, &process_tree);
        return Err(CodexCaptureError::Io);
    };
    let Some(stdout) = child.stdout.take() else {
        drop(stdin);
        let _ = stop_child(&mut child, &process_tree);
        return Err(CodexCaptureError::Io);
    };
    let stderr = child.stderr.take();
    let (sender, receiver) = mpsc::channel::<AppServerEvent>();
    let stdout_thread = thread::spawn(move || {
        for line in BufReader::new(stdout.take(MAX_CODEX_APP_SERVER_STDOUT_BYTES)).lines() {
            match line {
                Ok(line) => {
                    if sender.send(AppServerEvent::Line(line)).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = sender.send(AppServerEvent::ReadFailed);
                    return false;
                }
            }
        }
        true
    });
    let stderr_thread = thread::spawn(move || stderr.map(drain_reader).unwrap_or(true));

    let initialize_write = write_rpc(
        &mut stdin,
        &json!({
            "method": "initialize",
            "id": 1,
            "params": {"clientInfo": {"name": "ai_usage_monitor", "title": "AI Usage Monitor", "version": env!("CARGO_PKG_VERSION")}}
        }),
    );
    if let Err(error) = initialize_write {
        drop(stdin);
        let _ = stop_child(&mut child, &process_tree);
        let join_deadline = Instant::now() + CODEX_READER_JOIN_GRACE;
        let _ = join_reader_by(stdout_thread, join_deadline);
        let _ = join_reader_by(stderr_thread, join_deadline);
        return Err(error);
    }

    let deadline = Instant::now() + timeout;
    let mut rate_result = None;
    let mut initialized = false;
    let mut capture_failure = None;
    let mut saw_malformed_message = false;
    while Instant::now() < deadline && rate_result.is_none() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let event = match receiver.recv_timeout(remaining.min(Duration::from_millis(250))) {
            Ok(event) => event,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                capture_failure = Some(CodexCaptureError::Protocol);
                break;
            }
        };
        let line = match event {
            AppServerEvent::Line(line) => line,
            AppServerEvent::ReadFailed => {
                capture_failure = Some(CodexCaptureError::Io);
                break;
            }
        };
        let message = match serde_json::from_str::<Value>(&line) {
            Ok(message) => message,
            Err(_) => {
                saw_malformed_message = true;
                continue;
            }
        };
        match message.get("id").and_then(Value::as_i64) {
            Some(1) if message.get("error").is_none() => {
                initialized = true;
                if let Err(error) = write_rpc(&mut stdin, &json!({"method": "initialized"}))
                    .and_then(|_| {
                        write_rpc(
                            &mut stdin,
                            &json!({"method": "account/rateLimits/read", "id": 2}),
                        )
                    })
                {
                    capture_failure = Some(error);
                    break;
                }
            }
            Some(1) => {
                capture_failure = Some(if rpc_error_is_method_missing(&message) {
                    CodexCaptureError::CapabilityMissing
                } else {
                    CodexCaptureError::Protocol
                });
                break;
            }
            Some(2) if message.get("error").is_some() => {
                capture_failure = Some(if rpc_error_is_method_missing(&message) {
                    CodexCaptureError::CapabilityMissing
                } else {
                    CodexCaptureError::Protocol
                });
                break;
            }
            Some(2) => {
                rate_result = message.get("result").cloned();
                if rate_result.is_none() {
                    capture_failure = Some(CodexCaptureError::Protocol);
                    break;
                }
            }
            _ => {}
        }
    }
    if capture_failure.is_none() && rate_result.is_none() {
        capture_failure = Some(if saw_malformed_message {
            CodexCaptureError::Protocol
        } else {
            CodexCaptureError::Timeout
        });
    }
    drop(stdin);
    let stopped = stop_child(&mut child, &process_tree);
    let join_deadline = Instant::now() + CODEX_READER_JOIN_GRACE;
    let stdout_read_ok = join_reader_by(stdout_thread, join_deadline);
    let stderr_read_ok = join_reader_by(stderr_thread, join_deadline);
    if stdout_read_ok.is_none() || stderr_read_ok.is_none() {
        return Err(CodexCaptureError::Shutdown);
    }
    if !stopped {
        return Err(CodexCaptureError::Shutdown);
    }
    if stdout_read_ok == Some(false) || stderr_read_ok == Some(false) {
        return Err(CodexCaptureError::Io);
    }
    if let Some(error) = capture_failure {
        return Err(error);
    }
    if !initialized {
        return Err(CodexCaptureError::Protocol);
    }
    let rate_result = rate_result.ok_or(CodexCaptureError::Timeout)?;
    let status = build_codex_status(&rate_result);
    if status.get("parse_status").and_then(Value::as_str) != Some("ok") {
        return Err(CodexCaptureError::Protocol);
    }
    let previous = read_json(status_path);
    append_history_if_changed(history_dir, &status, previous.as_ref())
        .map_err(|_| CodexCaptureError::Storage)?;
    write_json(status_path, &status).map_err(|_| CodexCaptureError::Storage)?;
    Ok(status)
}

fn command_output_with_timeout(mut command: Command, timeout: Duration) -> Result<Output, String> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(_) => return child.wait_with_output().map_err(|error| error.to_string()),
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "명령 실행 시간이 {}초를 넘었습니다.",
                    timeout.as_secs()
                ));
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    }
}

pub fn parse_claude_usage(raw: &str) -> Vec<Value> {
    let pattern = Regex::new(
        r"(?i):\s*(\d{1,3})%\s+used(?:\s+[·•]\s+resets\s+([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?(am|pm))?",
    )
    .expect("valid Claude usage pattern");
    raw.lines()
        .filter_map(|line| {
            let kind = if line.starts_with("Current session:") {
                "five_hour"
            } else if line.starts_with("Current week (all models):") {
                "seven_day"
            } else {
                return None;
            };
            let captures = pattern.captures(line)?;
            let used = captures.get(1)?.as_str().parse::<i64>().ok()?.clamp(0, 100);
            let reset = captures.get(2).and_then(|month| {
                let month_number = match month.as_str().to_ascii_lowercase().as_str() {
                    "jan" => 1,
                    "feb" => 2,
                    "mar" => 3,
                    "apr" => 4,
                    "may" => 5,
                    "jun" => 6,
                    "jul" => 7,
                    "aug" => 8,
                    "sep" => 9,
                    "oct" => 10,
                    "nov" => 11,
                    "dec" => 12,
                    _ => return None,
                };
                let day = captures.get(3)?.as_str().parse::<u32>().ok()?;
                let mut hour = captures.get(4)?.as_str().parse::<u32>().ok()?;
                let minute = captures.get(5).map_or("00", |value| value.as_str());
                let meridiem = captures.get(6)?.as_str().to_ascii_lowercase();
                if meridiem == "pm" && hour < 12 {
                    hour += 12;
                }
                if meridiem == "am" && hour == 12 {
                    hour = 0;
                }
                Some(format!(
                    "resets {month_number:02}/{day:02} {hour:02}:{minute}"
                ))
            });
            Some(json!({
                "type": kind,
                "used_percent": used,
                "remaining_percent": 100 - used,
                "reset_text": reset
            }))
        })
        .collect()
}

pub fn build_claude_status(raw: &str, error: Option<&str>) -> Value {
    let limits = if error.is_none() {
        parse_claude_usage(raw)
    } else {
        Vec::new()
    };
    let summary = error.is_none()
        && raw
            .to_ascii_lowercase()
            .contains("using your subscription to power your claude code usage");
    let captured_at = now_kst_iso();
    let ok = !limits.is_empty() || summary;
    json!({
        "schema_version": 1,
        "captured_at": captured_at,
        "source": "claude_usage_command",
        "capture_method": "claude_usage_command",
        "parse_status": if ok { "ok" } else { "failed" },
        "error": error,
        "limits": limits,
        "summary_status": if summary { Some("subscription_usage_summary") } else { None },
        "raw_status_text": "",
        "capture": {
            "state": if ok { "on_demand_ok" } else { "on_demand_failed" },
            "heartbeat_at": captured_at,
            "mode": "on_demand"
        }
    })
}

pub fn capture_claude(
    status_path: &Path,
    history_dir: &Path,
    timeout: Duration,
) -> Result<Value, String> {
    let executable =
        resolve_claude_command().ok_or_else(|| "Claude Code를 찾을 수 없습니다.".to_string())?;
    let mut command = executable_command(&executable);
    command.arg("/usage");
    let output = command_output_with_timeout(command, timeout)?;
    let raw = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let error =
        (!output.status.success()).then(|| format!("Claude /usage 종료 코드: {}", output.status));
    let attempted = build_claude_status(&raw, error.as_deref());
    let previous = read_json(status_path);
    if attempted.get("parse_status").and_then(Value::as_str) == Some("ok") {
        write_json(status_path, &attempted)?;
        append_history_if_changed(history_dir, &attempted, previous.as_ref())?;
        return Ok(attempted);
    }
    if let Some(mut previous) =
        previous.filter(|value| value.get("parse_status").and_then(Value::as_str) == Some("ok"))
    {
        if let Some(object) = previous.as_object_mut() {
            object.insert(
                "capture".into(),
                attempted.get("capture").cloned().unwrap_or(Value::Null),
            );
            object.insert(
                "last_failed_status".into(),
                json!({
                    "captured_at": attempted.get("captured_at"),
                    "error": attempted.get("error")
                }),
            );
        }
        write_json(status_path, &previous)?;
    } else {
        write_json(status_path, &attempted)?;
    }
    Err(attempted
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("Claude /usage 출력을 해석하지 못했습니다.")
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_windows_become_remaining_limits() {
        let status = build_codex_status(&json!({
            "rateLimits": {
                "primary": {"usedPercent": 27, "windowDurationMins": 300, "resetsAt": 1784334600},
                "secondary": {"usedPercent": 61, "windowDurationMins": 10080, "resetsAt": 1784766600}
            },
            "rateLimitResetCredits": r"C:\Users\private-user\codex.exe",
            "spendControlReached": {"stderr": "private"}
        }));
        assert_eq!(status["limits"][0]["remaining_percent"], 73);
        assert_eq!(status["limits"][1]["type"], "weekly");
        assert!(status["rate_limit_reset_credits"].is_null());
        assert!(status["spend_control_reached"].is_null());
        assert_eq!(status["raw_status_text"], "");
        assert!(!status.to_string().contains("private-user"));
        assert!(!status.to_string().contains("stderr"));
    }

    #[test]
    fn claude_usage_text_keeps_only_numbers() {
        let raw = "Current session: 42% used · resets Jul 18, 9:30pm\nCurrent week (all models): 71% used • resets Jul 20, 12am";
        let limits = parse_claude_usage(raw);
        assert_eq!(limits[0]["remaining_percent"], 58);
        assert_eq!(limits[0]["reset_text"], "resets 07/18 21:30");
        assert_eq!(limits[1]["remaining_percent"], 29);
    }

    #[test]
    fn codex_desktop_candidates_are_not_standalone_clis() {
        let packaged = Path::new(
            r"C:\Program Files\WindowsApps\OpenAI.Codex_26.707.9981.0_x64__example\app\resources\codex.exe",
        );
        let app_execution_alias =
            Path::new(r"C:\Users\tester\AppData\Local\Microsoft\WindowsApps\codex.exe");
        let standalone = Path::new(r"C:\Users\tester\AppData\Roaming\npm\codex.cmd");
        let official_standalone =
            Path::new(r"C:\Users\tester\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe");
        assert!(is_codex_desktop_candidate(packaged));
        assert!(is_codex_desktop_candidate(app_execution_alias));
        assert!(!is_codex_desktop_candidate(standalone));
        assert!(!is_codex_desktop_candidate(official_standalone));
    }

    #[cfg(windows)]
    #[test]
    fn windows_alias_does_not_mask_standalone_codex_auth() {
        const CHILD_SCENARIO: &str = "AI_USAGE_MONITOR_CODEX_AUTH_TEST_SCENARIO";
        const CHILD_COMMAND: &str = "AI_USAGE_MONITOR_CODEX_AUTH_TEST_COMMAND";
        const TEST_NAME: &str =
            "collector::tests::windows_alias_does_not_mask_standalone_codex_auth";

        if let Ok(scenario) = std::env::var(CHILD_SCENARIO) {
            let expected = PathBuf::from(
                std::env::var_os(CHILD_COMMAND).expect("child command path is present"),
            );
            let resolved = resolve_codex_command().expect("standalone command is resolved");
            assert_eq!(
                std::fs::canonicalize(resolved).expect("resolved command is canonicalized"),
                std::fs::canonicalize(expected).expect("expected command is canonicalized")
            );
            let probe = probe_codex_auth(Duration::from_secs(5));
            let expected_state = if scenario == "authenticated" {
                AuthState::Authenticated
            } else {
                AuthState::Unauthenticated
            };
            assert_eq!(probe.state, expected_state, "{:?}", probe.error);
            return;
        }

        for (scenario, exit_code) in [("authenticated", 0), ("unauthenticated", 1)] {
            let root = std::env::temp_dir().join(format!(
                "ai-usage-monitor-codex-auth-{}-{scenario}",
                std::process::id()
            ));
            let alias_dir = root.join("User/AppData/Local/Microsoft/WindowsApps");
            let standalone_dir = root.join("Standalone");
            std::fs::create_dir_all(&alias_dir).expect("alias directory is created");
            std::fs::create_dir_all(&standalone_dir).expect("standalone directory is created");
            std::fs::write(alias_dir.join("codex.exe"), []).expect("alias placeholder is created");
            let standalone = standalone_dir.join("codex.cmd");
            std::fs::write(&standalone, format!("@echo off\r\nexit /b {exit_code}\r\n"))
                .expect("standalone command is created");

            let system32 =
                PathBuf::from(std::env::var_os("SystemRoot").expect("SystemRoot")).join("System32");
            let child_path = std::env::join_paths([alias_dir, standalone_dir, system32])
                .expect("child PATH is valid");
            let status = Command::new(std::env::current_exe().expect("test executable"))
                .args(["--exact", TEST_NAME, "--nocapture"])
                .env("PATH", child_path)
                .env("AI_USAGE_MONITOR_TEST_PROCESS_PATH_ONLY", "1")
                .env(CHILD_SCENARIO, scenario)
                .env(CHILD_COMMAND, &standalone)
                .status()
                .expect("child auth probe starts");
            let _ = std::fs::remove_dir_all(&root);
            assert!(status.success(), "{scenario} child probe failed");
        }
    }

    #[test]
    fn extensionless_command_checks_windows_launchers() {
        assert_eq!(
            path_candidate_names("codex"),
            ["codex", "codex.exe", "codex.cmd", "codex.bat"]
        );
        assert_eq!(path_candidate_names("codex.exe"), ["codex.exe"]);
    }

    #[test]
    fn auth_exit_status_is_reduced_to_a_boolean_state() {
        assert_eq!(auth_state_from_success(true), AuthState::Authenticated);
        assert_eq!(auth_state_from_success(false), AuthState::Unauthenticated);
        assert_eq!(AuthState::Unavailable.as_str(), "unavailable");
        assert_eq!(AuthState::Error.as_str(), "error");
    }

    #[test]
    fn codex_capture_failures_are_typed_and_privacy_safe() {
        let cases = [
            (CodexCaptureError::IdentityChanged, "identity"),
            (CodexCaptureError::Spawn, "spawn"),
            (CodexCaptureError::Io, "io"),
            (CodexCaptureError::Protocol, "protocol"),
            (CodexCaptureError::Timeout, "timeout"),
            (CodexCaptureError::Shutdown, "shutdown"),
            (CodexCaptureError::Storage, "storage"),
            (CodexCaptureError::CapabilityMissing, "capability"),
            (
                CodexCaptureError::AuthenticationUnconfirmed,
                "authentication",
            ),
        ];
        for (error, expected_kind) in cases {
            assert_eq!(error.kind(), expected_kind);
            let public = serde_json::to_string(&error.safe_error_code())
                .expect("safe capture error code serializes");
            assert!(!public.contains('\\'));
            assert!(!public.to_ascii_lowercase().contains("stderr"));
            assert!(!public.to_ascii_lowercase().contains("stdout"));
        }
        assert_eq!(
            CodexCaptureError::Timeout.safe_error_code(),
            SetupSafeErrorCode::UsageCaptureTimeout
        );
        assert_eq!(
            CodexCaptureError::CapabilityMissing.safe_error_code(),
            SetupSafeErrorCode::UsageCapabilityMissing
        );
        assert_eq!(
            CodexCaptureError::AuthenticationUnconfirmed.safe_error_code(),
            SetupSafeErrorCode::LoginUnconfirmed
        );
    }

    #[test]
    fn only_json_rpc_method_missing_is_a_capability_failure() {
        assert!(rpc_error_is_method_missing(
            &json!({"id": 2, "error": {"code": -32601, "message": "private"}})
        ));
        assert!(!rpc_error_is_method_missing(
            &json!({"id": 2, "error": {"code": -32000, "message": "private"}})
        ));
        assert!(!rpc_error_is_method_missing(
            &json!({"id": 2, "error": {"message": "method not found"}})
        ));
    }

    #[cfg(windows)]
    #[test]
    fn codex_app_server_timeout_and_method_missing_stay_distinct() {
        use crate::codex_cli::LauncherType;
        use std::time::{SystemTime, UNIX_EPOCH};

        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time is after Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "ai-usage-monitor-codex-capture-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("capture test directory is created");
        let _cleanup = Cleanup(root.clone());
        let child_path = std::env::var_os("PATH").expect("test PATH is available");

        let timeout_cli = root.join("timeout.cmd");
        std::fs::write(
            &timeout_cli,
            concat!(
                "@echo off\r\n",
                ">&2 echo C:\\Users\\private-user\\codex.exe\r\n",
                "\"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoLogo -NoProfile -Command \"Start-Sleep -Seconds 5\" >nul\r\n"
            ),
        )
        .expect("timeout fixture is written");
        let timeout_selected =
            SelectedCodex::new(timeout_cli, child_path.clone(), LauncherType::Cmd);
        let timeout_error = capture_codex_with(
            &timeout_selected,
            &root.join("timeout-status.json"),
            &root.join("timeout-history"),
            Duration::from_millis(100),
        )
        .expect_err("silent app-server must time out");
        assert_eq!(timeout_error, CodexCaptureError::Timeout);
        assert_eq!(
            timeout_error.safe_error_code(),
            SetupSafeErrorCode::UsageCaptureTimeout
        );

        let unsupported_cli = root.join("unsupported.cmd");
        std::fs::write(
            &unsupported_cli,
            concat!(
                "@echo off\r\n",
                "echo {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\r\n",
                "echo {\"jsonrpc\":\"2.0\",\"id\":2,\"error\":{\"code\":-32601,\"message\":\"C:\\\\Users\\\\private-user\\\\codex.exe\"}}\r\n",
                ">&2 echo C:\\Users\\private-user\\codex.exe\r\n",
                "\"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoLogo -NoProfile -Command \"Start-Sleep -Seconds 5\" >nul\r\n"
            ),
        )
        .expect("unsupported fixture is written");
        let unsupported_selected =
            SelectedCodex::new(unsupported_cli, child_path, LauncherType::Cmd);
        let unsupported_error = capture_codex_with(
            &unsupported_selected,
            &root.join("unsupported-status.json"),
            &root.join("unsupported-history"),
            Duration::from_secs(5),
        )
        .expect_err("method-not-found response must be unsupported");
        assert_eq!(unsupported_error, CodexCaptureError::CapabilityMissing);
        assert_eq!(
            unsupported_error.safe_error_code(),
            SetupSafeErrorCode::UsageCapabilityMissing
        );
    }
}
