use crate::codex_cli::types::{
    CandidateRejection, CandidateSource, CapabilitySet, CodexCandidate, Compatibility,
    LauncherType, ProvenanceConfidence, SelectedCodex,
};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const COMMAND_NAMES: [&str; 4] = ["codex", "codex.exe", "codex.cmd", "codex.bat"];

#[derive(Clone, Debug)]
pub(crate) struct CandidateInventory {
    pub(crate) candidates: Vec<CodexCandidate>,
    pub(crate) desktop_bundle_count: usize,
    pub(crate) execution_alias_count: usize,
    pub(crate) path_refresh_failed: bool,
}

#[derive(Clone, Debug, Default)]
struct DiscoveryInputs {
    process_environment: BTreeMap<String, OsString>,
    user_environment: BTreeMap<String, OsString>,
    machine_environment: BTreeMap<String, OsString>,
    where_candidates: Vec<PathBuf>,
    manual_candidates: Vec<PathBuf>,
    path_refresh_failed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DesktopCandidate {
    PackagedResource,
    ExecutionAlias,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExpansionError {
    Cycle,
    Unresolved,
}

#[allow(dead_code)]
pub(crate) fn discover_codex_candidates() -> CandidateInventory {
    discover_from_inputs(DiscoveryInputs::load())
}

pub(crate) fn discover_codex_candidates_with_manual(
    manual_candidates: Vec<PathBuf>,
) -> CandidateInventory {
    let mut inputs = DiscoveryInputs::load();
    inputs.manual_candidates = manual_candidates;
    discover_from_inputs(inputs)
}

impl DiscoveryInputs {
    fn load() -> Self {
        let process_environment = normalized_environment(std::env::vars_os());
        let where_candidates = where_candidates();
        let (user_environment, machine_environment, path_refresh_failed) = registry_environments();
        Self {
            process_environment,
            user_environment,
            machine_environment,
            where_candidates,
            manual_candidates: Vec::new(),
            path_refresh_failed,
        }
    }
}

fn discover_from_inputs(inputs: DiscoveryInputs) -> CandidateInventory {
    let effective_environment = effective_environment(&inputs);
    let child_path = effective_child_path(&inputs, &effective_environment);
    let local_app_data = environment_path(&effective_environment, "LOCALAPPDATA");
    let app_data = environment_path(&effective_environment, "APPDATA");
    let user_profile = environment_path(&effective_environment, "USERPROFILE");
    let program_files = environment_path(&effective_environment, "PROGRAMFILES");

    let mut raw_candidates = Vec::<(PathBuf, CandidateSource)>::new();
    raw_candidates.extend(
        inputs
            .where_candidates
            .iter()
            .cloned()
            .map(|path| (path, CandidateSource::CurrentPath)),
    );
    collect_path_candidates(
        inputs.process_environment.get("PATH"),
        CandidateSource::CurrentPath,
        &effective_environment,
        &mut raw_candidates,
    );
    collect_path_candidates(
        inputs.user_environment.get("PATH"),
        CandidateSource::UserPath,
        &effective_environment,
        &mut raw_candidates,
    );
    collect_path_candidates(
        inputs.machine_environment.get("PATH"),
        CandidateSource::MachinePath,
        &effective_environment,
        &mut raw_candidates,
    );

    if let Some(root) = local_app_data.as_ref() {
        raw_candidates.push((
            root.join("Programs/OpenAI/Codex/bin/codex.exe"),
            CandidateSource::DefaultStandalonePath,
        ));
    }
    if let Some(root) = app_data.as_ref() {
        raw_candidates.push((root.join("npm/codex.cmd"), CandidateSource::LegacyNpm));
    }
    if let Some(root) = user_profile.as_ref() {
        raw_candidates.push((root.join(".local/bin/codex.exe"), CandidateSource::LocalBin));
    }

    for environment in [
        &inputs.process_environment,
        &inputs.user_environment,
        &inputs.machine_environment,
    ] {
        if let Some(raw) = environment.get("CODEX_INSTALL_DIR")
            && let Ok(expanded) = expand_environment_value(raw, &effective_environment)
        {
            collect_install_dir_candidates(
                &expanded,
                CandidateSource::CustomInstallDir,
                &mut raw_candidates,
            );
        }
    }
    raw_candidates.extend(
        inputs
            .manual_candidates
            .iter()
            .cloned()
            .map(|path| (path, CandidateSource::Manual)),
    );

    let mut merged = BTreeMap::<String, CodexCandidate>::new();
    let mut desktop_bundle_count = 0;
    let mut execution_alias_count = 0;

    for (path, source) in raw_candidates {
        match classify_desktop_candidate(&path, local_app_data.as_deref(), program_files.as_deref())
        {
            Some(DesktopCandidate::PackagedResource) => {
                desktop_bundle_count += 1;
                continue;
            }
            Some(DesktopCandidate::ExecutionAlias) => {
                execution_alias_count += 1;
                continue;
            }
            None => {}
        }

        if launcher_type(&path).is_none() || !path.exists() {
            continue;
        }
        let canonical = fs::canonicalize(&path).unwrap_or_else(|_| lexical_absolute_path(&path));
        match classify_desktop_candidate(
            &canonical,
            local_app_data.as_deref(),
            program_files.as_deref(),
        ) {
            Some(DesktopCandidate::PackagedResource) => {
                desktop_bundle_count += 1;
                continue;
            }
            Some(DesktopCandidate::ExecutionAlias) => {
                execution_alias_count += 1;
                continue;
            }
            None => {}
        }
        let Some(launcher) = launcher_type(&canonical) else {
            continue;
        };
        let rejection = preliminary_rejection(&canonical);
        let key = windows_path_key(&canonical);
        let candidate = merged.entry(key).or_insert_with(|| CodexCandidate {
            command: SelectedCodex::new(canonical, child_path.clone(), launcher),
            discovered_from: BTreeSet::new(),
            version: None,
            capabilities: CapabilitySet::default(),
            compatibility: Compatibility::Invalid,
            provenance: ProvenanceConfidence::Unverified,
            rejection,
        });
        candidate.discovered_from.insert(source);
        if candidate.rejection.is_none() {
            candidate.rejection = rejection;
        }
    }

    CandidateInventory {
        candidates: merged.into_values().collect(),
        desktop_bundle_count,
        execution_alias_count,
        path_refresh_failed: inputs.path_refresh_failed,
    }
}

fn collect_path_candidates(
    raw_path: Option<&OsString>,
    source: CandidateSource,
    environment: &BTreeMap<String, OsString>,
    output: &mut Vec<(PathBuf, CandidateSource)>,
) {
    let Some(raw_path) = raw_path else {
        return;
    };
    for raw_entry in std::env::split_paths(raw_path) {
        let trimmed = trim_path_entry(&raw_entry);
        let Ok(expanded) = expand_environment_value(trimmed.as_os_str(), environment) else {
            continue;
        };
        if !is_absolute_windows_path(&expanded) {
            continue;
        }
        for name in COMMAND_NAMES {
            output.push((expanded.join(name), source));
        }
    }
}

fn collect_install_dir_candidates(
    raw: &Path,
    source: CandidateSource,
    output: &mut Vec<(PathBuf, CandidateSource)>,
) {
    let root = trim_path_entry(raw);
    if !is_absolute_windows_path(&root) {
        return;
    }
    if root.is_file() && launcher_type(&root).is_some() {
        output.push((root.clone(), source));
    }
    for name in COMMAND_NAMES {
        output.push((root.join(name), source));
        output.push((root.join("bin").join(name), source));
    }
}

fn preliminary_rejection(path: &Path) -> Option<CandidateRejection> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => Some(CandidateRejection::Directory),
        Ok(metadata) if metadata.len() == 0 => Some(CandidateRejection::EmptyFile),
        Ok(_) => None,
        Err(_) => Some(CandidateRejection::NotExecutable),
    }
}

