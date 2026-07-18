use crate::storage::{append_history_if_changed, now_kst_iso, read_json, write_json};
use chrono::{FixedOffset, TimeZone};
use regex::Regex;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn hide_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_window(_command: &mut Command) {}

pub fn resolve_command(name: &str) -> Option<PathBuf> {
    let mut command = Command::new("where.exe");
    command.arg(name);
    hide_window(&mut command);
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|path| path.exists())
}

pub fn command_exists(name: &str) -> bool {
    resolve_command(name).is_some()
}

fn write_rpc(stdin: &mut impl Write, message: &Value) -> Result<(), String> {
    writeln!(
        stdin,
        "{}",
        serde_json::to_string(message).map_err(|error| error.to_string())?
    )
    .map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

fn stop_child(child: &mut Child) {
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
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
        "rate_limit_reset_credits": rate_result.get("rateLimitResetCredits"),
        "spend_control_reached": rate_result.get("spendControlReached"),
        "capture": {
            "state": if ok { "on_demand_ok" } else { "on_demand_failed" },
            "detail": "official Codex app-server account snapshot",
            "heartbeat_at": captured_at,
            "mode": "on_demand"
        }
    })
}

pub fn capture_codex(
    status_path: &Path,
    history_dir: &Path,
    timeout: Duration,
) -> Result<Value, String> {
    let executable = resolve_command("codex.exe")
        .or_else(|| resolve_command("codex"))
        .ok_or_else(|| "Codex CLI를 찾을 수 없습니다.".to_string())?;
    let mut command = Command::new(executable);
    command
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex stdin을 열 수 없습니다.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex stdout을 열 수 없습니다.".to_string())?;
    let stderr = child.stderr.take();
    let (sender, receiver) = mpsc::channel::<String>();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let _ = sender.send(line);
        }
    });
    let stderr_thread = thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });

    write_rpc(
        &mut stdin,
        &json!({
            "method": "initialize",
            "id": 1,
            "params": {"clientInfo": {"name": "ai_usage_monitor", "title": "AI Usage Monitor", "version": "1.0.0"}}
        }),
    )?;

    let deadline = Instant::now() + timeout;
    let mut rate_result = None;
    let mut initialized = false;
    while Instant::now() < deadline && rate_result.is_none() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let line = match receiver.recv_timeout(remaining.min(Duration::from_millis(250))) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(_) => break,
        };
        let message = match serde_json::from_str::<Value>(&line) {
            Ok(message) => message,
            Err(_) => continue,
        };
        match message.get("id").and_then(Value::as_i64) {
            Some(1) if message.get("error").is_none() => {
                initialized = true;
                write_rpc(&mut stdin, &json!({"method": "initialized"}))?;
                write_rpc(
                    &mut stdin,
                    &json!({"method": "account/rateLimits/read", "id": 2}),
                )?;
            }
            Some(1) => break,
            Some(2) => rate_result = message.get("result").cloned(),
            _ => {}
        }
    }
    drop(stdin);
    stop_child(&mut child);
    let stderr = stderr_thread.join().unwrap_or_default();
    if !initialized {
        return Err(format!(
            "Codex app-server 초기화에 실패했습니다. {}",
            stderr.trim()
        ));
    }
    let rate_result =
        rate_result.ok_or_else(|| "Codex 계정 한도 응답 시간이 초과됐습니다.".to_string())?;
    let status = build_codex_status(&rate_result);
    let previous = read_json(status_path);
    write_json(status_path, &status)?;
    append_history_if_changed(history_dir, &status, previous.as_ref())?;
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
    let executable = resolve_command("claude.exe")
        .or_else(|| resolve_command("claude"))
        .ok_or_else(|| "Claude Code를 찾을 수 없습니다.".to_string())?;
    let mut command = Command::new(executable);
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
        let status = build_codex_status(&json!({"rateLimits": {
            "primary": {"usedPercent": 27, "windowDurationMins": 300, "resetsAt": 1784334600},
            "secondary": {"usedPercent": 61, "windowDurationMins": 10080, "resetsAt": 1784766600}
        }}));
        assert_eq!(status["limits"][0]["remaining_percent"], 73);
        assert_eq!(status["limits"][1]["type"], "weekly");
        assert_eq!(status["raw_status_text"], "");
    }

    #[test]
    fn claude_usage_text_keeps_only_numbers() {
        let raw = "Current session: 42% used · resets Jul 18, 9:30pm\nCurrent week (all models): 71% used • resets Jul 20, 12am";
        let limits = parse_claude_usage(raw);
        assert_eq!(limits[0]["remaining_percent"], 58);
        assert_eq!(limits[0]["reset_text"], "resets 07/18 21:30");
        assert_eq!(limits[1]["remaining_percent"], 29);
    }
}
