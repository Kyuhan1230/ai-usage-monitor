use crate::usage::UsageRow;
use chrono::{Datelike, FixedOffset, TimeZone, Utc};
use regex::Regex;
use serde_json::{Value, json};
use std::cmp::Ordering;
use std::collections::HashSet;

const HOUR_MS: i64 = 60 * 60 * 1000;
const DAY_MS: i64 = 24 * HOUR_MS;
pub const STATUS_FRESHNESS_MS: i64 = 10 * 60 * 1000;

#[derive(Clone, Copy)]
struct Price {
    input: f64,
    cached: f64,
    cache_write: f64,
    output: f64,
}

fn round(value: f64, digits: i32) -> f64 {
    let scale = 10_f64.powi(digits);
    (value * scale).round() / scale
}

fn median(mut values: Vec<f64>) -> Option<f64> {
    values.retain(|value| value.is_finite());
    values.sort_by(|left, right| left.partial_cmp(right).unwrap_or(Ordering::Equal));
    if values.is_empty() {
        return None;
    }
    let middle = values.len() / 2;
    Some(if values.len() % 2 == 1 {
        values[middle]
    } else {
        (values[middle - 1] + values[middle]) / 2.0
    })
}

fn price(provider: &str, model: &str) -> Option<Price> {
    let model = model.to_ascii_lowercase();
    let value = match provider {
        "codex" if model.starts_with("gpt-5.6-sol") => Price {
            input: 5.0,
            cached: 0.5,
            cache_write: 6.25,
            output: 30.0,
        },
        "codex" if model.starts_with("gpt-5.5") => Price {
            input: 5.0,
            cached: 0.5,
            cache_write: 5.0,
            output: 30.0,
        },
        "codex" if model.starts_with("gpt-5.6-terra") => Price {
            input: 2.5,
            cached: 0.25,
            cache_write: 3.125,
            output: 15.0,
        },
        "codex"
            if model.starts_with("gpt-5.4")
                && !model.contains("mini")
                && !model.contains("nano") =>
        {
            Price {
                input: 2.5,
                cached: 0.25,
                cache_write: 2.5,
                output: 15.0,
            }
        }
        "codex" if model.starts_with("gpt-5.6-luna") => Price {
            input: 1.0,
            cached: 0.1,
            cache_write: 1.25,
            output: 6.0,
        },
        "codex" if model.starts_with("gpt-5.4-mini") => Price {
            input: 0.75,
            cached: 0.075,
            cache_write: 0.75,
            output: 4.5,
        },
        "codex" if model.starts_with("gpt-5.4-nano") => Price {
            input: 0.2,
            cached: 0.02,
            cache_write: 0.2,
            output: 1.25,
        },
        "codex" if model.starts_with("gpt-5.3-codex") || model.starts_with("gpt-5.2-codex") => {
            Price {
                input: 1.75,
                cached: 0.175,
                cache_write: 1.75,
                output: 14.0,
            }
        }
        "codex" if model.starts_with("gpt-5.1-codex") || model.starts_with("gpt-5-codex") => {
            Price {
                input: 1.25,
                cached: 0.125,
                cache_write: 1.25,
                output: 10.0,
            }
        }
        "codex" if model.starts_with("gpt-5-mini") => Price {
            input: 0.25,
            cached: 0.025,
            cache_write: 0.25,
            output: 2.0,
        },
        "codex" if model.starts_with("codex-mini-latest") => Price {
            input: 1.5,
            cached: 0.375,
            cache_write: 1.5,
            output: 6.0,
        },
        "claude" if model.contains("opus-4") || model.contains("opus_4") => Price {
            input: 5.0,
            cached: 0.5,
            cache_write: 6.25,
            output: 25.0,
        },
        "claude" if model.contains("sonnet-5") || model.contains("sonnet_5") => Price {
            input: 2.0,
            cached: 0.2,
            cache_write: 2.5,
            output: 10.0,
        },
        "claude" if model.contains("sonnet-4") || model.contains("sonnet_4") => Price {
            input: 3.0,
            cached: 0.3,
            cache_write: 3.75,
            output: 15.0,
        },
        "claude" if model.contains("haiku-4-5") || model.contains("haiku-4.5") => Price {
            input: 1.0,
            cached: 0.1,
            cache_write: 1.25,
            output: 5.0,
        },
        "claude" if model.contains("haiku-3-5") || model.contains("haiku-3.5") => Price {
            input: 0.8,
            cached: 0.08,
            cache_write: 1.0,
            output: 4.0,
        },
        _ => return None,
    };
    Some(value)
}

