use serde_json::Value;

pub struct TrayUsage {
    pub percent: Option<u8>,
    pub tooltip: String,
    pub stale: bool,
}

pub fn select_codex_usage(codex: Option<&Value>, hidden: &[String]) -> TrayUsage {
    select_usage(codex, None, hidden)
}

pub fn select_usage(codex: Option<&Value>, claude: Option<&Value>, hidden: &[String]) -> TrayUsage {
    let mut values = Vec::new();
    let mut lines = Vec::new();
    for (key, name, status) in [("codex", "Codex", codex), ("claude", "Claude", claude)] {
        if hidden.iter().any(|item| item == key) {
            continue;
        }
        let Some(status) =
            status.filter(|s| s.get("parse_status").and_then(Value::as_str) == Some("ok"))
        else {
            continue;
        };
        let captured = status
            .get("captured_at")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let stale = chrono::DateTime::parse_from_rfc3339(captured)
            .ok()
            .is_none_or(|time| {
                chrono::Utc::now()
                    .signed_duration_since(time)
                    .num_milliseconds()
                    > crate::analytics::STATUS_FRESHNESS_MS
            });
        if let Some(limits) = status.get("limits").and_then(Value::as_array) {
            for limit in limits {
                let Some(value) = limit
                    .get("remaining_percent")
                    .and_then(Value::as_f64)
                    .filter(|v| (0.0..=100.0).contains(v))
                else {
                    continue;
                };
                let percent = value.round() as u8;
                let kind = match limit.get("type").and_then(Value::as_str) {
                    Some("five_hour") => "5h",
                    Some("weekly" | "seven_day") => "7d",
                    Some("monthly") => "month",
                    _ => "limit",
                };
                let warning = if status.get("last_failed_status").is_some() {
                    " (refresh failed)"
                } else if stale {
                    " (old)"
                } else {
                    ""
                };
                lines.push(format!("{name} {kind}: {percent}%{warning}"));
                values.push((percent, stale));
            }
        }
    }
    let selected = values.into_iter().min_by_key(|(percent, _)| *percent);
    TrayUsage {
        percent: selected.map(|(value, _)| value),
        stale: selected.is_some_and(|(_, stale)| stale),
        tooltip: if lines.is_empty() {
            "No usage data yet".into()
        } else {
            lines.join("\n")
        },
    }
}

// A compact 3x5 pixel font keeps three-digit percentages legible in a tray slot.
pub fn render_percent(percent: u8) -> Vec<u8> {
    const DIGITS: [[u8; 5]; 10] = [
        [7, 5, 5, 5, 7],
        [2, 6, 2, 2, 7],
        [7, 1, 7, 4, 7],
        [7, 1, 7, 1, 7],
        [5, 5, 7, 1, 1],
        [7, 4, 7, 1, 7],
        [7, 4, 7, 5, 7],
        [7, 1, 1, 1, 1],
        [7, 5, 7, 5, 7],
        [7, 5, 7, 1, 7],
    ];
    let label = if percent < 100 {
        format!("{percent}%")
    } else {
        "100".to_string()
    };
    let scale = 2usize;
    let width = (label.len() * 4 - 1) * scale;
    let left = (32 - width) / 2;
    let top = 11;
    let mut pixels = vec![0u8; 32 * 32 * 4];
    for y in 8..24 {
        for x in 0..32 {
            let offset = (y * 32 + x) * 4;
            pixels[offset..offset + 4].copy_from_slice(&[20, 24, 30, 220]);
        }
    }
    for (index, digit) in label.bytes().enumerate() {
        let glyph = if digit == b'%' {
            [5, 1, 2, 4, 5]
        } else {
            DIGITS[(digit - b'0') as usize]
        };
        for (y, row) in glyph.iter().enumerate() {
            for x in 0..3 {
                if row & (1 << (2 - x)) == 0 {
                    continue;
                }
                for dy in 0..scale {
                    for dx in 0..scale {
                        let offset = ((top + y * scale + dy) * 32
                            + left
                            + index * 4 * scale
                            + x * scale
                            + dx)
                            * 4;
                        pixels[offset..offset + 4].copy_from_slice(&[255, 255, 255, 255]);
                    }
                }
            }
        }
    }
    pixels
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn selects_smallest_valid_remaining_value_and_excludes_hidden_or_failed_providers() {
        let codex = json!({"parse_status":"ok", "limits":[{"type":"five_hour", "remaining_percent":62}, {"type":"weekly", "remaining_percent":18}]});
        let claude =
            json!({"parse_status":"ok", "limits":[{"type":"seven_day", "remaining_percent":30}]});
        assert_eq!(
            select_usage(Some(&codex), Some(&claude), &[]).percent,
            Some(18)
        );
        assert_eq!(
            select_usage(Some(&codex), Some(&claude), &["codex".into()]).percent,
            Some(30)
        );
        let failed = json!({"parse_status":"failed", "limits":[{"remaining_percent":0}]});
        assert_eq!(select_usage(Some(&failed), None, &[]).percent, None);
    }

    #[test]
    fn codex_taskbar_does_not_show_claude_values_when_codex_is_missing_or_hidden() {
        let codex = json!({"parse_status":"ok", "limits":[{"remaining_percent":79}]});
        assert_eq!(select_codex_usage(Some(&codex), &[]).percent, Some(79));
        assert_eq!(select_codex_usage(None, &[]).percent, None);
        assert_eq!(
            select_codex_usage(Some(&codex), &["codex".into()]).percent,
            None
        );
    }

    #[test]
    fn image_contains_visible_pixels_for_zero_and_one_hundred() {
        for percent in [0, 100] {
            let image = render_percent(percent);
            assert_eq!(image.len(), 32 * 32 * 4);
            assert!(image.chunks_exact(4).any(|pixel| pixel[3] > 0));
        }
        assert_ne!(render_percent(0), render_percent(100));
    }

    #[test]
    fn warns_when_cached_usage_is_old_or_refresh_failed() {
        let status = json!({"parse_status":"ok", "captured_at":"2000-01-01T00:00:00Z", "limits":[{"type":"weekly", "remaining_percent":42}]});
        let usage = select_usage(Some(&status), None, &[]);
        assert!(usage.stale);
        assert!(usage.tooltip.contains("old"));
        let mut failed = status;
        failed["last_failed_status"] = json!({"error":"offline"});
        assert!(
            select_usage(Some(&failed), None, &[])
                .tooltip
                .contains("refresh failed")
        );
    }
}
