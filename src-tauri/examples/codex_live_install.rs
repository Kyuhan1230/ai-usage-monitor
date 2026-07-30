#![allow(dead_code, unused_imports)]

mod codex_cli {
    pub(crate) mod discovery {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/codex_cli/discovery.rs"
        ));
    }
    pub(crate) mod error {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/codex_cli/error.rs"
        ));
    }
    pub(crate) mod probe {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/codex_cli/probe.rs"
        ));
    }
    pub(crate) mod process_tree {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/codex_cli/process_tree.rs"
        ));
    }
    pub(crate) mod types {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/codex_cli/types.rs"
        ));
    }

    pub(crate) use discovery::discover_codex_candidates;
    pub(crate) use probe::{probe_auth, probe_candidates, select_candidates, setup_dto};
    pub(crate) use types::{
        AuthState, CandidateSource, CliState, Compatibility, ProvenanceConfidence,
    };
}

use codex_cli::{
    AuthState, CandidateSource, CliState, Compatibility, ProvenanceConfidence,
    discover_codex_candidates, probe_auth, probe_candidates, select_candidates, setup_dto,
};
use serde::Serialize;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const CODEX_PATH_ENV: &str = "AI_USAGE_MONITOR_T2_CODEX_PATH";
const CODEX_HOME_ENV: &str = "AI_USAGE_MONITOR_T2_CODEX_HOME";
const EXPECTED_SOURCE_ENV: &str = "AI_USAGE_MONITOR_T2_EXPECTED_SOURCE";
const EVIDENCE_PATH_ENV: &str = "AI_USAGE_MONITOR_T2_EVIDENCE_PATH";

#[derive(Clone, Debug)]
struct Contract {
    codex_path: PathBuf,
    codex_home: PathBuf,
    expected_source: CandidateSource,
    expected_source_text: &'static str,
    evidence_path: PathBuf,
}

#[derive(Clone, Debug)]
struct HarnessFailure {
    safe_code: &'static str,
}

impl HarnessFailure {
    const fn new(safe_code: &'static str) -> Self {
        Self { safe_code }
    }
}

#[derive(Clone, Debug, Serialize)]
struct Evidence {
    schema_version: u8,
    selected_expected_candidate: bool,
    selected_source: String,
    selected_version: String,
    provenance: String,
    auth_state: String,
    safe_error_code: Option<String>,
}

impl Evidence {
    fn failure(expected_source: Option<&str>, safe_code: &'static str) -> Self {
        Self {
            schema_version: 1,
            selected_expected_candidate: false,
            selected_source: expected_source.unwrap_or("unknown").to_owned(),
            selected_version: "unknown".to_owned(),
            provenance: "invalid".to_owned(),
            auth_state: "error".to_owned(),
            safe_error_code: Some(safe_code.to_owned()),
        }
    }
}

fn main() -> ExitCode {
    let fallback_evidence_path = env::var_os(EVIDENCE_PATH_ENV).map(PathBuf::from);
    let fallback_source = env::var(EXPECTED_SOURCE_ENV)
        .ok()
        .and_then(|value| parse_expected_source(&value).ok())
        .map(|(_, source_text)| source_text);

    let contract = Contract::load();
    let validated_evidence_path = contract
        .as_ref()
        .ok()
        .map(|contract| contract.evidence_path.clone());
    let result = contract.and_then(run_harness);
    let (evidence, succeeded) = match result {
        Ok(evidence) => (evidence, true),
        Err(error) => (Evidence::failure(fallback_source, error.safe_code), false),
    };

    let evidence_path = validated_evidence_path.or(fallback_evidence_path);
    let serialized = match serialize_evidence(&evidence) {
        Ok(serialized) => serialized,
        Err(error) => {
            let fallback = Evidence::failure(fallback_source, error.safe_code);
            let serialized = serde_json::to_string(&fallback).unwrap_or_else(|_| {
                "{\"schema_version\":1,\"selected_expected_candidate\":false,\"selected_source\":\"unknown\",\"selected_version\":\"unknown\",\"provenance\":\"invalid\",\"auth_state\":\"error\",\"safe_error_code\":\"t2_evidence_invalid\"}".to_owned()
            });
            println!("{serialized}");
            eprintln!("T2 live harness failed: {}", error.safe_code);
            return ExitCode::FAILURE;
        }
    };

    let Some(evidence_path) = evidence_path else {
        println!("{serialized}");
        eprintln!("T2 live harness failed: t2_contract_invalid");
        return ExitCode::FAILURE;
    };
    if write_evidence(&evidence_path, &serialized).is_err() {
        let write_failure = Evidence::failure(fallback_source, "t2_evidence_write_failed");
        let serialized = serde_json::to_string(&write_failure).unwrap_or_else(|_| {
            "{\"schema_version\":1,\"selected_expected_candidate\":false,\"selected_source\":\"unknown\",\"selected_version\":\"unknown\",\"provenance\":\"invalid\",\"auth_state\":\"error\",\"safe_error_code\":\"t2_evidence_write_failed\"}".to_owned()
        });
        println!("{serialized}");
        eprintln!("T2 live harness failed: t2_evidence_write_failed");
        return ExitCode::FAILURE;
    }

    println!("{serialized}");
    if succeeded {
        ExitCode::SUCCESS
    } else {
        let safe_code = evidence
            .safe_error_code
            .as_deref()
            .unwrap_or("t2_probe_failed");
        eprintln!("T2 live harness failed: {safe_code}");
        ExitCode::FAILURE
    }
}

