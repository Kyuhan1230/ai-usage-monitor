mod analytics;
mod collector;
mod hook;
mod storage;
mod usage;

use crate::analytics::build_analytics;
use crate::collector::{capture_claude, capture_codex, command_exists};
use crate::storage::{data_dir, read_history, read_json, write_json};
use serde_json::{Map, Value, json};
use std::process::Command;
use std::sync::Mutex;
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
        }
    }
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
    snapshot.as_object_mut().expect("snapshot object").insert("setup".into(), json!({
        "codexCommand": command_exists("codex.exe") || command_exists("codex"),
        "claudeCommand": command_exists("claude.exe") || command_exists("claude"),
        "hookCommand": format!("\"{}\" --claude-status-hook", std::env::current_exe().map(|path| path.display().to_string()).unwrap_or_default())
    }));
    snapshot
}

fn notify_alerts(app: &AppHandle, report: &Value) {
    let alerts = report
        .get("alerts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if alerts.is_empty() {
        return;
    }
    let signature = serde_json::to_string(&alerts).unwrap_or_default();
    let state = app.state::<RuntimeState>();
    let mut previous = state.last_alert_signature.lock().expect("alert state lock");
    if *previous == signature {
        return;
    }
    *previous = signature;
    let body = alerts
        .iter()
        .take(3)
        .map(|alert| {
            format!(
                "{} {}: {}% 남음",
                if alert.get("provider").and_then(Value::as_str) == Some("codex") {
                    "Codex"
                } else {
                    "Claude"
                },
                alert
                    .get("limitType")
                    .and_then(Value::as_str)
                    .unwrap_or("limit"),
                alert
                    .get("remainingPercent")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
            )
        })
        .collect::<Vec<_>>()
        .join(" · ");
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
    let (codex_result, claude_result) = std::thread::scope(|scope| {
        let codex =
            scope.spawn(|| capture_codex(&codex_status, &history_dir, Duration::from_secs(20)));
        let claude =
            scope.spawn(|| capture_claude(&claude_status, &history_dir, Duration::from_secs(60)));
        (
            codex
                .join()
                .unwrap_or_else(|_| Err("Codex 수집 작업이 중단됐습니다.".into())),
            claude
                .join()
                .unwrap_or_else(|_| Err("Claude 수집 작업이 중단됐습니다.".into())),
        )
    });
    let mut errors = Map::new();
    if let Err(error) = codex_result {
        errors.insert("codex".into(), Value::String(error));
    }
    if let Err(error) = claude_result {
        errors.insert("claude".into(), Value::String(error));
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
    snapshot_value(app)
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
fn setup_snapshot(app: AppHandle) -> Value {
    setup_snapshot_value(&app)
}

#[tauri::command]
async fn refresh_setup_snapshot(app: AppHandle) -> Result<Value, String> {
    let refreshed = app.clone();
    tauri::async_runtime::spawn_blocking(move || refresh_all(&refreshed))
        .await
        .map_err(|error| error.to_string())?;
    Ok(setup_snapshot_value(&app))
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
            430.0,
            320.0,
            280.0,
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
        "setup" => ("setup.html", "Setup", 560.0, 720.0, 500.0, 580.0, true),
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

#[tauri::command]
fn show_window(app: AppHandle, label: String) -> Result<(), String> {
    show_window_by_label(&app, &label)
}

#[tauri::command]
fn install_claude_hook(force: bool) -> Result<Value, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    hook::install_hook(&executable, force)
}

#[tauri::command]
fn open_login_terminal(provider: String) -> Result<(), String> {
    let command = if provider == "codex" {
        "codex login"
    } else {
        "claude auth"
    };
    Command::new("powershell.exe")
        .args(["-NoExit", "-Command", command])
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
                let _ = show_window_by_label(app, label);
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
                let _ = show_window_by_label(tray.app_handle(), "compact");
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
            if !std::env::args().any(|argument| argument == "--background") {
                show_window_by_label(app.handle(), "compact").map_err(std::io::Error::other)?;
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
            set_always_on_top,
            set_opacity,
            minimize_window,
            close_window,
            show_window,
            install_claude_hook,
            open_login_terminal,
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
