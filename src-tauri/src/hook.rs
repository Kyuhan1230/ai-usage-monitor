use crate::storage::{
    append_history_if_changed, data_dir, home_dir, now_kst_iso, read_json, write_json,
};
use chrono::Utc;
use serde_json::{Map, Value, json};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

fn clamp_percent(value: &Value) -> Option<i64> {
    value
        .as_f64()
        .map(|number| number.round().clamp(0.0, 100.0) as i64)
}

fn read_percent(limit: &Map<String, Value>) -> Option<(i64, i64)> {
    for key in [
        "used_percentage",
        "usedPercentage",
        "used_percent",
        "usedPercent",
    ] {
        if let Some(used) = limit.get(key).and_then(clamp_percent) {
            return Some((used, 100 - used));
        }
    }
    for key in [
        "remaining_percentage",
        "remainingPercentage",
        "remaining_percent",
        "remainingPercent",
    ] {
        if let Some(remaining) = limit.get(key).and_then(clamp_percent) {
            return Some((100 - remaining, remaining));
        }
    }
    None
}

fn reset_text(limit: &Map<String, Value>) -> Option<String> {
    for (key, value) in limit {
        if !key.to_ascii_lowercase().contains("reset")
            && !key.to_ascii_lowercase().contains("expire")
            && !key.to_ascii_lowercase().contains("renew")
        {
            continue;
        }
        if let Some(epoch) = value.as_i64() {
            let epoch = if epoch > 1_000_000_000_000 {
                epoch / 1000
            } else {
                epoch
            };
            return crate::collector::build_codex_status(
                &json!({"rateLimits": {"primary": {"usedPercent": 0, "windowDurationMins": 300, "resetsAt": epoch}}}),
            )["limits"][0]["reset_text"]
                .as_str()
                .map(str::to_string);
        }
        if let Some(text) = value.as_str() {
            return Some(text.to_string());
        }
    }
    None
}

pub fn build_hook_status(raw: &str) -> Value {
    let payload = serde_json::from_str::<Value>(raw).unwrap_or_else(|_| json!({}));
    let rate_limits = ["rate_limits", "rateLimits", "limits"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(Value::as_object));
    let limits = ["five_hour", "seven_day"]
        .iter()
        .filter_map(|kind| {
            let limit = rate_limits?.get(*kind)?.as_object()?;
            let (used, remaining) = read_percent(limit)?;
            Some(json!({
                "type": kind,
                "used_percent": used,
                "remaining_percent": remaining,
                "reset_text": reset_text(limit)
            }))
        })
        .collect::<Vec<_>>();
    json!({
        "schema_version": 1,
        "captured_at": now_kst_iso(),
        "source": "claude_statusline_hook",
        "capture_method": "claude_statusline_hook",
        "parse_status": if limits.is_empty() { "failed" } else { "ok" },
        "limits": limits,
        "raw_status_text": ""
    })
}

fn status_time(status: &Value) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    let heartbeat = status
        .get("capture")
        .and_then(|value| value.get("heartbeat_at"))
        .and_then(Value::as_str)
        .or_else(|| status.get("captured_at").and_then(Value::as_str))?;
    chrono::DateTime::parse_from_rfc3339(heartbeat).ok()
}

fn should_preserve_usage(status: Option<&Value>) -> bool {
    let Some(status) = status else {
        return false;
    };
    if status.get("capture_method").and_then(Value::as_str) != Some("claude_usage_command") {
        return false;
    }
    status_time(status)
        .is_some_and(|captured| Utc::now().signed_duration_since(captured).num_minutes() <= 10)
}

fn summary(status: &Value) -> String {
    let Some(limits) = status.get("limits").and_then(Value::as_array) else {
        return "Claude limits: N/A".to_string();
    };
    if limits.is_empty() {
        return "Claude limits: N/A".to_string();
    }
    limits
        .iter()
        .filter_map(|limit| {
            let label = match limit.get("type").and_then(Value::as_str) {
                Some("five_hour") => "5h",
                Some("seven_day") => "7d",
                _ => return None,
            };
            let used = limit.get("used_percent").and_then(Value::as_i64)?;
            Some(format!("{label}:{used}% used"))
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn run_cli_hook() -> Result<(), String> {
    let status_path = data_dir().join("claude-status.json");
    let history_dir = data_dir().join("history");
    let mut raw = String::new();
    io::stdin()
        .read_to_string(&mut raw)
        .map_err(|error| error.to_string())?;
    let status = build_hook_status(&raw);
    let previous = read_json(&status_path);
    if !should_preserve_usage(previous.as_ref()) {
        write_json(&status_path, &status)?;
        append_history_if_changed(&history_dir, &status, previous.as_ref())?;
    }
    println!("{}", summary(&status));
    Ok(())
}

pub fn settings_path() -> PathBuf {
    home_dir().join(".claude").join("settings.json")
}

pub fn hook_installed() -> bool {
    read_json(&settings_path())
        .and_then(|settings| settings.get("statusLine").cloned())
        .and_then(|line| {
            line.get("command")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .is_some_and(|command| command.contains("--claude-status-hook"))
}

fn backup_path(path: &Path) -> PathBuf {
    let stamp = now_kst_iso().replace([':', '+'], "-");
    PathBuf::from(format!("{}.backup-{stamp}", path.display()))
}

pub fn install_hook(executable: &Path, force: bool) -> Result<Value, String> {
    let path = settings_path();
    let mut settings = read_json(&path).unwrap_or_else(|| json!({}));
    if !settings.is_object() {
        return Err("Claude settings.json이 객체가 아닙니다.".to_string());
    }
    let existing = settings
        .get("statusLine")
        .and_then(|line| line.get("command"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let managed = existing
        .as_deref()
        .is_some_and(|command| command.contains("--claude-status-hook"));
    if existing
        .as_deref()
        .is_some_and(|command| !command.trim().is_empty())
        && !managed
        && !force
    {
        return Ok(json!({"status": "replacement_required", "existingCommand": existing}));
    }
    let mut backup = None;
    if force && existing.is_some() && path.exists() {
        let destination = backup_path(&path);
        fs::copy(&path, &destination).map_err(|error| error.to_string())?;
        backup = Some(destination.display().to_string());
    }
    let command = format!("\"{}\" --claude-status-hook", executable.display());
    settings
        .as_object_mut()
        .expect("checked settings object")
        .insert(
            "statusLine".into(),
            json!({"type": "command", "command": command}),
        );
    write_json(&path, &settings)?;
    Ok(json!({
        "status": "installed",
        "existingCommand": existing,
        "backupPath": backup
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statusline_payload_drops_raw_content() {
        let status = build_hook_status(
            r#"{"rate_limits":{"five_hour":{"used_percentage":35},"seven_day":{"remaining_percentage":22}}}"#,
        );
        assert_eq!(status["limits"][0]["remaining_percent"], 65);
        assert_eq!(status["limits"][1]["remaining_percent"], 22);
        assert_eq!(status["raw_status_text"], "");
    }
}