fn alternative(provider: &str) -> (&'static str, Price) {
    if provider == "codex" {
        (
            "gpt-5.6-luna",
            Price {
                input: 1.0,
                cached: 0.1,
                cache_write: 1.25,
                output: 6.0,
            },
        )
    } else {
        (
            "claude-haiku-4.5",
            Price {
                input: 1.0,
                cached: 0.1,
                cache_write: 1.25,
                output: 5.0,
            },
        )
    }
}

fn row_cost(row: &UsageRow, price: Price) -> f64 {
    let input = row.input_tokens as f64;
    let cached = row.cached_input_tokens as f64;
    let uncached = if row.provider == "codex" {
        (input - cached).max(0.0)
    } else {
        input
    };
    (uncached * price.input
        + cached * price.cached
        + row.cache_creation_input_tokens as f64 * price.cache_write
        + row.output_tokens as f64 * price.output)
        / 1_000_000.0
}

fn local_date(now_ms: i64, day_offset: i64) -> String {
    let offset = FixedOffset::east_opt(9 * 60 * 60).expect("valid KST offset");
    let timestamp = Utc
        .timestamp_millis_opt(now_ms + day_offset * DAY_MS)
        .single()
        .unwrap_or_else(Utc::now);
    timestamp
        .with_timezone(&offset)
        .format("%Y-%m-%d")
        .to_string()
}

fn usage_total(rows: &[UsageRow], provider: Option<&str>, dates: &HashSet<String>) -> u64 {
    rows.iter()
        .filter(|row| {
            provider.is_none_or(|value| row.provider == value) && dates.contains(&row.date)
        })
        .map(|row| row.total_tokens)
        .sum()
}

fn delta_percent(current: u64, previous: u64) -> Value {
    if previous == 0 {
        Value::Null
    } else {
        json!(round(
            ((current as f64 - previous as f64) / previous as f64) * 100.0,
            1
        ))
    }
}

fn comparison(rows: &[UsageRow], provider: Option<&str>, now_ms: i64) -> Value {
    let today = HashSet::from([local_date(now_ms, 0)]);
    let yesterday = HashSet::from([local_date(now_ms, -1)]);
    let current_week = (0..7)
        .map(|index| local_date(now_ms, -index))
        .collect::<HashSet<_>>();
    let previous_week = (7..14)
        .map(|index| local_date(now_ms, -index))
        .collect::<HashSet<_>>();
    let today_tokens = usage_total(rows, provider, &today);
    let yesterday_tokens = usage_total(rows, provider, &yesterday);
    let current = usage_total(rows, provider, &current_week);
    let previous = usage_total(rows, provider, &previous_week);
    json!({
        "todayTokens": today_tokens,
        "yesterdayTokens": yesterday_tokens,
        "dayOverDayPercent": delta_percent(today_tokens, yesterday_tokens),
        "currentSevenDaysTokens": current,
        "previousSevenDaysTokens": previous,
        "weekOverWeekPercent": delta_percent(current, previous)
    })
}

#[derive(Clone)]
struct Sample {
    captured_ms: i64,
    remaining: f64,
    limit: Value,
}

