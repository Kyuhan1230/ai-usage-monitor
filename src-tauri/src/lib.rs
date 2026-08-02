mod analytics;
mod codex_cli;
mod collector;
mod hook;
mod storage;
mod update;
mod usage;

use crate::analytics::{STATUS_FRESHNESS_MS, build_analytics};
use crate::codex_cli::{
    AuthState as CodexAuthState, CandidateSource, ChildWindow, CliState as CodexCliState,
    CodexSetupDto, CodexSetupError, InstallOperationDto, InstallOperationState, JobLifetime,
    LoginOperationDto, LoginOperationState, OperationKind, OperationManager, ProcessTree,
    ProvenanceConfidence, SelectedCodex, SetupSafeErrorCode, cancellation_requested,
    capture_install_evidence, discover_codex_candidates_with_manual, probe_auth, probe_candidates,
    ready_conflict_count, select_candidates, selected_login_command, setup_dto,
    single_install_delta, spawn_in_process_tree,
};
use crate::collector::{
    AuthProbe as ClaudeAuthProbe, CliState as CollectorCliState, CodexCaptureError, capture_claude,
    capture_codex_with, claude_cli_state, probe_claude_auth, resolve_claude_command,
};
use crate::storage::{data_dir, read_history, read_json, write_json};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_notification::NotificationExt;

#[derive(Clone)]
struct CodexCandidateSelection {
    path: PathBuf,
    persistable: bool,
}

struct RuntimeState {
    refresh_guard: Mutex<()>,
    refresh: Mutex<Value>,
    window: Mutex<WindowState>,
    provider_auth: Mutex<ProviderAuthCache>,
    codex_operations: OperationManager,
    codex_selected: Mutex<Option<SelectedCodex>>,
    codex_preferred_path: Mutex<Option<PathBuf>>,
    codex_manual_path: Mutex<Option<PathBuf>>,
    codex_tracked_install_path: Mutex<Option<PathBuf>>,
    codex_candidate_paths: Mutex<BTreeMap<String, CodexCandidateSelection>>,
    codex_preferred_fingerprint: Mutex<Option<String>>,
    codex_status: Mutex<Option<Value>>,
    last_alert_signature: Mutex<String>,
    last_collection_ms: Mutex<i64>,
}

#[derive(Clone, Default)]
struct ProviderAuthCache {
    codex: Option<CodexAuthState>,
    claude: Option<ClaudeAuthProbe>,
}

#[derive(Clone)]
struct WindowState {
    always_on_top: bool,
    opacity: f64,
}

impl Default for RuntimeState {
    fn default() -> Self {
        let (install_detached, login_detached) = detached_codex_operation_flags();
        Self {
            refresh_guard: Mutex::new(()),
            refresh: Mutex::new(json!({"state":"idle","completedAt":Value::Null,"errors":{}})),
            window: Mutex::new(WindowState {
                always_on_top: false,
                opacity: 0.96,
            }),
            provider_auth: Mutex::new(ProviderAuthCache::default()),
            codex_operations: OperationManager::with_detached(install_detached, login_detached),
            codex_selected: Mutex::new(None),
            codex_preferred_path: Mutex::new(None),
            codex_manual_path: Mutex::new(None),
            codex_tracked_install_path: Mutex::new(None),
            codex_candidate_paths: Mutex::new(BTreeMap::new()),
            codex_preferred_fingerprint: Mutex::new(stored_codex_selection_fingerprint()),
            codex_status: Mutex::new(None),
            last_alert_signature: Mutex::new(stored_notification_signature()),
            last_collection_ms: Mutex::new(0),
        }
    }
}

const ACTIVITY_CHECK_INTERVAL: Duration = Duration::from_secs(60);
const AUTO_REFRESH_COOLDOWN_MS: i64 = 5 * 60 * 1000;
const UPDATE_MONITOR_MAX_SLEEP: Duration = Duration::from_secs(60 * 60);
const UPDATE_MONITOR_BUSY_SLEEP: Duration = Duration::from_secs(60);
const UPDATE_MONITOR_ERROR_SLEEP: Duration = Duration::from_secs(15 * 60);
// 기존 설치본의 자동 실행 설정을 잃지 않기 위한 내부 레지스트리 값이다.
const LAUNCH_AT_LOGIN_REGISTRY_VALUE: &str = "Codex Claude Usage";
static UPDATE_MENU_ITEM: OnceLock<MenuItem<tauri::Wry>> = OnceLock::new();

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

fn automatic_refresh_decision(
    pending_activity: bool,
    changed: bool,
    cooldown_elapsed: bool,
) -> (bool, bool) {
    let pending_activity = pending_activity || changed;
    if pending_activity && cooldown_elapsed {
        (false, true)
    } else {
        (pending_activity, false)
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
        .and_then(|key| {
            key.get_value::<String, _>(LAUNCH_AT_LOGIN_REGISTRY_VALUE)
                .ok()
        })
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
            LAUNCH_AT_LOGIN_REGISTRY_VALUE,
            &format!("\"{}\" --background", executable.display()),
        )
        .map_err(|error| error.to_string())
    } else {
        match key.delete_value(LAUNCH_AT_LOGIN_REGISTRY_VALUE) {
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

/// 이 앱에서만 공급자를 숨긴다. CLI 인증은 건드리지 않으므로 다른 작업에 영향이 없다.
fn hidden_providers() -> Vec<String> {
    read_json(&data_dir().join("preferences.json"))
        .and_then(|value| {
            value
                .get("hiddenProviders")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .filter(|name| *name == "codex" || *name == "claude")
                        .map(str::to_string)
                        .collect()
                })
        })
        .unwrap_or_default()
}

fn is_hidden(provider: &str) -> bool {
    hidden_providers().iter().any(|name| name == provider)
}

fn update_hidden_provider(provider: &str, hidden: bool) -> Result<Vec<String>, String> {
    if provider != "codex" && provider != "claude" {
        return Err(format!("알 수 없는 공급자입니다: {provider}"));
    }
    let path = data_dir().join("preferences.json");
    let mut preferences = read_json(&path).unwrap_or_else(|| json!({}));
    let mut list = hidden_providers();
    list.retain(|name| name != provider);
    if hidden {
        list.push(provider.to_string());
    }
    if !preferences.is_object() {
        preferences = json!({});
    }
    preferences["hiddenProviders"] = json!(list);
    write_json(&path, &preferences)?;
    Ok(list)
}

#[derive(Clone)]
struct CodexResolution {
    dto: CodexSetupDto,
    selected: Option<SelectedCodex>,
    device_auth_supported: bool,
}

