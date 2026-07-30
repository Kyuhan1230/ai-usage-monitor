use crate::codex_cli::error::SetupSafeErrorCode;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileIdentity {
    volume: u64,
    file_index: u64,
    size: u64,
    last_write: u64,
}

#[cfg(windows)]
fn file_identity(path: &Path) -> io::Result<FileIdentity> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let file = fs::File::open(path)?;
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: `file` owns a valid handle for the duration of this call and `information`
    // points to writable storage of the exact structure expected by the Windows API.
    unsafe {
        GetFileInformationByHandle(
            HANDLE(file.as_raw_handle()),
            std::ptr::addr_of_mut!(information),
        )
        .map_err(io::Error::other)?;
    }
    Ok(FileIdentity {
        volume: u64::from(information.dwVolumeSerialNumber),
        file_index: (u64::from(information.nFileIndexHigh) << 32)
            | u64::from(information.nFileIndexLow),
        size: (u64::from(information.nFileSizeHigh) << 32) | u64::from(information.nFileSizeLow),
        last_write: (u64::from(information.ftLastWriteTime.dwHighDateTime) << 32)
            | u64::from(information.ftLastWriteTime.dwLowDateTime),
    })
}

#[cfg(unix)]
fn file_identity(path: &Path) -> io::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::metadata(path)?;
    Ok(FileIdentity {
        volume: metadata.dev(),
        file_index: metadata.ino(),
        size: metadata.size(),
        last_write: (metadata.mtime() as u64).wrapping_mul(1_000_000_000)
            ^ metadata.mtime_nsec() as u64,
    })
}