fn launcher_type(path: &Path) -> Option<LauncherType> {
    match path
        .extension()
        .and_then(OsStr::to_str)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("exe") => Some(LauncherType::Exe),
        Some("cmd") => Some(LauncherType::Cmd),
        Some("bat") => Some(LauncherType::Bat),
        Some(_) => None,
        None => Some(LauncherType::Extensionless),
    }
}

fn classify_desktop_candidate(
    path: &Path,
    local_app_data: Option<&Path>,
    program_files: Option<&Path>,
) -> Option<DesktopCandidate> {
    let normalized = windows_path_key(path);
    let file_name = path
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let is_codex_name = file_name == "codex" || file_name == "codex.exe";

    if is_codex_name && let Some(local_app_data) = local_app_data {
        let alias_root = windows_path_key(&local_app_data.join("Microsoft/WindowsApps"));
        if windows_path_key(path.parent().unwrap_or_else(|| Path::new(""))) == alias_root {
            return Some(DesktopCandidate::ExecutionAlias);
        }
    }

    if is_codex_name && let Some(program_files) = program_files {
        let package_root = format!(
            "{}\\windowsapps\\openai.codex_",
            windows_path_key(program_files).trim_end_matches('\\')
        );
        if normalized.starts_with(&package_root) && normalized.contains("\\app\\resources\\codex") {
            return Some(DesktopCandidate::PackagedResource);
        }
    }
    None
}

