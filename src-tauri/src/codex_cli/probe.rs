use crate::codex_cli::discovery::CandidateInventory;
use crate::codex_cli::error::SetupSafeErrorCode;
use crate::codex_cli::process_tree::{ChildWindow, JobLifetime, spawn_in_process_tree};
use crate::codex_cli::types::{
    AuthDto, AuthProbe, AuthState, CandidateDto, CandidateRejection, CandidateSource,
    CapabilitySet, CliState, CodexCandidate, CodexSetupDto, Compatibility, LauncherType,
    ProvenanceConfidence, SelectedCodex, SelectionResult, candidate_safe_error,
    source_display_label,
};
use semver::Version;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const AUTH_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_OUTPUT_BYTES: usize = 16 * 1024;
const MAX_NPM_LAUNCHER_BYTES: u64 = 16 * 1024;
const MAX_PARALLEL_CANDIDATES: usize = 4;
const READER_JOIN_GRACE: Duration = Duration::from_secs(1);
// @openai/codex/codex-cli/package.json declares `engines.node: >=16` (verified 2026-07-30).
const MIN_NODE_VERSION: (u64, u64, u64) = (16, 0, 0);
const KNOWN_UNAUTHENTICATED_TEXT: &str = "Not logged in";

#[derive(Debug)]
struct BoundedOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    truncated: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessFailure {
    Spawn,
    Wait,
    Timeout,
}

#[derive(Clone, Debug)]
struct ProbeOutcome {
    version: Option<Version>,
    capabilities: CapabilitySet,
    compatibility: Compatibility,
    rejection: Option<CandidateRejection>,
}

pub(crate) fn probe_candidates(mut inventory: CandidateInventory) -> CandidateInventory {
    let mut probed = Vec::with_capacity(inventory.candidates.len());
    for chunk in inventory.candidates.chunks(MAX_PARALLEL_CANDIDATES) {
        let outcomes = thread::scope(|scope| {
            chunk
                .iter()
                .cloned()
                .map(|candidate| scope.spawn(move || probe_candidate(candidate)))
                .collect::<Vec<_>>()
                .into_iter()
                .map(|handle| handle.join().expect("Codex candidate probe panicked"))
                .collect::<Vec<_>>()
        });
        probed.extend(outcomes);
    }
    inventory.candidates = probed;
    inventory
}

fn probe_candidate(mut candidate: CodexCandidate) -> CodexCandidate {
    if candidate.rejection.is_some() {
        return candidate;
    }

    if is_npm_codex_launcher(&candidate.command) {
        match probe_node_runtime(&candidate.command) {
            Ok(()) => {}
            Err(CandidateRejection::RuntimeDependencyMissing) => {
                candidate.compatibility = Compatibility::RuntimeDependencyMissing;
                candidate.rejection = Some(CandidateRejection::RuntimeDependencyMissing);
                return candidate;
            }
            Err(_) => {
                candidate.compatibility = Compatibility::RuntimeDependencyIncompatible;
                candidate.rejection = Some(CandidateRejection::RuntimeDependencyIncompatible);
                return candidate;
            }
        }
    }

    let outcome = probe_operational_contract(&candidate.command);
    if !candidate.command.identity_unchanged() {
        candidate.version = None;
        candidate.capabilities = CapabilitySet::default();
        candidate.compatibility = Compatibility::Invalid;
        candidate.rejection = Some(CandidateRejection::NotExecutable);
        return candidate;
    }
    candidate.version = outcome.version;
    candidate.capabilities = outcome.capabilities;
    candidate.compatibility = outcome.compatibility;
    candidate.rejection = outcome.rejection;
    candidate
}

fn probe_operational_contract(command: &SelectedCodex) -> ProbeOutcome {
    let version_output = match run_candidate(command, &["--version"], PROBE_TIMEOUT) {
        Ok(output) if output.status.success() && !output.truncated => output,
        Ok(_) => {
            return ProbeOutcome {
                version: None,
                capabilities: CapabilitySet::default(),
                compatibility: Compatibility::Invalid,
                rejection: Some(CandidateRejection::VersionUnrecognized),
            };
        }
        Err(ProcessFailure::Timeout) => {
            return ProbeOutcome {
                version: None,
                capabilities: CapabilitySet::default(),
                compatibility: Compatibility::Invalid,
                rejection: Some(CandidateRejection::ProbeTimeout),
            };
        }
        Err(_) => {
            return ProbeOutcome {
                version: None,
                capabilities: CapabilitySet::default(),
                compatibility: Compatibility::Invalid,
                rejection: Some(CandidateRejection::NotExecutable),
            };
        }
    };
    let version_text = bounded_text(&version_output);
    let Some(version) = parse_codex_version(&version_text) else {
        return ProbeOutcome {
            version: None,
            capabilities: CapabilitySet::default(),
            compatibility: Compatibility::Invalid,
            rejection: Some(CandidateRejection::VersionUnrecognized),
        };
    };

    let login_help = run_candidate(command, &["login", "--help"], PROBE_TIMEOUT);
    let app_server_help = run_candidate(command, &["app-server", "--help"], PROBE_TIMEOUT);
    let mut capabilities = CapabilitySet::default();
    if let Ok(output) = login_help
        && output.status.success()
        && !output.truncated
    {
        let text = bounded_text(&output);
        capabilities.login_status = help_has_status_subcommand(&text);
        capabilities.device_auth = text.contains("--device-auth");
    }
    if let Ok(output) = app_server_help
        && output.status.success()
        && !output.truncated
    {
        capabilities.app_server = bounded_text(&output)
            .to_ascii_lowercase()
            .contains("app-server");
    }

    if !capabilities.login_status || !capabilities.app_server {
        return ProbeOutcome {
            version: Some(version),
            capabilities,
            compatibility: Compatibility::Unsupported,
            rejection: Some(CandidateRejection::CapabilityMissing),
        };
    }
    ProbeOutcome {
        version: Some(version),
        capabilities,
        compatibility: Compatibility::Supported,
        rejection: None,
    }
}