impl Contract {
    fn load() -> Result<Self, HarnessFailure> {
        let codex_path = required_path(CODEX_PATH_ENV)?;
        let codex_home = required_path(CODEX_HOME_ENV)?;
        let evidence_path = required_path(EVIDENCE_PATH_ENV)?;
        let (expected_source, expected_source_text) =
            parse_expected_source(&required_text(EXPECTED_SOURCE_ENV)?)?;

        if !codex_path.is_absolute()
            || !codex_path.is_file()
            || !file_name_is_codex_exe(&codex_path)
            || !codex_home.is_absolute()
            || !codex_home.is_dir()
            || !evidence_path.is_absolute()
            || evidence_path.parent().is_none_or(|parent| !parent.is_dir())
        {
            return Err(HarnessFailure::new("t2_contract_invalid"));
        }
        if codex_home.join("auth.json").exists() {
            return Err(HarnessFailure::new("t2_home_not_isolated"));
        }
        if ["OPENAI_API_KEY", "CODEX_API_KEY"]
            .into_iter()
            .any(|name| env::var_os(name).is_some_and(|value| !value.is_empty()))
        {
            return Err(HarnessFailure::new("t2_credentials_present"));
        }

        let inherited_codex_home =
            env::var_os("CODEX_HOME").ok_or_else(|| HarnessFailure::new("t2_contract_invalid"))?;
        if canonical_existing(Path::new(&inherited_codex_home))? != canonical_existing(&codex_home)?
        {
            return Err(HarnessFailure::new("t2_contract_invalid"));
        }

        Ok(Self {
            codex_path: canonical_existing(&codex_path)?,
            codex_home: canonical_existing(&codex_home)?,
            expected_source,
            expected_source_text,
            evidence_path,
        })
    }
}

fn run_harness(contract: Contract) -> Result<Evidence, HarnessFailure> {
    if contract.codex_home.join("auth.json").exists() {
        return Err(HarnessFailure::new("t2_home_not_isolated"));
    }

    let inventory = discover_codex_candidates();
    let matching_indexes = inventory
        .candidates
        .iter()
        .enumerate()
        .filter_map(|(index, candidate)| {
            canonical_existing(candidate.command.path())
                .ok()
                .filter(|path| path == &contract.codex_path)
                .map(|_| index)
        })
        .collect::<Vec<_>>();
    if matching_indexes.len() != 1 {
        return Err(HarnessFailure::new("t2_expected_candidate_missing"));
    }

    let matching_index = matching_indexes[0];
    let discovered_candidate = &inventory.candidates[matching_index];
    if !discovered_candidate
        .discovered_from
        .contains(&contract.expected_source)
        || discovered_candidate.primary_source() != contract.expected_source
    {
        return Err(HarnessFailure::new("t2_source_mismatch"));
    }

    let inventory = probe_candidates(inventory);
    let selection = select_candidates(&inventory);
    if selection.state != CliState::Ready {
        return Err(HarnessFailure::new("t2_candidate_probe_failed"));
    }
    let selected_index = selection
        .selected_index
        .ok_or_else(|| HarnessFailure::new("t2_candidate_probe_failed"))?;

    let candidate = inventory
        .candidates
        .get(selected_index)
        .ok_or_else(|| HarnessFailure::new("t2_candidate_probe_failed"))?;
    if canonical_existing(candidate.command.path())? != contract.codex_path
        || selected_index != matching_index
    {
        return Err(HarnessFailure::new("t2_unexpected_candidate_selected"));
    }
    if !candidate.is_compatible()
        || !matches!(
            candidate.compatibility,
            Compatibility::Supported | Compatibility::UntestedNewer
        )
        || !candidate.capabilities.login_status
        || !candidate.capabilities.app_server
    {
        return Err(HarnessFailure::new("t2_capability_mismatch"));
    }
    let version = candidate
        .version
        .as_ref()
        .map(ToString::to_string)
        .ok_or_else(|| HarnessFailure::new("t2_version_missing"))?;

    let auth = probe_auth(Some(&candidate.command));
    if auth.state != AuthState::Unauthenticated || auth.safe_error_code.is_some() {
        return Err(HarnessFailure::new("t2_auth_mismatch"));
    }
    if contract.codex_home.join("auth.json").exists() {
        return Err(HarnessFailure::new("t2_home_not_isolated"));
    }

    let dto = setup_dto(&inventory, &selection, &auth);
    let selected = dto
        .selected
        .ok_or_else(|| HarnessFailure::new("t2_candidate_probe_failed"))?;
    if selected.source != contract.expected_source
        || selected.version.as_deref() != Some(version.as_str())
        || selected.provenance == ProvenanceConfidence::Invalid
        || dto.auth.state != AuthState::Unauthenticated
        || dto.safe_error_code.is_some()
    {
        return Err(HarnessFailure::new("t2_dto_mismatch"));
    }

    Ok(Evidence {
        schema_version: 1,
        selected_expected_candidate: true,
        selected_source: contract.expected_source_text.to_owned(),
        selected_version: version,
        provenance: enum_text(selected.provenance)?,
        auth_state: enum_text(dto.auth.state)?,
        safe_error_code: None,
    })
}