fn effective_environment(inputs: &DiscoveryInputs) -> BTreeMap<String, OsString> {
    let mut result = inputs.machine_environment.clone();
    for (name, value) in &inputs.user_environment {
        result.insert(name.clone(), value.clone());
    }
    for (name, value) in &inputs.process_environment {
        result.insert(name.clone(), value.clone());
    }
    result
}

fn effective_child_path(
    inputs: &DiscoveryInputs,
    environment: &BTreeMap<String, OsString>,
) -> OsString {
    let mut seen = BTreeSet::new();
    let mut paths = Vec::new();
    for raw_path in [
        inputs.process_environment.get("PATH"),
        inputs.user_environment.get("PATH"),
        inputs.machine_environment.get("PATH"),
    ]
    .into_iter()
    .flatten()
    {
        for raw_entry in std::env::split_paths(raw_path) {
            let trimmed = trim_path_entry(&raw_entry);
            let Ok(expanded) = expand_environment_value(trimmed.as_os_str(), environment) else {
                continue;
            };
            if !is_absolute_windows_path(&expanded) {
                continue;
            }
            if seen.insert(windows_path_key(&expanded)) {
                paths.push(expanded);
            }
        }
    }
    std::env::join_paths(paths).unwrap_or_else(|_| {
        inputs
            .process_environment
            .get("PATH")
            .cloned()
            .unwrap_or_default()
    })
}

fn environment_path(environment: &BTreeMap<String, OsString>, name: &str) -> Option<PathBuf> {
    let value = environment.get(&name.to_ascii_uppercase())?;
    let expanded = expand_environment_value(value, environment).ok()?;
    is_absolute_windows_path(&expanded).then_some(expanded)
}

fn normalized_environment<I>(values: I) -> BTreeMap<String, OsString>
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

fn expand_environment_value(
    value: &OsStr,
    environment: &BTreeMap<String, OsString>,
) -> Result<PathBuf, ExpansionError> {
    let mut current = value.to_string_lossy().into_owned();
    let mut seen = BTreeSet::new();
    for _ in 0..4 {
        if !seen.insert(current.to_ascii_lowercase()) {
            return Err(ExpansionError::Cycle);
        }
        let (expanded, changed, unresolved) = expand_once(&current, environment);
        if unresolved {
            return Err(ExpansionError::Unresolved);
        }
        if !changed || expanded == current {
            return Ok(PathBuf::from(expanded));
        }
        current = expanded;
    }
    if contains_variable_token(&current) {
        Err(ExpansionError::Unresolved)
    } else {
        Ok(PathBuf::from(current))
    }
}

fn expand_once(value: &str, environment: &BTreeMap<String, OsString>) -> (String, bool, bool) {
    let mut output = String::with_capacity(value.len());
    let mut cursor = 0;
    let mut changed = false;
    let mut unresolved = false;
    while let Some(relative_start) = value[cursor..].find('%') {
        let start = cursor + relative_start;
        output.push_str(&value[cursor..start]);
        let Some(relative_end) = value[start + 1..].find('%') else {
            output.push_str(&value[start..]);
            cursor = value.len();
            break;
        };
        let end = start + 1 + relative_end;
        let name = &value[start + 1..end];
        if name.is_empty() {
            output.push_str("%%");
        } else if let Some(replacement) = environment.get(&name.to_ascii_uppercase()) {
            output.push_str(&replacement.to_string_lossy());
            changed = true;
        } else {
            output.push_str(&value[start..=end]);
            unresolved = true;
        }
        cursor = end + 1;
    }
    if cursor < value.len() {
        output.push_str(&value[cursor..]);
    }
    (output, changed, unresolved)
}

fn contains_variable_token(value: &str) -> bool {
    let Some(start) = value.find('%') else {
        return false;
    };
    value[start + 1..].contains('%')
}

fn trim_path_entry(path: &Path) -> PathBuf {
    PathBuf::from(path.to_string_lossy().trim().trim_matches('"').to_string())
}

fn is_absolute_windows_path(path: &Path) -> bool {
    if path.is_absolute() {
        return true;
    }
    let text = path.to_string_lossy();
    let bytes = text.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/'))
        || text.starts_with(r"\\")
}

