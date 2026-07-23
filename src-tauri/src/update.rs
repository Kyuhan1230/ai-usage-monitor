use crate::storage::{data_dir, read_json, write_json};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

pub const AUTO_CHECK_DELAY_SECONDS: u64 = 15;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const MINUTE_MS: i64 = 60 * 1000;
const HOUR_MS: i64 = 60 * MINUTE_MS;
const DEFAULT_NOTES: &str = "안정성과 사용 경험을 개선한 새 버전입니다.";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PersistedUpdateState {
    pub schema_version: u8,
    pub last_successful_check_at: Option<String>,
    pub last_successful_check_app_version: Option<String>,
    pub last_automatic_attempt_at: Option<String>,
    pub consecutive_automatic_failures: u8,
    pub last_check_error: Option<String>,
    pub available_version: Option<String>,
    pub last_notified_version: Option<String>,
    pub snooze_until: Option<String>,
}

impl Default for PersistedUpdateState {
    fn default() -> Self {
        Self {
            schema_version: 2,
            last_successful_check_at: None,
            last_successful_check_app_version: None,
            last_automatic_attempt_at: None,
            consecutive_automatic_failures: 0,
            last_check_error: None,
            available_version: None,
            last_notified_version: None,
            snooze_until: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    pub current_version: String,
    pub version: String,
    pub notes: String,
    pub published_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub status: String,
    pub manual: bool,
    pub current_version: String,
    pub available: Option<AvailableUpdate>,
    pub last_successful_check_at: Option<String>,
    pub should_notify: bool,
    pub should_open_window: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateViewState {
    pub current_version: String,
    pub available: Option<AvailableUpdate>,
    pub available_version: Option<String>,
    pub last_successful_check_at: Option<String>,
    pub last_check_error: Option<String>,
    pub last_notified_version: Option<String>,
    pub snooze_until: Option<String>,
    pub installing: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub event: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInstallResult {
    pub status: String,
    pub version: String,
}

#[derive(Default)]
pub struct UpdateRuntime {
    check_in_flight: AtomicBool,
    install_in_flight: AtomicBool,
    state_io: Mutex<()>,
    pending: Mutex<Option<AvailableUpdate>>,
}

struct AtomicFlagGuard<'a> {
    flag: &'a AtomicBool,
}

impl Drop for AtomicFlagGuard<'_> {
    fn drop(&mut self) {
        self.flag.store(false, Ordering::Release);
    }
}

fn acquire_flag(flag: &AtomicBool) -> Option<AtomicFlagGuard<'_>> {
    flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .ok()
        .map(|_| AtomicFlagGuard { flag })
}

fn state_path() -> PathBuf {
    data_dir().join("update-state.json")
}

fn read_state_at(path: &Path) -> PersistedUpdateState {
    read_json(path)
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn read_state() -> PersistedUpdateState {
    read_state_at(&state_path())
}

fn persist_state(state: &PersistedUpdateState) -> Result<(), String> {
    let mut state = state.clone();
    state.schema_version = 2;
    let value = serde_json::to_value(state).map_err(|error| error.to_string())?;
    write_json(&state_path(), &value)
}

fn timestamp_ms(value: Option<&str>) -> Option<i64> {
    value
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis())
}

fn automatic_retry_delay_ms(failures: u8) -> i64 {
    match failures {
        0 => 0,
        1 => 15 * MINUTE_MS,
        2 => HOUR_MS,
        _ => 6 * HOUR_MS,
    }
}

fn next_automatic_check_delay_ms(
    state: &PersistedUpdateState,
    current_version: &str,
    now_ms: i64,
) -> i64 {
    if state.consecutive_automatic_failures > 0 {
        let retry_delay = automatic_retry_delay_ms(state.consecutive_automatic_failures);
        if let Some(attempted_at) = timestamp_ms(state.last_automatic_attempt_at.as_deref()) {
            return (attempted_at.saturating_add(retry_delay) - now_ms).max(0);
        }
    }

    if state.last_successful_check_app_version.as_deref() != Some(current_version) {
        return 0;
    }

    timestamp_ms(state.last_successful_check_at.as_deref())
        .map(|checked_at| (checked_at.saturating_add(DAY_MS) - now_ms).max(0))
        .unwrap_or(0)
}

pub fn automatic_check_wait(app: &AppHandle) -> Duration {
    let runtime = app.state::<UpdateRuntime>();
    let _state_guard = runtime.state_io.lock().expect("update state I/O lock");
    let delay_ms = next_automatic_check_delay_ms(
        &read_state(),
        &current_version(app),
        chrono::Utc::now().timestamp_millis(),
    );
    Duration::from_millis(delay_ms as u64)
}

fn check_allowed(
    manual: bool,
    state: &PersistedUpdateState,
    current_version: &str,
    now_ms: i64,
) -> bool {
    manual || next_automatic_check_delay_ms(state, current_version, now_ms) == 0
}

fn should_notify_version(state: &PersistedUpdateState, version: &str) -> bool {
    state
        .last_notified_version
        .as_deref()
        .is_none_or(|notified| version_is_newer(version, notified))
}

#[derive(Debug, PartialEq)]
struct CheckEffects {
    should_notify: bool,
    should_open_window: bool,
}

fn available_check_effects(
    manual: bool,
    state: &PersistedUpdateState,
    version: &str,
) -> CheckEffects {
    CheckEffects {
        should_notify: !manual && should_notify_version(state, version),
        should_open_window: manual,
    }
}

fn version_is_newer(candidate: &str, previous: &str) -> bool {
    let candidate = candidate.strip_prefix('v').unwrap_or(candidate);
    let previous = previous.strip_prefix('v').unwrap_or(previous);
    match (
        semver::Version::parse(candidate),
        semver::Version::parse(previous),
    ) {
        (Ok(candidate), Ok(previous)) => candidate > previous,
        _ => false,
    }
}

fn effective_available_version(
    state: &PersistedUpdateState,
    current_version: &str,
) -> Option<String> {
    state
        .available_version
        .as_deref()
        .filter(|candidate| version_is_newer(candidate, current_version))
        .map(str::to_owned)
}

pub fn display_version(version: &str) -> &str {
    version.strip_prefix('v').unwrap_or(version)
}

fn tray_menu_text_for(state: &PersistedUpdateState, current_version: &str) -> String {
    effective_available_version(state, current_version)
        .map(|version| format!("v{} 업데이트 가능", display_version(&version)))
        .unwrap_or_else(|| "업데이트 확인".to_string())
}

pub fn tray_menu_text(app: &AppHandle) -> String {
    let runtime = app.state::<UpdateRuntime>();
    let _state_guard = runtime.state_io.lock().expect("update state I/O lock");
    tray_menu_text_for(&read_state(), &current_version(app))
}

fn sanitize_check_error(error: &str) -> String {
    error
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(300)
        .collect()
}

fn apply_check_failure(
    persisted: &mut PersistedUpdateState,
    manual: bool,
    now: chrono::DateTime<chrono::Utc>,
    error: &str,
) {
    persisted.last_check_error = Some(sanitize_check_error(error));
    if !manual {
        persisted.last_automatic_attempt_at = Some(now.to_rfc3339());
        persisted.consecutive_automatic_failures =
            persisted.consecutive_automatic_failures.saturating_add(1);
    }
}

fn record_check_failure(
    app: &AppHandle,
    manual: bool,
    now: chrono::DateTime<chrono::Utc>,
    error: &str,
) {
    let runtime = app.state::<UpdateRuntime>();
    let _state_guard = runtime.state_io.lock().expect("update state I/O lock");
    let mut persisted = read_state();
    apply_check_failure(&mut persisted, manual, now, error);
    let _ = persist_state(&persisted);
}

fn record_check_success(
    persisted: &mut PersistedUpdateState,
    manual: bool,
    now: chrono::DateTime<chrono::Utc>,
    current_version: &str,
) {
    persisted.last_successful_check_at = Some(now.to_rfc3339());
    persisted.last_successful_check_app_version = Some(current_version.to_string());
    if !manual {
        persisted.last_automatic_attempt_at = Some(now.to_rfc3339());
    }
    persisted.consecutive_automatic_failures = 0;
    persisted.last_check_error = None;
}

fn postpone_state(state: &mut PersistedUpdateState, version: &str, now_ms: i64) {
    state.last_notified_version = Some(version.to_string());
    state.snooze_until =
        chrono::DateTime::from_timestamp_millis(now_ms + DAY_MS).map(|value| value.to_rfc3339());
}

fn validate_expected_version(expected: &str, actual: &str) -> Result<(), String> {
    if expected == actual {
        Ok(())
    } else {
        Err(format!(
            "업데이트 버전이 확인 중 변경됐습니다. 예상 {expected}, 현재 {actual}"
        ))
    }
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

pub async fn check_for_update(app: AppHandle, manual: bool) -> Result<UpdateCheckResult, String> {
    let current_version = current_version(&app);
    let now = chrono::Utc::now();
    let now_ms = now.timestamp_millis();
    let runtime = app.state::<UpdateRuntime>();
    let persisted = {
        let _state_guard = runtime.state_io.lock().expect("update state I/O lock");
        read_state()
    };

    if !check_allowed(manual, &persisted, &current_version, now_ms) {
        return Ok(UpdateCheckResult {
            status: "skipped".into(),
            manual,
            current_version,
            available: None,
            last_successful_check_at: persisted.last_successful_check_at,
            should_notify: false,
            should_open_window: false,
        });
    }

    let Some(_guard) = acquire_flag(&runtime.check_in_flight) else {
        return Ok(UpdateCheckResult {
            status: "busy".into(),
            manual,
            current_version,
            available: None,
            last_successful_check_at: persisted.last_successful_check_at,
            should_notify: false,
            should_open_window: false,
        });
    };

    let update = match app.updater() {
        Ok(updater) => updater.check().await.map_err(|error| error.to_string()),
        Err(error) => Err(error.to_string()),
    };
    let update = match update {
        Ok(update) => update,
        Err(error) => {
            record_check_failure(&app, manual, chrono::Utc::now(), &error);
            return Err(error);
        }
    };

    // The network check can overlap with a user clicking "나중에". Re-read the
    // file before writing check results so that the newer user decision wins.
    let completed_at = chrono::Utc::now();
    let _state_guard = runtime.state_io.lock().expect("update state I/O lock");
    let mut persisted = read_state();
    record_check_success(&mut persisted, manual, completed_at, &current_version);

    let Some(update) = update else {
        *runtime.pending.lock().expect("pending update lock") = None;
        persisted.available_version = None;
        persist_state(&persisted)?;
        return Ok(UpdateCheckResult {
            status: "up_to_date".into(),
            manual,
            current_version,
            available: None,
            last_successful_check_at: persisted.last_successful_check_at,
            should_notify: false,
            should_open_window: false,
        });
    };

    let published_at = update
        .raw_json
        .get("pub_date")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let available = AvailableUpdate {
        current_version: update.current_version,
        version: update.version,
        notes: update
            .body
            .filter(|body| !body.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_NOTES.to_string()),
        published_at,
    };
    *runtime.pending.lock().expect("pending update lock") = Some(available.clone());
    persisted.available_version = Some(available.version.clone());

    let effects = available_check_effects(manual, &persisted, &available.version);
    if effects.should_notify || manual {
        if persisted.last_notified_version.as_deref() != Some(&available.version) {
            persisted.snooze_until = None;
        }
        persisted.last_notified_version = Some(available.version.clone());
    }
    persist_state(&persisted)?;

    Ok(UpdateCheckResult {
        status: "available".into(),
        manual,
        current_version,
        available: Some(available),
        last_successful_check_at: persisted.last_successful_check_at,
        should_notify: effects.should_notify,
        should_open_window: effects.should_open_window,
    })
}

pub fn installation_in_progress(app: &AppHandle) -> bool {
    app.state::<UpdateRuntime>()
        .install_in_flight
        .load(Ordering::Acquire)
}

pub fn view_state(app: &AppHandle) -> UpdateViewState {
    let runtime = app.state::<UpdateRuntime>();
    let _state_guard = runtime.state_io.lock().expect("update state I/O lock");
    let persisted = read_state();
    UpdateViewState {
        current_version: current_version(app),
        available: runtime.pending.lock().expect("pending update lock").clone(),
        available_version: effective_available_version(&persisted, &current_version(app)),
        last_successful_check_at: persisted.last_successful_check_at,
        last_check_error: persisted.last_check_error,
        last_notified_version: persisted.last_notified_version,
        snooze_until: persisted.snooze_until,
        installing: runtime.install_in_flight.load(Ordering::Acquire),
    }
}

pub fn postpone_update(app: &AppHandle, version: &str) -> Result<UpdateViewState, String> {
    let runtime = app.state::<UpdateRuntime>();
    let pending_version = runtime
        .pending
        .lock()
        .expect("pending update lock")
        .as_ref()
        .map(|update| update.version.clone());
    if pending_version.as_deref() != Some(version) {
        return Err("미뤄 둘 업데이트 버전이 현재 확인 결과와 다릅니다.".into());
    }
    {
        let _state_guard = runtime.state_io.lock().expect("update state I/O lock");
        let mut persisted = read_state();
        postpone_state(
            &mut persisted,
            version,
            chrono::Utc::now().timestamp_millis(),
        );
        persist_state(&persisted)?;
    }
    Ok(view_state(app))
}

pub fn postpone_pending_on_close(app: &AppHandle) {
    let runtime = app.state::<UpdateRuntime>();
    if runtime.install_in_flight.load(Ordering::Acquire) {
        return;
    }
    let version = runtime
        .pending
        .lock()
        .expect("pending update lock")
        .as_ref()
        .map(|update| update.version.clone());
    if let Some(version) = version {
        let _ = postpone_update(app, &version);
    }
}

pub async fn install_update(
    app: AppHandle,
    expected_version: String,
    on_progress: Channel<UpdateProgress>,
) -> Result<UpdateInstallResult, String> {
    let runtime = app.state::<UpdateRuntime>();
    let Some(_guard) = acquire_flag(&runtime.install_in_flight) else {
        return Err("업데이트 설치가 이미 진행 중입니다.".into());
    };
    let pending_version = runtime
        .pending
        .lock()
        .expect("pending update lock")
        .as_ref()
        .map(|update| update.version.clone());
    if pending_version.as_deref() != Some(expected_version.as_str()) {
        return Err("설치 요청 버전이 현재 표시된 업데이트와 다릅니다.".into());
    }

    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "설치 직전 다시 확인했지만 업데이트를 찾지 못했습니다.".to_string())?;
    validate_expected_version(&expected_version, &update.version)?;

    let _ = on_progress.send(UpdateProgress {
        event: "preparing".into(),
        downloaded_bytes: 0,
        total_bytes: None,
    });
    let progress_channel = on_progress.clone();
    let finish_channel = on_progress.clone();
    let mut downloaded_bytes = 0_u64;
    update
        .download_and_install(
            move |chunk_length, total_bytes| {
                downloaded_bytes = downloaded_bytes.saturating_add(chunk_length as u64);
                let _ = progress_channel.send(UpdateProgress {
                    event: "progress".into(),
                    downloaded_bytes,
                    total_bytes,
                });
            },
            move || {
                let _ = finish_channel.send(UpdateProgress {
                    event: "downloaded".into(),
                    downloaded_bytes: 0,
                    total_bytes: None,
                });
            },
        )
        .await
        .map_err(|error| error.to_string())?;

    let _ = on_progress.send(UpdateProgress {
        event: "installed".into(),
        downloaded_bytes: 0,
        total_bytes: None,
    });
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn automatic_checks_wait_for_the_daily_cooldown_but_manual_checks_do_not() {
        let now_ms = chrono::DateTime::parse_from_rfc3339("2026-07-21T12:00:00Z")
            .unwrap()
            .timestamp_millis();
        let state = PersistedUpdateState {
            last_successful_check_at: Some("2026-07-21T11:00:00Z".into()),
            last_successful_check_app_version: Some("1.2.2".into()),
            ..Default::default()
        };

        assert!(!check_allowed(false, &state, "1.2.2", now_ms));
        assert!(check_allowed(true, &state, "1.2.2", now_ms));
        assert_eq!(
            next_automatic_check_delay_ms(&state, "1.2.2", now_ms),
            23 * HOUR_MS
        );
    }

    #[test]
    fn a_new_app_version_bypasses_the_previous_success_cooldown() {
        let now_ms = chrono::DateTime::parse_from_rfc3339("2026-07-21T12:00:00Z")
            .unwrap()
            .timestamp_millis();
        let state = PersistedUpdateState {
            last_successful_check_at: Some("2026-07-21T11:00:00Z".into()),
            last_successful_check_app_version: Some("1.2.2".into()),
            ..Default::default()
        };

        assert_eq!(next_automatic_check_delay_ms(&state, "1.2.3", now_ms), 0);
    }

    #[test]
    fn a_failed_first_check_on_a_new_version_respects_backoff() {
        let now_ms = chrono::DateTime::parse_from_rfc3339("2026-07-21T12:05:00Z")
            .unwrap()
            .timestamp_millis();
        let state = PersistedUpdateState {
            last_successful_check_at: Some("2026-07-21T11:00:00Z".into()),
            last_successful_check_app_version: Some("1.2.2".into()),
            last_automatic_attempt_at: Some("2026-07-21T12:00:00Z".into()),
            consecutive_automatic_failures: 1,
            ..Default::default()
        };

        assert_eq!(
            next_automatic_check_delay_ms(&state, "1.2.3", now_ms),
            10 * MINUTE_MS
        );
    }

    #[test]
    fn automatic_failures_use_bounded_backoff() {
        assert_eq!(automatic_retry_delay_ms(1), 15 * MINUTE_MS);
        assert_eq!(automatic_retry_delay_ms(2), HOUR_MS);
        assert_eq!(automatic_retry_delay_ms(3), 6 * HOUR_MS);
        assert_eq!(automatic_retry_delay_ms(u8::MAX), 6 * HOUR_MS);
    }

    #[test]
    fn manual_failures_do_not_change_automatic_backoff() {
        let attempted_at = chrono::DateTime::parse_from_rfc3339("2026-07-21T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let mut state = PersistedUpdateState {
            last_automatic_attempt_at: Some("2026-07-21T11:00:00Z".into()),
            consecutive_automatic_failures: 2,
            ..Default::default()
        };

        apply_check_failure(&mut state, true, attempted_at, "manual failure");

        assert_eq!(state.consecutive_automatic_failures, 2);
        assert_eq!(
            state.last_automatic_attempt_at.as_deref(),
            Some("2026-07-21T11:00:00Z")
        );
        assert_eq!(state.last_check_error.as_deref(), Some("manual failure"));
    }

    #[test]
    fn successful_checks_preserve_a_concurrent_postpone_decision() {
        let completed_at = chrono::DateTime::parse_from_rfc3339("2026-07-21T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let mut state = PersistedUpdateState {
            last_notified_version: Some("1.2.3".into()),
            snooze_until: Some("2026-07-22T12:00:00Z".into()),
            ..Default::default()
        };

        record_check_success(&mut state, false, completed_at, "1.2.2");

        assert_eq!(state.last_notified_version.as_deref(), Some("1.2.3"));
        assert_eq!(state.snooze_until.as_deref(), Some("2026-07-22T12:00:00Z"));
    }

    #[test]
    fn automatic_available_checks_notify_once_without_opening_a_window() {
        let state = PersistedUpdateState {
            last_notified_version: Some("1.2.1".into()),
            ..Default::default()
        };

        assert_eq!(
            available_check_effects(false, &state, "1.2.1"),
            CheckEffects {
                should_notify: false,
                should_open_window: false,
            }
        );
        assert_eq!(
            available_check_effects(false, &state, "1.2.2"),
            CheckEffects {
                should_notify: true,
                should_open_window: false,
            }
        );
        assert_eq!(
            available_check_effects(false, &state, "v1.2.2"),
            CheckEffects {
                should_notify: true,
                should_open_window: false,
            }
        );
    }

    #[test]
    fn manual_available_checks_open_the_window_without_a_second_notification() {
        assert_eq!(
            available_check_effects(true, &PersistedUpdateState::default(), "1.2.3"),
            CheckEffects {
                should_notify: false,
                should_open_window: true,
            }
        );
    }

    #[test]
    fn update_checks_cannot_enter_twice() {
        let flag = AtomicBool::new(false);
        let first = acquire_flag(&flag).expect("first check acquires the guard");
        assert!(acquire_flag(&flag).is_none());
        drop(first);
        assert!(acquire_flag(&flag).is_some());
    }

    #[test]
    fn malformed_update_state_recovers_to_defaults() {
        let root = std::env::temp_dir().join(format!("update-state-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("update-state.json");
        fs::write(&path, "{not-json").unwrap();

        let state = read_state_at(&path);

        assert_eq!(state.schema_version, 2);
        assert!(state.last_successful_check_at.is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn version_one_update_state_keeps_existing_fields_and_defaults_new_ones() {
        let root = std::env::temp_dir().join(format!("update-state-v1-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("update-state.json");
        fs::write(
            &path,
            r#"{
                "schemaVersion": 1,
                "lastSuccessfulCheckAt": "2026-07-21T11:00:00Z",
                "lastNotifiedVersion": "1.2.2",
                "snoozeUntil": "2026-07-22T11:00:00Z"
            }"#,
        )
        .unwrap();

        let state = read_state_at(&path);

        assert_eq!(state.schema_version, 1);
        assert_eq!(
            state.last_successful_check_at.as_deref(),
            Some("2026-07-21T11:00:00Z")
        );
        assert!(state.last_successful_check_app_version.is_none());
        assert_eq!(state.consecutive_automatic_failures, 0);
        assert!(state.available_version.is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn persisted_available_version_must_be_newer_than_the_running_app() {
        let state = PersistedUpdateState {
            available_version: Some("1.2.3".into()),
            ..Default::default()
        };

        assert_eq!(
            effective_available_version(&state, "1.2.2").as_deref(),
            Some("1.2.3")
        );
        assert!(effective_available_version(&state, "1.2.3").is_none());
        assert!(effective_available_version(&state, "1.2.4").is_none());
        assert_eq!(tray_menu_text_for(&state, "1.2.2"), "v1.2.3 업데이트 가능");
        assert_eq!(tray_menu_text_for(&state, "1.2.3"), "업데이트 확인");

        let prefixed = PersistedUpdateState {
            available_version: Some("v1.2.3".into()),
            ..Default::default()
        };
        assert_eq!(
            tray_menu_text_for(&prefixed, "1.2.2"),
            "v1.2.3 업데이트 가능"
        );
    }

    #[test]
    fn persisted_check_errors_are_single_line_and_bounded() {
        let error = format!("network\n  failed {}", "x".repeat(400));
        let sanitized = sanitize_check_error(&error);

        assert!(!sanitized.contains('\n'));
        assert!(sanitized.chars().count() <= 300);
    }

    #[test]
    fn install_aborts_when_the_fresh_version_changed() {
        assert!(validate_expected_version("1.2.1", "1.2.1").is_ok());
        assert!(validate_expected_version("1.2.1", "1.2.2").is_err());
    }
}