pub(crate) fn probe_auth(selected: Option<&SelectedCodex>) -> AuthProbe {
    let Some(selected) = selected else {
        return AuthProbe {
            state: AuthState::Unavailable,
            safe_error_code: None,
        };
    };
    match run_candidate(selected, &["login", "status"], AUTH_TIMEOUT) {
        Ok(output) if output.status.success() => AuthProbe {
            state: AuthState::Authenticated,
            safe_error_code: None,
        },
        Ok(output) if is_known_unauthenticated(&output) => AuthProbe {
            state: AuthState::Unauthenticated,
            safe_error_code: None,
        },
        Ok(_) => AuthProbe {
            state: AuthState::Error,
            safe_error_code: Some(SetupSafeErrorCode::AuthProbeFailed),
        },
        Err(ProcessFailure::Timeout) => AuthProbe {
            state: AuthState::Error,
            safe_error_code: Some(SetupSafeErrorCode::AuthProbeTimeout),
        },
        Err(_) => AuthProbe {
            state: AuthState::Error,
            safe_error_code: Some(SetupSafeErrorCode::AuthProbeFailed),
        },
    }
}

pub(crate) fn select_candidates(inventory: &CandidateInventory) -> SelectionResult {
    let compatible = inventory
        .candidates
        .iter()
        .enumerate()
        .filter(|(_, candidate)| candidate.is_compatible())
        .collect::<Vec<_>>();
    if compatible.is_empty() {
        return no_compatible_selection(inventory);
    }

    let best_rank = compatible
        .iter()
        .map(|(_, candidate)| selection_rank(candidate))
        .min()
        .expect("compatible candidates are non-empty");
    let best = compatible
        .iter()
        .filter(|(_, candidate)| selection_rank(candidate) == best_rank)
        .map(|(index, _)| *index)
        .collect::<Vec<_>>();
    if best.len() != 1 {
        return SelectionResult {
            state: CliState::Conflict,
            selected_index: None,
            conflict_count: compatible.len(),
            safe_error_code: Some(SetupSafeErrorCode::CandidateConflict),
        };
    }
    SelectionResult {
        state: CliState::Ready,
        selected_index: best.first().copied(),
        conflict_count: ready_conflict_count(inventory, best[0]),
        safe_error_code: None,
    }
}

pub(crate) fn ready_conflict_count(inventory: &CandidateInventory, selected_index: usize) -> usize {
    inventory
        .candidates
        .iter()
        .enumerate()
        .filter(|(index, candidate)| {
            *index != selected_index
                && (candidate.is_compatible()
                    || candidate
                        .discovered_from
                        .contains(&CandidateSource::LegacyNpm))
        })
        .count()
}

pub(crate) fn setup_dto(
    inventory: &CandidateInventory,
    selection: &SelectionResult,
    auth: &AuthProbe,
) -> CodexSetupDto {
    let candidate_namespace = uuid::Uuid::new_v4().simple().to_string();
    let mut source_ordinals = BTreeMap::<CandidateSource, usize>::new();
    let candidates = inventory
        .candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            let source = candidate.primary_source();
            let ordinal = source_ordinals.entry(source).or_default();
            *ordinal += 1;
            CandidateDto {
                candidate_id: format!("candidate-{candidate_namespace}-{}", index + 1),
                candidate_tag: format!("CLI-A{}", index + 1),
                display_label: source_display_label(source, *ordinal),
                source,
                launcher: candidate.command.launcher(),
                version: candidate.version.as_ref().map(ToString::to_string),
                compatibility: candidate.compatibility,
                provenance: candidate.provenance,
                safe_error_code: candidate_safe_error(candidate.rejection),
            }
        })
        .collect::<Vec<_>>();
    CodexSetupDto {
        cli_state: selection.state,
        selected: selection
            .selected_index
            .and_then(|index| candidates.get(index).cloned()),
        candidate_count: candidates.len(),
        candidates,
        conflict_count: selection.conflict_count,
        device_auth_supported: selection
            .selected_index
            .and_then(|index| inventory.candidates.get(index))
            .is_some_and(|candidate| candidate.capabilities.device_auth),
        auth: AuthDto {
            state: auth.state,
            safe_error_code: auth.safe_error_code,
        },
        safe_error_code: selection.safe_error_code,
    }
}

fn no_compatible_selection(inventory: &CandidateInventory) -> SelectionResult {
    let has_rejection = |rejection| {
        inventory
            .candidates
            .iter()
            .any(|candidate| candidate.rejection == Some(rejection))
    };
    let (state, safe_error_code) = if has_rejection(CandidateRejection::RuntimeDependencyMissing) {
        (
            CliState::RuntimeDependencyMissing,
            SetupSafeErrorCode::RuntimeDependencyMissing,
        )
    } else if has_rejection(CandidateRejection::RuntimeDependencyIncompatible) {
        (
            CliState::RuntimeDependencyIncompatible,
            SetupSafeErrorCode::RuntimeDependencyIncompatible,
        )
    } else if inventory.candidates.iter().any(|candidate| {
        matches!(
            candidate.rejection,
            Some(CandidateRejection::VersionUnsupported | CandidateRejection::CapabilityMissing)
        )
    }) {
        (
            CliState::Unsupported,
            SetupSafeErrorCode::CandidateUnsupported,
        )
    } else if !inventory.candidates.is_empty() {
        (
            CliState::InvalidCandidate,
            inventory
                .candidates
                .iter()
                .find_map(|candidate| candidate_safe_error(candidate.rejection))
                .unwrap_or(SetupSafeErrorCode::CandidateNotExecutable),
        )
    } else if inventory.desktop_bundle_count > 0 || inventory.execution_alias_count > 0 {
        (
            CliState::DesktopBundleOnly,
            SetupSafeErrorCode::DesktopBundleOnly,
        )
    } else if inventory.path_refresh_failed {
        (CliState::ProbeError, SetupSafeErrorCode::PathRefreshFailed)
    } else {
        (CliState::Missing, SetupSafeErrorCode::CodexNotFound)
    };
    SelectionResult {
        state,
        selected_index: None,
        conflict_count: 0,
        safe_error_code: Some(safe_error_code),
    }
}