#[cfg(not(any(windows, unix)))]
fn file_identity(path: &Path) -> io::Result<FileIdentity> {
    use std::time::UNIX_EPOCH;

    let metadata = fs::metadata(path)?;
    let last_write = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos() as u64;
    Ok(FileIdentity {
        volume: 0,
        file_index: 0,
        size: metadata.len(),
        last_write,
    })
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateSource {
    CurrentPath,
    UserPath,
    MachinePath,
    DefaultStandalonePath,
    LegacyNpm,
    LocalBin,
    CustomInstallDir,
    Manual,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LauncherType {
    Exe,
    Cmd,
    Bat,
    Extensionless,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProvenanceConfidence {
    VerifiedPublisher,
    TrackedOfficialInstall,
    Unverified,
    Invalid,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Compatibility {
    Supported,
    UntestedNewer,
    Unsupported,
    Invalid,
    RuntimeDependencyMissing,
    RuntimeDependencyIncompatible,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CandidateRejection {
    DesktopPackagedResource,
    AppExecutionAlias,
    Directory,
    EmptyFile,
    UnsupportedLauncher,
    NotExecutable,
    VersionUnrecognized,
    VersionUnsupported,
    CapabilityMissing,
    RuntimeDependencyMissing,
    RuntimeDependencyIncompatible,
    ProvenanceInvalid,
    ProbeTimeout,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct CapabilitySet {
    pub(crate) login_status: bool,
    pub(crate) device_auth: bool,
    pub(crate) app_server: bool,
}

/// CLI 실행에 필요한 민감한 경로와 갱신된 child PATH를 보관하는 유일한 내부 타입입니다.
///
/// 이 타입은 Serialize를 구현하지 않으며 renderer DTO로 변환할 때 경로를 폐기합니다.
#[derive(Clone, Debug)]
pub(crate) struct SelectedCodex {
    path: PathBuf,
    child_path: OsString,
    launcher: LauncherType,
    file_identity: Option<FileIdentity>,
}

impl SelectedCodex {
    pub(crate) fn new(path: PathBuf, child_path: OsString, launcher: LauncherType) -> Self {
        let file_identity = file_identity(&path).ok();
        Self {
            path,
            child_path,
            launcher,
            file_identity,
        }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn child_path(&self) -> &OsString {
        &self.child_path
    }

    pub(crate) fn launcher(&self) -> LauncherType {
        self.launcher
    }

    /// 발견 때 고정한 파일과 현재 경로의 파일이 같은 객체·크기·수정시각인지 확인합니다.
    ///
    /// identity를 얻지 못한 후보는 실행하지 않습니다. 경로 자체는 오류나 DTO에 포함하지 않습니다.
    pub(crate) fn identity_unchanged(&self) -> bool {
        match (self.file_identity.as_ref(), file_identity(&self.path)) {
            (Some(expected), Ok(current)) => &current == expected,
            _ => false,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct CodexCandidate {
    pub(crate) command: SelectedCodex,
    pub(crate) discovered_from: BTreeSet<CandidateSource>,
    pub(crate) version: Option<Version>,
    pub(crate) capabilities: CapabilitySet,
    pub(crate) compatibility: Compatibility,
    pub(crate) provenance: ProvenanceConfidence,
    pub(crate) rejection: Option<CandidateRejection>,
}

impl CodexCandidate {
    pub(crate) fn is_compatible(&self) -> bool {
        self.rejection.is_none()
            && matches!(
                self.compatibility,
                Compatibility::Supported | Compatibility::UntestedNewer
            )
    }

    pub(crate) fn primary_source(&self) -> CandidateSource {
        const SOURCE_PRIORITY: [CandidateSource; 8] = [
            CandidateSource::Manual,
            CandidateSource::DefaultStandalonePath,
            CandidateSource::CustomInstallDir,
            CandidateSource::UserPath,
            CandidateSource::CurrentPath,
            CandidateSource::MachinePath,
            CandidateSource::LegacyNpm,
            CandidateSource::LocalBin,
        ];
        SOURCE_PRIORITY
            .into_iter()
            .find(|source| self.discovered_from.contains(source))
            .unwrap_or(CandidateSource::CurrentPath)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CliState {
    Probing,
    Missing,
    DesktopBundleOnly,
    InvalidCandidate,
    RuntimeDependencyMissing,
    RuntimeDependencyIncompatible,
    Unsupported,
    Conflict,
    Ready,
    ProbeError,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthState {
    Unavailable,
    Checking,
    Unauthenticated,
    Authenticated,
    Error,
}

#[derive(Clone, Debug)]
pub(crate) struct AuthProbe {
    pub(crate) state: AuthState,
    pub(crate) safe_error_code: Option<SetupSafeErrorCode>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateDto {
    pub candidate_id: String,
    pub candidate_tag: String,
    pub display_label: String,
    pub source: CandidateSource,
    pub launcher: LauncherType,
    pub version: Option<String>,
    pub compatibility: Compatibility,
    pub provenance: ProvenanceConfidence,
    pub safe_error_code: Option<SetupSafeErrorCode>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthDto {
    pub state: AuthState,
    pub safe_error_code: Option<SetupSafeErrorCode>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSetupDto {
    pub cli_state: CliState,
    pub selected: Option<CandidateDto>,
    pub candidates: Vec<CandidateDto>,
    pub candidate_count: usize,
    pub conflict_count: usize,
    pub device_auth_supported: bool,
    pub auth: AuthDto,
    pub safe_error_code: Option<SetupSafeErrorCode>,
}

#[derive(Clone, Debug)]
pub(crate) struct SelectionResult {
    pub(crate) state: CliState,
    pub(crate) selected_index: Option<usize>,
    pub(crate) conflict_count: usize,
    pub(crate) safe_error_code: Option<SetupSafeErrorCode>,
}

pub(crate) fn candidate_safe_error(
    rejection: Option<CandidateRejection>,
) -> Option<SetupSafeErrorCode> {
    match rejection {
        None => None,
        Some(CandidateRejection::DesktopPackagedResource)
        | Some(CandidateRejection::AppExecutionAlias) => {
            Some(SetupSafeErrorCode::DesktopBundleOnly)
        }
        Some(CandidateRejection::RuntimeDependencyMissing) => {
            Some(SetupSafeErrorCode::RuntimeDependencyMissing)
        }
        Some(CandidateRejection::RuntimeDependencyIncompatible) => {
            Some(SetupSafeErrorCode::RuntimeDependencyIncompatible)
        }
        Some(CandidateRejection::VersionUnrecognized) => {
            Some(SetupSafeErrorCode::CandidateVersionUnrecognized)
        }
        Some(CandidateRejection::VersionUnsupported)
        | Some(CandidateRejection::CapabilityMissing) => {
            Some(SetupSafeErrorCode::CandidateUnsupported)
        }
        Some(CandidateRejection::ProvenanceInvalid) => {
            Some(SetupSafeErrorCode::CandidateProvenanceInvalid)
        }
        Some(CandidateRejection::Directory)
        | Some(CandidateRejection::EmptyFile)
        | Some(CandidateRejection::UnsupportedLauncher)
        | Some(CandidateRejection::NotExecutable)
        | Some(CandidateRejection::ProbeTimeout) => {
            Some(SetupSafeErrorCode::CandidateNotExecutable)
        }
    }
}

pub(crate) fn source_display_label(source: CandidateSource, ordinal: usize) -> String {
    match source {
        CandidateSource::CurrentPath => format!("현재 PATH #{ordinal}"),
        CandidateSource::UserPath => format!("사용자 PATH #{ordinal}"),
        CandidateSource::MachinePath => format!("시스템 PATH #{ordinal}"),
        CandidateSource::DefaultStandalonePath => "기본 standalone 경로".into(),
        CandidateSource::LegacyNpm => "npm 전역 launcher".into(),
        CandidateSource::LocalBin => ".local launcher".into(),
        CandidateSource::CustomInstallDir => "사용자 지정 설치 경로".into(),
        CandidateSource::Manual => "직접 선택한 Codex CLI".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn public_setup_dto_never_has_a_path_field() {
        let dto = CodexSetupDto {
            cli_state: CliState::Ready,
            selected: Some(CandidateDto {
                candidate_id: "candidate-1".into(),
                candidate_tag: "CLI-A1".into(),
                display_label: "기본 standalone 경로".into(),
                source: CandidateSource::DefaultStandalonePath,
                launcher: LauncherType::Exe,
                version: Some("0.144.5".into()),
                compatibility: Compatibility::Supported,
                provenance: ProvenanceConfidence::Unverified,
                safe_error_code: None,
            }),
            candidates: Vec::new(),
            candidate_count: 1,
            conflict_count: 0,
            device_auth_supported: true,
            auth: AuthDto {
                state: AuthState::Authenticated,
                safe_error_code: None,
            },
            safe_error_code: None,
        };

        let value = serde_json::to_value(dto).expect("setup DTO serializes");
        let serialized = value.to_string();
        assert_eq!(value["cliState"], "ready");
        assert!(!serialized.to_ascii_lowercase().contains("pathbuf"));
        assert!(!serialized.contains(r"C:\Users"));
        assert!(value["selected"].get("path").is_none());
        assert!(value["selected"].get("canonicalPath").is_none());
    }

    #[test]
    fn selected_codex_rejects_deleted_replaced_or_modified_files() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "ai-usage-monitor-file-identity-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).expect("fixture directory");
        let executable = root.join("codex.exe");
        fs::write(&executable, b"original").expect("fixture executable");
        let selected = SelectedCodex::new(
            fs::canonicalize(&executable).expect("canonical fixture"),
            OsString::new(),
            LauncherType::Exe,
        );
        assert!(selected.identity_unchanged());

        fs::remove_file(&executable).expect("selected file is deleted");
        assert!(!selected.identity_unchanged());
        fs::write(&executable, b"replacement-with-a-different-size").expect("replacement file");
        assert!(!selected.identity_unchanged());

        let replaced = SelectedCodex::new(
            fs::canonicalize(&executable).expect("canonical replacement"),
            OsString::new(),
            LauncherType::Exe,
        );
        assert!(replaced.identity_unchanged());
        fs::write(&executable, b"modified").expect("replacement is modified");
        assert!(!replaced.identity_unchanged());
        fs::remove_dir_all(root).expect("fixture is removed");
    }
}
