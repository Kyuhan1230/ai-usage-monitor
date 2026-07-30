mod discovery;
pub mod error;
pub(crate) mod operation;
mod probe;
mod process_tree;
mod types;

pub use error::SetupSafeErrorCode;
#[allow(unused_imports)]
pub use types::{
    AuthState, CandidateSource, CliState, CodexSetupDto, Compatibility, LauncherType,
    ProvenanceConfidence,
};

#[allow(unused_imports)]
pub(crate) use discovery::{
    CandidateInventory, discover_codex_candidates, discover_codex_candidates_with_manual,
};
pub(crate) use error::CodexSetupError;
pub(crate) use operation::{
    InstallOperationDto, InstallOperationState, LoginOperationDto, LoginOperationState,
    OperationKind, OperationManager, cancellation_requested, capture_install_evidence,
    single_install_delta,
};
pub(crate) use probe::{
    probe_auth, probe_candidates, ready_conflict_count, select_candidates,
    selected_app_server_command, selected_login_command, setup_dto,
};
pub(crate) use process_tree::{ChildWindow, JobLifetime, ProcessTree, spawn_in_process_tree};
pub(crate) use types::SelectedCodex;
