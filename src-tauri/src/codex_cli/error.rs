use serde::{Deserialize, Serialize};

/// Renderer에 공개해도 계정 정보나 로컬 경로를 노출하지 않는 오류 코드입니다.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupSafeErrorCode {
    CodexNotFound,
    DesktopBundleOnly,
    CandidateNotExecutable,
    CandidateVersionUnrecognized,
    CandidateUnsupported,
    CandidateConflict,
    RuntimeDependencyMissing,
    RuntimeDependencyIncompatible,
    CandidateProvenanceInvalid,
    PathRefreshFailed,
    InstallTargetInvalid,
    InstallSpawnFailed,
    InstallExitNonzero,
    InstallNoValidCli,
    InstallCancelled,
    LoginSpawnFailed,
    LoginCancelled,
    LoginUnconfirmed,
    AuthProbeTimeout,
    AuthProbeFailed,
    UsageCapabilityMissing,
    UsageCaptureFailed,
    UsageCaptureTimeout,
    OperationAlreadyRunning,
    UnknownSetupError,
}

/// 원문 오류는 backend 메모리 안에서만 유지하고 공개 DTO에는 `safe_code`만 사용합니다.
#[derive(Clone, Debug)]
pub(crate) struct CodexSetupError {
    safe_code: SetupSafeErrorCode,
    raw_detail: Option<String>,
}

impl CodexSetupError {
    pub(crate) fn new(safe_code: SetupSafeErrorCode) -> Self {
        Self {
            safe_code,
            raw_detail: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_raw_detail(
        safe_code: SetupSafeErrorCode,
        raw_detail: impl Into<String>,
    ) -> Self {
        Self {
            safe_code,
            raw_detail: Some(raw_detail.into()),
        }
    }

    pub(crate) fn safe_code(&self) -> SetupSafeErrorCode {
        self.safe_code
    }

    #[allow(dead_code)]
    pub(crate) fn raw_detail(&self) -> Option<&str> {
        self.raw_detail.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_error_serialization_contains_only_the_safe_code() {
        let error = CodexSetupError::with_raw_detail(
            SetupSafeErrorCode::CandidateNotExecutable,
            r"C:\Users\private-user\codex.exe: access denied",
        );

        let serialized = serde_json::to_string(&error.safe_code()).expect("safe code serializes");
        assert_eq!(serialized, r#""candidate_not_executable""#);
        assert!(!serialized.contains("private-user"));
        assert!(!serialized.contains("access denied"));
        assert_eq!(
            serde_json::to_string(&SetupSafeErrorCode::UsageCaptureTimeout)
                .expect("capture timeout code serializes"),
            r#""usage_capture_timeout""#
        );
        assert_eq!(
            serde_json::to_string(&SetupSafeErrorCode::InstallTargetInvalid)
                .expect("install target code serializes"),
            r#""install_target_invalid""#
        );
    }
}
