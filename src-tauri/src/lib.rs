mod analytics;
mod collector;
mod hook;
mod storage;
mod usage;

use crate::analytics::build_analytics;
use crate::collector::{
    AuthProbe, CliState, capture_claude, capture_codex, claude_cli_state, codex_cli_state,
    probe_claude_auth, probe_codex_auth, resolve_claude_command, resolve_codex_command,
};
use crate::storage::{data_dir, read_history, read_json, write_json};
use serde_json::{Map, Value, json};
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

struct RuntimeState {
    refresh_guard: Mutex<()>,
    refresh: Mutex<Value>,
    window: Mutex<WindowState>,
    last_alert_signature: Mutex<String>,
    last_collection_ms: Mutex<i64>,
}

#[derive(Clone)]
struct WindowState {
    always_on_top: bool,
    opacity: f64,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            refresh_guard: Mutex::new(()),
            refresh: Mutex::new(json!({"state":"idle","completedAt":Value::Null,"errors":{}})),
            window: Mutex::new(WindowState {
                always_on_top: false,
                opacity: 0.96,
            }),
            last_alert_signature: Mutex::new(String::new()),
            last_collection_ms: Mutex::new(0),
        }
    }
}

const ACTIVITY_CHECK_INTERVAL: Duration = Duration::from_secs(60);
const AUTO_REFRESH_COOLDOWN_MS: i64 = 5 * 60 * 1000;

fn activity_monitoring_enabled() -> bool {
    read_json(&data_dir().join("monitoring.json"))
        .and_then(|value| value.get("enabled").and_then(Value::as_bool))
        .unwrap_or(false)
}

fn monitoring_snapshot() -> Value {
    json!({
        "enabled": activity_monitoring_enabled(),
        "mode": "local_session_activity",
        "checkIntervalMs": ACTIVITY_CHECK_INTERVAL.as_millis() as u64,
        "minimumRefreshIntervalMs": AUTO_REFRESH_COOLDOWN_MS,
    })
}

fn has_new_activity(previous: Option<u64>, current: Option<u64>) -> bool {
    match (previous, current) {
        (Some(before), Some(after)) => after > before,
        (None, Some(_)) => true,
        _ => false,
    }
}

fn auto_refresh_cooldown_elapsed(last_collection_ms: i64, now_ms: i64) -> bool {
    now_ms - last_collection_ms >= AUTO_REFRESH_COOLDOWN_MS
}

fn status_age_ms(status: Option<&Value>) -> Value {
    let captured = status
        .and_then(|value| value.get("captured_at"))
        .and_then(Value::as_str)
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok());
    captured
        .map(|value| (chrono::Utc::now().timestamp_millis() - value.timestamp_millis()).max(0))
        .map(Value::from)
        .unwrap_or(Value::Null)
}

fn limits_by_type(status: Option<&Value>) -> Value {
    let mut result = Map::new();
    if let Some(limits) = status
        .and_then(|value| value.get("limits"))
        .and_then(Value::as_array)
    {
        for limit in limits {
            if let Some(kind) = limit.get("type").and_then(Value::as_str) {
                result.insert(kind.to_string(), limit.clone());
            }
        }
    }
    Value::Object(result)
}

#[cfg(windows)]
fn launch_at_login() -> bool {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .ok()
        .and_then(|key| key.get_value::<String, _>("Codex Claude Usage").ok())
        .is_some()
}

#[cfg(not(windows))]
fn launch_at_login() -> bool {
    false
}