fn required_path(name: &str) -> Result<PathBuf, HarnessFailure> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| HarnessFailure::new("t2_contract_invalid"))
}

fn required_text(name: &str) -> Result<String, HarnessFailure> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| HarnessFailure::new("t2_contract_invalid"))
}

fn parse_expected_source(value: &str) -> Result<(CandidateSource, &'static str), HarnessFailure> {
    match value {
        "default_standalone_path" => Ok((
            CandidateSource::DefaultStandalonePath,
            "default_standalone_path",
        )),
        "custom_install_dir" => Ok((CandidateSource::CustomInstallDir, "custom_install_dir")),
        _ => Err(HarnessFailure::new("t2_contract_invalid")),
    }
}

fn canonical_existing(path: &Path) -> Result<PathBuf, HarnessFailure> {
    fs::canonicalize(path).map_err(|_| HarnessFailure::new("t2_contract_invalid"))
}

fn file_name_is_codex_exe(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("codex.exe"))
}

fn enum_text(value: impl Serialize) -> Result<String, HarnessFailure> {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| HarnessFailure::new("t2_evidence_invalid"))
}

fn serialize_evidence(evidence: &Evidence) -> Result<String, HarnessFailure> {
    let value =
        serde_json::to_value(evidence).map_err(|_| HarnessFailure::new("t2_evidence_invalid"))?;
    let object = value
        .as_object()
        .ok_or_else(|| HarnessFailure::new("t2_evidence_invalid"))?;
    let mut keys = object.keys().map(String::as_str).collect::<Vec<_>>();
    keys.sort_unstable();
    let mut expected = vec![
        "auth_state",
        "provenance",
        "safe_error_code",
        "schema_version",
        "selected_expected_candidate",
        "selected_source",
        "selected_version",
    ];
    expected.sort_unstable();
    if keys != expected {
        return Err(HarnessFailure::new("t2_evidence_invalid"));
    }
    serde_json::to_string(&value).map_err(|_| HarnessFailure::new("t2_evidence_invalid"))
}

fn write_evidence(path: &Path, serialized: &str) -> Result<(), HarnessFailure> {
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(path)
        .map_err(|_| HarnessFailure::new("t2_evidence_write_failed"))?;
    file.write_all(serialized.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|_| HarnessFailure::new("t2_evidence_write_failed"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expected_sources_are_explicitly_allowlisted() {
        assert_eq!(
            parse_expected_source("default_standalone_path")
                .expect("default source")
                .0,
            CandidateSource::DefaultStandalonePath
        );
        assert_eq!(
            parse_expected_source("custom_install_dir")
                .expect("custom source")
                .0,
            CandidateSource::CustomInstallDir
        );
        assert!(parse_expected_source("current_path").is_err());
        assert!(parse_expected_source("").is_err());
    }

    #[test]
    fn evidence_schema_is_fixed_and_contains_no_diagnostic_payloads() {
        let evidence = Evidence {
            schema_version: 1,
            selected_expected_candidate: true,
            selected_source: "default_standalone_path".to_owned(),
            selected_version: "0.146.0".to_owned(),
            provenance: "unverified".to_owned(),
            auth_state: "unauthenticated".to_owned(),
            safe_error_code: None,
        };
        let serialized = serialize_evidence(&evidence).expect("safe evidence");
        let value: serde_json::Value = serde_json::from_str(&serialized).expect("valid JSON");
        assert_eq!(value.as_object().expect("object").len(), 7);
        assert_eq!(value["selected_expected_candidate"], true);
        assert_eq!(value["auth_state"], "unauthenticated");
        for forbidden in [
            "canonicalpath",
            "canonical_path",
            "stdout",
            "stderr",
            "command",
            "credential",
            "token",
            "auth.json",
            r"c:\users",
        ] {
            assert!(
                !serialized.to_ascii_lowercase().contains(forbidden),
                "evidence leaked forbidden text: {forbidden}"
            );
        }
    }

    #[test]
    fn failure_evidence_cannot_report_a_successful_selection() {
        let evidence = Evidence::failure(Some("custom_install_dir"), "t2_auth_mismatch");
        assert!(!evidence.selected_expected_candidate);
        assert_eq!(evidence.selected_version, "unknown");
        assert_eq!(evidence.provenance, "invalid");
        assert_eq!(evidence.auth_state, "error");
        assert_eq!(
            evidence.safe_error_code.as_deref(),
            Some("t2_auth_mismatch")
        );
    }
}