fn selection_rank(candidate: &CodexCandidate) -> u8 {
    if candidate.discovered_from.contains(&CandidateSource::Manual) {
        return 0;
    }
    match candidate.provenance {
        ProvenanceConfidence::VerifiedPublisher => return 1,
        ProvenanceConfidence::TrackedOfficialInstall => return 2,
        ProvenanceConfidence::Invalid | ProvenanceConfidence::Unverified => {}
    }
    if candidate
        .discovered_from
        .contains(&CandidateSource::DefaultStandalonePath)
    {
        3
    } else if candidate
        .discovered_from
        .contains(&CandidateSource::CustomInstallDir)
        || candidate
            .discovered_from
            .contains(&CandidateSource::UserPath)
    {
        4
    } else if candidate
        .discovered_from
        .contains(&CandidateSource::CurrentPath)
    {
        5
    } else if candidate
        .discovered_from
        .contains(&CandidateSource::MachinePath)
        || candidate
            .discovered_from
            .contains(&CandidateSource::LocalBin)
    {
        6
    } else {
        7
    }
}

fn is_npm_codex_launcher(command: &SelectedCodex) -> bool {
    if command.launcher() != LauncherType::Cmd
        || !command
            .path()
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("codex.cmd"))
    {
        return false;
    }
    let Some(prefix) = command.path().parent() else {
        return false;
    };
    if !prefix
        .join("node_modules/@openai/codex/bin/codex.js")
        .is_file()
    {
        return false;
    }

    let Ok(file) = std::fs::File::open(command.path()) else {
        return false;
    };
    let mut bytes = Vec::with_capacity(MAX_NPM_LAUNCHER_BYTES as usize);
    if file
        .take(MAX_NPM_LAUNCHER_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > MAX_NPM_LAUNCHER_BYTES
    {
        return false;
    }
    let Ok(text) = String::from_utf8(bytes) else {
        return false;
    };
    let normalized = text.replace('\\', "/").to_ascii_lowercase();
    normalized.contains("node_modules/@openai/codex/bin/codex.js")
        && (normalized.contains("%dp0%") || normalized.contains("%~dp0"))
        && (normalized.contains("%dp0%/node.exe")
            || normalized.contains("%~dp0/node.exe")
            || normalized.contains("%~dp0node.exe"))
}

fn probe_node_runtime(command: &SelectedCodex) -> Result<(), CandidateRejection> {
    let child_path = command.child_path();
    let adjacent_node = command
        .path()
        .parent()
        .map(|prefix| prefix.join("node.exe"));
    let node = match adjacent_node {
        Some(path) if path.is_file() => path,
        Some(path) if path.exists() => {
            return Err(CandidateRejection::RuntimeDependencyIncompatible);
        }
        _ => find_on_path(child_path, &["node.exe", "node"])
            .ok_or(CandidateRejection::RuntimeDependencyMissing)?,
    };
    let version_output = run_executable(&node, &["--version"], child_path, PROBE_TIMEOUT)
        .map_err(|_| CandidateRejection::RuntimeDependencyIncompatible)?;
    let architecture_output =
        run_executable(&node, &["-p", "process.arch"], child_path, PROBE_TIMEOUT)
            .map_err(|_| CandidateRejection::RuntimeDependencyIncompatible)?;
    if !version_output.status.success() || !architecture_output.status.success() {
        return Err(CandidateRejection::RuntimeDependencyIncompatible);
    }
    node_runtime_compatible(
        &bounded_text(&version_output),
        &bounded_text(&architecture_output),
        expected_node_architecture(),
    )
    .then_some(())
    .ok_or(CandidateRejection::RuntimeDependencyIncompatible)
}

fn node_runtime_compatible(version: &str, architecture: &str, expected_architecture: &str) -> bool {
    let version = version.trim().trim_start_matches('v');
    let Ok(version) = Version::parse(version) else {
        return false;
    };
    let minimum = Version::new(MIN_NODE_VERSION.0, MIN_NODE_VERSION.1, MIN_NODE_VERSION.2);
    version >= minimum && architecture.trim() == expected_architecture
}

fn expected_node_architecture() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        value => value,
    }
}

fn find_on_path(path: &std::ffi::OsString, names: &[&str]) -> Option<PathBuf> {
    std::env::split_paths(path)
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|candidate| candidate.is_file())
}

fn parse_codex_version(text: &str) -> Option<Version> {
    text.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let product = fields.next()?.to_ascii_lowercase();
        if product != "codex-cli" && product != "codex" {
            return None;
        }
        let version = fields.next()?.trim_start_matches('v');
        (fields.next().is_none())
            .then(|| Version::parse(version).ok())
            .flatten()
    })
}

fn help_has_status_subcommand(text: &str) -> bool {
    text.lines().any(|line| {
        let trimmed = line.trim_start();
        trimmed == "status"
            || trimmed
                .strip_prefix("status")
                .is_some_and(|suffix| suffix.starts_with(char::is_whitespace))
    })
}

fn is_known_unauthenticated(output: &BoundedOutput) -> bool {
    is_known_unauthenticated_result(
        output.status.code(),
        output.truncated,
        &bounded_text(output),
    )
}

fn is_known_unauthenticated_result(exit_code: Option<i32>, truncated: bool, output: &str) -> bool {
    exit_code == Some(1)
        && !truncated
        && output.lines().map(str::trim).rfind(|line| !line.is_empty())
            == Some(KNOWN_UNAUTHENTICATED_TEXT)
}

fn bounded_text(output: &BoundedOutput) -> String {
    let mut bytes = Vec::with_capacity(output.stdout.len() + output.stderr.len() + 1);
    bytes.extend_from_slice(&output.stdout);
    if !output.stdout.is_empty() && !output.stderr.is_empty() {
        bytes.push(b'\n');
    }
    bytes.extend_from_slice(&output.stderr);
    String::from_utf8_lossy(&bytes).into_owned()
}