#[cfg(windows)]
fn update_launch_at_login(enabled: bool) -> Result<(), String> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;
    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = current_user
        .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .map_err(|error| error.to_string())?;
    if enabled {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        key.set_value(
            "Codex Claude Usage",
            &format!("\"{}\" --background", executable.display()),
        )
        .map_err(|error| error.to_string())
    } else {
        match key.delete_value("Codex Claude Usage") {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(not(windows))]
fn update_launch_at_login(_enabled: bool) -> Result<(), String> {
    Ok(())
}

fn snapshot_value(app: &AppHandle) -> Value {
    let state = app.state::<RuntimeState>();
    let directory = data_dir();
    let codex = read_json(&directory.join("status.json"));
    let claude = read_json(&directory.join("claude-status.json"));
    let analytics = read_json(&directory.join("analytics.json"));
    let window = state.window.lock().expect("window state lock").clone();
    let refresh = state.refresh.lock().expect("refresh state lock").clone();
    json!({
        "capturedAt": chrono::Utc::now().to_rfc3339(),
        "details": {"running": app.get_webview_window("details").is_some(), "mode": "embedded"},
        "capture": {"mode":"on_demand", "codexFreshnessMs":600000, "claudeFreshnessMs":600000},
        "monitoring": monitoring_snapshot(),
        "refresh": refresh,
        "analytics": analytics,
        "codex": {
            "connected": codex.as_ref().and_then(|value| value.get("parse_status")).and_then(Value::as_str) == Some("ok"),
            "ageMs": status_age_ms(codex.as_ref()),
            "status": codex,
            "limits": limits_by_type(codex.as_ref())
        },
        "claude": {
            "connected": claude.as_ref().and_then(|value| value.get("parse_status")).and_then(Value::as_str) == Some("ok"),
            "hookInstalled": hook::hook_installed(),
            "ageMs": status_age_ms(claude.as_ref()),
            "status": claude,
            "limits": limits_by_type(claude.as_ref())
        },
        "window": {"alwaysOnTop":window.always_on_top,"opacity":window.opacity},
        "launchAtLogin": launch_at_login()
    })
}

fn setup_snapshot_value(app: &AppHandle) -> Value {
    let mut snapshot = snapshot_value(app);
    let codex_state = codex_cli_state();
    let claude_state = claude_cli_state();
    let (codex_auth, claude_auth) = std::thread::scope(|scope| {
        let codex = scope.spawn(|| probe_codex_auth(Duration::from_secs(8)));
        let claude = scope.spawn(|| probe_claude_auth(Duration::from_secs(8)));
        (
            codex.join().unwrap_or_else(|_| AuthProbe {
                state: crate::collector::AuthState::Error,
                error: Some("Codex 인증 확인 작업이 중단됐습니다.".into()),
            }),
            claude.join().unwrap_or_else(|_| AuthProbe {
                state: crate::collector::AuthState::Error,
                error: Some("Claude 인증 확인 작업이 중단됐습니다.".into()),
            }),
        )
    });
    snapshot.as_object_mut().expect("snapshot object").insert("setup".into(), json!({
        "codexCommand": codex_state == CliState::Ready,
        "codexCommandState": codex_state.as_str(),
        "codexAuth": auth_probe_value(&codex_auth),
        "claudeCommand": claude_state == CliState::Ready,
        "claudeCommandState": claude_state.as_str(),
        "claudeAuth": auth_probe_value(&claude_auth),
        "onboardingComplete": onboarding_complete(),
        "hookCommand": format!("\"{}\" --claude-status-hook", std::env::current_exe().map(|path| path.display().to_string()).unwrap_or_default())
    }));
    snapshot
}

fn auth_probe_value(probe: &AuthProbe) -> Value {
    json!({
        "state": probe.state.as_str(),
        "error": probe.error,
    })
}

fn onboarding_complete() -> bool {
    read_json(&data_dir().join("onboarding.json"))
        .and_then(|value| value.get("completed").and_then(Value::as_bool))
        .unwrap_or(false)
}

fn notification_payload(report: &Value) -> Option<(String, String)> {
    let alerts = report
        .get("alerts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let anomalies = ["codex", "claude"]
        .iter()
        .filter(|provider| {
            report
                .get("anomalies")
                .and_then(|value| value.get(**provider))
                .and_then(|value| value.get("detected"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .map(|provider| {
            json!({
                "provider": provider,
                "multiplier": report["anomalies"][*provider]["multiplier"]
            })
        })
        .collect::<Vec<_>>();
    if alerts.is_empty() && anomalies.is_empty() {
        return None;
    }
    let signature = serde_json::to_string(&json!({
        "alerts": &alerts,
        "anomalies": &anomalies,
    }))
    .unwrap_or_default();
    let mut messages = alerts
        .iter()
        .map(|alert| {
            let provider = if alert.get("provider").and_then(Value::as_str) == Some("codex") {
                "Codex"
            } else {
                "Claude"
            };
            let limit = match alert.get("limitType").and_then(Value::as_str) {
                Some("five_hour") => "5시간",
                Some("weekly") | Some("seven_day") => "주간",
                Some("monthly") => "월간",
                _ => "한도",
            };
            let reason = match alert.get("reason").and_then(Value::as_str) {
                Some("forecast_before_reset") => "리셋 전 고갈 예상",
                Some("threshold_critical") => "위험 임계치",
                _ => "주의 임계치",
            };
            format!(
                "{provider} {limit}: {:.0}% 남음 · {reason}",
                alert
                    .get("remainingPercent")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
            )
        })
        .collect::<Vec<_>>();
    messages.extend(anomalies.iter().map(|anomaly| {
        let provider = if anomaly.get("provider").and_then(Value::as_str) == Some("codex") {
            "Codex"
        } else {
            "Claude"
        };
        let multiplier = anomaly
            .get("multiplier")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        format!("{provider} 오늘 토큰 {multiplier:.1}배 급증")
    }));
    messages.truncate(3);
    Some((signature, messages.join(" · ")))
}

fn notify_alerts(app: &AppHandle, report: &Value) {
    let Some((signature, body)) = notification_payload(report) else {
        return;
    };
    let state = app.state::<RuntimeState>();
    let mut previous = state.last_alert_signature.lock().expect("alert state lock");
    if *previous == signature {
        return;
    }
    *previous = signature;
    let _ = app
        .notification()
        .builder()
        .title("AI 사용량 확인 필요")
        .body(body)
        .show();
}

fn refresh_all(app: &AppHandle) -> Value {
    let state = app.state::<RuntimeState>();
    let _guard = state.refresh_guard.lock().expect("refresh lock");
    *state.refresh.lock().expect("refresh state lock") =
        json!({"state":"running","completedAt":Value::Null,"errors":{}});
    let directory = data_dir();
    let history_dir = directory.join("history");
    let codex_status = directory.join("status.json");
    let claude_status = directory.join("claude-status.json");
    let codex_ready = codex_cli_state() == CliState::Ready;
    let claude_ready = claude_cli_state() == CliState::Ready;
    let (codex_result, claude_result) = std::thread::scope(|scope| {
        let codex = codex_ready.then(|| {
            scope.spawn(|| capture_codex(&codex_status, &history_dir, Duration::from_secs(20)))
        });
        let claude = claude_ready.then(|| {
            scope.spawn(|| capture_claude(&claude_status, &history_dir, Duration::from_secs(60)))
        });
        (
            codex.map(|thread| {
                thread
                    .join()
                    .unwrap_or_else(|_| Err("Codex 수집 작업이 중단됐습니다.".into()))
            }),
            claude.map(|thread| {
                thread
                    .join()
                    .unwrap_or_else(|_| Err("Claude 수집 작업이 중단됐습니다.".into()))
            }),
        )
    });
    let mut errors = Map::new();
    if let Some(Err(error)) = codex_result {
        errors.insert("codex".into(), Value::String(error));
    }
    if let Some(Err(error)) = claude_result {
        errors.insert("claude".into(), Value::String(error));
    }
    if !codex_ready && !claude_ready {
        errors.insert(
            "providers".into(),
            Value::String("사용량을 확인할 Codex 또는 Claude CLI가 필요합니다.".into()),
        );
    }
    let rows = usage::scan_token_usage();
    let history = read_history(&history_dir, 30);
    let report = build_analytics(&history, &rows, chrono::Utc::now().timestamp_millis());
    let _ = write_json(&directory.join("analytics.json"), &report);
    notify_alerts(app, &report);
    *state.refresh.lock().expect("refresh state lock") = json!({
        "state": if errors.is_empty() { "completed" } else { "partial" },
        "completedAt": chrono::Utc::now().to_rfc3339(),
        "errors": errors
    });
    *state
        .last_collection_ms
        .lock()
        .expect("collection state lock") = chrono::Utc::now().timestamp_millis();
    snapshot_value(app)
}

fn start_activity_monitor(app: AppHandle) {
    thread::spawn(move || {
        let mut last_activity = usage::latest_session_activity_ms();
        loop {
            thread::sleep(ACTIVITY_CHECK_INTERVAL);
            if !activity_monitoring_enabled() {
                continue;
            }
            let current_activity = usage::latest_session_activity_ms();
            let changed = has_new_activity(last_activity, current_activity);
            last_activity = current_activity.or(last_activity);
            if !changed {
                continue;
            }
            let now_ms = chrono::Utc::now().timestamp_millis();
            let last_collection = *app
                .state::<RuntimeState>()
                .last_collection_ms
                .lock()
                .expect("collection state lock");
            if !auto_refresh_cooldown_elapsed(last_collection, now_ms) {
                continue;
            }
            refresh_all(&app);
        }
    });
}

#[tauri::command]
fn snapshot(app: AppHandle) -> Value {
    snapshot_value(&app)
}

#[tauri::command]
async fn refresh_snapshot(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || refresh_all(&app))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn setup_snapshot(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || setup_snapshot_value(&app))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn refresh_setup_snapshot(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        refresh_all(&app);
        setup_snapshot_value(&app)
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn complete_onboarding(skipped: bool) -> Result<Value, String> {
    let value = json!({
        "schemaVersion": 1,
        "completed": true,
        "skipped": skipped,
        "completedAt": chrono::Utc::now().to_rfc3339(),
    });
    write_json(&data_dir().join("onboarding.json"), &value)?;
    Ok(value)
}

#[tauri::command]
fn set_activity_monitoring(enabled: bool) -> Result<Value, String> {
    let value = json!({
        "schemaVersion": 1,
        "enabled": enabled,
        "mode": "local_session_activity",
        "updatedAt": chrono::Utc::now().to_rfc3339(),
    });
    write_json(&data_dir().join("monitoring.json"), &value)?;
    Ok(monitoring_snapshot())
}

#[tauri::command]
fn set_always_on_top(app: AppHandle, enabled: bool) -> Result<Value, String> {
    let window = app
        .get_webview_window("compact")
        .ok_or_else(|| "compact window missing".to_string())?;
    window
        .set_always_on_top(enabled)
        .map_err(|error| error.to_string())?;
    app.state::<RuntimeState>()
        .window
        .lock()
        .expect("window state lock")
        .always_on_top = enabled;
    Ok(snapshot_value(&app))
}

#[cfg(windows)]
fn apply_window_opacity(window: &WebviewWindow, opacity: f64) -> Result<(), String> {
    use windows::Win32::Foundation::COLORREF;
    use windows::Win32::UI::WindowsAndMessaging::{
        GWL_EXSTYLE, GetWindowLongW, LWA_ALPHA, SetLayeredWindowAttributes, SetWindowLongW,
        WS_EX_LAYERED,
    };

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        let style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        if style & WS_EX_LAYERED.0 as i32 == 0 {
            SetWindowLongW(hwnd, GWL_EXSTYLE, style | WS_EX_LAYERED.0 as i32);
        }
        SetLayeredWindowAttributes(
            hwnd,
            COLORREF(0),
            (opacity * 255.0).round() as u8,
            LWA_ALPHA,
        )
        .map_err(|error| error.to_string())
    }
}

#[cfg(not(windows))]
fn apply_window_opacity(_window: &WebviewWindow, _opacity: f64) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn set_opacity(app: AppHandle, value: f64) -> Result<Value, String> {
    let opacity = value.clamp(0.55, 1.0);
    let window = app
        .get_webview_window("compact")
        .ok_or_else(|| "compact window missing".to_string())?;
    apply_window_opacity(&window, opacity)?;
    app.state::<RuntimeState>()
        .window
        .lock()
        .expect("window state lock")
        .opacity = opacity;
    Ok(snapshot_value(&app))
}

#[tauri::command]
fn minimize_window(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
fn close_window(window: WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|error| error.to_string())
}

fn create_secondary_window(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    let (url, title, width, height, min_width, min_height, decorations) = match label {
        "compact" => (
            "compact.html",
            "Codex Claude Usage",
            360.0,
            480.0,
            320.0,
            360.0,
            false,
        ),
        "insights" => (
            "insights.html",
            "Usage Insights",
            820.0,
            1000.0,
            720.0,
            640.0,
            true,
        ),
        "details" => (
            "details.html",
            "Local Token Details",
            1180.0,
            760.0,
            900.0,
            620.0,
            true,
        ),
        "setup" => ("setup.html", "Setup", 680.0, 820.0, 560.0, 640.0, true),
        _ => return Err("unknown window label".to_string()),
    };
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(min_width, min_height)
        .decorations(decorations)
        .build()
        .map_err(|error| error.to_string())
}

fn show_window_by_label(app: &AppHandle, label: &str) -> Result<(), String> {
    let window = match app.get_webview_window(label) {
        Some(window) => window,
        None => create_secondary_window(app, label)?,
    };
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn show_window_on_worker(app: AppHandle, label: String) {
    // Windows WebView2 can deadlock when a WebviewWindow is built directly
    // inside a synchronous Tauri command or tray event handler.
    let _ = std::thread::spawn(move || {
        let _ = show_window_by_label(&app, &label);
    });
}

#[tauri::command]
async fn show_window(app: AppHandle, label: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || show_window_by_label(&app, &label))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn install_claude_hook(force: bool) -> Result<Value, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    hook::install_hook(&executable, force)
}

#[tauri::command]
fn open_login_terminal(provider: String) -> Result<Value, String> {
    let (executable, arguments, display_command) = match provider.as_str() {
        "codex" => (
            resolve_codex_command().ok_or_else(|| {
                if codex_cli_state() == CliState::DesktopBundleOnly {
                    "Codex 데스크톱 앱의 보호된 실행 파일만 감지됐습니다. 독립 실행 Codex CLI를 설치하세요."
                        .to_string()
                } else {
                    "Codex CLI를 찾을 수 없습니다. 공식 설치 안내에서 CLI를 먼저 설치하세요."
                        .to_string()
                }
            })?,
            &["login"][..],
            "codex login",
        ),
        "claude" => (
            resolve_claude_command().ok_or_else(|| {
                "Claude Code를 찾을 수 없습니다. 공식 설치 안내에서 CLI를 먼저 설치하세요."
                    .to_string()
            })?,
            &["auth", "login"][..],
            "claude auth login",
        ),
        _ => return Err("지원하지 않는 로그인 제공자입니다.".to_string()),
    };
    let quoted_path = executable.to_string_lossy().replace('\'', "''");
    let command = format!("& '{quoted_path}' {}", arguments.join(" "));
    Command::new("powershell.exe")
        .args(["-NoLogo", "-NoProfile", "-NoExit", "-Command", &command])
        .spawn()
        .map(|_| json!({"status":"opened","command":display_command}))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_install_terminal(provider: String) -> Result<Value, String> {
    let (script, display_command) = match provider.as_str() {
        "codex" => (
            "irm https://chatgpt.com/codex/install.ps1 | iex",
            "OpenAI Codex CLI 공식 설치 프로그램",
        ),
        "claude" => (
            "irm https://claude.ai/install.ps1 | iex",
            "Anthropic Claude Code 공식 설치 프로그램",
        ),
        _ => return Err("지원하지 않는 CLI 제공자입니다.".to_string()),
    };
    Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NoExit",
            "-ExecutionPolicy",
            "ByPass",
            "-Command",
            script,
        ])
        .spawn()
        .map(|_| json!({"status":"opened","command":display_command}))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_official_guide(provider: String) -> Result<(), String> {
    let url = match provider.as_str() {
        "codex" => "https://learn.chatgpt.com/docs/codex/cli",
        "claude" => "https://code.claude.com/docs/en/setup",
        _ => return Err("지원하지 않는 설치 안내 제공자입니다.".to_string()),
    };
    Command::new("explorer.exe")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_launch_at_login(enabled: bool) -> Result<bool, String> {
    update_launch_at_login(enabled)?;
    Ok(launch_at_login())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let compact = MenuItem::with_id(app, "compact", "Compact window", true, None::<&str>)?;
    let insights = MenuItem::with_id(app, "insights", "Usage insights", true, None::<&str>)?;
    let details = MenuItem::with_id(app, "details", "Token details", true, None::<&str>)?;
    let setup = MenuItem::with_id(app, "setup", "Setup", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&compact, &insights, &details, &setup, &separator, &quit],
    )?;
    let mut builder = TrayIconBuilder::new()
        .tooltip("Codex, Claude Usage")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => app.exit(0),
            label => {
                show_window_on_worker(app.clone(), label.to_string());
            }
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_window_on_worker(tray.app_handle().clone(), "compact".to_string());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn run() {
    if std::env::args().any(|argument| argument == "--claude-status-hook") {
        if let Err(error) = hook::run_cli_hook() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }

    tauri::Builder::default()
        .manage(RuntimeState::default())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            build_tray(app)?;
            start_activity_monitor(app.handle().clone());
            if !std::env::args().any(|argument| argument == "--background") {
                let first_window = if onboarding_complete() {
                    "compact"
                } else {
                    "setup"
                };
                show_window_by_label(app.handle(), first_window).map_err(std::io::Error::other)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.destroy();
            }
        })
        .invoke_handler(tauri::generate_handler![
            snapshot,
            refresh_snapshot,
            setup_snapshot,
            refresh_setup_snapshot,
            complete_onboarding,
            set_activity_monitoring,
            set_always_on_top,
            set_opacity,
            minimize_window,
            close_window,
            show_window,
            install_claude_hook,
            open_login_terminal,
            open_install_terminal,
            open_official_guide,
            set_launch_at_login,
            quit_app
        ])
        .build(tauri::generate_context!())
        .expect("error while building Codex Claude Usage")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event
                && code.is_none()
            {
                api.prevent_exit();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_monitor_requires_a_new_or_changed_session_file() {
        assert!(!has_new_activity(None, None));
        assert!(has_new_activity(None, Some(10)));
        assert!(!has_new_activity(Some(10), Some(10)));
        assert!(has_new_activity(Some(10), Some(11)));
    }

    #[test]
    fn automatic_collection_respects_the_cooldown() {
        assert!(!auto_refresh_cooldown_elapsed(
            1_000,
            1_000 + AUTO_REFRESH_COOLDOWN_MS - 1
        ));
        assert!(auto_refresh_cooldown_elapsed(
            1_000,
            1_000 + AUTO_REFRESH_COOLDOWN_MS
        ));
    }

    #[test]
    fn notification_payload_includes_limit_reason_and_token_spike() {
        let report = json!({
            "alerts": [{
                "provider": "codex",
                "limitType": "five_hour",
                "remainingPercent": 22,
                "reason": "forecast_before_reset"
            }],
            "anomalies": {
                "codex": {"detected": true, "multiplier": 2.4},
                "claude": {"detected": false}
            }
        });
        let (signature, body) = notification_payload(&report).expect("notification payload");
        assert!(signature.contains("forecast_before_reset"));
        assert!(signature.contains("multiplier"));
        assert!(body.contains("Codex 5시간: 22% 남음 · 리셋 전 고갈 예상"));
        assert!(body.contains("Codex 오늘 토큰 2.4배 급증"));
    }

    #[test]
    fn notification_payload_supports_anomaly_only_and_healthy_reports() {
        let anomaly = json!({
            "alerts": [],
            "anomalies": {
                "codex": {"detected": false},
                "claude": {"detected": true, "multiplier": 1.9}
            }
        });
        assert!(
            notification_payload(&anomaly)
                .expect("anomaly notification")
                .1
                .contains("Claude 오늘 토큰 1.9배 급증")
        );
        assert!(
            notification_payload(&json!({
                "alerts": [],
                "anomalies": {
                    "codex": {"detected": false},
                    "claude": {"detected": false}
                }
            }))
            .is_none()
        );
    }
}
