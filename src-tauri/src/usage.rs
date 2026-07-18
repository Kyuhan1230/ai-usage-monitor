use crate::storage::{home_dir, read_json_lines, write_json};
use chrono::FixedOffset;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    pub provider: String,
    pub date: String,
    pub model: String,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_output_tokens: u64,
    pub total_tokens: u64,
    pub events: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CacheEntry {
    provider: String,
    modified_ms: u64,
    size: u64,
    rows: Vec<UsageRow>,
}

#[derive(Default, Deserialize, Serialize)]
struct UsageCache {
    schema_version: u32,
    files: HashMap<String, CacheEntry>,
}

fn safe_integer(value: Option<&Value>) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(0)
}

fn kst_date(value: Option<&str>, fallback: &str) -> String {
    let Some(value) = value else {
        return fallback.to_string();
    };
    let Ok(timestamp) = chrono::DateTime::parse_from_rfc3339(value) else {
        return fallback.to_string();
    };
    let offset = FixedOffset::east_opt(9 * 60 * 60).expect("valid KST offset");
    timestamp
        .with_timezone(&offset)
        .format("%Y-%m-%d")
        .to_string()
}

fn list_jsonl_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                pending.push(path);
            } else if file_type.is_file() && path.extension().is_some_and(|value| value == "jsonl")
            {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

fn codex_date(record: &Value, file_path: &Path) -> String {
    let timestamp = record.get("timestamp").and_then(Value::as_str).or_else(|| {
        record
            .get("payload")
            .and_then(|payload| payload.get("timestamp"))
            .and_then(Value::as_str)
    });
    let fallback = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .and_then(|name| name.strip_prefix("rollout-"))
        .and_then(|name| name.get(..10))
        .unwrap_or("unknown");
    kst_date(timestamp, fallback)
}

fn codex_model(record: &Value) -> Option<&str> {
    let payload = record.get("payload")?;
    payload.get("model").and_then(Value::as_str).or_else(|| {
        payload
            .get("collaboration_mode")?
            .get("settings")?
            .get("model")?
            .as_str()
    })
}

fn codex_usage<'a>(record: &'a Value, key: &str) -> Option<&'a Value> {
    record.get("payload")?.get("info")?.get(key)?.as_object()?;
    record.get("payload")?.get("info")?.get(key)
}

fn codex_row(date: String, model: String, usage: &Value) -> UsageRow {
    UsageRow {
        provider: "codex".to_string(),
        date,
        model,
        input_tokens: safe_integer(usage.get("input_tokens")),
        cached_input_tokens: safe_integer(usage.get("cached_input_tokens")),
        cache_creation_input_tokens: 0,
        output_tokens: safe_integer(usage.get("output_tokens")),
        reasoning_output_tokens: safe_integer(usage.get("reasoning_output_tokens")),
        total_tokens: safe_integer(usage.get("total_tokens")),
        events: 1,
    }
}

pub fn parse_codex_file(file_path: &Path) -> Vec<UsageRow> {
    let records = read_json_lines(file_path);
    let mut rows = Vec::new();
    let mut model = "unknown".to_string();
    let mut last_total = None;
    for record in &records {
        if let Some(next_model) = codex_model(record) {
            model = next_model.to_string();
        }
        if let Some(total) = codex_usage(record, "total_token_usage") {
            last_total = Some((codex_date(record, file_path), model.clone(), total.clone()));
        }
        if let Some(usage) = codex_usage(record, "last_token_usage") {
            rows.push(codex_row(
                codex_date(record, file_path),
                model.clone(),
                usage,
            ));
        }
    }
    if rows.is_empty()
        && let Some((date, model, usage)) = last_total
    {
        rows.push(codex_row(date, model, &usage));
    }
    rows
}

fn claude_row(date: String, model: String, usage: &Value) -> UsageRow {
    let input = safe_integer(usage.get("input_tokens"));
    let cached = safe_integer(usage.get("cache_read_input_tokens"));
    let cache_write = safe_integer(usage.get("cache_creation_input_tokens"));
    let output = safe_integer(usage.get("output_tokens"));
    UsageRow {
        provider: "claude".to_string(),
        date,
        model,
        input_tokens: input,
        cached_input_tokens: cached,
        cache_creation_input_tokens: cache_write,
        output_tokens: output,
        reasoning_output_tokens: 0,
        total_tokens: input + cached + cache_write + output,
        events: 1,
    }
}

pub fn parse_claude_file(file_path: &Path) -> Vec<UsageRow> {
    let mut rows = HashMap::<String, UsageRow>::new();
    let mut model = "unknown".to_string();
    let mut missing_id = 0_u64;
    for record in read_json_lines(file_path) {
        if record.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(message) = record.get("message") else {
            continue;
        };
        if let Some(next_model) = message.get("model").and_then(Value::as_str) {
            model = next_model.to_string();
        }
        let Some(usage) = message.get("usage").filter(|value| value.is_object()) else {
            continue;
        };
        let identifier = message
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                missing_id += 1;
                format!("__missing_id__:{missing_id}")
            });
        rows.insert(
            identifier,
            claude_row(
                kst_date(record.get("timestamp").and_then(Value::as_str), "unknown"),
                model.clone(),
                usage,
            ),
        );
    }
    rows.into_values().collect()
}