fn run_candidate(
    selected: &SelectedCodex,
    arguments: &[&str],
    timeout: Duration,
) -> Result<BoundedOutput, ProcessFailure> {
    let mut command =
        command_for_selected(selected, arguments).map_err(|_| ProcessFailure::Spawn)?;
    command.stdin(Stdio::null());
    run_bounded(command, timeout, MAX_OUTPUT_BYTES)
}

pub(crate) fn selected_login_command(
    selected: &SelectedCodex,
    device_auth: bool,
) -> std::io::Result<Command> {
    if device_auth {
        command_for_selected(selected, &["login", "--device-auth"])
    } else {
        command_for_selected(selected, &["login"])
    }
}

pub(crate) fn selected_app_server_command(selected: &SelectedCodex) -> std::io::Result<Command> {
    command_for_selected(selected, &["app-server", "--listen", "stdio://"])
}

fn command_for_selected(selected: &SelectedCodex, arguments: &[&str]) -> std::io::Result<Command> {
    if !selected.identity_unchanged() {
        return Err(std::io::Error::other(
            "selected Codex file identity changed",
        ));
    }
    let mut command = match selected.launcher() {
        LauncherType::Cmd | LauncherType::Bat => {
            let mut command = Command::new("cmd.exe");
            configure_cmd_launcher(&mut command, selected, arguments);
            command
        }
        LauncherType::Exe | LauncherType::Extensionless => {
            let mut command = Command::new(selected.path());
            command.args(arguments);
            command
        }
    };
    command.env("PATH", selected.child_path());
    Ok(command)
}

#[cfg(windows)]
fn configure_cmd_launcher(command: &mut Command, selected: &SelectedCodex, arguments: &[&str]) {
    use std::os::windows::process::CommandExt;

    // These are fixed backend-owned probe tokens, never renderer or shell input.
    debug_assert!(arguments.iter().all(|argument| {
        argument.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'/' | b'.')
        })
    }));
    // `/S /C` strips the outer quote pair; keep a second pair around the expanded target.
    // Expanding the target exactly once preserves literal `%NAME%` path segments.
    let mut command_text = "\"\"%AI_USAGE_MONITOR_CODEX_CLI_TARGET%\"".to_string();
    for argument in arguments {
        command_text.push(' ');
        command_text.push_str(argument);
    }
    command_text.push('"');
    // `raw_arg` is required for cmd.exe: ordinary Windows argv quoting turns the embedded
    // quotes into literal `\"`, which breaks paths containing spaces or metacharacters.
    command
        .args(["/D", "/V:OFF", "/S", "/C"])
        .raw_arg(command_text)
        .env(
            "AI_USAGE_MONITOR_CODEX_CLI_TARGET",
            cmd_compatible_path(selected.path()),
        );
}

#[cfg(not(windows))]
fn configure_cmd_launcher(command: &mut Command, selected: &SelectedCodex, arguments: &[&str]) {
    let mut command_text = "\"\"%AI_USAGE_MONITOR_CODEX_CLI_TARGET%\"".to_string();
    for argument in arguments {
        command_text.push(' ');
        command_text.push_str(argument);
    }
    command_text.push('"');
    command
        .args(["/D", "/V:OFF", "/S", "/C"])
        .arg(command_text)
        .env(
            "AI_USAGE_MONITOR_CODEX_CLI_TARGET",
            cmd_compatible_path(selected.path()),
        );
}

#[cfg(windows)]
fn cmd_compatible_path(path: &Path) -> std::ffi::OsString {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    const VERBATIM_PREFIX: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    const VERBATIM_UNC_PREFIX: &[u16] = &[
        b'\\' as u16,
        b'\\' as u16,
        b'?' as u16,
        b'\\' as u16,
        b'U' as u16,
        b'N' as u16,
        b'C' as u16,
        b'\\' as u16,
    ];

    let wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    if let Some(rest) = wide.strip_prefix(VERBATIM_UNC_PREFIX) {
        let mut compatible = vec![b'\\' as u16, b'\\' as u16];
        compatible.extend_from_slice(rest);
        return std::ffi::OsString::from_wide(&compatible);
    }
    if let Some(rest) = wide.strip_prefix(VERBATIM_PREFIX) {
        return std::ffi::OsString::from_wide(rest);
    }
    path.as_os_str().to_owned()
}

#[cfg(not(windows))]
fn cmd_compatible_path(path: &Path) -> std::ffi::OsString {
    path.as_os_str().to_owned()
}

fn run_executable(
    executable: &Path,
    arguments: &[&str],
    child_path: &std::ffi::OsString,
    timeout: Duration,
) -> Result<BoundedOutput, ProcessFailure> {
    let mut command = Command::new(executable);
    command
        .args(arguments)
        .env("PATH", child_path)
        .stdin(Stdio::null());
    run_bounded(command, timeout, MAX_OUTPUT_BYTES)
}