fn lexical_absolute_path(path: &Path) -> PathBuf {
    if is_absolute_windows_path(path) {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from(r"C:\"))
            .join(path)
    }
}

fn windows_path_key(path: &Path) -> String {
    let mut value = path
        .to_string_lossy()
        .replace('/', "\\")
        .trim()
        .trim_matches('"')
        .to_string();
    if let Some(stripped) = value.strip_prefix(r"\\?\") {
        value = stripped.to_string();
    }
    while value.len() > 3 && value.ends_with('\\') {
        value.pop();
    }
    value.to_ascii_lowercase()
}

#[cfg(windows)]
fn where_candidates() -> Vec<PathBuf> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut output = Vec::new();
    for name in ["codex.exe", "codex"] {
        let result = Command::new("where.exe")
            .arg(name)
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if let Ok(result) = result
            && result.status.success()
        {
            output.extend(
                String::from_utf8_lossy(&result.stdout)
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(PathBuf::from),
            );
        }
    }
    output
}

#[cfg(not(windows))]
fn where_candidates() -> Vec<PathBuf> {
    Vec::new()
}

#[cfg(windows)]
fn registry_environments() -> (BTreeMap<String, OsString>, BTreeMap<String, OsString>, bool) {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    let user = read_registry_environment(&RegKey::predef(HKEY_CURRENT_USER), "Environment");
    let machine = read_registry_environment(
        &RegKey::predef(HKEY_LOCAL_MACHINE),
        "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    );
    let failed = user.is_err() || machine.is_err();
    (
        user.unwrap_or_default(),
        machine.unwrap_or_default(),
        failed,
    )
}

#[cfg(windows)]
fn read_registry_environment(
    root: &winreg::RegKey,
    subkey: &str,
) -> std::io::Result<BTreeMap<String, OsString>> {
    let key = root.open_subkey(subkey)?;
    let mut values = BTreeMap::new();
    for value in key.enum_values().flatten() {
        let name = value.0;
        if let Ok(text) = key.get_value::<String, _>(&name) {
            values.insert(name.to_ascii_uppercase(), text.into());
        }
    }
    Ok(values)
}

#[cfg(not(windows))]
fn registry_environments() -> (BTreeMap<String, OsString>, BTreeMap<String, OsString>, bool) {
    (BTreeMap::new(), BTreeMap::new(), false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock is after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "ai-usage-monitor-discovery-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn environment(values: &[(&str, OsString)]) -> BTreeMap<String, OsString> {
        values
            .iter()
            .map(|(name, value)| (name.to_ascii_uppercase(), value.clone()))
            .collect()
    }

    #[test]
    fn nested_environment_values_expand_but_unknown_and_cycles_are_rejected() {
        let environment = environment(&[
            ("ROOT", OsString::from(r"C:\Users\tester")),
            ("BIN", OsString::from(r"%ROOT%\bin")),
            ("A", OsString::from("%B%")),
            ("B", OsString::from("%A%")),
        ]);

        assert_eq!(
            expand_environment_value(OsStr::new(r"%BIN%\codex.exe"), &environment)
                .expect("nested value expands"),
            PathBuf::from(r"C:\Users\tester\bin\codex.exe")
        );
        assert_eq!(
            expand_environment_value(OsStr::new(r"%UNKNOWN%\codex.exe"), &environment),
            Err(ExpansionError::Unresolved)
        );
        assert_eq!(
            expand_environment_value(OsStr::new(r"%A%\codex.exe"), &environment),
            Err(ExpansionError::Cycle)
        );
    }

    #[test]
    fn process_environment_wins_over_user_and_machine_values() {
        let inputs = DiscoveryInputs {
            process_environment: environment(&[("LOCALAPPDATA", OsString::from(r"C:\Process"))]),
            user_environment: environment(&[("LOCALAPPDATA", OsString::from(r"C:\User"))]),
            machine_environment: environment(&[("LOCALAPPDATA", OsString::from(r"C:\Machine"))]),
            ..DiscoveryInputs::default()
        };
        assert_eq!(
            effective_environment(&inputs).get("LOCALAPPDATA"),
            Some(&OsString::from(r"C:\Process"))
        );
    }

    #[test]
    fn alias_and_packaged_resource_are_classified_without_blocking_similar_user_paths() {
        let local = Path::new(r"C:\Users\tester\AppData\Local");
        let program_files = Path::new(r"C:\Program Files");
        assert_eq!(
            classify_desktop_candidate(
                Path::new(r"C:\Users\tester\AppData\Local\Microsoft\WindowsApps\codex.exe"),
                Some(local),
                Some(program_files)
            ),
            Some(DesktopCandidate::ExecutionAlias)
        );
        assert_eq!(
            classify_desktop_candidate(
                Path::new(
                    r"C:\Program Files\WindowsApps\OpenAI.Codex_1.0_x64__id\app\resources\codex.exe"
                ),
                Some(local),
                Some(program_files)
            ),
            Some(DesktopCandidate::PackagedResource)
        );
        assert_eq!(
            classify_desktop_candidate(
                Path::new(r"C:\Users\tester\WindowsApps\OpenAI.Codex_fake\app\resources\codex.exe"),
                Some(local),
                Some(program_files)
            ),
            None
        );
    }

    #[cfg(windows)]
    #[test]
    fn canonicalized_junction_into_packaged_resources_is_rejected() {
        let root = unique_root("packaged-junction");
        let local = root.join("Local");
        let program_files = root.join("Program Files");
        let packaged_resources = program_files
            .join("WindowsApps")
            .join("OpenAI.Codex_1.0_x64__id")
            .join("app")
            .join("resources");
        let junction = root.join("apparently-safe-bin");
        fs::create_dir_all(&local).expect("local app data fixture");
        fs::create_dir_all(&packaged_resources).expect("packaged resource fixture");
        fs::write(packaged_resources.join("codex.exe"), b"fixture")
            .expect("packaged executable fixture");
        let junction_status = Command::new("cmd.exe")
            .args([
                "/D",
                "/C",
                "mklink",
                "/J",
                junction.to_str().expect("junction path is UTF-8"),
                packaged_resources.to_str().expect("target path is UTF-8"),
            ])
            .status()
            .expect("junction command starts");
        assert!(junction_status.success(), "junction fixture is created");

        let inputs = DiscoveryInputs {
            process_environment: environment(&[
                ("LOCALAPPDATA", OsString::from(local.as_os_str())),
                ("PROGRAMFILES", OsString::from(program_files.as_os_str())),
            ]),
            where_candidates: vec![junction.join("codex.exe")],
            ..DiscoveryInputs::default()
        };
        let inventory = discover_from_inputs(inputs);

        assert!(inventory.candidates.is_empty());
        assert_eq!(inventory.desktop_bundle_count, 1);
        fs::remove_dir(&junction).expect("junction fixture is removed without traversing it");
        fs::remove_dir_all(root).expect("fixture is removed");
    }

    #[test]
    fn inventory_collects_custom_user_and_default_sources_and_deduplicates_them() {
        let root = unique_root("sources");
        let local = root.join("Local");
        let app_data = root.join("Roaming");
        let profile = root.join("Profile");
        let default_bin = local.join("Programs/OpenAI/Codex/bin");
        fs::create_dir_all(&default_bin).expect("default bin is created");
        fs::create_dir_all(&app_data).expect("app data is created");
        fs::create_dir_all(&profile).expect("profile is created");
        let executable = default_bin.join("codex.exe");
        fs::write(&executable, b"fixture").expect("fixture is written");

        let inputs = DiscoveryInputs {
            process_environment: environment(&[
                ("PATH", OsString::from(default_bin.as_os_str())),
                ("LOCALAPPDATA", OsString::from(local.as_os_str())),
                ("APPDATA", OsString::from(app_data.as_os_str())),
                ("USERPROFILE", OsString::from(profile.as_os_str())),
                (
                    "PROGRAMFILES",
                    OsString::from(root.join("Program Files").as_os_str()),
                ),
            ]),
            user_environment: environment(&[(
                "CODEX_INSTALL_DIR",
                OsString::from(default_bin.as_os_str()),
            )]),
            machine_environment: BTreeMap::new(),
            where_candidates: vec![executable.clone()],
            manual_candidates: Vec::new(),
            path_refresh_failed: false,
        };
        let inventory = discover_from_inputs(inputs);

        assert_eq!(inventory.candidates.len(), 1);
        let candidate = &inventory.candidates[0];
        assert!(
            candidate
                .discovered_from
                .contains(&CandidateSource::CurrentPath)
        );
        assert!(
            candidate
                .discovered_from
                .contains(&CandidateSource::DefaultStandalonePath)
        );
        assert!(
            candidate
                .discovered_from
                .contains(&CandidateSource::CustomInstallDir)
        );
        assert_eq!(
            candidate.command.path(),
            fs::canonicalize(&executable).unwrap()
        );

        fs::remove_dir_all(&root).expect("fixture is removed");
    }

    #[test]
    fn relative_and_unresolved_path_entries_do_not_become_candidates() {
        let inputs = DiscoveryInputs {
            process_environment: environment(&[(
                "PATH",
                OsString::from(r"relative-bin;%UNKNOWN%\bin"),
            )]),
            ..DiscoveryInputs::default()
        };

        assert!(discover_from_inputs(inputs).candidates.is_empty());
    }
}