fn provider_from_status(status: &Value) -> Option<&'static str> {
    let source = status
        .get("source")
        .or_else(|| status.get("capture_method"))
        .and_then(Value::as_str)?
        .to_ascii_lowercase();
    if source.contains("claude") {
        Some("claude")
    } else if source.contains("codex") {
        Some("codex")
    } else {
        None
    }
}

fn samples(history: &[Value], provider: &str, kind: &str) -> Vec<Sample> {
    let mut result = history
        .iter()
        .filter(|status| provider_from_status(status) == Some(provider))
        .filter_map(|status| {
            let captured_ms =
                chrono::DateTime::parse_from_rfc3339(status.get("captured_at")?.as_str()?)
                    .ok()?
                    .timestamp_millis();
            let limit = status
                .get("limits")?
                .as_array()?
                .iter()
                .find(|limit| limit.get("type").and_then(Value::as_str) == Some(kind))?
                .clone();
            let remaining = limit.get("remaining_percent")?.as_f64()?;
            Some(Sample {
                captured_ms,
                remaining,
                limit,
            })
        })
        .collect::<Vec<_>>();
    result.sort_by_key(|sample| sample.captured_ms);
    result.dedup_by_key(|sample| sample.captured_ms);
    result
}

fn current_cycle(samples: &[Sample]) -> Vec<Sample> {
    let mut start = 0;
    for index in 1..samples.len() {
        if samples[index].remaining - samples[index - 1].remaining >= 5.0 {
            start = index;
        }
    }
    samples[start..].to_vec()
}

fn reset_at(limit: &Value, now_ms: i64) -> Option<i64> {
    if let Some(epoch) = limit
        .get("resets_at")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
    {
        return Some(epoch * 1000);
    }
    let text = limit.get("reset_text").and_then(Value::as_str)?;
    let pattern = Regex::new(r"(?i)resets?\s+(\d{1,2})/(\d{1,2})\s+(\d{1,2}):(\d{2})").ok()?;
    let captures = pattern.captures(text)?;
    let offset = FixedOffset::east_opt(9 * 60 * 60)?;
    let now = Utc
        .timestamp_millis_opt(now_ms)
        .single()?
        .with_timezone(&offset);
    let mut year = now.year();
    let month = captures.get(1)?.as_str().parse().ok()?;
    let day = captures.get(2)?.as_str().parse().ok()?;
    let hour = captures.get(3)?.as_str().parse().ok()?;
    let minute = captures.get(4)?.as_str().parse().ok()?;
    let mut candidate = offset
        .with_ymd_and_hms(year, month, day, hour, minute, 0)
        .single()?
        .timestamp_millis();
    if candidate < now_ms - DAY_MS {
        year += 1;
        candidate = offset
            .with_ymd_and_hms(year, month, day, hour, minute, 0)
            .single()?
            .timestamp_millis();
    }
    Some(candidate)
}