fn windows_path_identity(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_start_matches(r"\\?\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn same_windows_path(left: &Path, right: &Path) -> bool {
    windows_path_identity(left) == windows_path_identity(right)
}

fn codex_selection_state_path() -> PathBuf {
    data_dir().join("codex-selection.json")
}

fn valid_sha256_text(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn stored_codex_selection_fingerprint() -> Option<String> {
    read_json(&codex_selection_state_path())
        .and_then(|value| {
            value
                .get("selectedFingerprint")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|value| valid_sha256_text(value))
}

fn stored_codex_selection_salt() -> Option<String> {
    read_json(&codex_selection_state_path())
        .and_then(|value| value.get("salt").and_then(Value::as_str).map(str::to_owned))
        .filter(|value| uuid::Uuid::parse_str(value).is_ok())
}

fn codex_path_fingerprint(salt: &str, path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ai-usage-monitor/codex-selection/v1\0");
    hasher.update(salt.as_bytes());
    hasher.update(b"\0");
    hasher.update(windows_path_identity(path).as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn persist_codex_selection(app: &AppHandle, path: &Path) {
    let salt = stored_codex_selection_salt().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let fingerprint = codex_path_fingerprint(&salt, path);
    let value = json!({
        "schemaVersion": 1,
        "salt": salt,
        "selectedFingerprint": fingerprint,
        "updatedAt": chrono::Utc::now().to_rfc3339(),
    });
    if write_json(&codex_selection_state_path(), &value).is_ok() {
        *app.state::<RuntimeState>()
            .codex_preferred_fingerprint
            .lock()
            .expect("Codex preferred fingerprint lock") =
            value["selectedFingerprint"].as_str().map(str::to_owned);
    }
}

fn resolve_codex_setup(app: &AppHandle) -> CodexResolution {
    let state = app.state::<RuntimeState>();
    let manual_paths = state
        .codex_manual_path
        .lock()
        .expect("Codex manual path lock")
        .clone()
        .into_iter()
        .collect::<Vec<_>>();
    let preferred_path = state
        .codex_preferred_path
        .lock()
        .expect("Codex preferred path lock")
        .clone();
    let preferred_fingerprint = state
        .codex_preferred_fingerprint
        .lock()
        .expect("Codex preferred fingerprint lock")
        .clone();
    let selection_salt = stored_codex_selection_salt();
    let tracked_path = state
        .codex_tracked_install_path
        .lock()
        .expect("Codex tracked install path lock")
        .clone();

    let mut inventory = probe_candidates(discover_codex_candidates_with_manual(manual_paths));
    if let Some(tracked_path) = tracked_path.as_deref() {
        for candidate in &mut inventory.candidates {
            if candidate.is_compatible()
                && same_windows_path(candidate.command.path(), tracked_path)
            {
                candidate.provenance = ProvenanceConfidence::TrackedOfficialInstall;
            }
        }
    }

    let mut selection = select_candidates(&inventory);
    let preferred_index = preferred_path
        .as_deref()
        .and_then(|preferred_path| {
            inventory.candidates.iter().position(|candidate| {
                candidate.is_compatible()
                    && same_windows_path(candidate.command.path(), preferred_path)
            })
        })
        .or_else(|| {
            let salt = selection_salt.as_deref()?;
            let fingerprint = preferred_fingerprint.as_deref()?;
            inventory.candidates.iter().position(|candidate| {
                candidate.is_compatible()
                    && codex_path_fingerprint(salt, candidate.command.path()) == fingerprint
            })
        });
    if let Some(index) = preferred_index {
        selection.state = CodexCliState::Ready;
        selection.selected_index = Some(index);
        selection.conflict_count = ready_conflict_count(&inventory, index);
        selection.safe_error_code = None;
    }

    let selected_index = selection.selected_index;
    let selected = selected_index
        .and_then(|index| inventory.candidates.get(index))
        .map(|candidate| candidate.command.clone());
    let device_auth_supported = selected_index
        .and_then(|index| inventory.candidates.get(index))
        .is_some_and(|candidate| candidate.capabilities.device_auth);
    let auth = probe_auth(selected.as_ref());
    // Candidate IDs are scoped to this exact discovery snapshot. Reusing ordinal IDs such as
    // `candidate-1` lets a click from an older renderer snapshot select a different path after a
    // concurrent refresh reorders candidates. A fresh opaque namespace makes stale selections
    // fail closed without exposing the canonical path.
    let dto = setup_dto(&inventory, &selection, &auth);
    let candidate_paths = inventory
        .candidates
        .iter()
        .zip(&dto.candidates)
        .map(|(candidate, candidate_dto)| {
            (
                candidate_dto.candidate_id.clone(),
                CodexCandidateSelection {
                    path: candidate.command.path().to_path_buf(),
                    persistable: candidate
                        .discovered_from
                        .iter()
                        .any(|source| *source != CandidateSource::Manual),
                },
            )
        })
        .collect();

    *state
        .codex_selected
        .lock()
        .expect("Codex selected command lock") = selected.clone();
    *state
        .codex_candidate_paths
        .lock()
        .expect("Codex candidate path map lock") = candidate_paths;
    state
        .provider_auth
        .lock()
        .expect("provider auth state lock")
        .codex = Some(auth.state);

    CodexResolution {
        dto,
        selected,
        device_auth_supported,
    }
}

fn snapshot_value(app: &AppHandle) -> Value {
    let state = app.state::<RuntimeState>();
    let directory = data_dir();
    let codex = state
        .codex_status
        .lock()
        .expect("Codex status lock")
        .clone()
        .or_else(|| read_json(&directory.join("status.json")));
    let codex_last_success = codex.as_ref().and_then(last_successful_codex_status);
    let claude = read_json(&directory.join("claude-status.json"));
    let analytics = read_json(&directory.join("analytics.json"));
    let window = state.window.lock().expect("window state lock").clone();
    let refresh = state.refresh.lock().expect("refresh state lock").clone();
    let provider_auth = state
        .provider_auth
        .lock()
        .expect("provider auth state lock")
        .clone();
    json!({
        "capturedAt": chrono::Utc::now().to_rfc3339(),
        "details": {"running": app.get_webview_window("details").is_some(), "mode": "embedded"},
        "capture": {"mode":"on_demand", "codexFreshnessMs":STATUS_FRESHNESS_MS, "claudeFreshnessMs":STATUS_FRESHNESS_MS},
        "monitoring": monitoring_snapshot(),
        "refresh": refresh,
        "analytics": analytics,
        "codex": {
            "connected": codex.as_ref().and_then(|value| value.get("parse_status")).and_then(Value::as_str) == Some("ok"),
            "ageMs": status_age_ms(codex_last_success.as_ref()),
            "status": codex,
            "lastSuccess": codex_last_success,
            "limits": limits_by_type(codex_last_success.as_ref())
        },
        "claude": {
            "connected": claude.as_ref().and_then(|value| value.get("parse_status")).and_then(Value::as_str) == Some("ok"),
            "hookInstalled": hook::hook_installed(),
            "ageMs": status_age_ms(claude.as_ref()),
            "status": claude,
            "limits": limits_by_type(claude.as_ref())
        },
        "providers": {
            "codex": {"authState": cached_codex_auth_state(provider_auth.codex), "hidden": is_hidden("codex")},
            "claude": {"authState": cached_claude_auth_state(&provider_auth.claude), "hidden": is_hidden("claude")}
        },
        "hiddenProviders": hidden_providers(),
        "window": {"alwaysOnTop":window.always_on_top,"opacity":window.opacity},
        "launchAtLogin": launch_at_login()
    })
}

fn setup_snapshot_value(app: &AppHandle) -> Value {
    let codex = resolve_codex_setup(app);
    let claude_state = claude_cli_state();
    let claude_auth = probe_claude_auth(Duration::from_secs(8));
    {
        let state = app.state::<RuntimeState>();
        let mut cached = state
            .provider_auth
            .lock()
            .expect("provider auth state lock");
        cached.claude = Some(claude_auth.clone());
    }
    let state = app.state::<RuntimeState>();
    let mut codex_setup = serde_json::to_value(&codex.dto).expect("Codex setup DTO serialization");
    let codex_setup_object = codex_setup.as_object_mut().expect("Codex setup DTO object");
    codex_setup_object.insert(
        "install".into(),
        json!(state.codex_operations.install_snapshot()),
    );
    codex_setup_object.insert(
        "login".into(),
        json!(state.codex_operations.login_snapshot()),
    );
    let mut snapshot = snapshot_value(app);
    snapshot.as_object_mut().expect("snapshot object").insert(
        "setup".into(),
        json!({
            "codexSetup": codex_setup,
            "codexCommand": codex.dto.cli_state == CodexCliState::Ready,
            "codexCommandState": codex.dto.cli_state,
            "codexAuth": codex.dto.auth,
            "claudeCommand": claude_state == CollectorCliState::Ready,
            "claudeCommandState": claude_state.as_str(),
            "claudeAuth": claude_auth_probe_value(&claude_auth),
            "onboardingComplete": onboarding_complete(),
            "hiddenProviders": hidden_providers()
        }),
    );
    snapshot
}

fn claude_auth_probe_value(probe: &ClaudeAuthProbe) -> Value {
    json!({
        "state": probe.state.as_str(),
        "error": probe.error,
    })
}

fn cached_codex_auth_state(state: Option<CodexAuthState>) -> &'static str {
    match state {
        Some(CodexAuthState::Unavailable) => "unavailable",
        Some(CodexAuthState::Checking) => "checking",
        Some(CodexAuthState::Unauthenticated) => "unauthenticated",
        Some(CodexAuthState::Authenticated) => "authenticated",
        Some(CodexAuthState::Error) => "error",
        None => "unknown",
    }
}

fn cached_claude_auth_state(probe: &Option<ClaudeAuthProbe>) -> &'static str {
    probe
        .as_ref()
        .map(|value| value.state.as_str())
        .unwrap_or("unknown")
}

fn onboarding_complete() -> bool {
    read_json(&data_dir().join("onboarding.json"))
        .and_then(|value| value.get("completed").and_then(Value::as_bool))
        .unwrap_or(false)
}

fn notification_state_path() -> std::path::PathBuf {
    data_dir().join("notification-state.json")
}

fn stored_notification_signature() -> String {
    read_json(&notification_state_path())
        .and_then(|value| {
            value
                .get("signature")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

fn persist_notification_signature(signature: &str) {
    let _ = write_json(
        &notification_state_path(),
        &json!({
            "schemaVersion": 1,
            "signature": signature,
            "updatedAt": chrono::Utc::now().to_rfc3339(),
        }),
    );
}

fn notification_payload(report: &Value) -> Option<(String, String)> {
    let alerts = report
        .get("alerts")
        .and_then(Value::as_array)
        .map(|alerts| {
            alerts
                .iter()
                .filter(|alert| {
                    alert.get("reason").and_then(Value::as_str) != Some("forecast_before_reset")
                        || alert.get("confidence").and_then(Value::as_str) != Some("low")
                })
                .cloned()
                .collect::<Vec<_>>()
        })
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
                "date": report["anomalies"][*provider]["date"],
                "multiplier": report["anomalies"][*provider]["multiplier"]
            })
        })
        .collect::<Vec<_>>();
    if alerts.is_empty() && anomalies.is_empty() {
        return None;
    }
    let alert_episodes = alerts
        .iter()
        .map(|alert| {
            json!({
                "provider": alert.get("provider"),
                "limitType": alert.get("limitType"),
                "severity": alert.get("severity"),
                "reason": alert.get("reason"),
                "resetAt": alert.get("resetAt"),
            })
        })
        .collect::<Vec<_>>();
    let anomaly_episodes = anomalies
        .iter()
        .map(|anomaly| {
            json!({
                "provider": anomaly.get("provider"),
                "date": anomaly.get("date"),
            })
        })
        .collect::<Vec<_>>();
    let signature = serde_json::to_string(&json!({
        "alerts": alert_episodes,
        "anomalies": anomaly_episodes,
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
                Some("limit_exhausted") => "한도 소진",
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

fn update_notification_signature(previous: &mut String, next: Option<&str>) -> bool {
    let next = next.unwrap_or_default();
    if previous == next {
        return false;
    }
    next.clone_into(previous);
    true
}

fn notify_alerts(app: &AppHandle, report: &Value) {
    let payload = notification_payload(report);
    let state = app.state::<RuntimeState>();
    let mut previous = state.last_alert_signature.lock().expect("alert state lock");
    if !update_notification_signature(
        &mut previous,
        payload.as_ref().map(|(signature, _)| signature.as_str()),
    ) {
        return;
    }
    persist_notification_signature(&previous);
    let Some((_, body)) = payload else {
        return;
    };
    drop(previous);
    let _ = app
        .notification()
        .builder()
        .title("AI 사용량 확인 필요")
        .body(body)
        .show();
}

fn safe_codex_reset_text(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| {
        text.len() <= 64
            && text.starts_with("resets ")
            && text
                .chars()
                .all(|character| character.is_ascii_digit() || " resets/-:".contains(character))
    })
}

fn sanitized_codex_limit(limit: &Value) -> Option<Value> {
    let kind = limit.get("type").and_then(Value::as_str)?;
    if !matches!(kind, "five_hour" | "weekly" | "monthly") {
        return None;
    }
    let used_percent = limit.get("used_percent").and_then(Value::as_i64)?;
    let remaining_percent = limit.get("remaining_percent").and_then(Value::as_i64)?;
    Some(json!({
        "type": kind,
        "used_percent": used_percent.clamp(0, 100),
        "remaining_percent": remaining_percent.clamp(0, 100),
        "reset_text": limit.get("reset_text").and_then(safe_codex_reset_text),
        "resets_at": limit.get("resets_at").and_then(Value::as_i64),
        "window_duration_mins": limit.get("window_duration_mins").and_then(Value::as_i64),
    }))
}

fn sanitized_codex_success(status: &Value) -> Option<Value> {
    if status.get("parse_status").and_then(Value::as_str) != Some("ok") {
        return None;
    }
    let captured_at = status.get("captured_at").and_then(Value::as_str)?;
    chrono::DateTime::parse_from_rfc3339(captured_at).ok()?;
    let limits = status
        .get("limits")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(sanitized_codex_limit)
        .collect::<Vec<_>>();
    if limits.is_empty() {
        return None;
    }
    Some(json!({
        "schema_version": 1,
        "captured_at": captured_at,
        "source": "codex_app_server",
        "capture_method": "codex_app_server",
        "parse_status": "ok",
        "limits": limits,
        "rate_limit_reset_credits": status
            .get("rate_limit_reset_credits")
            .and_then(Value::as_i64)
            .map(|value| value.max(0)),
        "spend_control_reached": status
            .get("spend_control_reached")
            .and_then(Value::as_bool),
        "raw_status_text": "",
        "capture": {
            "state": "on_demand_ok",
            "detail": "official Codex app-server account snapshot",
            "heartbeat_at": captured_at,
            "mode": "on_demand"
        }
    }))
}

fn last_successful_codex_status(status: &Value) -> Option<Value> {
    sanitized_codex_success(status)
        .or_else(|| status.get("last_success").and_then(sanitized_codex_success))
}

fn failed_codex_capture_status(error: CodexCaptureError, previous: Option<&Value>) -> Value {
    let captured_at = chrono::Utc::now().to_rfc3339();
    let last_success = previous.and_then(last_successful_codex_status);
    json!({
        "schema_version": 1,
        "captured_at": captured_at,
        "source": "codex_app_server",
        "capture_method": "codex_app_server",
        "parse_status": "failed",
        "safe_error_code": error.safe_error_code(),
        "limits": [],
        "last_success": last_success,
        "raw_status_text": "",
        "capture": {
            "state": "on_demand_failed",
            "detail": "Codex usage capture failed",
            "heartbeat_at": captured_at,
            "mode": "on_demand"
        }
    })
}

fn capture_error_after_auth_probe(
    error: CodexCaptureError,
    auth_state: CodexAuthState,
) -> CodexCaptureError {
    if error.should_reprobe_auth() && auth_state == CodexAuthState::Unauthenticated {
        CodexCaptureError::AuthenticationUnconfirmed
    } else {
        error
    }
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
    let previous_codex_status = state
        .codex_status
        .lock()
        .expect("Codex status lock")
        .clone()
        .or_else(|| read_json(&codex_status));
    // 이 앱에서 숨긴 공급자는 CLI를 아예 실행하지 않는다.
    let codex_resolution = (!is_hidden("codex")).then(|| resolve_codex_setup(app));
    let codex_selected = codex_resolution
        .as_ref()
        .filter(|resolution| resolution.dto.cli_state == CodexCliState::Ready)
        .and_then(|resolution| resolution.selected.clone());
    let codex_ready = codex_selected.is_some();
    let claude_ready = claude_cli_state() == CollectorCliState::Ready && !is_hidden("claude");
    let (codex_result, claude_result) = std::thread::scope(|scope| {
        let codex = codex_selected.as_ref().map(|selected| {
            scope.spawn(|| {
                capture_codex_with(
                    selected,
                    &codex_status,
                    &history_dir,
                    Duration::from_secs(20),
                )
            })
        });
        let claude = claude_ready.then(|| {
            scope.spawn(|| capture_claude(&claude_status, &history_dir, Duration::from_secs(60)))
        });
        (
            codex.map(|thread| thread.join().unwrap_or(Err(CodexCaptureError::Shutdown))),
            claude.map(|thread| {
                thread
                    .join()
                    .unwrap_or_else(|_| Err("Claude 수집 작업이 중단됐습니다.".into()))
            }),
        )
    });
    let mut errors = Map::new();
    let codex_result = codex_result.or_else(|| {
        let resolution = codex_resolution.as_ref()?;
        let had_success = previous_codex_status
            .as_ref()
            .and_then(last_successful_codex_status)
            .is_some();
        if resolution.dto.cli_state == CodexCliState::Unsupported {
            Some(Err(CodexCaptureError::CapabilityMissing))
        } else if had_success && resolution.selected.is_none() {
            Some(Err(CodexCaptureError::Spawn))
        } else {
            None
        }
    });
    match codex_result {
        Some(Ok(status)) => {
            *state.codex_status.lock().expect("Codex status lock") = Some(status);
        }
        Some(Err(mut error)) => {
            if error.should_reprobe_auth()
                && let Some(selected) = codex_selected.as_ref()
            {
                let auth = probe_auth(Some(selected));
                error = capture_error_after_auth_probe(error, auth.state);
                state
                    .provider_auth
                    .lock()
                    .expect("provider auth state lock")
                    .codex = Some(auth.state);
            }
            let failed = failed_codex_capture_status(error, previous_codex_status.as_ref());
            *state.codex_status.lock().expect("Codex status lock") = Some(failed.clone());
            let _ = write_json(&codex_status, &failed);
            errors.insert(
                "codex".into(),
                Value::String("Codex 사용량을 안전하게 확인하지 못했습니다.".into()),
            );
        }
        None => {}
    }
    if let Some(Err(error)) = claude_result {
        errors.insert("claude".into(), Value::String(error));
    }
    if !codex_ready && !claude_ready {
        let message = if is_hidden("codex") && is_hidden("claude") {
            "표시할 도구를 모두 숨겼습니다. Setup에서 하나 이상 다시 표시하세요."
        } else {
            "사용량을 확인할 Codex 또는 Claude CLI가 필요합니다."
        };
        errors.insert("providers".into(), Value::String(message.into()));
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
        let mut pending_activity = false;
        loop {
            thread::sleep(ACTIVITY_CHECK_INTERVAL);
            if !activity_monitoring_enabled() {
                pending_activity = false;
                continue;
            }
            let current_activity = usage::latest_session_activity_ms();
            let changed = has_new_activity(last_activity, current_activity);
            last_activity = current_activity.or(last_activity);
            let now_ms = chrono::Utc::now().timestamp_millis();
            let last_collection = *app
                .state::<RuntimeState>()
                .last_collection_ms
                .lock()
                .expect("collection state lock");
            let (next_pending, should_refresh) = automatic_refresh_decision(
                pending_activity,
                changed,
                auto_refresh_cooldown_elapsed(last_collection, now_ms),
            );
            pending_activity = next_pending;
            if !should_refresh {
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
fn codex_operation_snapshot(app: AppHandle) -> Value {
    let operations = &app.state::<RuntimeState>().codex_operations;
    json!({
        "install": operations.install_snapshot(),
        "login": operations.login_snapshot(),
    })
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

fn sync_update_tray_text(app: &AppHandle) {
    if let Some(item) = UPDATE_MENU_ITEM.get() {
        let _ = item.set_text(update::tray_menu_text(app));
    }
}

async fn check_and_present_update(
    app: AppHandle,
    manual: bool,
) -> Result<update::UpdateCheckResult, String> {
    let result = match update::check_for_update(app.clone(), manual).await {
        Ok(result) => result,
        Err(error) => {
            sync_update_tray_text(&app);
            return Err(error);
        }
    };
    sync_update_tray_text(&app);
    if result.should_notify {
        let version = result
            .available
            .as_ref()
            .map(|available| update::display_version(&available.version))
            .unwrap_or("새 버전");
        let _ = app
            .notification()
            .builder()
            .title("새 버전이 있습니다")
            .body(format!(
                "v{version} 업데이트를 사용할 수 있습니다. 트레이 메뉴에서 확인하세요."
            ))
            .show();
    }
    if result.should_open_window {
        result
            .available
            .as_ref()
            .ok_or_else(|| "업데이트 창에 표시할 버전 정보가 없습니다.".to_string())?;
        let window_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || show_window_by_label(&window_app, "update"))
            .await
            .map_err(|error| error.to_string())??;
    }
    Ok(result)
}

#[tauri::command]
async fn check_for_update(
    app: AppHandle,
    manual: bool,
) -> Result<update::UpdateCheckResult, String> {
    check_and_present_update(app, manual).await
}

#[tauri::command]
fn get_update_state(app: AppHandle) -> update::UpdateViewState {
    update::view_state(&app)
}

#[tauri::command]
fn postpone_update(app: AppHandle, version: String) -> Result<update::UpdateViewState, String> {
    update::postpone_update(&app, &version)
}

#[tauri::command]
async fn install_update(
    app: AppHandle,
    expected_version: String,
    on_progress: Channel<update::UpdateProgress>,
) -> Result<update::UpdateInstallResult, String> {
    update::install_update(app, expected_version, on_progress).await
}

fn start_update_monitor(app: AppHandle) {
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(update::AUTO_CHECK_DELAY_SECONDS));
        loop {
            let wait = update::automatic_check_wait(&app);
            if !wait.is_zero() {
                thread::sleep(wait.min(UPDATE_MONITOR_MAX_SLEEP));
                continue;
            }

            match tauri::async_runtime::block_on(check_and_present_update(app.clone(), false)) {
                Ok(result) if result.status == "busy" => thread::sleep(UPDATE_MONITOR_BUSY_SLEEP),
                Err(_) => {
                    // State persistence can fail independently of the network check. Always
                    // keep a local delay so an unwritable state file cannot create a tight loop.
                    thread::sleep(UPDATE_MONITOR_ERROR_SLEEP);
                }
                Ok(_) => {}
            }
        }
    });
}

fn start_tray_update_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        match check_and_present_update(app.clone(), true).await {
            Ok(result) if result.status == "up_to_date" => {
                let _ = app
                    .notification()
                    .builder()
                    .title("업데이트 확인")
                    .body("현재 최신 버전을 사용하고 있습니다.")
                    .show();
            }
            Ok(result) if result.status == "busy" => {
                let _ = app
                    .notification()
                    .builder()
                    .title("업데이트 확인 중")
                    .body("이미 진행 중인 확인이 끝날 때까지 잠시 기다려 주세요.")
                    .show();
            }
            Ok(_) => {}
            Err(error) => {
                let _ = app
                    .notification()
                    .builder()
                    .title("업데이트 확인 실패")
                    .body(format!("네트워크를 확인한 뒤 다시 시도하세요. {error}"))
                    .show();
            }
        }
    });
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct WindowMetrics {
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
}

fn fitted_window_metrics(
    preferred: (f64, f64),
    minimum: (f64, f64),
    work_area: (f64, f64),
) -> WindowMetrics {
    fn fit_dimension(preferred: f64, minimum: f64, available: f64, margin: f64) -> (f64, f64) {
        let maximum = (available - margin).max(1.0);
        let fitted_minimum = minimum.min(maximum);
        (preferred.min(maximum).max(fitted_minimum), fitted_minimum)
    }

    let (width, min_width) = fit_dimension(preferred.0, minimum.0, work_area.0, 48.0);
    let (height, min_height) = fit_dimension(preferred.1, minimum.1, work_area.1, 64.0);
    WindowMetrics {
        width,
        height,
        min_width,
        min_height,
    }
}

fn primary_work_area(app: &AppHandle) -> (f64, f64) {
    app.primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| {
            let scale = monitor.scale_factor();
            let scale = if scale.is_finite() && scale > 0.0 {
                scale
            } else {
                1.0
            };
            let size = &monitor.work_area().size;
            (
                f64::from(size.width) / scale,
                f64::from(size.height) / scale,
            )
        })
        .unwrap_or((1920.0, 1080.0))
}

fn create_secondary_window(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    let (url, title, width, height, min_width, min_height, decorations) = match label {
        "compact" => (
            "compact.html",
            "Codex Claude Usage",
            560.0,
            320.0,
            340.0,
            320.0,
            false,
        ),
        "insights" => (
            "insights.html",
            "Usage Insights",
            820.0,
            1000.0,
            360.0,
            480.0,
            true,
        ),
        "details" => (
            "details.html",
            "Local Token Details",
            1180.0,
            760.0,
            360.0,
            440.0,
            true,
        ),
        "setup" => ("setup.html", "Setup", 680.0, 820.0, 360.0, 480.0, true),
        "update" => (
            "update.html",
            "새 버전이 있습니다",
            520.0,
            440.0,
            340.0,
            360.0,
            true,
        ),
        _ => return Err("unknown window label".to_string()),
    };
    let metrics = fitted_window_metrics(
        (width, height),
        (min_width, min_height),
        primary_work_area(app),
    );
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(metrics.width, metrics.height)
        .min_inner_size(metrics.min_width, metrics.min_height)
        .resizable(true)
        .maximizable(decorations)
        .decorations(decorations)
        .center()
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

const CODEX_OPERATION_LONG_RUNNING_AFTER: Duration = Duration::from_secs(10 * 60);
const CODEX_INSTALL_SCRIPT_URL: &str = "https://chatgpt.com/codex/install.ps1";

fn codex_operation_marker_path() -> PathBuf {
    data_dir().join("codex-operation-state.json")
}

fn detached_codex_operation_flags() -> (bool, bool) {
    let marker = read_json(&codex_operation_marker_path());
    let flags = (
        marker
            .as_ref()
            .and_then(|value| value.get("installActive"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        marker
            .as_ref()
            .and_then(|value| value.get("loginActive"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
    );
    if flags.0 || flags.1 {
        let cleared = json!({
            "schemaVersion": 1,
            "installActive": false,
            "loginActive": false,
            "updatedAt": chrono::Utc::now().to_rfc3339(),
        });
        let _ = write_json(&codex_operation_marker_path(), &cleared);
    }
    flags
}

fn persist_codex_operation_active(kind: OperationKind, active: bool) {
    let path = codex_operation_marker_path();
    let mut marker = read_json(&path).unwrap_or_else(|| {
        json!({
            "schemaVersion": 1,
            "installActive": false,
            "loginActive": false,
        })
    });
    let field = match kind {
        OperationKind::Install => "installActive",
        OperationKind::Login => "loginActive",
    };
    marker[field] = Value::Bool(active);
    marker["updatedAt"] = Value::String(chrono::Utc::now().to_rfc3339());
    let _ = write_json(&path, &marker);
}

struct CodexOperationMarkerGuard {
    kind: OperationKind,
}

impl CodexOperationMarkerGuard {
    fn begin(kind: OperationKind) -> Self {
        persist_codex_operation_active(kind, true);
        Self { kind }
    }
}

impl Drop for CodexOperationMarkerGuard {
    fn drop(&mut self) {
        persist_codex_operation_active(self.kind, false);
    }
}

enum TrackedChildOutcome {
    Exited(ExitStatus),
    Cancelled,
    TrackingFailed,
}

fn tracked_cancel_outcome(process_tree_stopped: bool) -> TrackedChildOutcome {
    if process_tree_stopped {
        TrackedChildOutcome::Cancelled
    } else {
        TrackedChildOutcome::TrackingFailed
    }
}

fn linearize_tracked_child_outcome(
    manager: &OperationManager,
    kind: OperationKind,
    operation_id: &str,
    outcome: TrackedChildOutcome,
    child: &mut Child,
    process_tree: &ProcessTree,
) -> TrackedChildOutcome {
    match (
        outcome,
        manager.close_cancellation_window(kind, operation_id),
    ) {
        (TrackedChildOutcome::Exited(status), Some(false)) => TrackedChildOutcome::Exited(status),
        (TrackedChildOutcome::Exited(_), Some(true)) => {
            tracked_cancel_outcome(process_tree.terminate_and_wait(child))
        }
        (TrackedChildOutcome::Cancelled, Some(true)) => TrackedChildOutcome::Cancelled,
        (TrackedChildOutcome::TrackingFailed, Some(_)) => TrackedChildOutcome::TrackingFailed,
        (TrackedChildOutcome::Exited(_), None) => {
            let _ = process_tree.terminate_and_wait(child);
            TrackedChildOutcome::TrackingFailed
        }
        (TrackedChildOutcome::Cancelled, None | Some(false))
        | (TrackedChildOutcome::TrackingFailed, None) => TrackedChildOutcome::TrackingFailed,
    }
}

fn safe_setup_error(code: SetupSafeErrorCode) -> String {
    let error = CodexSetupError::new(code);
    serde_json::to_value(error.safe_code())
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "unknown_setup_error".into())
}

fn operation_is_long_running(started: Instant, now: Instant) -> bool {
    now.saturating_duration_since(started) >= CODEX_OPERATION_LONG_RUNNING_AFTER
}

#[cfg(windows)]
fn configure_hidden_console(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_hidden_console(_command: &mut Command) {}

fn wait_for_tracked_child(
    child: &mut Child,
    process_tree: &ProcessTree,
    cancellation: &std::sync::atomic::AtomicBool,
    mut mark_long_running: impl FnMut(),
) -> TrackedChildOutcome {
    let started = Instant::now();
    let mut long_running_marked = false;
    loop {
        if cancellation_requested(cancellation) {
            return tracked_cancel_outcome(process_tree.terminate_and_wait(child));
        }
        match child.try_wait() {
            Ok(Some(status)) => return TrackedChildOutcome::Exited(status),
            Ok(None) => {
                if !long_running_marked && operation_is_long_running(started, Instant::now()) {
                    mark_long_running();
                    long_running_marked = true;
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(_) => {
                let _ = process_tree.terminate_and_wait(child);
                return TrackedChildOutcome::TrackingFailed;
            }
        }
    }
}

type InstallEnvironment = BTreeMap<String, OsString>;
type RegistryInstallEnvironments = (InstallEnvironment, InstallEnvironment);

fn normalized_install_environment<I>(values: I) -> InstallEnvironment
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    values
        .into_iter()
        .filter_map(|(name, value)| {
            let normalized = name.to_str()?.to_ascii_uppercase();
            Some((normalized, value))
        })
        .collect()
}

fn effective_install_environment(
    process: &InstallEnvironment,
    user: &InstallEnvironment,
    machine: &InstallEnvironment,
) -> InstallEnvironment {
    let mut effective = machine.clone();
    effective.extend(user.clone());
    effective.extend(process.clone());
    effective
}

fn expand_install_environment_path(
    raw: &OsStr,
    environment: &InstallEnvironment,
) -> Result<PathBuf, SetupSafeErrorCode> {
    let mut current = raw
        .to_str()
        .ok_or(SetupSafeErrorCode::InstallTargetInvalid)?
        .trim()
        .trim_matches('"')
        .to_string();
    if current.is_empty() {
        return Err(SetupSafeErrorCode::InstallTargetInvalid);
    }

    let mut seen = BTreeSet::new();
    for _ in 0..4 {
        if !seen.insert(current.to_ascii_lowercase()) {
            return Err(SetupSafeErrorCode::InstallTargetInvalid);
        }

        let mut expanded = String::with_capacity(current.len());
        let mut cursor = 0;
        let mut changed = false;
        while let Some(relative_start) = current[cursor..].find('%') {
            let start = cursor + relative_start;
            expanded.push_str(&current[cursor..start]);
            let Some(relative_end) = current[start + 1..].find('%') else {
                return Err(SetupSafeErrorCode::InstallTargetInvalid);
            };
            let end = start + 1 + relative_end;
            let name = &current[start + 1..end];
            if name.is_empty() {
                return Err(SetupSafeErrorCode::InstallTargetInvalid);
            }
            let replacement = environment
                .get(&name.to_ascii_uppercase())
                .and_then(|value| value.to_str())
                .ok_or(SetupSafeErrorCode::InstallTargetInvalid)?;
            expanded.push_str(replacement);
            cursor = end + 1;
            changed = true;
        }
        expanded.push_str(&current[cursor..]);
        if !changed {
            return Ok(PathBuf::from(current));
        }
        current = expanded;
    }

    if current.contains('%') {
        Err(SetupSafeErrorCode::InstallTargetInvalid)
    } else {
        Ok(PathBuf::from(current))
    }
}

fn validate_install_directory(path: PathBuf) -> Result<PathBuf, SetupSafeErrorCode> {
    if !path.is_absolute() {
        return Err(SetupSafeErrorCode::InstallTargetInvalid);
    }
    match std::fs::metadata(&path) {
        Ok(metadata) if metadata.is_dir() => Ok(path),
        Ok(_) => Err(SetupSafeErrorCode::InstallTargetInvalid),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(path),
        Err(_) => Err(SetupSafeErrorCode::InstallTargetInvalid),
    }
}

#[cfg(windows)]
fn read_registry_install_environment(
    root: &winreg::RegKey,
    subkey: &str,
) -> Result<InstallEnvironment, SetupSafeErrorCode> {
    use winreg::enums::{REG_EXPAND_SZ, REG_SZ};

    let key = match root.open_subkey(subkey) {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(_) => return Err(SetupSafeErrorCode::InstallTargetInvalid),
    };
    let mut values = BTreeMap::new();
    for value in key.enum_values() {
        let (name, raw) = value.map_err(|_| SetupSafeErrorCode::InstallTargetInvalid)?;
        let is_install_dir = name.eq_ignore_ascii_case("CODEX_INSTALL_DIR");
        if !matches!(raw.vtype, REG_SZ | REG_EXPAND_SZ) {
            if is_install_dir {
                return Err(SetupSafeErrorCode::InstallTargetInvalid);
            }
            continue;
        }
        match key.get_value::<OsString, _>(&name) {
            Ok(text) => {
                values.insert(name.to_ascii_uppercase(), text);
            }
            Err(_) if is_install_dir => {
                return Err(SetupSafeErrorCode::InstallTargetInvalid);
            }
            Err(_) => {}
        }
    }
    Ok(values)
}

#[cfg(windows)]
fn registry_codex_install_environments() -> Result<RegistryInstallEnvironments, SetupSafeErrorCode>
{
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    let user =
        read_registry_install_environment(&RegKey::predef(HKEY_CURRENT_USER), "Environment")?;
    let machine = read_registry_install_environment(
        &RegKey::predef(HKEY_LOCAL_MACHINE),
        "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    )?;
    Ok((user, machine))
}

#[cfg(not(windows))]
fn registry_codex_install_environments() -> Result<RegistryInstallEnvironments, SetupSafeErrorCode>
{
    Ok((BTreeMap::new(), BTreeMap::new()))
}

fn resolved_codex_install_target_from(
    process: &InstallEnvironment,
    user: &InstallEnvironment,
    machine: &InstallEnvironment,
) -> Result<(PathBuf, Option<PathBuf>), SetupSafeErrorCode> {
    let effective = effective_install_environment(process, user, machine);
    let custom = process
        .get("CODEX_INSTALL_DIR")
        .or_else(|| user.get("CODEX_INSTALL_DIR"))
        .or_else(|| machine.get("CODEX_INSTALL_DIR"));
    if let Some(raw) = custom {
        let custom = validate_install_directory(expand_install_environment_path(raw, &effective)?)?;
        return Ok((custom.clone(), Some(custom)));
    }
    let local_app_data = effective
        .get("LOCALAPPDATA")
        .ok_or(SetupSafeErrorCode::InstallSpawnFailed)?;
    let local_app_data =
        validate_install_directory(expand_install_environment_path(local_app_data, &effective)?)?;
    Ok((local_app_data.join("Programs/OpenAI/Codex/bin"), None))
}

fn resolved_codex_install_target() -> Result<(PathBuf, Option<PathBuf>), SetupSafeErrorCode> {
    // Read both registry hives when install is requested so newly published environment values
    // participate in expansion. Explicit process values retain Windows' normal precedence.
    let process = normalized_install_environment(std::env::vars_os());
    let (user, machine) = registry_codex_install_environments()?;
    resolved_codex_install_target_from(&process, &user, &machine)
}

fn spawn_codex_installer(
    custom_install_dir: Option<&Path>,
) -> std::io::Result<(Child, ProcessTree)> {
    let script = format!(
        "$ErrorActionPreference='Stop'; Invoke-RestMethod '{}' | Invoke-Expression",
        CODEX_INSTALL_SCRIPT_URL
    );
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "ByPass",
        "-Command",
        &script,
    ]);
    command.env_remove("CODEX_NON_INTERACTIVE");
    if let Some(custom_install_dir) = custom_install_dir {
        command.env("CODEX_INSTALL_DIR", custom_install_dir);
    } else {
        command.env_remove("CODEX_INSTALL_DIR");
    }
    spawn_in_process_tree(command, ChildWindow::Visible, JobLifetime::DetachOnDrop)
}

fn spawn_codex_login(
    selected: &SelectedCodex,
    device_auth: bool,
) -> std::io::Result<(Child, ProcessTree)> {
    let command = selected_login_command(selected, device_auth)?;
    if !selected.identity_unchanged() {
        return Err(std::io::Error::other(
            "selected Codex file identity changed",
        ));
    }
    spawn_in_process_tree(command, ChildWindow::Visible, JobLifetime::DetachOnDrop)
}

fn manual_paths(app: &AppHandle) -> Vec<PathBuf> {
    app.state::<RuntimeState>()
        .codex_manual_path
        .lock()
        .expect("Codex manual path lock")
        .clone()
        .into_iter()
        .collect()
}

fn compatible_codex_candidate_at(app: &AppHandle, path: &Path) -> bool {
    probe_candidates(discover_codex_candidates_with_manual(manual_paths(app)))
        .candidates
        .iter()
        .any(|candidate| {
            candidate.is_compatible() && same_windows_path(candidate.command.path(), path)
        })
}

#[tauri::command]
fn start_codex_install(app: AppHandle) -> Result<InstallOperationDto, String> {
    let (target, custom_install_dir) = resolved_codex_install_target().map_err(safe_setup_error)?;
    let before = capture_install_evidence(&target);
    let operation = app
        .state::<RuntimeState>()
        .codex_operations
        .begin_install()
        .map_err(safe_setup_error)?;
    let initial = app
        .state::<RuntimeState>()
        .codex_operations
        .install_snapshot();
    let worker_app = app.clone();
    // Persist the detached diagnostic before dispatch so an immediate app crash cannot leave an
    // active operation with no marker. The guard is moved to the worker and clears on every exit.
    let operation_marker = CodexOperationMarkerGuard::begin(OperationKind::Install);
    thread::spawn(move || {
        let _operation_marker = operation_marker;
        let manager = &worker_app.state::<RuntimeState>().codex_operations;
        let (mut child, process_tree) = match spawn_codex_installer(custom_install_dir.as_deref()) {
            Ok(spawned) => spawned,
            Err(_) => {
                manager.mark_install(
                    &operation.operation_id,
                    InstallOperationState::Failed,
                    Some(SetupSafeErrorCode::InstallSpawnFailed),
                );
                return;
            }
        };
        manager.mark_install(
            &operation.operation_id,
            InstallOperationState::Running,
            None,
        );
        let outcome =
            wait_for_tracked_child(&mut child, &process_tree, &operation.cancellation, || {
                manager.mark_install(
                    &operation.operation_id,
                    InstallOperationState::LongRunning,
                    None,
                );
            });
        let outcome = linearize_tracked_child_outcome(
            manager,
            OperationKind::Install,
            &operation.operation_id,
            outcome,
            &mut child,
            &process_tree,
        );
        // No KILL_ON_JOB_CLOSE: normal app/worker exit detaches provider helpers. Only the explicit
        // cancel path above or a cancellation that wins at the exit boundary terminates the Job.
        drop(process_tree);
        let status = match outcome {
            TrackedChildOutcome::Cancelled => {
                manager.mark_install(
                    &operation.operation_id,
                    InstallOperationState::Cancelled,
                    Some(SetupSafeErrorCode::InstallCancelled),
                );
                return;
            }
            TrackedChildOutcome::TrackingFailed => {
                manager.mark_install(
                    &operation.operation_id,
                    InstallOperationState::Failed,
                    Some(SetupSafeErrorCode::UnknownSetupError),
                );
                return;
            }
            TrackedChildOutcome::Exited(status) => status,
        };

        let after = capture_install_evidence(&target);
        if let Some(delta_path) = single_install_delta(&before, &after)
            && compatible_codex_candidate_at(&worker_app, &delta_path)
        {
            let state = worker_app.state::<RuntimeState>();
            *state
                .codex_tracked_install_path
                .lock()
                .expect("Codex tracked install path lock") = Some(delta_path.clone());
            *state
                .codex_preferred_path
                .lock()
                .expect("Codex preferred path lock") = Some(delta_path.clone());
            persist_codex_selection(&worker_app, &delta_path);
        }
        let resolution = resolve_codex_setup(&worker_app);
        let valid =
            resolution.dto.cli_state == CodexCliState::Ready && resolution.selected.is_some();
        match (status.success(), valid) {
            (true, true) => manager.mark_install(
                &operation.operation_id,
                InstallOperationState::Succeeded,
                None,
            ),
            (false, true) => manager.mark_install(
                &operation.operation_id,
                InstallOperationState::Succeeded,
                Some(SetupSafeErrorCode::InstallExitNonzero),
            ),
            (true, false) => manager.mark_install(
                &operation.operation_id,
                InstallOperationState::Failed,
                Some(SetupSafeErrorCode::InstallNoValidCli),
            ),
            (false, false) => manager.mark_install(
                &operation.operation_id,
                InstallOperationState::Failed,
                Some(SetupSafeErrorCode::InstallExitNonzero),
            ),
        }
    });
    Ok(initial)
}

#[tauri::command]
fn start_codex_login(app: AppHandle, device_auth: bool) -> Result<LoginOperationDto, String> {
    let resolution = resolve_codex_setup(&app);
    if resolution.dto.cli_state != CodexCliState::Ready {
        return Err(safe_setup_error(
            resolution
                .dto
                .safe_error_code
                .unwrap_or(SetupSafeErrorCode::CodexNotFound),
        ));
    }
    if device_auth && !resolution.device_auth_supported {
        return Err(safe_setup_error(SetupSafeErrorCode::CandidateUnsupported));
    }
    let selected = resolution
        .selected
        .ok_or_else(|| safe_setup_error(SetupSafeErrorCode::CodexNotFound))?;
    let operation = app
        .state::<RuntimeState>()
        .codex_operations
        .begin_login()
        .map_err(safe_setup_error)?;
    let initial = app
        .state::<RuntimeState>()
        .codex_operations
        .login_snapshot();
    let worker_app = app.clone();
    let operation_marker = CodexOperationMarkerGuard::begin(OperationKind::Login);
    thread::spawn(move || {
        let _operation_marker = operation_marker;
        let manager = &worker_app.state::<RuntimeState>().codex_operations;
        let (mut child, process_tree) = match spawn_codex_login(&selected, device_auth) {
            Ok(spawned) => spawned,
            Err(_) => {
                manager.mark_login(
                    &operation.operation_id,
                    LoginOperationState::Failed,
                    Some(SetupSafeErrorCode::LoginSpawnFailed),
                );
                return;
            }
        };
        manager.mark_login(&operation.operation_id, LoginOperationState::Running, None);
        let outcome =
            wait_for_tracked_child(&mut child, &process_tree, &operation.cancellation, || {
                manager.mark_login(
                    &operation.operation_id,
                    LoginOperationState::LongRunning,
                    None,
                );
            });
        let outcome = linearize_tracked_child_outcome(
            manager,
            OperationKind::Login,
            &operation.operation_id,
            outcome,
            &mut child,
            &process_tree,
        );
        drop(process_tree);
        match outcome {
            TrackedChildOutcome::Cancelled => {
                manager.mark_login(
                    &operation.operation_id,
                    LoginOperationState::Cancelled,
                    Some(SetupSafeErrorCode::LoginCancelled),
                );
            }
            TrackedChildOutcome::TrackingFailed => {
                manager.mark_login(
                    &operation.operation_id,
                    LoginOperationState::Failed,
                    Some(SetupSafeErrorCode::UnknownSetupError),
                );
            }
            TrackedChildOutcome::Exited(_) => {
                worker_app
                    .state::<RuntimeState>()
                    .provider_auth
                    .lock()
                    .expect("provider auth state lock")
                    .codex = Some(CodexAuthState::Checking);
                let (auth_state, login_candidate_unchanged) = if selected.identity_unchanged() {
                    // 로그인에 실제 사용한 동일 후보로만 결과를 확인한다. probe 자체도 실행
                    // 직전에 identity를 다시 검사하므로 이 사이 교체는 auth error로 닫힌다.
                    let auth = probe_auth(Some(&selected));
                    worker_app
                        .state::<RuntimeState>()
                        .provider_auth
                        .lock()
                        .expect("provider auth state lock")
                        .codex = Some(auth.state);
                    (auth.state, true)
                } else {
                    // 로그인 도중 CLI가 교체·삭제됐으면 A의 성공으로 귀속하지 않는다. 전체
                    // discovery로 현재 사실 상태만 재구성하고 login은 확인 실패로 남긴다.
                    let resolution = resolve_codex_setup(&worker_app);
                    (resolution.dto.auth.state, false)
                };
                let cancelled = cancellation_requested(&operation.cancellation);
                let operation_state = if cancelled {
                    LoginOperationState::Cancelled
                } else {
                    LoginOperationState::Exited
                };
                let safe_error = if cancelled {
                    Some(SetupSafeErrorCode::LoginCancelled)
                } else {
                    (!login_candidate_unchanged || auth_state != CodexAuthState::Authenticated)
                        .then_some(SetupSafeErrorCode::LoginUnconfirmed)
                };
                manager.mark_login(&operation.operation_id, operation_state, safe_error);
            }
        }
    });
    Ok(initial)
}

#[tauri::command]
fn cancel_codex_operation(app: AppHandle, kind: String) -> Result<Value, String> {
    let kind = match kind.as_str() {
        "install" => OperationKind::Install,
        "login" => OperationKind::Login,
        _ => return Err(safe_setup_error(SetupSafeErrorCode::UnknownSetupError)),
    };
    let state = app.state::<RuntimeState>();
    if !state.codex_operations.cancel(kind) {
        return Err(safe_setup_error(SetupSafeErrorCode::UnknownSetupError));
    }
    Ok(match kind {
        OperationKind::Install => json!(state.codex_operations.install_snapshot()),
        OperationKind::Login => json!(state.codex_operations.login_snapshot()),
    })
}

#[tauri::command]
fn select_codex_candidate(app: AppHandle, candidate_id: String) -> Result<Value, String> {
    let Some((namespace, ordinal)) = candidate_id
        .strip_prefix("candidate-")
        .and_then(|suffix| suffix.rsplit_once('-'))
    else {
        return Err(safe_setup_error(SetupSafeErrorCode::CandidateConflict));
    };
    if namespace.len() != 32
        || !namespace.bytes().all(|byte| byte.is_ascii_hexdigit())
        || ordinal.is_empty()
        || !ordinal.bytes().all(|byte| byte.is_ascii_digit())
        || ordinal.starts_with('0')
    {
        return Err(safe_setup_error(SetupSafeErrorCode::CandidateConflict));
    }
    let candidate = app
        .state::<RuntimeState>()
        .codex_candidate_paths
        .lock()
        .expect("Codex candidate path map lock")
        .get(&candidate_id)
        .cloned()
        .ok_or_else(|| safe_setup_error(SetupSafeErrorCode::CandidateConflict))?;
    if !compatible_codex_candidate_at(&app, &candidate.path) {
        return Err(safe_setup_error(SetupSafeErrorCode::CandidateNotExecutable));
    }
    if candidate.persistable {
        persist_codex_selection(&app, &candidate.path);
    }
    *app.state::<RuntimeState>()
        .codex_preferred_path
        .lock()
        .expect("Codex preferred path lock") = Some(candidate.path);
    Ok(setup_snapshot_value(&app))
}

#[cfg(windows)]
fn choose_manual_codex_path() -> Result<Option<PathBuf>, SetupSafeErrorCode> {
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Select Codex CLI'
$dialog.Filter = 'Codex CLI|codex.exe;codex.cmd;codex.bat;codex|All files|*.*'
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::Out.Write($dialog.FileName)
}
"#;
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoLogo", "-NoProfile", "-Sta", "-Command", script])
        .stdin(Stdio::null())
        .stderr(Stdio::null());
    configure_hidden_console(&mut command);
    let output = command
        .output()
        .map_err(|_| SetupSafeErrorCode::CandidateNotExecutable)?;
    if !output.status.success() || output.stdout.len() > 32 * 1024 {
        return Err(SetupSafeErrorCode::CandidateNotExecutable);
    }
    if output.stdout.is_empty() {
        return Ok(None);
    }
    let text =
        String::from_utf8(output.stdout).map_err(|_| SetupSafeErrorCode::CandidateNotExecutable)?;
    if text.contains(['\r', '\n']) {
        return Err(SetupSafeErrorCode::CandidateNotExecutable);
    }
    let path = PathBuf::from(text);
    if !path.is_absolute() || !path.is_file() {
        return Err(SetupSafeErrorCode::CandidateNotExecutable);
    }
    std::fs::canonicalize(path)
        .map(Some)
        .map_err(|_| SetupSafeErrorCode::CandidateNotExecutable)
}

#[cfg(not(windows))]
fn choose_manual_codex_path() -> Result<Option<PathBuf>, SetupSafeErrorCode> {
    Err(SetupSafeErrorCode::CandidateNotExecutable)
}

#[tauri::command]
async fn browse_codex_candidate(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = choose_manual_codex_path().map_err(safe_setup_error)? else {
            return Ok(setup_snapshot_value(&app));
        };
        {
            let state = app.state::<RuntimeState>();
            *state
                .codex_manual_path
                .lock()
                .expect("Codex manual path lock") = Some(path.clone());
        }
        if !compatible_codex_candidate_at(&app, &path) {
            *app.state::<RuntimeState>()
                .codex_manual_path
                .lock()
                .expect("Codex manual path lock") = None;
            return Err(safe_setup_error(SetupSafeErrorCode::CandidateNotExecutable));
        }
        *app.state::<RuntimeState>()
            .codex_preferred_path
            .lock()
            .expect("Codex preferred path lock") = Some(path);
        let snapshot = setup_snapshot_value(&app);
        let persistable_path = app
            .state::<RuntimeState>()
            .codex_candidate_paths
            .lock()
            .expect("Codex candidate path map lock")
            .values()
            .find(|candidate| {
                candidate.persistable
                    && app
                        .state::<RuntimeState>()
                        .codex_manual_path
                        .lock()
                        .expect("Codex manual path lock")
                        .as_deref()
                        .is_some_and(|manual| same_windows_path(&candidate.path, manual))
            })
            .map(|candidate| candidate.path.clone());
        if let Some(path) = persistable_path {
            persist_codex_selection(&app, &path);
        }
        Ok(snapshot)
    })
    .await
    .map_err(|_| safe_setup_error(SetupSafeErrorCode::UnknownSetupError))?
}

#[tauri::command]
fn install_claude_hook(force: bool) -> Result<Value, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    hook::install_hook(&executable, force)
}

#[tauri::command]
fn open_login_terminal(provider: String) -> Result<Value, String> {
    let (executable, arguments, display_command) = match provider.as_str() {
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

/// 이 앱의 표시에서만 공급자를 빼거나 되돌린다. CLI 로그아웃은 하지 않는다.
#[tauri::command]
fn set_provider_hidden(provider: String, hidden: bool) -> Result<Vec<String>, String> {
    update_hidden_provider(&provider, hidden)
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let compact = MenuItem::with_id(app, "compact", "사용량 요약", true, None::<&str>)?;
    let insights = MenuItem::with_id(app, "insights", "사용량 인사이트", true, None::<&str>)?;
    let details = MenuItem::with_id(app, "details", "토큰 상세", true, None::<&str>)?;
    let setup = MenuItem::with_id(app, "setup", "설정", true, None::<&str>)?;
    let check_update = MenuItem::with_id(
        app,
        "check_update",
        update::tray_menu_text(app.handle()),
        true,
        None::<&str>,
    )?;
    let _ = UPDATE_MENU_ITEM.set(check_update.clone());
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "종료", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &compact,
            &insights,
            &details,
            &setup,
            &check_update,
            &separator,
            &quit,
        ],
    )?;
    let mut builder = TrayIconBuilder::new()
        .tooltip("Codex, Claude Usage")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quit" => app.exit(0),
            "check_update" => start_tray_update_check(app.clone()),
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
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let label = if onboarding_complete() {
                "compact"
            } else {
                "setup"
            };
            show_window_on_worker(app.clone(), label.to_string());
        }))
        .manage(RuntimeState::default())
        .manage(update::UpdateRuntime::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            build_tray(app)?;
            start_activity_monitor(app.handle().clone());
            start_update_monitor(app.handle().clone());
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
                if window.label() == "update" {
                    if update::installation_in_progress(window.app_handle()) {
                        return;
                    }
                    update::postpone_pending_on_close(window.app_handle());
                }
                let _ = window.destroy();
            }
        })
        .invoke_handler(tauri::generate_handler![
            snapshot,
            refresh_snapshot,
            setup_snapshot,
            codex_operation_snapshot,
            refresh_setup_snapshot,
            complete_onboarding,
            set_activity_monitoring,
            set_always_on_top,
            set_opacity,
            minimize_window,
            close_window,
            show_window,
            check_for_update,
            get_update_state,
            postpone_update,
            install_update,
            install_claude_hook,
            start_codex_install,
            start_codex_login,
            cancel_codex_operation,
            select_codex_candidate,
            browse_codex_candidate,
            open_login_terminal,
            open_install_terminal,
            open_official_guide,
            set_launch_at_login,
            set_provider_hidden,
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
    fn secondary_windows_fit_inside_the_logical_work_area() {
        assert_eq!(
            fitted_window_metrics((820.0, 1000.0), (360.0, 480.0), (1366.0, 728.0)),
            WindowMetrics {
                width: 820.0,
                height: 664.0,
                min_width: 360.0,
                min_height: 480.0,
            }
        );
        assert_eq!(
            fitted_window_metrics((520.0, 440.0), (340.0, 360.0), (320.0, 240.0)),
            WindowMetrics {
                width: 272.0,
                height: 176.0,
                min_width: 272.0,
                min_height: 176.0,
            }
        );
    }

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
        assert_eq!(
            automatic_refresh_decision(false, true, false),
            (true, false)
        );
        assert_eq!(automatic_refresh_decision(true, false, true), (false, true));
    }

    #[test]
    fn notification_payload_includes_limit_reason_and_token_spike() {
        let report = json!({
            "alerts": [
                {
                    "provider": "codex",
                    "limitType": "five_hour",
                    "remainingPercent": 22,
                    "reason": "forecast_before_reset",
                    "severity": "warning",
                    "resetAt": "2026-07-19T09:00:00Z"
                },
                {
                    "provider": "claude",
                    "limitType": "five_hour",
                    "remainingPercent": 0,
                    "reason": "limit_exhausted",
                    "severity": "critical",
                    "resetAt": "2026-07-19T10:00:00Z"
                }
            ],
            "anomalies": {
                "codex": {"detected": true, "date": "2026-07-19", "multiplier": 2.4},
                "claude": {"detected": false}
            }
        });
        let (signature, body) = notification_payload(&report).expect("notification payload");
        assert!(signature.contains("forecast_before_reset"));
        assert!(!signature.contains("multiplier"));
        assert!(body.contains("Codex 5시간: 22% 남음 · 리셋 전 고갈 예상"));
        assert!(body.contains("Claude 5시간: 0% 남음 · 한도 소진"));
        assert!(body.contains("Codex 오늘 토큰 2.4배 급증"));
    }

    #[test]
    fn notification_payload_supports_anomaly_only_and_healthy_reports() {
        let anomaly = json!({
            "alerts": [],
            "anomalies": {
                "codex": {"detected": false},
                "claude": {"detected": true, "date": "2026-07-19", "multiplier": 1.9}
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

        let mut signature = String::new();
        assert!(update_notification_signature(&mut signature, Some("risk")));
        assert!(!update_notification_signature(&mut signature, Some("risk")));
        assert!(update_notification_signature(&mut signature, None));
        assert!(signature.is_empty());
        assert!(update_notification_signature(&mut signature, Some("risk")));

        let low_confidence_forecast = json!({
            "alerts": [{
                "provider": "codex",
                "limitType": "five_hour",
                "remainingPercent": 40,
                "reason": "forecast_before_reset",
                "confidence": "low"
            }],
            "anomalies": {
                "codex": {"detected": false},
                "claude": {"detected": false}
            }
        });
        assert!(notification_payload(&low_confidence_forecast).is_none());
    }

    #[test]
    fn notification_signature_tracks_an_episode_not_live_measurements() {
        let report = |remaining, multiplier| {
            json!({
                "alerts": [{
                    "provider": "codex",
                    "limitType": "five_hour",
                    "remainingPercent": remaining,
                    "reason": "threshold_warning",
                    "severity": "warning",
                    "resetAt": "2026-07-19T09:00:00Z"
                }],
                "anomalies": {
                    "codex": {"detected": true, "date": "2026-07-19", "multiplier": multiplier},
                    "claude": {"detected": false}
                }
            })
        };
        let first = notification_payload(&report(24, 2.0))
            .expect("first episode")
            .0;
        let updated = notification_payload(&report(19, 2.7))
            .expect("updated episode")
            .0;
        assert_eq!(first, updated);

        let next_cycle = json!({
            "alerts": [{
                "provider": "codex",
                "limitType": "five_hour",
                "remainingPercent": 24,
                "reason": "threshold_warning",
                "severity": "warning",
                "resetAt": "2026-07-20T09:00:00Z"
            }],
            "anomalies": {
                "codex": {"detected": true, "date": "2026-07-20", "multiplier": 2.0},
                "claude": {"detected": false}
            }
        });
        assert_ne!(
            first,
            notification_payload(&next_cycle).expect("next episode").0
        );
    }

    #[test]
    fn codex_path_identity_and_selection_fingerprint_are_privacy_safe() {
        let left = Path::new(r"\\?\C:\Users\Private\Codex\codex.exe");
        let right = Path::new(r"c:/users/private/codex/codex.exe");
        assert!(same_windows_path(left, right));
        let first = codex_path_fingerprint("salt-a", left);
        let same = codex_path_fingerprint("salt-a", right);
        let other_install = codex_path_fingerprint("salt-b", right);
        assert_eq!(first, same);
        assert_ne!(first, other_install);
        assert!(valid_sha256_text(&first));
        assert!(!first.contains("Private"));
        assert!(!first.contains("codex.exe"));
    }

    #[test]
    fn tracked_operations_only_become_long_running_at_ten_minutes() {
        let started = Instant::now();
        assert!(!operation_is_long_running(
            started,
            started + CODEX_OPERATION_LONG_RUNNING_AFTER - Duration::from_millis(1)
        ));
        assert!(operation_is_long_running(
            started,
            started + CODEX_OPERATION_LONG_RUNNING_AFTER
        ));
    }

    #[test]
    fn operation_cancel_is_not_confirmed_when_tree_cleanup_fails() {
        assert!(matches!(
            tracked_cancel_outcome(true),
            TrackedChildOutcome::Cancelled
        ));
        assert!(matches!(
            tracked_cancel_outcome(false),
            TrackedChildOutcome::TrackingFailed
        ));
    }

    #[test]
    fn setup_command_errors_serialize_as_safe_codes_only() {
        assert_eq!(
            safe_setup_error(SetupSafeErrorCode::LoginUnconfirmed),
            "login_unconfirmed"
        );
        assert!(!safe_setup_error(SetupSafeErrorCode::CandidateNotExecutable).contains('\\'));
        assert_eq!(
            safe_setup_error(SetupSafeErrorCode::InstallTargetInvalid),
            "install_target_invalid"
        );
    }

    fn install_environment(values: &[(&str, OsString)]) -> BTreeMap<String, OsString> {
        values
            .iter()
            .map(|(name, value)| (name.to_ascii_uppercase(), value.clone()))
            .collect()
    }

    #[test]
    fn install_target_uses_fresh_registry_values_for_nested_expansion() {
        let root = std::env::temp_dir().join(format!(
            "ai-usage-monitor-install-target-{}",
            uuid::Uuid::new_v4()
        ));
        let expanded = root.join("Codex Bin");
        let nested = format!("%CUSTOM_ROOT%{}Codex Bin", std::path::MAIN_SEPARATOR);
        let user = install_environment(&[
            ("CUSTOM_ROOT", root.as_os_str().to_owned()),
            ("CODEX_INSTALL_DIR", nested.into()),
        ]);

        let resolved =
            resolved_codex_install_target_from(&BTreeMap::new(), &user, &BTreeMap::new())
                .expect("fresh registry variables expand");

        assert_eq!(resolved, (expanded.clone(), Some(expanded)));
    }

    #[test]
    fn valid_absolute_process_custom_target_is_preserved() {
        let custom = std::env::temp_dir();
        let process = install_environment(&[("CODEX_INSTALL_DIR", custom.as_os_str().to_owned())]);

        assert_eq!(
            resolved_codex_install_target_from(&process, &BTreeMap::new(), &BTreeMap::new()),
            Ok((custom.clone(), Some(custom)))
        );
    }

    #[test]
    fn invalid_explicit_install_target_never_falls_back() {
        let default_root = std::env::temp_dir();
        let valid_machine_target = default_root.join("machine-codex-bin");
        let process = install_environment(&[("LOCALAPPDATA", default_root.as_os_str().to_owned())]);
        let machine = install_environment(&[(
            "CODEX_INSTALL_DIR",
            valid_machine_target.as_os_str().to_owned(),
        )]);

        for invalid in [
            OsString::from(r"%UNRESOLVED_INSTALL_ROOT%\Codex"),
            OsString::from(r"%CODEX_INSTALL_DIR%"),
            OsString::from("relative-codex-bin"),
            OsString::new(),
        ] {
            let user = install_environment(&[("CODEX_INSTALL_DIR", invalid)]);
            assert_eq!(
                resolved_codex_install_target_from(&process, &user, &machine),
                Err(SetupSafeErrorCode::InstallTargetInvalid)
            );
        }
    }

    #[test]
    fn existing_file_is_not_accepted_as_an_install_directory() {
        let file = std::env::temp_dir().join(format!(
            "ai-usage-monitor-install-target-file-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&file, b"not a directory").expect("file-valued target fixture");
        let user = install_environment(&[("CODEX_INSTALL_DIR", file.as_os_str().to_owned())]);

        assert_eq!(
            resolved_codex_install_target_from(&BTreeMap::new(), &user, &BTreeMap::new()),
            Err(SetupSafeErrorCode::InstallTargetInvalid)
        );

        std::fs::remove_file(file).expect("file-valued target fixture cleanup");
    }

    #[test]
    fn default_install_target_is_preserved_without_an_explicit_custom_value() {
        let local_app_data = std::env::temp_dir();
        let process =
            install_environment(&[("LOCALAPPDATA", local_app_data.as_os_str().to_owned())]);

        assert_eq!(
            resolved_codex_install_target_from(&process, &BTreeMap::new(), &BTreeMap::new()),
            Ok((local_app_data.join("Programs/OpenAI/Codex/bin"), None))
        );
    }

    #[test]
    fn failed_codex_capture_cannot_leave_a_connected_or_raw_error_snapshot() {
        let previous = json!({
            "schema_version": 1,
            "captured_at": "2026-07-30T10:00:00+09:00",
            "source": "codex_app_server",
            "capture_method": "codex_app_server",
            "parse_status": "ok",
            "limits": [{
                "type": "five_hour",
                "used_percent": 25,
                "remaining_percent": 75,
                "reset_text": "resets 07/30 15:00",
                "resets_at": 1785381600,
                "window_duration_mins": 300,
                "private_path": r"C:\Users\private-user\codex.exe"
            }],
            "raw_status_text": r"C:\Users\private-user\codex.exe",
            "rate_limit_reset_credits": 12,
            "spend_control_reached": false,
            "stderr": "private token"
        });
        let status = failed_codex_capture_status(CodexCaptureError::Timeout, Some(&previous));
        assert_eq!(status["parse_status"], "failed");
        assert_eq!(status["safe_error_code"], "usage_capture_timeout");
        assert!(status["capture"].get("failure_kind").is_none());
        assert_eq!(status["raw_status_text"], "");
        assert!(status["limits"].as_array().is_some_and(Vec::is_empty));
        assert_eq!(status["last_success"]["parse_status"], "ok");
        assert_eq!(status["last_success"]["limits"][0]["remaining_percent"], 75);
        assert_eq!(status["last_success"]["rate_limit_reset_credits"], 12);
        assert_eq!(status["last_success"]["spend_control_reached"], false);
        let serialized = status.to_string().to_ascii_lowercase();
        assert!(!serialized.contains("stdout"));
        assert!(!serialized.contains("stderr"));
        assert!(!serialized.contains(r"c:\\users"));
        assert!(!serialized.contains("private token"));

        let repeated = failed_codex_capture_status(CodexCaptureError::Protocol, Some(&status));
        assert_eq!(repeated["safe_error_code"], "usage_capture_failed");
        assert_eq!(repeated["last_success"], status["last_success"]);
        assert!(!repeated.to_string().contains("private-user"));
    }

    #[test]
    fn capture_auth_reprobe_only_maps_confirmed_unauthenticated_to_login_unconfirmed() {
        assert_eq!(
            capture_error_after_auth_probe(
                CodexCaptureError::Timeout,
                CodexAuthState::Unauthenticated
            ),
            CodexCaptureError::AuthenticationUnconfirmed
        );
        assert_eq!(
            capture_error_after_auth_probe(
                CodexCaptureError::Timeout,
                CodexAuthState::Authenticated
            ),
            CodexCaptureError::Timeout
        );
        assert_eq!(
            capture_error_after_auth_probe(
                CodexCaptureError::CapabilityMissing,
                CodexAuthState::Unauthenticated
            ),
            CodexCaptureError::CapabilityMissing
        );
    }
}