fn merge_rows(rows: Vec<UsageRow>) -> Vec<UsageRow> {
    let mut merged = HashMap::<(String, String, String), UsageRow>::new();
    for row in rows {
        let key = (row.provider.clone(), row.date.clone(), row.model.clone());
        let target = merged.entry(key).or_insert_with(|| UsageRow {
            provider: row.provider.clone(),
            date: row.date.clone(),
            model: row.model.clone(),
            ..UsageRow::default()
        });
        target.input_tokens += row.input_tokens;
        target.cached_input_tokens += row.cached_input_tokens;
        target.cache_creation_input_tokens += row.cache_creation_input_tokens;
        target.output_tokens += row.output_tokens;
        target.reasoning_output_tokens += row.reasoning_output_tokens;
        target.total_tokens += row.total_tokens;
        target.events += row.events;
    }
    let mut rows = merged.into_values().collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        right
            .date
            .cmp(&left.date)
            .then_with(|| left.provider.cmp(&right.provider))
            .then_with(|| left.model.cmp(&right.model))
    });
    rows
}

fn signature(path: &Path) -> Option<(u64, u64)> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some((modified, metadata.len()))
}

fn scan_provider(
    provider: &str,
    root: &Path,
    previous: &HashMap<String, CacheEntry>,
    next: &mut HashMap<String, CacheEntry>,
) -> Vec<UsageRow> {
    let mut rows = Vec::new();
    for path in list_jsonl_files(root) {
        let Some((modified_ms, size)) = signature(&path) else {
            continue;
        };
        let key = path.display().to_string();
        let parsed = previous
            .get(&key)
            .filter(|entry| {
                entry.provider == provider && entry.modified_ms == modified_ms && entry.size == size
            })
            .map(|entry| entry.rows.clone())
            .unwrap_or_else(|| {
                if provider == "codex" {
                    parse_codex_file(&path)
                } else {
                    parse_claude_file(&path)
                }
            });
        rows.extend(parsed.clone());
        next.insert(
            key,
            CacheEntry {
                provider: provider.to_string(),
                modified_ms,
                size,
                rows: parsed,
            },
        );
    }
    rows
}

pub fn scan_token_usage() -> Vec<UsageRow> {
    let base = home_dir();
    scan_token_usage_at(
        &base.join(".codex").join("sessions"),
        &base.join(".claude").join("projects"),
        &base
            .join(".codex-usage-wrapper")
            .join("token-usage-cache.json"),
    )
}

pub fn scan_token_usage_at(
    codex_root: &Path,
    claude_root: &Path,
    cache_path: &Path,
) -> Vec<UsageRow> {
    let cache = fs::read_to_string(cache_path)
        .ok()
        .and_then(|body| serde_json::from_str::<UsageCache>(&body).ok())
        .unwrap_or_default();
    let mut next = HashMap::new();
    let mut rows = scan_provider("codex", codex_root, &cache.files, &mut next);
    rows.extend(scan_provider(
        "claude",
        claude_root,
        &cache.files,
        &mut next,
    ));
    let next_cache = UsageCache {
        schema_version: 1,
        files: next,
    };
    if let Ok(value) = serde_json::to_value(next_cache) {
        let _ = write_json(cache_path, &value);
    }
    merge_rows(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_lines(path: &Path, records: &[Value]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = fs::File::create(path).unwrap();
        for record in records {
            writeln!(file, "{record}").unwrap();
        }
    }

    #[test]
    fn local_files_are_deduplicated_and_cached() {
        let root = std::env::temp_dir().join(format!("usage-reader-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let codex = root.join("codex");
        let claude = root.join("claude");
        write_lines(
            &codex.join("rollout-2026-07-18T100000.jsonl"),
            &[
                serde_json::json!({"timestamp":"2026-07-18T01:00:00Z","payload":{"model":"gpt-5.3-codex"}}),
                serde_json::json!({"timestamp":"2026-07-18T01:01:00Z","payload":{"info":{"last_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":250,"reasoning_output_tokens":50,"total_tokens":1250}}}}),
            ],
        );
        let message = serde_json::json!({"type":"assistant","timestamp":"2026-07-18T02:00:00Z","message":{"id":"msg-1","model":"claude-sonnet-4-5","usage":{"input_tokens":500,"cache_read_input_tokens":200,"cache_creation_input_tokens":100,"output_tokens":300}}});
        write_lines(&claude.join("session.jsonl"), &[message.clone(), message]);
        let cache = root.join("cache.json");
        let rows = scan_token_usage_at(&codex, &claude, &cache);
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows.iter()
                .find(|row| row.provider == "claude")
                .unwrap()
                .total_tokens,
            1100
        );
        assert_eq!(scan_token_usage_at(&codex, &claude, &cache), rows);
        let _ = fs::remove_dir_all(root);
    }
}
