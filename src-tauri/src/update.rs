use crate::storage::{data_dir, read_json, write_json};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

pub const AUTO_CHECK_DELAY_SECONDS: u64 = 15;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
const DEFAULT_NOTES: &str = "안정성과 사용 경험을 개선한 새 버전입니다.";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PersistedUpdateState {
    pub schema_version: u8,
    pub last_successful_check_at: Option<String>,
    pub last_notified_version: Option<String>,
    pub snooze_until: Option<String>,
}

impl Default for PersistedUpdateState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            last_successful_check_at: None,
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
    pub should_open_window: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateViewState {
    pub current_version: String,
    pub available: Option<AvailableUpdate>,
    pub last_successful_check_at: Option<String>,
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
    pending: Mutex<Option<AvailableUpdate>>,
    shown_versions: Mutex<HashSet<String>>,
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
    let value = serde_json::to_value(state).map_err(|error| error.to_string())?;
    write_json(&state_path(), &value)
}

fn timestamp_ms(value: Option<&str>) -> Option<i64> {
    value
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis())
}

fn automatic_check_due(state: &PersistedUpdateState, now_ms: i64) -> bool {
    timestamp_ms(state.last_successful_check_at.as_deref())
        .is_none_or(|checked_at| now_ms.saturating_sub(checked_at) >= DAY_MS)
}

fn check_allowed(manual: bool, state: &PersistedUpdateState, now_ms: i64) -> bool {
    manual || automatic_check_due(state, now_ms)
}

fn update_is_snoozed(state: &PersistedUpdateState, version: &str, now_ms: i64) -> bool {
    let snooze_active =
        timestamp_ms(state.snooze_until.as_deref()).is_some_and(|until| until > now_ms);
    let newer_than_notified = state
        .last_notified_version
        .as_deref()
        .is_none_or(|notified| version_is_newer(version, notified));
    snooze_active && !newer_than_notified
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
    let mut persisted = read_state();

    if !check_allowed(manual, &persisted, now_ms) {
        return Ok(UpdateCheckResult {
            status: "skipped".into(),
            manual,
            current_version,
            available: None,
            last_successful_check_at: persisted.last_successful_check_at,
            should_open_window: false,
        });
    }

    let runtime = app.state::<UpdateRuntime>();
    let Some(_guard) = acquire_flag(&runtime.check_in_flight) else {
        return Ok(UpdateCheckResult {
            status: "busy".into(),
            manual,
            current_version,
            available: None,
            last_successful_check_at: persisted.last_successful_check_at,
            should_open_window: false,
        });
    };

    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    persisted.last_successful_check_at = Some(now.to_rfc3339());

    let Some(update) = update else {
        *runtime.pending.lock().expect("pending update lock") = None;
        persist_state(&persisted)?;
        return Ok(UpdateCheckResult {
            status: "up_to_date".into(),
            manual,
            current_version,
            available: None,
            last_successful_check_at: persisted.last_successful_check_at,
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

    let snoozed = !manual && update_is_snoozed(&persisted, &available.version, now_ms);
    let already_shown = !manual
        && runtime
            .shown_versions
            .lock()
            .expect("shown update versions lock")
            .contains(&available.version);
    let should_open_window = !snoozed && !already_shown;
    persist_state(&persisted)?;

    Ok(UpdateCheckResult {
        status: "available".into(),
        manual,
        current_version,
        available: Some(available),
        last_successful_check_at: persisted.last_successful_check_at,
        should_open_window,
    })
}

pub fn mark_window_opened(app: &AppHandle, version: &str) -> Result<(), String> {
    let runtime = app.state::<UpdateRuntime>();
    runtime
        .shown_versions
        .lock()
        .expect("shown update versions lock")
        .insert(version.to_string());
    let mut persisted = read_state();
    if persisted.last_notified_version.as_deref() != Some(version) {
        persisted.snooze_until = None;
    }
    persisted.last_notified_version = Some(version.to_string());
    persist_state(&persisted)
}

pub fn installation_in_progress(app: &AppHandle) -> bool {
    app.state::<UpdateRuntime>()
        .install_in_flight
        .load(Ordering::Acquire)
}

pub fn view_state(app: &AppHandle) -> UpdateViewState {
    let runtime = app.state::<UpdateRuntime>();
    let persisted = read_state();
    UpdateViewState {
        current_version: current_version(app),
        available: runtime.pending.lock().expect("pending update lock").clone(),
        last_successful_check_at: persisted.last_successful_check_at,
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
    let mut persisted = read_state();
    postpone_state(
        &mut persisted,
        version,
        chrono::Utc::now().timestamp_millis(),
    );
    persist_state(&persisted)?;
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
            ..Default::default()
        };

        assert!(!check_allowed(false, &state, now_ms));
        assert!(check_allowed(true, &state, now_ms));
    }

    #[test]
    fn the_same_version_is_snoozed_but_a_new_version_is_not() {
        let now_ms = chrono::DateTime::parse_from_rfc3339("2026-07-21T12:00:00Z")
            .unwrap()
            .timestamp_millis();
        let state = PersistedUpdateState {
            last_notified_version: Some("1.2.1".into()),
            snooze_until: Some("2026-07-22T12:00:00Z".into()),
            ..Default::default()
        };

        assert!(update_is_snoozed(&state, "1.2.1", now_ms));
        assert!(!update_is_snoozed(&state, "1.2.2", now_ms));
        assert!(!update_is_snoozed(&state, "v1.2.2", now_ms));
        assert!(update_is_snoozed(&state, "1.2.0", now_ms));
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

        assert_eq!(state.schema_version, 1);
        assert!(state.last_successful_check_at.is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn install_aborts_when_the_fresh_version_changed() {
        assert!(validate_expected_version("1.2.1", "1.2.1").is_ok());
        assert!(validate_expected_version("1.2.1", "1.2.2").is_err());
    }
}