fn run_bounded(
    mut command: Command,
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<BoundedOutput, ProcessFailure> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let (mut child, process_tree) =
        spawn_in_process_tree(command, ChildWindow::Hidden, JobLifetime::KillOnDrop)
            .map_err(|_| ProcessFailure::Spawn)?;
    let stdout = child.stdout.take().ok_or(ProcessFailure::Spawn)?;
    let stderr = child.stderr.take().ok_or(ProcessFailure::Spawn)?;
    let per_stream_limit = max_output_bytes / 2;
    let stdout_thread = thread::spawn(move || read_and_drain(stdout, per_stream_limit));
    let stderr_thread = thread::spawn(move || read_and_drain(stderr, per_stream_limit));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !process_tree.terminate_and_wait(&mut child) {
                    return Err(ProcessFailure::Wait);
                }
                break status;
            }
            Ok(None) if Instant::now() >= deadline => {
                let terminated = process_tree.terminate_and_wait(&mut child);
                let join_deadline = Instant::now() + READER_JOIN_GRACE;
                let _ = join_thread_by(stdout_thread, join_deadline);
                let _ = join_thread_by(stderr_thread, join_deadline);
                return Err(if terminated {
                    ProcessFailure::Timeout
                } else {
                    ProcessFailure::Wait
                });
            }
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(_) => {
                let _ = process_tree.terminate_and_wait(&mut child);
                let join_deadline = Instant::now() + READER_JOIN_GRACE;
                let _ = join_thread_by(stdout_thread, join_deadline);
                let _ = join_thread_by(stderr_thread, join_deadline);
                return Err(ProcessFailure::Wait);
            }
        }
    };
    let join_deadline = Instant::now() + READER_JOIN_GRACE;
    let (stdout, stdout_truncated) =
        join_thread_by(stdout_thread, join_deadline).ok_or(ProcessFailure::Wait)?;
    let (stderr, stderr_truncated) =
        join_thread_by(stderr_thread, join_deadline).ok_or(ProcessFailure::Wait)?;
    Ok(BoundedOutput {
        status,
        stdout,
        stderr,
        truncated: stdout_truncated || stderr_truncated,
    })
}

fn join_thread_by<T>(handle: thread::JoinHandle<T>, deadline: Instant) -> Option<T> {
    while !handle.is_finished() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    handle.is_finished().then(|| handle.join().ok()).flatten()
}

