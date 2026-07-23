use chrono::{FixedOffset, Utc};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

pub fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn data_dir() -> PathBuf {
    #[cfg(feature = "updater-e2e")]
    {
        std::env::temp_dir().join("codex-claude-usage-updater-e2e")
    }
    #[cfg(not(feature = "updater-e2e"))]
    {
        home_dir().join(".codex-usage-wrapper")
    }
}

pub fn now_kst_iso() -> String {
    let offset = FixedOffset::east_opt(9 * 60 * 60).expect("valid KST offset");
    Utc::now()
        .with_timezone(&offset)
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

pub fn read_json(path: &Path) -> Option<Value> {
    let body = fs::read_to_string(path).ok()?;
    serde_json::from_str(body.trim_start_matches('\u{feff}')).ok()
}

pub fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(value).map_err(|error| error.to_string())?
    );
    fs::write(&temporary, body).map_err(|error| error.to_string())?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

pub fn append_history(history_dir: &Path, status: &Value) -> Result<(), String> {
    fs::create_dir_all(history_dir).map_err(|error| error.to_string())?;
    let date = status
        .get("captured_at")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .chars()
        .take(10)
        .collect::<String>();
    let path = history_dir.join(format!("{date}.jsonl"));
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    writeln!(
        file,
        "{}",
        serde_json::to_string(status).map_err(|error| error.to_string())?
    )
    .map_err(|error| error.to_string())
}

fn limit_signature(status: Option<&Value>) -> String {
    let signature = status
        .and_then(|value| value.get("limits"))
        .and_then(Value::as_array)
        .map(|limits| {
            limits
                .iter()
                .map(|limit| {
                    serde_json::json!({
                        "type": limit.get("type"),
                        "remaining": limit.get("remaining_percent"),
                        "reset": limit.get("resets_at").or_else(|| limit.get("reset_text")),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    serde_json::to_string(&signature).unwrap_or_default()
}

pub fn append_history_if_changed(
    history_dir: &Path,
    status: &Value,
    previous: Option<&Value>,
) -> Result<bool, String> {
    if status.get("parse_status").and_then(Value::as_str) != Some("ok") {
        return Ok(false);
    }
    if let Some(previous) = previous {
        let changed = limit_signature(Some(status)) != limit_signature(Some(previous));
        let previous_time = previous
            .get("captured_at")
            .and_then(Value::as_str)
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok());
        let current_time = status
            .get("captured_at")
            .and_then(Value::as_str)
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok());
        let silent_too_long = previous_time
            .zip(current_time)
            .is_some_and(|(before, after)| (after - before).num_minutes() >= 30);
        if !changed && !silent_too_long {
            return Ok(false);
        }
    }
    append_history(history_dir, status)?;
    Ok(true)
}

pub fn read_history(history_dir: &Path, maximum_files: usize) -> Vec<Value> {
    let mut names = match fs::read_dir(history_dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "jsonl")
            })
            .collect::<Vec<_>>(),
        Err(_) => return Vec::new(),
    };
    names.sort();
    let start = names.len().saturating_sub(maximum_files);
    names[start..]
        .iter()
        .flat_map(|path| read_json_lines(path))
        .collect()
}

pub fn read_json_lines(path: &Path) -> Vec<Value> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return Vec::new(),
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unchanged_history_is_deduplicated() {
        let root = std::env::temp_dir().join(format!("usage-storage-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let first = serde_json::json!({
            "captured_at": "2026-07-18T09:00:00+09:00",
            "parse_status": "ok",
            "limits": [{"type": "five_hour", "remaining_percent": 50}]
        });
        let same = serde_json::json!({
            "captured_at": "2026-07-18T09:10:00+09:00",
            "parse_status": "ok",
            "limits": [{"type": "five_hour", "remaining_percent": 50}]
        });
        assert!(append_history_if_changed(&root, &first, None).unwrap());
        assert!(!append_history_if_changed(&root, &same, Some(&first)).unwrap());
        assert_eq!(read_history(&root, 30).len(), 1);
        let _ = fs::remove_dir_all(root);
    }
}