fn iso(timestamp_ms: i64) -> String {
    Utc.timestamp_millis_opt(timestamp_ms)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn analyze_limit(values: &[Sample], now_ms: i64) -> Value {
    if values.is_empty() {
        return Value::Null;
    }
    let cycle = current_cycle(values);
    let latest = cycle.last().expect("non-empty cycle");
    let elapsed_hours = if cycle.len() >= 2 {
        (latest.captured_ms - cycle[0].captured_ms) as f64 / HOUR_MS as f64
    } else {
        0.0
    };
    let depleted = cycle
        .windows(2)
        .map(|pair| (pair[0].remaining - pair[1].remaining).max(0.0))
        .sum::<f64>();
    let rate = (elapsed_hours >= 1.0 / 12.0 && depleted > 0.0).then_some(depleted / elapsed_hours);
    let exhaustion =
        rate.map(|rate| latest.captured_ms + (latest.remaining / rate * HOUR_MS as f64) as i64);
    let interval_rates = cycle
        .windows(2)
        .filter_map(|pair| {
            let hours = (pair[1].captured_ms - pair[0].captured_ms) as f64 / HOUR_MS as f64;
            (hours >= 1.0 / 12.0)
                .then_some(((pair[0].remaining - pair[1].remaining).max(0.0)) / hours)
        })
        .collect::<Vec<_>>();
    let variability = rate.and_then(|center| {
        (interval_rates.len() >= 2).then(|| {
            let mad = median(
                interval_rates
                    .iter()
                    .map(|value| (value - center).abs())
                    .collect(),
            )
            .unwrap_or(0.0);
            round((mad / center) * 100.0, 0)
        })
    });
    let exhaustion_range = rate.and_then(|center| {
        let variability = variability? / 100.0;
        let spread = variability.clamp(0.15, 0.75);
        let fast_rate = center * (1.0 + spread);
        let slow_rate = (center * (1.0 - spread)).max(center * 0.1);
        Some((
            latest.captured_ms + (latest.remaining / fast_rate * HOUR_MS as f64) as i64,
            latest.captured_ms + (latest.remaining / slow_rate * HOUR_MS as f64) as i64,
        ))
    });
    let reset = reset_at(&latest.limit, now_ms);
    let forecast_status = match exhaustion_range.zip(reset) {
        Some(((_, latest), reset)) if latest < reset => "risk",
        Some(((earliest, _), reset)) if earliest >= reset => "safe",
        Some(_) => "unknown",
        None => "unknown",
    };
    let will_exhaust_before_reset = match forecast_status {
        "risk" => Some(true),
        "safe" => Some(false),
        _ => None,
    };
    let hours_until_reset = reset
        .filter(|reset| *reset > latest.captured_ms)
        .map(|reset| (reset - latest.captured_ms) as f64 / HOUR_MS as f64);
    let safe_rate = hours_until_reset.map(|hours| latest.remaining / hours);
    let required_reduction = rate.zip(safe_rate).map(|(current, safe)| {
        if current <= 0.0 {
            0.0
        } else {
            ((1.0 - safe / current) * 100.0).clamp(0.0, 100.0)
        }
    });
    let confidence = if cycle.len() >= 8
        && elapsed_hours >= 6.0
        && interval_rates.len() >= 5
        && variability.is_some_and(|value| value <= 25.0)
    {
        "high"
    } else if cycle.len() >= 4
        && elapsed_hours >= 2.0
        && interval_rates.len() >= 3
        && variability.is_some_and(|value| value <= 60.0)
    {
        "medium"
    } else {
        "low"
    };
    json!({
        "remainingPercent": round(latest.remaining, 0),
        "sourceCapturedAt": iso(latest.captured_ms),
        "staleAfterMs": STATUS_FRESHNESS_MS,
        "sampleCount": cycle.len(),
        "observedHours": round(elapsed_hours, 1),
        "observedIntervalCount": interval_rates.len(),
        "depletionRatePercentPerHour": rate.map(|value| round(value, 2)),
        "currentRatePercentPerHour": rate.map(|value| round(value, 2)),
        "safeRatePercentPerHour": safe_rate.map(|value| round(value, 2)),
        "requiredReductionPercent": required_reduction.map(|value| round(value, 1)),
        "reductionMethod": "remaining_over_hours_until_reset_vs_cycle_average",
        "expectedExhaustionAt": exhaustion.map(iso),
        "expectedExhaustionEarliestAt": exhaustion_range.map(|value| iso(value.0)),
        "expectedExhaustionLatestAt": exhaustion_range.map(|value| iso(value.1)),
        "rateVariabilityPercent": variability,
        "forecastMethod": "cycle_average_with_interval_mad_band",
        "resetAt": reset.map(iso),
        "willExhaustBeforeReset": will_exhaust_before_reset,
        "forecastStatus": forecast_status,
        "confidence": confidence,
        "anomaly": {"detected": false}
    })
}

fn usage_anomaly(rows: &[UsageRow], provider: &str, now_ms: i64) -> Value {
    let today = usage_total(
        rows,
        Some(provider),
        &HashSet::from([local_date(now_ms, 0)]),
    );
    let previous = (1..=7)
        .map(|index| {
            usage_total(
                rows,
                Some(provider),
                &HashSet::from([local_date(now_ms, -index)]),
            )
        })
        .filter(|value| *value > 0)
        .map(|value| value as f64)
        .collect::<Vec<_>>();
    let Some(baseline) = median(previous.clone()) else {
        return json!({"detected": false, "reason": "insufficient_history"});
    };
    if previous.len() < 3 {
        return json!({"detected": false, "reason": "insufficient_history"});
    }
    let mad = median(
        previous
            .iter()
            .map(|value| (value - baseline).abs())
            .collect(),
    )
    .unwrap_or(0.0);
    let threshold = (baseline * 1.8).max(baseline + 3.0 * mad);
    if today >= 10_000 && today as f64 > threshold {
        json!({
            "detected": true,
            "date": local_date(now_ms, 0),
            "todayTokens": today,
            "baselineDailyTokens": round(baseline, 0),
            "multiplier": round(today as f64 / baseline, 1)
        })
    } else {
        json!({"detected": false})
    }
}

fn provider_cost(rows: &[UsageRow], provider: &str, today: &str) -> Value {
    let provider_rows = rows
        .iter()
        .filter(|row| row.provider == provider && row.date == today)
        .collect::<Vec<_>>();
    let total_tokens = provider_rows
        .iter()
        .map(|row| row.total_tokens)
        .sum::<u64>();
    let mut priced_tokens = 0_u64;
    let mut cost = 0.0;
    let mut primary: Option<(&UsageRow, f64)> = None;
    for row in provider_rows {
        let Some(price) = price(provider, &row.model) else {
            continue;
        };
        let value = row_cost(row, price);
        cost += value;
        priced_tokens += row.total_tokens;
        if primary.is_none_or(|(_, current)| value > current) {
            primary = Some((row, value));
        }
    }
    let savings = primary.and_then(|(row, current)| {
        let (alternative_model, alternative_price) = alternative(provider);
        let alternative_cost = row_cost(row, alternative_price);
        (current > alternative_cost).then(|| {
            json!({
                "fromModel": row.model,
                "toModel": alternative_model,
                "estimatedUsd": round(current - alternative_cost, 4),
                "percent": round(((current - alternative_cost) / current) * 100.0, 1),
                "scope": "today_primary_model_same_tokens"
            })
        })
    });
    json!({
        "estimatedUsd": round(cost, 4),
        "totalTokens": total_tokens,
        "pricedTokens": priced_tokens,
        "coveragePercent": (total_tokens > 0).then(|| round(priced_tokens as f64 / total_tokens as f64 * 100.0, 1)),
        "savings": savings
    })
}

fn recommendations(providers: &Value, costs: &Value, anomalies: &Value) -> Vec<Value> {
    let mut result = Vec::<Value>::new();
    for provider in ["codex", "claude"] {
        if let Some(limits) = providers
            .get(provider)
            .and_then(|value| value.get("limits"))
            .and_then(Value::as_object)
        {
            for (kind, limit) in limits {
                if limit.is_null() {
                    continue;
                }
                let remaining = limit
                    .get("remainingPercent")
                    .and_then(Value::as_f64)
                    .unwrap_or(100.0);
                if remaining <= 10.0 {
                    result.push(json!({
                        "priority": "critical", "provider": provider, "reason": "critical_limit",
                        "action": format!("{} {} 한도가 {}% 남았습니다. 큰 작업을 멈추고 초기화 이후로 미루세요.", if provider == "codex" { "Codex" } else { "Claude" }, kind, remaining as i64)
                    }));
                } else if limit.get("forecastStatus").and_then(Value::as_str) == Some("risk")
                    && limit.get("confidence").and_then(Value::as_str) != Some("low")
                    && let Some(reduction) = limit
                        .get("requiredReductionPercent")
                        .and_then(Value::as_f64)
                {
                    let rounded = (reduction / 5.0).ceil() as i64 * 5;
                    result.push(json!({
                        "priority": "warning", "provider": provider, "reason": "forecast_before_reset",
                        "action": format!("{} 사용 속도를 약 {}% 줄이면 초기화 전 고갈을 피할 가능성이 큽니다.", if provider == "codex" { "Codex" } else { "Claude" }, rounded)
                    }));
                }
            }
        }
        if anomalies
            .get(provider)
            .and_then(|value| value.get("detected"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            let multiplier = anomalies[provider]["multiplier"].as_f64().unwrap_or(0.0);
            result.push(json!({
                "priority": "warning", "provider": provider, "reason": "token_spike",
                "action": format!("오늘 토큰 사용량이 최근 중앙값의 {}배입니다. 자동 반복 작업과 큰 컨텍스트 입력을 점검하세요.", multiplier)
            }));
        }
        if let Some(savings) = costs
            .get("providers")
            .and_then(|value| value.get(provider))
            .and_then(|value| value.get("savings"))
            .filter(|value| !value.is_null())
        {
            let percent = savings
                .get("percent")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let amount = savings
                .get("estimatedUsd")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            if percent >= 20.0 && amount >= 0.01 {
                result.push(json!({
                    "priority": "info", "provider": provider, "reason": "model_savings",
                    "action": format!("단순 작업을 {}로 보내면 같은 토큰 기준 오늘 약 ${:.2} ({}%)를 절약할 수 있습니다.", savings["toModel"].as_str().unwrap_or("저비용 모델"), amount, percent)
                }));
            }
        }
    }
    if result.is_empty() {
        result.push(json!({
            "priority": "ok", "provider": Value::Null, "reason": "healthy",
            "action": "현재 속도에서는 즉시 바꿀 설정이 없습니다. 다음 작업 전 새로고침해 추세를 확인하세요."
        }));
    }
    result.sort_by_key(|item| match item.get("priority").and_then(Value::as_str) {
        Some("critical") => 0,
        Some("warning") => 1,
        Some("info") => 2,
        _ => 3,
    });
    result.truncate(5);
    result
}

pub fn build_analytics(history: &[Value], rows: &[UsageRow], now_ms: i64) -> Value {
    let mut alerts = Vec::new();
    let mut provider_map = serde_json::Map::new();
    for provider in ["codex", "claude"] {
        let types: &[&str] = if provider == "codex" {
            &["five_hour", "weekly", "monthly"]
        } else {
            &["five_hour", "seven_day"]
        };
        let mut limits = serde_json::Map::new();
        for kind in types {
            let analysis = analyze_limit(&samples(history, provider, kind), now_ms);
            if !analysis.is_null() {
                let remaining = analysis
                    .get("remainingPercent")
                    .and_then(Value::as_f64)
                    .unwrap_or(100.0);
                let forecast =
                    analysis.get("forecastStatus").and_then(Value::as_str) == Some("risk");
                let (severity, reason) = if remaining <= 10.0 {
                    ("critical", "threshold_critical")
                } else if remaining <= 25.0 {
                    ("warning", "threshold_warning")
                } else if forecast {
                    ("warning", "forecast_before_reset")
                } else {
                    ("none", "healthy")
                };
                if severity != "none" {
                    alerts.push(json!({
                        "provider": provider,
                        "limitType": kind,
                        "severity": severity,
                        "remainingPercent": remaining,
                        "reason": reason,
                        "confidence": analysis.get("confidence").cloned().unwrap_or(Value::Null),
                        "resetAt": analysis.get("resetAt").cloned().unwrap_or(Value::Null)
                    }));
                }
            }
            limits.insert((*kind).to_string(), analysis);
        }
        provider_map.insert(
            provider.to_string(),
            json!({
                "limits": limits,
                "comparison": comparison(rows, Some(provider), now_ms)
            }),
        );
    }
    let providers = Value::Object(provider_map);
    let anomalies = json!({
        "codex": usage_anomaly(rows, "codex", now_ms),
        "claude": usage_anomaly(rows, "claude", now_ms)
    });
    let today = local_date(now_ms, 0);
    let codex_cost = provider_cost(rows, "codex", &today);
    let claude_cost = provider_cost(rows, "claude", &today);
    let costs = json!({
        "basis": "api_list_price_equivalent_not_bill",
        "currency": "USD",
        "pricingAsOf": "2026-07-18",
        "sources": {
            "codex": "https://openai.com/api/pricing/",
            "claude": "https://platform.claude.com/docs/en/about-claude/pricing"
        },
        "providers": {"codex": codex_cost, "claude": claude_cost},
        "estimatedUsd": round(codex_cost["estimatedUsd"].as_f64().unwrap_or(0.0) + claude_cost["estimatedUsd"].as_f64().unwrap_or(0.0), 4)
    });
    let mut details = rows
        .iter()
        .map(|row| {
            let estimated =
                price(&row.provider, &row.model).map(|value| round(row_cost(row, value), 4));
            json!({
                "provider": row.provider,
                "date": row.date,
                "model": row.model,
                "inputTokens": row.input_tokens,
                "cachedInputTokens": row.cached_input_tokens,
                "cacheCreationInputTokens": row.cache_creation_input_tokens,
                "outputTokens": row.output_tokens,
                "reasoningOutputTokens": row.reasoning_output_tokens,
                "totalTokens": row.total_tokens,
                "estimatedUsd": estimated
            })
        })
        .collect::<Vec<_>>();
    details.sort_by(|left, right| {
        right["date"]
            .as_str()
            .cmp(&left["date"].as_str())
            .then_with(|| {
                right["totalTokens"]
                    .as_u64()
                    .cmp(&left["totalTokens"].as_u64())
            })
    });
    details.truncate(500);
    let actions = recommendations(&providers, &costs, &anomalies);
    json!({
        "schemaVersion": 1,
        "generatedAt": iso(now_ms),
        "thresholds": {"warning": 25, "critical": 10},
        "historySampleCount": history.len(),
        "usageRowCount": rows.len(),
        "providers": providers,
        "alerts": alerts,
        "anomalies": anomalies,
        "comparison": comparison(rows, None, now_ms),
        "costs": costs,
        "usage": {"rows": details},
        "recommendations": actions
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_cache_and_savings_prices_are_explicit() {
        let sol = price("codex", "gpt-5.6-sol").unwrap();
        let terra = price("codex", "gpt-5.6-terra").unwrap();
        let luna = price("codex", "gpt-5.6-luna").unwrap();
        assert_eq!(sol.cache_write, 6.25);
        assert_eq!(terra.cache_write, 3.125);
        assert_eq!(luna.cache_write, 1.25);
        assert_eq!(alternative("codex").0, "gpt-5.6-luna");
        assert_eq!(price("claude", "claude-sonnet-5").unwrap().input, 2.0);
        assert_eq!(price("claude", "claude-opus-4-8").unwrap().output, 25.0);
    }

    #[test]
    fn decision_metrics_are_built_together() {
        let now_ms = chrono::DateTime::parse_from_rfc3339("2026-07-18T12:00:00Z")
            .unwrap()
            .timestamp_millis();
        let reset = (now_ms + 20 * HOUR_MS) / 1000;
        let mut history = [60, 55, 50, 45, 40]
            .iter()
            .enumerate()
            .map(|(index, remaining)| {
                json!({
                    "source": "codex_app_server",
                    "captured_at": iso(now_ms - (4 - index as i64) * HOUR_MS),
                    "parse_status": "ok",
                    "limits": [{"type":"five_hour","remaining_percent":remaining,"resets_at":reset}]
                })
            })
            .collect::<Vec<_>>();
        history.push(json!({
            "source":"claude_statusline_hook","captured_at":iso(now_ms),"parse_status":"ok",
            "limits":[{"type":"five_hour","remaining_percent":8,"reset_text":"resets 07/19 18:00"}]
        }));
        let mut rows = vec![UsageRow {
            provider: "codex".into(),
            date: local_date(now_ms, 0),
            model: "gpt-5.3-codex".into(),
            input_tokens: 40_000,
            cached_input_tokens: 10_000,
            output_tokens: 10_000,
            total_tokens: 50_000,
            ..UsageRow::default()
        }];
        for index in 1..=7 {
            rows.push(UsageRow {
                provider: "codex".into(),
                date: local_date(now_ms, -index),
                model: "gpt-5.3-codex".into(),
                input_tokens: 8_000,
                output_tokens: 2_000,
                total_tokens: 10_000,
                ..UsageRow::default()
            });
        }
        let report = build_analytics(&history, &rows, now_ms);
        assert_eq!(
            report["providers"]["codex"]["limits"]["five_hour"]["depletionRatePercentPerHour"],
            5.0
        );
        assert_eq!(
            report["providers"]["codex"]["limits"]["five_hour"]["currentRatePercentPerHour"],
            5.0
        );
        assert_eq!(
            report["providers"]["codex"]["limits"]["five_hour"]["safeRatePercentPerHour"],
            2.0
        );
        assert_eq!(
            report["providers"]["codex"]["limits"]["five_hour"]["requiredReductionPercent"],
            60.0
        );
        assert_eq!(
            report["providers"]["codex"]["limits"]["five_hour"]["sourceCapturedAt"],
            iso(now_ms)
        );
        assert_eq!(
            report["providers"]["codex"]["limits"]["five_hour"]["willExhaustBeforeReset"],
            true
        );
        assert!(
            report["providers"]["codex"]["limits"]["five_hour"]["expectedExhaustionEarliestAt"]
                .is_string()
        );
        assert!(
            report["providers"]["codex"]["limits"]["five_hour"]["expectedExhaustionLatestAt"]
                .is_string()
        );
        assert_eq!(
            report["providers"]["codex"]["limits"]["five_hour"]["confidence"],
            "medium"
        );
        assert_eq!(report["anomalies"]["codex"]["detected"], true);
        assert!(report["costs"]["estimatedUsd"].as_f64().unwrap() > 0.0);
        assert!(!report["recommendations"].as_array().unwrap().is_empty());
    }

    #[test]
    fn missing_forecast_inputs_are_unknown_instead_of_safe() {
        let now_ms = chrono::DateTime::parse_from_rfc3339("2026-07-18T12:00:00Z")
            .unwrap()
            .timestamp_millis();
        let limit = analyze_limit(
            &[Sample {
                captured_ms: now_ms,
                remaining: 80.0,
                limit: json!({"type": "five_hour", "remaining_percent": 80}),
            }],
            now_ms,
        );
        assert_eq!(limit["forecastStatus"], "unknown");
        assert!(limit["willExhaustBeforeReset"].is_null());
    }

    #[test]
    fn forecast_range_overlapping_reset_is_unknown() {
        let now_ms = chrono::DateTime::parse_from_rfc3339("2026-07-18T12:00:00Z")
            .unwrap()
            .timestamp_millis();
        let reset = (now_ms + 8 * HOUR_MS) / 1000;
        let values = [60.0, 55.0, 50.0, 45.0, 40.0]
            .iter()
            .enumerate()
            .map(|(index, remaining)| Sample {
                captured_ms: now_ms - (4 - index as i64) * HOUR_MS,
                remaining: *remaining,
                limit: json!({"type": "five_hour", "remaining_percent": remaining, "resets_at": reset}),
            })
            .collect::<Vec<_>>();
        let limit = analyze_limit(&values, now_ms);
        assert_eq!(limit["forecastStatus"], "unknown");
        assert!(limit["willExhaustBeforeReset"].is_null());
    }
}
