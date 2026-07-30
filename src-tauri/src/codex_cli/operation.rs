use crate::codex_cli::error::SetupSafeErrorCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallOperationState {
    Idle,
    ConsentRequired,
    Starting,
    Running,
    LongRunning,
    Succeeded,
    Failed,
    Cancelled,
    Detached,
}

impl InstallOperationState {
    fn active(self) -> bool {
        matches!(self, Self::Starting | Self::Running | Self::LongRunning)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginOperationState {
    Idle,
    Starting,
    Running,
    LongRunning,
    Exited,
    Failed,
    Cancelled,
    Detached,
}

impl LoginOperationState {
    fn active(self) -> bool {
        matches!(self, Self::Starting | Self::Running | Self::LongRunning)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    Install,
    Login,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOperationDto {
    pub state: InstallOperationState,
    pub operation_id: Option<String>,
    pub safe_error_code: Option<SetupSafeErrorCode>,
    pub cancelable: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginOperationDto {
    pub state: LoginOperationState,
    pub operation_id: Option<String>,
    pub safe_error_code: Option<SetupSafeErrorCode>,
    pub cancelable: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct OperationStart {
    pub(crate) operation_id: String,
    pub(crate) cancellation: Arc<AtomicBool>,
}

struct InstallRecord {
    dto: InstallOperationDto,
    cancellation: Option<Arc<AtomicBool>>,
}

impl Default for InstallRecord {
    fn default() -> Self {
        Self {
            dto: InstallOperationDto {
                state: InstallOperationState::Idle,
                operation_id: None,
                safe_error_code: None,
                cancelable: false,
            },
            cancellation: None,
        }
    }
}

struct LoginRecord {
    dto: LoginOperationDto,
    cancellation: Option<Arc<AtomicBool>>,
}

impl Default for LoginRecord {
    fn default() -> Self {
        Self {
            dto: LoginOperationDto {
                state: LoginOperationState::Idle,
                operation_id: None,
                safe_error_code: None,
                cancelable: false,
            },
            cancellation: None,
        }
    }
}

#[derive(Default)]
pub(crate) struct OperationManager {
    install: Mutex<InstallRecord>,
    login: Mutex<LoginRecord>,
}

impl OperationManager {
    pub(crate) fn with_detached(install_detached: bool, login_detached: bool) -> Self {
        let manager = Self::default();
        if install_detached {
            manager
                .install
                .lock()
                .expect("Codex install operation lock")
                .dto
                .state = InstallOperationState::Detached;
        }
        if login_detached {
            manager
                .login
                .lock()
                .expect("Codex login operation lock")
                .dto
                .state = LoginOperationState::Detached;
        }
        manager
    }

    pub(crate) fn install_snapshot(&self) -> InstallOperationDto {
        self.install
            .lock()
            .expect("Codex install operation lock")
            .dto
            .clone()
    }

    pub(crate) fn login_snapshot(&self) -> LoginOperationDto {
        self.login
            .lock()
            .expect("Codex login operation lock")
            .dto
            .clone()
    }

    pub(crate) fn begin_install(&self) -> Result<OperationStart, SetupSafeErrorCode> {
        let mut record = self.install.lock().expect("Codex install operation lock");
        let login = self.login.lock().expect("Codex login operation lock");
        if record.dto.state.active() || login.dto.state.active() {
            return Err(SetupSafeErrorCode::OperationAlreadyRunning);
        }
        drop(login);
        let operation_id = Uuid::new_v4().to_string();
        let cancellation = Arc::new(AtomicBool::new(false));
        record.dto = InstallOperationDto {
            state: InstallOperationState::Starting,
            operation_id: Some(operation_id.clone()),
            safe_error_code: None,
            cancelable: true,
        };
        record.cancellation = Some(cancellation.clone());
        Ok(OperationStart {
            operation_id,
            cancellation,
        })
    }

    pub(crate) fn begin_login(&self) -> Result<OperationStart, SetupSafeErrorCode> {
        let install = self.install.lock().expect("Codex install operation lock");
        let mut record = self.login.lock().expect("Codex login operation lock");
        if install.dto.state.active() || record.dto.state.active() {
            return Err(SetupSafeErrorCode::OperationAlreadyRunning);
        }
        drop(install);
        let operation_id = Uuid::new_v4().to_string();
        let cancellation = Arc::new(AtomicBool::new(false));
        record.dto = LoginOperationDto {
            state: LoginOperationState::Starting,
            operation_id: Some(operation_id.clone()),
            safe_error_code: None,
            cancelable: true,
        };
        record.cancellation = Some(cancellation.clone());
        Ok(OperationStart {
            operation_id,
            cancellation,
        })
    }

    pub(crate) fn mark_install(
        &self,
        operation_id: &str,
        state: InstallOperationState,
        safe_error_code: Option<SetupSafeErrorCode>,
    ) {
        let mut record = self.install.lock().expect("Codex install operation lock");
        if record.dto.operation_id.as_deref() != Some(operation_id) {
            return;
        }
        record.dto.state = state;
        record.dto.safe_error_code = safe_error_code;
        if !state.active() {
            record.cancellation = None;
            record.dto.cancelable = false;
        }
    }

    pub(crate) fn mark_login(
        &self,
        operation_id: &str,
        state: LoginOperationState,
        safe_error_code: Option<SetupSafeErrorCode>,
    ) {
        let mut record = self.login.lock().expect("Codex login operation lock");
        if record.dto.operation_id.as_deref() != Some(operation_id) {
            return;
        }
        record.dto.state = state;
        record.dto.safe_error_code = safe_error_code;
        if !state.active() {
            record.cancellation = None;
            record.dto.cancelable = false;
        }
    }

    pub(crate) fn cancel(&self, kind: OperationKind) -> bool {
        match kind {
            OperationKind::Install => {
                let mut record = self.install.lock().expect("Codex install operation lock");
                if !record.dto.cancelable {
                    return false;
                }
                let accepted = record.cancellation.as_ref().is_some_and(|flag| {
                    flag.store(true, Ordering::Release);
                    true
                });
                if accepted {
                    record.dto.cancelable = false;
                }
                accepted
            }
            OperationKind::Login => {
                let mut record = self.login.lock().expect("Codex login operation lock");
                if !record.dto.cancelable {
                    return false;
                }
                let accepted = record.cancellation.as_ref().is_some_and(|flag| {
                    flag.store(true, Ordering::Release);
                    true
                });
                if accepted {
                    record.dto.cancelable = false;
                }
                accepted
            }
        }
    }

    /// Child exit와 사용자 cancel 사이의 경합을 operation record lock으로 선형화합니다.
    ///
    /// `Some(true)`면 cancel이 먼저 확정됐고 worker가 Job을 종료해야 합니다.
    /// `Some(false)`면 worker가 먼저 cancellation window를 닫았으므로 이후 cancel은 거부됩니다.
    pub(crate) fn close_cancellation_window(
        &self,
        kind: OperationKind,
        operation_id: &str,
    ) -> Option<bool> {
        match kind {
            OperationKind::Install => {
                let mut record = self.install.lock().expect("Codex install operation lock");
                if record.dto.operation_id.as_deref() != Some(operation_id) {
                    return None;
                }
                record.dto.cancelable = false;
                record
                    .cancellation
                    .take()
                    .map(|flag| cancellation_requested(&flag))
            }
            OperationKind::Login => {
                let mut record = self.login.lock().expect("Codex login operation lock");
                if record.dto.operation_id.as_deref() != Some(operation_id) {
                    return None;
                }
                record.dto.cancelable = false;
                record
                    .cancellation
                    .take()
                    .map(|flag| cancellation_requested(&flag))
            }
        }
    }
}

pub(crate) fn cancellation_requested(flag: &AtomicBool) -> bool {
    flag.load(Ordering::Acquire)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct InstallFileEvidence {
    path: PathBuf,
    size: u64,
    sha256: [u8; 32],
}

pub(crate) fn capture_install_evidence(target: &Path) -> Vec<InstallFileEvidence> {
    [
        target.join("codex.exe"),
        target.join("codex.cmd"),
        target.join("bin/codex.exe"),
        target.join("bin/codex.cmd"),
    ]
    .into_iter()
    .filter_map(|path| file_evidence(path).ok())
    .collect()
}

pub(crate) fn single_install_delta(
    before: &[InstallFileEvidence],
    after: &[InstallFileEvidence],
) -> Option<PathBuf> {
    let changed = after
        .iter()
        .filter(|current| {
            before.iter().find(|previous| previous.path == current.path) != Some(*current)
        })
        .collect::<Vec<_>>();
    (changed.len() == 1).then(|| changed[0].path.clone())
}

fn file_evidence(path: PathBuf) -> std::io::Result<InstallFileEvidence> {
    let canonical = fs::canonicalize(&path)?;
    let metadata = fs::metadata(&canonical)?;
    if !metadata.is_file() {
        return Err(std::io::Error::other("install candidate is not a file"));
    }
    let mut file = fs::File::open(&canonical)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(InstallFileEvidence {
        path: canonical,
        size: metadata.len(),
        sha256: hasher.finalize().into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn duplicate_install_and_login_starts_are_rejected() {
        let manager = OperationManager::default();
        let install = manager.begin_install().expect("first install starts");
        assert_eq!(
            manager
                .begin_install()
                .expect_err("duplicate install is rejected"),
            SetupSafeErrorCode::OperationAlreadyRunning
        );
        manager.mark_install(
            &install.operation_id,
            InstallOperationState::Succeeded,
            None,
        );
        let second_install = manager
            .begin_install()
            .expect("install can restart after terminal state");
        manager.mark_install(
            &second_install.operation_id,
            InstallOperationState::Succeeded,
            None,
        );

        let login = manager.begin_login().expect("first login starts");
        assert_eq!(
            manager
                .begin_login()
                .expect_err("duplicate login is rejected"),
            SetupSafeErrorCode::OperationAlreadyRunning
        );
        manager.mark_login(&login.operation_id, LoginOperationState::Exited, None);
        assert!(
            manager.begin_login().is_ok(),
            "login can restart after terminal state"
        );
    }

    #[test]
    fn install_and_login_cannot_run_at_the_same_time() {
        let manager = OperationManager::default();
        let install = manager.begin_install().expect("install starts");
        assert_eq!(
            manager.begin_login().expect_err("login is blocked"),
            SetupSafeErrorCode::OperationAlreadyRunning
        );
        manager.mark_install(
            &install.operation_id,
            InstallOperationState::Succeeded,
            None,
        );
        let login = manager.begin_login().expect("login starts");
        assert_eq!(
            manager.begin_install().expect_err("install is blocked"),
            SetupSafeErrorCode::OperationAlreadyRunning
        );
        manager.mark_login(&login.operation_id, LoginOperationState::Exited, None);
    }

    #[test]
    fn stale_process_markers_restore_detached_diagnostics_only() {
        let manager = OperationManager::with_detached(true, true);
        assert_eq!(
            manager.install_snapshot().state,
            InstallOperationState::Detached
        );
        assert_eq!(
            manager.login_snapshot().state,
            LoginOperationState::Detached
        );
        assert!(manager.install_snapshot().operation_id.is_none());
        assert!(manager.login_snapshot().operation_id.is_none());
    }

    #[test]
    fn explicit_cancel_only_sets_the_matching_operation_flag() {
        let manager = OperationManager::default();
        let login = manager.begin_login().expect("login starts");
        assert!(manager.login_snapshot().cancelable);
        assert!(!cancellation_requested(&login.cancellation));
        assert!(!manager.cancel(OperationKind::Install));
        assert!(manager.cancel(OperationKind::Login));
        assert!(cancellation_requested(&login.cancellation));
        assert!(!manager.login_snapshot().cancelable);
        assert!(!manager.cancel(OperationKind::Login));
    }

    #[test]
    fn worker_closes_the_visible_cancellation_window_before_verification() {
        let manager = OperationManager::default();
        let operation = manager.begin_install().expect("install starts");
        assert!(manager.install_snapshot().cancelable);

        assert_eq!(
            manager.close_cancellation_window(OperationKind::Install, &operation.operation_id),
            Some(false)
        );
        assert!(!manager.install_snapshot().cancelable);
        assert!(!manager.cancel(OperationKind::Install));
    }

    #[test]
    fn cancellation_and_worker_exit_have_one_locked_winner() {
        for _ in 0..64 {
            let manager = Arc::new(OperationManager::default());
            let operation = manager.begin_login().expect("login starts");
            let operation_id = operation.operation_id.clone();
            let barrier = Arc::new(std::sync::Barrier::new(2));
            let cancelling_manager = Arc::clone(&manager);
            let cancelling_barrier = Arc::clone(&barrier);
            let cancel = std::thread::spawn(move || {
                cancelling_barrier.wait();
                cancelling_manager.cancel(OperationKind::Login)
            });

            barrier.wait();
            let cancellation_won =
                manager.close_cancellation_window(OperationKind::Login, &operation_id);
            let cancel_accepted = cancel.join().expect("cancel thread completes");

            assert!(
                matches!(
                    (cancel_accepted, cancellation_won),
                    (true, Some(true)) | (false, Some(false))
                ),
                "cancel and worker finalization must agree on the lock winner"
            );
            assert!(!manager.cancel(OperationKind::Login));
        }
    }

    #[test]
    fn stale_worker_cannot_close_another_operations_cancellation_window() {
        let manager = OperationManager::default();
        let install = manager.begin_install().expect("install starts");

        assert_eq!(
            manager.close_cancellation_window(OperationKind::Install, "stale-operation-id"),
            None
        );
        assert!(manager.cancel(OperationKind::Install));
        assert_eq!(
            manager.close_cancellation_window(OperationKind::Install, &install.operation_id),
            Some(true)
        );
    }

    #[test]
    fn stale_worker_cannot_overwrite_a_new_operation() {
        let manager = OperationManager::default();
        let first = manager.begin_login().expect("first login starts");
        manager.mark_login(&first.operation_id, LoginOperationState::Exited, None);
        let second = manager.begin_login().expect("second login starts");
        manager.mark_login(
            &first.operation_id,
            LoginOperationState::Failed,
            Some(SetupSafeErrorCode::LoginSpawnFailed),
        );
        assert_eq!(
            manager.login_snapshot().operation_id.as_deref(),
            Some(second.operation_id.as_str())
        );
        assert_eq!(
            manager.login_snapshot().state,
            LoginOperationState::Starting
        );
    }

    #[test]
    fn tracked_install_requires_exactly_one_new_or_changed_target_file() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "ai-usage-monitor-install-evidence-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("fixture directory");
        let executable = root.join("codex.exe");
        fs::write(&executable, b"before").expect("initial candidate");
        let before = capture_install_evidence(&root);
        assert!(single_install_delta(&before, &before).is_none());

        fs::write(&executable, b"after").expect("changed candidate");
        let after = capture_install_evidence(&root);
        assert_eq!(
            single_install_delta(&before, &after),
            Some(fs::canonicalize(&executable).expect("canonical candidate"))
        );

        fs::write(root.join("codex.cmd"), b"@exit /b 0").expect("second candidate");
        let ambiguous = capture_install_evidence(&root);
        assert!(single_install_delta(&before, &ambiguous).is_none());
        fs::remove_dir_all(root).expect("fixture cleanup");
    }
}