fn read_and_drain(mut reader: impl Read, limit: usize) -> (Vec<u8>, bool) {
    let mut kept = Vec::with_capacity(limit);
    let mut buffer = [0_u8; 4096];
    let mut truncated = false;
    while let Ok(read) = reader.read(&mut buffer) {
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(kept.len());
        let take = remaining.min(read);
        kept.extend_from_slice(&buffer[..take]);
        truncated |= take < read;
    }
    (kept, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::fs;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn candidate(path: PathBuf, source: CandidateSource, launcher: LauncherType) -> CodexCandidate {
        candidate_with_child_path(
            path,
            source,
            launcher,
            std::env::var_os("PATH").unwrap_or_default(),
        )
    }

    fn candidate_with_child_path(
        path: PathBuf,
        source: CandidateSource,
        launcher: LauncherType,
        child_path: std::ffi::OsString,
    ) -> CodexCandidate {
        let mut sources = BTreeSet::new();
        sources.insert(source);
        CodexCandidate {
            command: SelectedCodex::new(path, child_path, launcher),
            discovered_from: sources,
            version: Some(Version::new(0, 144, 5)),
            capabilities: CapabilitySet {
                login_status: true,
                device_auth: true,
                app_server: true,
            },
            compatibility: Compatibility::Supported,
            provenance: ProvenanceConfidence::Unverified,
            rejection: None,
        }
    }

    fn inventory(candidates: Vec<CodexCandidate>) -> CandidateInventory {
        CandidateInventory {
            candidates,
            desktop_bundle_count: 0,
            execution_alias_count: 0,
            path_refresh_failed: false,
        }
    }

    fn unique_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock is after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "ai-usage-monitor-probe-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn npm_launcher_fixture(root: &Path) -> PathBuf {
        fs::create_dir_all(root.join("node_modules/@openai/codex/bin"))
            .expect("npm package fixture directory");
        fs::write(
            root.join("node_modules/@openai/codex/bin/codex.js"),
            b"// npm Codex entry point",
        )
        .expect("npm package entry point");
        let launcher = root.join("codex.cmd");
        fs::write(
            &launcher,
            b"@ECHO off\r\n\
              SET dp0=%~dp0\r\n\
              IF EXIST \"%dp0%\\node.exe\" (\r\n\
                SET \"_prog=%dp0%\\node.exe\"\r\n\
              ) ELSE (\r\n\
                SET \"_prog=node\"\r\n\
              )\r\n\
              \"%_prog%\" \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n",
        )
        .expect("npm launcher fixture");
        fs::canonicalize(launcher).expect("canonical npm launcher fixture")
    }

    #[test]
    fn version_parser_accepts_supported_semver_shapes_only() {
        assert_eq!(
            parse_codex_version("codex-cli 0.144.5"),
            Some(Version::new(0, 144, 5))
        );
        assert_eq!(
            parse_codex_version("warning\ncodex-cli 0.145.0-beta.1+build.2"),
            Some(Version::parse("0.145.0-beta.1+build.2").unwrap())
        );
        assert_eq!(parse_codex_version("unrelated 0.144.5"), None);
        assert_eq!(parse_codex_version("codex-cli newest"), None);
        assert_eq!(parse_codex_version("codex-cli 0.144.5 extra"), None);
    }

    #[test]
    fn node_runtime_requires_version_16_and_matching_architecture() {
        assert!(node_runtime_compatible("v16.0.0", "x64", "x64"));
        assert!(node_runtime_compatible("v22.12.0", "arm64", "arm64"));
        assert!(!node_runtime_compatible("v15.99.0", "x64", "x64"));
        assert!(!node_runtime_compatible("v22.12.0", "ia32", "x64"));
        assert!(!node_runtime_compatible("garbage", "x64", "x64"));
    }

    #[test]
    fn npm_runtime_detection_is_independent_of_discovery_source() {
        let root = unique_root("npm source classification");
        let launcher = npm_launcher_fixture(&root);

        for source in [
            CandidateSource::CurrentPath,
            CandidateSource::CustomInstallDir,
            CandidateSource::Manual,
        ] {
            let probed = probe_candidate(candidate_with_child_path(
                launcher.clone(),
                source,
                LauncherType::Cmd,
                std::ffi::OsString::new(),
            ));
            assert_eq!(
                probed.rejection,
                Some(CandidateRejection::RuntimeDependencyMissing),
                "{source:?} npm launcher must diagnose its missing Node runtime"
            );
            assert_eq!(
                probed.compatibility,
                Compatibility::RuntimeDependencyMissing
            );
        }

        fs::remove_dir_all(root).expect("npm source fixture is removed");
    }

    #[test]
    fn npm_runtime_detection_rejects_arbitrary_cmd_and_standalone_exe() {
        let root = unique_root("npm false positives");
        fs::create_dir_all(root.join("node_modules/@openai/codex/bin"))
            .expect("false-positive fixture directory");
        fs::write(
            root.join("node_modules/@openai/codex/bin/codex.js"),
            b"// unrelated adjacent file",
        )
        .expect("false-positive adjacent file");

        let arbitrary_cmd = root.join("codex.cmd");
        fs::write(&arbitrary_cmd, b"@ECHO off\r\necho codex-cli 0.144.5\r\n")
            .expect("arbitrary cmd fixture");
        let arbitrary_cmd = SelectedCodex::new(
            fs::canonicalize(arbitrary_cmd).expect("canonical arbitrary cmd"),
            std::ffi::OsString::new(),
            LauncherType::Cmd,
        );
        assert!(!is_npm_codex_launcher(&arbitrary_cmd));

        let standalone_exe = root.join("codex.exe");
        fs::write(
            &standalone_exe,
            b"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js",
        )
        .expect("standalone exe fixture");
        let standalone_exe = SelectedCodex::new(
            fs::canonicalize(standalone_exe).expect("canonical standalone exe"),
            std::ffi::OsString::new(),
            LauncherType::Exe,
        );
        assert!(!is_npm_codex_launcher(&standalone_exe));

        fs::remove_dir_all(root).expect("false-positive fixture is removed");
    }

    #[test]
    fn npm_runtime_prefers_launcher_local_node_and_maps_probe_failure_to_incompatible() {
        let root = unique_root("npm local node");
        let launcher = npm_launcher_fixture(&root);
        fs::copy(
            std::env::current_exe().expect("current test executable"),
            root.join("node.exe"),
        )
        .expect("unusable local node fixture");

        let probed = probe_candidate(candidate_with_child_path(
            launcher,
            CandidateSource::CustomInstallDir,
            LauncherType::Cmd,
            std::ffi::OsString::new(),
        ));
        assert_eq!(
            probed.rejection,
            Some(CandidateRejection::RuntimeDependencyIncompatible)
        );
        assert_eq!(
            probed.compatibility,
            Compatibility::RuntimeDependencyIncompatible
        );

        fs::remove_dir_all(root).expect("local node fixture is removed");
    }

    #[test]
    fn unauthenticated_requires_exact_last_line_exit_one_and_complete_output() {
        assert!(is_known_unauthenticated_result(
            Some(1),
            false,
            "harmless warning\n\n Not logged in \r\n"
        ));
        assert!(!is_known_unauthenticated_result(
            Some(1),
            true,
            "Not logged in"
        ));
        assert!(!is_known_unauthenticated_result(
            Some(2),
            false,
            "Not logged in"
        ));
        assert!(!is_known_unauthenticated_result(
            Some(1),
            false,
            "Not logged in\nunexpected failure"
        ));
        assert!(!is_known_unauthenticated_result(
            Some(1),
            false,
            "not logged in"
        ));
    }

    #[test]
    fn default_standalone_wins_over_legacy_but_equal_priority_stops() {
        let default = candidate(
            PathBuf::from(r"C:\default\codex.exe"),
            CandidateSource::DefaultStandalonePath,
            LauncherType::Exe,
        );
        let legacy = candidate(
            PathBuf::from(r"C:\npm\codex.cmd"),
            CandidateSource::LegacyNpm,
            LauncherType::Cmd,
        );
        let result = select_candidates(&inventory(vec![legacy.clone(), default]));
        assert_eq!(result.state, CliState::Ready);
        assert_eq!(result.selected_index, Some(1));
        assert_eq!(result.conflict_count, 1);

        let other_legacy = candidate(
            PathBuf::from(r"D:\npm\codex.cmd"),
            CandidateSource::LegacyNpm,
            LauncherType::Cmd,
        );
        let result = select_candidates(&inventory(vec![legacy, other_legacy]));
        assert_eq!(result.state, CliState::Conflict);
        assert_eq!(result.selected_index, None);
        assert_eq!(
            result.safe_error_code,
            Some(SetupSafeErrorCode::CandidateConflict)
        );
    }

    #[test]
    fn selected_standalone_warns_about_an_incompatible_legacy_npm_candidate() {
        let standalone = candidate(
            PathBuf::from(r"C:\standalone\codex.exe"),
            CandidateSource::DefaultStandalonePath,
            LauncherType::Exe,
        );
        let mut outdated_legacy = candidate(
            PathBuf::from(r"C:\npm\codex.cmd"),
            CandidateSource::LegacyNpm,
            LauncherType::Cmd,
        );
        outdated_legacy.compatibility = Compatibility::RuntimeDependencyIncompatible;
        outdated_legacy.rejection = Some(CandidateRejection::RuntimeDependencyIncompatible);
        let inventory = inventory(vec![standalone, outdated_legacy]);

        let selection = select_candidates(&inventory);
        assert_eq!(selection.state, CliState::Ready);
        assert_eq!(selection.selected_index, Some(0));
        assert_eq!(selection.conflict_count, 1);
    }

    #[test]
    fn selection_is_independent_of_input_order_when_the_best_source_is_unique() {
        let default = candidate(
            PathBuf::from(r"C:\default\codex.exe"),
            CandidateSource::DefaultStandalonePath,
            LauncherType::Exe,
        );
        let current = candidate(
            PathBuf::from(r"C:\path\codex.exe"),
            CandidateSource::CurrentPath,
            LauncherType::Exe,
        );
        for candidates in [
            vec![default.clone(), current.clone()],
            vec![current, default],
        ] {
            let inventory = inventory(candidates);
            let selection = select_candidates(&inventory);
            let selected = &inventory.candidates[selection.selected_index.unwrap()];
            assert!(
                selected
                    .discovered_from
                    .contains(&CandidateSource::DefaultStandalonePath)
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn capability_compatible_fake_cli_has_no_numeric_version_floor() {
        // `call` would parse the expanded command a second time and remove or expand the
        // literal `%...%` path segment, so this fixture also guards same-candidate execution.
        let root = unique_root("fake cli %AUM_TEST_PERCENT_LITERAL_7429% 한글 & (괄호)");
        fs::create_dir_all(&root).expect("fixture directory is created");
        let script = root.join("codex.cmd");
        let arguments = root.join("arguments.txt");
        let script_text = "@echo off\r\n\
             echo %*>>\"%~dp0arguments.txt\"\r\n\
             if \"%~1\"==\"--version\" goto version\r\n\
             if \"%~1\"==\"login\" if \"%~2\"==\"--help\" goto loginhelp\r\n\
             if \"%~1\"==\"login\" if \"%~2\"==\"--device-auth\" goto loginrun\r\n\
             if \"%~1\"==\"login\" if \"%~2\"==\"\" goto loginrun\r\n\
             if \"%~1\"==\"app-server\" if \"%~2\"==\"--help\" goto apphelp\r\n\
             if \"%~1\"==\"app-server\" if \"%~2\"==\"--listen\" if \"%~3\"==\"stdio://\" goto appserverrun\r\n\
             if \"%~1\"==\"login\" if \"%~2\"==\"status\" goto status\r\n\
             exit /b 91\r\n\
             :version\r\n\
             echo codex-cli 0.1.0\r\n\
             exit /b 0\r\n\
             :loginhelp\r\n\
             echo Usage: codex login\r\n\
             echo   status  Show login status\r\n\
             echo   --device-auth\r\n\
             exit /b 0\r\n\
             :apphelp\r\n\
             echo Usage: codex app-server\r\n\
             exit /b 0\r\n\
             :status\r\n\
             echo Not logged in\r\n\
             exit /b 1\r\n\
             :loginrun\r\n\
             exit /b 0\r\n\
             :appserverrun\r\n\
             exit /b 0\r\n";
        fs::write(&script, script_text).expect("fixture is written");
        let mut candidate = candidate(
            fs::canonicalize(&script).expect("fixture path is canonicalized like production"),
            CandidateSource::CurrentPath,
            LauncherType::Cmd,
        );
        candidate.version = None;
        candidate.capabilities = CapabilitySet::default();
        candidate.compatibility = Compatibility::Invalid;

        let probed = probe_candidate(candidate);
        assert!(probed.is_compatible(), "{:?}", probed.rejection);
        assert_eq!(probed.version, Some(Version::new(0, 1, 0)));
        assert!(probed.capabilities.login_status);
        assert!(probed.capabilities.device_auth);
        assert!(probed.capabilities.app_server);
        let auth = probe_auth(Some(&probed.command));
        assert_eq!(auth.state, AuthState::Unauthenticated);
        for device_auth in [true, false] {
            let mut login = selected_login_command(&probed.command, device_auth)
                .expect("identity is unchanged");
            let status = login
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .expect("interactive login builder starts");
            assert!(status.success());
        }
        let mut app_server =
            selected_app_server_command(&probed.command).expect("identity is unchanged");
        let status = app_server
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("app-server builder starts");
        assert!(status.success());
        let recorded = fs::read_to_string(arguments).expect("arguments are recorded");
        assert_eq!(
            recorded.lines().collect::<Vec<_>>(),
            [
                "--version",
                "login --help",
                "app-server --help",
                "login status",
                "login --device-auth",
                "login",
                "app-server --listen stdio://"
            ]
        );
        fs::remove_dir_all(root).expect("fixture is removed");
    }

    #[test]
    fn setup_dto_contains_no_internal_path_or_auth_output() {
        let inventory = inventory(vec![candidate(
            PathBuf::from(r"C:\Users\secret\codex.exe"),
            CandidateSource::DefaultStandalonePath,
            LauncherType::Exe,
        )]);
        let selection = select_candidates(&inventory);
        let auth = AuthProbe {
            state: AuthState::Error,
            safe_error_code: Some(SetupSafeErrorCode::AuthProbeFailed),
        };
        let serialized = serde_json::to_string(&setup_dto(&inventory, &selection, &auth)).unwrap();
        assert!(!serialized.contains("secret"));
        assert!(!serialized.contains("Not logged in"));
        assert!(serialized.contains("auth_probe_failed"));
    }

    #[test]
    fn candidate_ids_are_opaque_and_scoped_to_one_setup_snapshot() {
        let inventory = inventory(vec![candidate(
            PathBuf::from(r"C:\safe\codex.exe"),
            CandidateSource::DefaultStandalonePath,
            LauncherType::Exe,
        )]);
        let selection = select_candidates(&inventory);
        let auth = AuthProbe {
            state: AuthState::Authenticated,
            safe_error_code: None,
        };

        let first = setup_dto(&inventory, &selection, &auth);
        let second = setup_dto(&inventory, &selection, &auth);
        let first_id = &first.candidates[0].candidate_id;
        let second_id = &second.candidates[0].candidate_id;

        assert_ne!(first_id, second_id);
        assert_eq!(
            first
                .selected
                .as_ref()
                .map(|candidate| &candidate.candidate_id),
            Some(first_id)
        );
        assert!(first_id.starts_with("candidate-"));
        assert!(first_id.len() <= 128);
        assert!(
            first_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        );
    }

    #[test]
    fn every_selected_command_refuses_a_changed_file_identity() {
        let root = unique_root("identity-change");
        fs::create_dir_all(&root).expect("fixture directory");
        let script = root.join("codex.cmd");
        fs::write(&script, b"@exit /b 0\r\n").expect("fixture command");
        let selected = SelectedCodex::new(
            fs::canonicalize(&script).expect("canonical fixture"),
            std::env::var_os("PATH").unwrap_or_default(),
            LauncherType::Cmd,
        );
        assert!(selected.identity_unchanged());
        fs::write(&script, b"@echo replacement\r\n@exit /b 0\r\n").expect("changed command");

        assert!(selected_login_command(&selected, false).is_err());
        assert!(selected_login_command(&selected, true).is_err());
        assert!(selected_app_server_command(&selected).is_err());
        assert_eq!(
            run_candidate(&selected, &["--version"], Duration::from_secs(1))
                .expect_err("probe refuses changed identity"),
            ProcessFailure::Spawn
        );
        fs::remove_dir_all(root).expect("fixture is removed");
    }

    #[cfg(windows)]
    #[test]
    fn job_object_reaps_cmd_node_grandchildren_after_normal_timeout_and_cancel() {
        fn process_is_running(process_id: u32) -> bool {
            use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
            use windows::Win32::System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            };

            // SAFETY: the PID comes from the child itself; the returned handle is closed below.
            let Ok(handle) =
                (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) })
            else {
                return false;
            };
            let mut exit_code = 0_u32;
            // SAFETY: `exit_code` is writable and `handle` remains open for this call.
            let queried =
                unsafe { GetExitCodeProcess(handle, std::ptr::addr_of_mut!(exit_code)) }.is_ok();
            // SAFETY: this scope owns the process handle.
            let _ = unsafe { CloseHandle(handle) };
            queried && exit_code == STILL_ACTIVE.0 as u32
        }

        fn fixture(mode: &str) -> (PathBuf, PathBuf, PathBuf, SelectedCodex) {
            let launcher_root = unique_root(&format!("job tree 한글 {mode}"));
            let worker_root = unique_root(&format!("job-worker-{mode}"));
            fs::create_dir_all(&launcher_root).expect("launcher fixture directory");
            fs::create_dir_all(&worker_root).expect("worker fixture directory");
            let parent_script = worker_root.join("parent.js");
            fs::write(
                &parent_script,
                r#""use strict";
const fs = require("fs");
const { spawn } = require("child_process");
const hold = setInterval(() => {}, 1000);
const grandchild = spawn(
  process.argv[2],
  [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    "Start-Sleep -Seconds 60"
  ],
  { stdio: "ignore", windowsHide: true }
);
grandchild.once("error", () => process.exit(71));
if (!grandchild.pid) process.exit(71);
fs.writeFileSync(process.argv[3], String(grandchild.pid));
grandchild.unref();
if (process.argv[4] === "normal") clearInterval(hold);
"#,
            )
            .expect("Node parent");
            let pid_path = worker_root.join("grandchild.pid");
            let launcher = launcher_root.join("codex.cmd");
            fs::write(
                &launcher,
                format!(
                    "@echo off\r\n\
                     if /I not \"%~1\"==\"--version\" exit /b 87\r\n\
                     node.exe \"{}\" \"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" \"{}\" \"{mode}\"\r\n\
                     exit /b %errorlevel%\r\n",
                    parent_script.display(),
                    pid_path.display()
                ),
            )
            .expect("cmd launcher");
            let selected = SelectedCodex::new(
                fs::canonicalize(&launcher).expect("canonical launcher"),
                std::env::var_os("PATH").unwrap_or_default(),
                LauncherType::Cmd,
            );
            (launcher_root, worker_root, pid_path, selected)
        }

        fn wait_for_descendant_pid(pid_path: &Path) -> u32 {
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                if let Some(process_id) = fs::read_to_string(pid_path)
                    .ok()
                    .and_then(|text| text.trim().parse::<u32>().ok())
                {
                    return process_id;
                }
                assert!(
                    Instant::now() < deadline,
                    "Node parent did not write a complete grandchild PID"
                );
                thread::sleep(Duration::from_millis(10));
            }
        }

        for (mode, timeout, expected) in [
            // These deadlines cover a deliberately layered cmd -> Node ->
            // PowerShell fixture on contended hosted runners. Production probe
            // deadlines are independently enforced by PROBE_TIMEOUT/AUTH_TIMEOUT.
            ("normal", Duration::from_secs(15), Ok(())),
            (
                "timeout",
                Duration::from_secs(15),
                Err(ProcessFailure::Timeout),
            ),
        ] {
            let (launcher_root, worker_root, pid_path, selected) = fixture(mode);
            let result = run_candidate(&selected, &["--version"], timeout);
            match expected {
                Ok(()) => {
                    let output = result.expect("normal process completes");
                    assert!(output.status.success(), "normal process exit status");
                }
                Err(expected_failure) => {
                    assert_eq!(
                        result.expect_err("bounded process must fail"),
                        expected_failure,
                        "{mode} process result"
                    );
                }
            }
            let process_id = wait_for_descendant_pid(&pid_path);
            assert!(
                !process_is_running(process_id),
                "{mode} left Node's grandchild {process_id} running"
            );
            fs::remove_dir_all(launcher_root).expect("launcher fixture is removed");
            fs::remove_dir_all(worker_root).expect("worker fixture is removed");
        }

        let (launcher_root, worker_root, pid_path, selected) = fixture("cancel");
        let mut command =
            command_for_selected(&selected, &["--version"]).expect("cancel command is valid");
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let (mut child, process_tree) =
            spawn_in_process_tree(command, ChildWindow::Hidden, JobLifetime::DetachOnDrop)
                .expect("cancel fixture starts");
        let process_id = wait_for_descendant_pid(&pid_path);
        assert!(
            process_is_running(process_id),
            "cancel fixture descendant was not running before termination"
        );
        let terminated = process_tree.terminate_and_wait(&mut child);
        assert!(terminated, "cancel terminated and reaped the process tree");
        assert!(
            !process_is_running(process_id),
            "cancel left Node's grandchild {process_id} running"
        );
        fs::remove_dir_all(launcher_root).expect("launcher fixture is removed");
        fs::remove_dir_all(worker_root).expect("worker fixture is removed");
    }

    #[test]
    fn output_reader_discards_bytes_after_its_limit_while_draining() {
        let input = vec![b'x'; 1024];
        let (kept, truncated) = read_and_drain(input.as_slice(), 16);
        assert_eq!(kept.len(), 16);
        assert!(truncated);
        let mut sink = Vec::new();
        sink.write_all(&kept).unwrap();
        assert_eq!(sink.len(), 16);
    }
}
