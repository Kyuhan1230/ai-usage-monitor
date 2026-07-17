"use strict";

const fs = require("fs");
const path = require("path");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_THRESHOLDS = { warning: 25, critical: 10 };
const PRICING_AS_OF = "2026-07-18";
const PRICING_SOURCES = {
  codex: "https://platform.openai.com/docs/pricing",
  claude: "https://platform.claude.com/docs/en/about-claude/pricing",
};

const MODEL_PRICES = [
  { provider: "codex", pattern: /^gpt-5\.6-sol/i, model: "gpt-5.6-sol", input: 5, cached: 0.5, output: 30 },
  { provider: "codex", pattern: /^gpt-5\.6-terra/i, model: "gpt-5.6-terra", input: 2.5, cached: 0.25, output: 15 },
  { provider: "codex", pattern: /^gpt-5\.6-luna/i, model: "gpt-5.6-luna", input: 1, cached: 0.1, output: 6 },
  { provider: "codex", pattern: /^gpt-5\.5/i, model: "gpt-5.5", input: 5, cached: 0.5, output: 30 },
  { provider: "codex", pattern: /^gpt-5\.4-mini/i, model: "gpt-5.4-mini", input: 0.75, cached: 0.075, output: 4.5 },
  { provider: "codex", pattern: /^gpt-5\.4-nano/i, model: "gpt-5.4-nano", input: 0.2, cached: 0.02, output: 1.25 },
  { provider: "codex", pattern: /^gpt-5\.4/i, model: "gpt-5.4", input: 2.5, cached: 0.25, output: 15 },
  { provider: "codex", pattern: /^gpt-5\.3-codex/i, model: "gpt-5.3-codex", input: 1.75, cached: 0.175, output: 14 },
  { provider: "codex", pattern: /^gpt-5\.2-codex/i, model: "gpt-5.2-codex", input: 1.75, cached: 0.175, output: 14 },
  { provider: "codex", pattern: /^gpt-5\.1-codex/i, model: "gpt-5.1-codex", input: 1.25, cached: 0.125, output: 10 },
  { provider: "codex", pattern: /^gpt-5-codex/i, model: "gpt-5-codex", input: 1.25, cached: 0.125, output: 10 },
  { provider: "codex", pattern: /^gpt-5-mini/i, model: "gpt-5-mini", input: 0.25, cached: 0.025, output: 2 },
  { provider: "codex", pattern: /^codex-mini-latest/i, model: "codex-mini-latest", input: 1.5, cached: 0.375, output: 6 },
  { provider: "claude", pattern: /opus[-_ ]?4[-_. ]?(8|7|6|5)/i, model: "claude-opus-4.x", input: 5, cached: 0.5, cacheWrite: 6.25, output: 25 },
  { provider: "claude", pattern: /sonnet[-_ ]?5/i, model: "claude-sonnet-5", input: 2, cached: 0.2, cacheWrite: 2.5, output: 10 },
  { provider: "claude", pattern: /sonnet[-_ ]?4/i, model: "claude-sonnet-4.x", input: 3, cached: 0.3, cacheWrite: 3.75, output: 15 },
  { provider: "claude", pattern: /haiku[-_ ]?4[-_. ]?5/i, model: "claude-haiku-4.5", input: 1, cached: 0.1, cacheWrite: 1.25, output: 5 },
  { provider: "claude", pattern: /haiku[-_ ]?3[-_. ]?5/i, model: "claude-haiku-3.5", input: 0.8, cached: 0.08, cacheWrite: 1, output: 4 },
];

const ALTERNATIVE_PRICES = {
  codex: { model: "codex-mini-latest", input: 1.5, cached: 0.375, output: 6 },
  claude: { model: "claude-haiku-4.5", input: 1, cached: 0.1, cacheWrite: 1.25, output: 5 },
};

function round(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function providerFromStatus(status) {
  const source = String(status && (status.source || status.capture_method) || "").toLowerCase();
  return source.includes("claude") ? "claude" : source.includes("codex") ? "codex" : null;
}

function parseResetAt(limit, nowMs) {
  const epoch = Number(limit && limit.resets_at);
  if (Number.isFinite(epoch) && epoch > 0) {
    return epoch * 1000;
  }
  const match = String(limit && limit.reset_text || "").match(/resets?\s+(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/i);
  if (!match) {
    return null;
  }
  const now = new Date(nowMs + 9 * HOUR_MS);
  let year = now.getUTCFullYear();
  let candidate = Date.UTC(year, Number(match[1]) - 1, Number(match[2]), Number(match[3]) - 9, Number(match[4]));
  if (candidate < nowMs - DAY_MS) {
    year += 1;
    candidate = Date.UTC(year, Number(match[1]) - 1, Number(match[2]), Number(match[3]) - 9, Number(match[4]));
  }
  return candidate;
}

function samplesFor(records, provider, type) {
  const samples = [];
  for (const status of records) {
    if (providerFromStatus(status) !== provider || !Array.isArray(status.limits)) {
      continue;
    }
    const capturedAt = Date.parse(status.captured_at);
    const limit = status.limits.find((candidate) => candidate && candidate.type === type);
    const remaining = Number(limit && limit.remaining_percent);
    if (!Number.isFinite(capturedAt) || !Number.isFinite(remaining)) {
      continue;
    }
    samples.push({ capturedAt, remaining, limit });
  }
  samples.sort((left, right) => left.capturedAt - right.capturedAt);
  return samples.filter((sample, index) => index === 0 || sample.capturedAt !== samples[index - 1].capturedAt);
}

function currentCycle(samples) {
  let start = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].remaining - samples[index - 1].remaining >= 5) {
      start = index;
    }
  }
  return samples.slice(start);
}

function intervalRates(samples) {
  const rates = [];
  for (let index = 1; index < samples.length; index += 1) {
    const elapsedHours = (samples[index].capturedAt - samples[index - 1].capturedAt) / HOUR_MS;
    const depleted = samples[index - 1].remaining - samples[index].remaining;
    if (elapsedHours >= 1 / 60 && elapsedHours <= 24 && depleted > 0 && depleted < 50) {
      rates.push({
        capturedAt: samples[index].capturedAt,
        depleted,
        rate: depleted / elapsedHours,
      });
    }
  }
  return rates;
}

function analyzeLimit(samples, nowMs) {
  if (samples.length === 0) {
    return null;
  }
  const cycle = currentCycle(samples);
  const latest = cycle[cycle.length - 1];
  const elapsedHours = cycle.length >= 2
    ? (latest.capturedAt - cycle[0].capturedAt) / HOUR_MS
    : 0;
  const depleted = cycle.length >= 2
    ? cycle.slice(1).reduce((total, sample, index) => total + Math.max(0, cycle[index].remaining - sample.remaining), 0)
    : 0;
  const rate = elapsedHours >= 1 / 12 && depleted > 0 ? depleted / elapsedHours : null;
  const exhaustionAt = rate ? latest.capturedAt + (latest.remaining / rate) * HOUR_MS : null;
  const resetAt = parseResetAt(latest.limit, nowMs);
  const confidence = cycle.length >= 6 && elapsedHours >= 6
    ? "high"
    : cycle.length >= 3 && elapsedHours >= 1
      ? "medium"
      : "low";
  const rates = intervalRates(cycle);
  const baseline = median(rates.slice(0, -1).map((item) => item.rate));
  const deviations = baseline === null ? [] : rates.slice(0, -1).map((item) => Math.abs(item.rate - baseline));
  const mad = median(deviations);
  const latestRate = rates.length ? rates[rates.length - 1] : null;
  const anomalyThreshold = baseline === null ? null : Math.max(baseline * 3, baseline + 3 * (mad || 0));
  const anomalous = Boolean(latestRate && rates.length >= 4 && latestRate.depleted >= 5 && latestRate.rate > anomalyThreshold);

  return {
    remainingPercent: round(latest.remaining, 0),
    sampleCount: cycle.length,
    observedHours: round(elapsedHours, 1),
    depletionRatePercentPerHour: round(rate, 2),
    expectedExhaustionAt: exhaustionAt ? new Date(exhaustionAt).toISOString() : null,
    resetAt: resetAt ? new Date(resetAt).toISOString() : null,
    willExhaustBeforeReset: Boolean(exhaustionAt && resetAt && exhaustionAt < resetAt),
    confidence,
    anomaly: anomalous ? {
      detected: true,
      latestRatePercentPerHour: round(latestRate.rate, 2),
      baselineRatePercentPerHour: round(baseline, 2),
      multiplier: baseline ? round(latestRate.rate / baseline, 1) : null,
    } : { detected: false },
  };
}

function alertFor(provider, type, analysis, thresholds) {
  if (!analysis) {
    return null;
  }
  let severity = "none";
  if (analysis.remainingPercent <= thresholds.critical) {
    severity = "critical";
  } else if (analysis.remainingPercent <= thresholds.warning || analysis.willExhaustBeforeReset) {
    severity = "warning";
  }
  return {
    provider,
    limitType: type,
    severity,
    remainingPercent: analysis.remainingPercent,
    reason: analysis.remainingPercent <= thresholds.critical
      ? "threshold_critical"
      : analysis.remainingPercent <= thresholds.warning
        ? "threshold_warning"
        : analysis.willExhaustBeforeReset
          ? "forecast_before_reset"
          : "healthy",
  };
}

function localDate(nowMs, dayOffset = 0) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs + dayOffset * DAY_MS));
}

function usageTotal(rows, provider, dates) {
  const allowed = new Set(dates);
  return rows.reduce((total, row) => (
    (!provider || row.provider === provider) && allowed.has(row.date)
      ? total + Number(row.totalTokens || 0)
      : total
  ), 0);
}

function deltaPercent(current, previous) {
  return previous > 0 ? round(((current - previous) / previous) * 100, 1) : null;
}

function usageComparison(rows, provider, nowMs) {
  const today = localDate(nowMs);
  const yesterday = localDate(nowMs, -1);
  const currentWeek = Array.from({ length: 7 }, (_, index) => localDate(nowMs, -index));
  const previousWeek = Array.from({ length: 7 }, (_, index) => localDate(nowMs, -index - 7));
  const todayTokens = usageTotal(rows, provider, [today]);
  const yesterdayTokens = usageTotal(rows, provider, [yesterday]);
  const currentWeekTokens = usageTotal(rows, provider, currentWeek);
  const previousWeekTokens = usageTotal(rows, provider, previousWeek);
  return {
    todayTokens,
    yesterdayTokens,
    dayOverDayPercent: deltaPercent(todayTokens, yesterdayTokens),
    currentSevenDaysTokens: currentWeekTokens,
    previousSevenDaysTokens: previousWeekTokens,
    weekOverWeekPercent: deltaPercent(currentWeekTokens, previousWeekTokens),
  };
}

function findPrice(provider, model) {
  return MODEL_PRICES.find((price) => price.provider === provider && price.pattern.test(String(model || ""))) || null;
}

function estimateRowCost(row, price) {
  if (!price) {
    return null;
  }
  const input = Number(row.inputTokens || 0);
  const cached = Number(row.cachedInputTokens || 0);
  const cacheWrite = Number(row.cacheCreationInputTokens || 0);
  const output = Number(row.outputTokens || 0);
  const uncachedInput = row.provider === "codex" ? Math.max(0, input - cached) : input;
  return (
    uncachedInput * price.input
    + cached * price.cached
    + cacheWrite * (price.cacheWrite || price.input)
    + output * price.output
  ) / 1_000_000;
}

function estimateCosts(rows, nowMs) {
  const today = localDate(nowMs);
  const todayRows = rows.filter((row) => row.date === today);
  const byProvider = {};
  for (const provider of ["codex", "claude"]) {
    const providerRows = todayRows.filter((row) => row.provider === provider);
    let cost = 0;
    let pricedTokens = 0;
    let totalTokens = 0;
    const modelCosts = [];
    for (const row of providerRows) {
      const price = findPrice(provider, row.model);
      const rowCost = estimateRowCost(row, price);
      totalTokens += Number(row.totalTokens || 0);
      if (rowCost !== null) {
        cost += rowCost;
        pricedTokens += Number(row.totalTokens || 0);
        modelCosts.push({ row, cost: rowCost, price });
      }
    }
    const primary = modelCosts.sort((left, right) => right.cost - left.cost)[0] || null;
    let savings = null;
    if (primary) {
      const alternativePrice = ALTERNATIVE_PRICES[provider];
      const alternativeCost = estimateRowCost(primary.row, alternativePrice);
      if (alternativeCost !== null && primary.cost > alternativeCost) {
        savings = {
          fromModel: primary.row.model,
          toModel: alternativePrice.model,
          estimatedUsd: round(primary.cost - alternativeCost, 4),
          percent: round(((primary.cost - alternativeCost) / primary.cost) * 100, 1),
          scope: "today_primary_model_same_tokens",
        };
      }
    }
    byProvider[provider] = {
      estimatedUsd: round(cost, 4),
      totalTokens,
      pricedTokens,
      coveragePercent: totalTokens > 0 ? round((pricedTokens / totalTokens) * 100, 1) : null,
      savings,
    };
  }
  return {
    basis: "api_list_price_equivalent_not_bill",
    currency: "USD",
    pricingAsOf: PRICING_AS_OF,
    sources: PRICING_SOURCES,
    providers: byProvider,
    estimatedUsd: round(byProvider.codex.estimatedUsd + byProvider.claude.estimatedUsd, 4),
  };
}

function detectUsageAnomaly(rows, provider, nowMs) {
  const todayTokens = usageTotal(rows, provider, [localDate(nowMs)]);
  const previous = Array.from({ length: 7 }, (_, index) => usageTotal(rows, provider, [localDate(nowMs, -index - 1)]))
    .filter((value) => value > 0);
  const baseline = median(previous);
  if (baseline === null || previous.length < 3) {
    return { detected: false, reason: "insufficient_history" };
  }
  const deviations = previous.map((value) => Math.abs(value - baseline));
  const mad = median(deviations) || 0;
  const threshold = Math.max(baseline * 1.8, baseline + 3 * mad);
  return todayTokens >= 10_000 && todayTokens > threshold
    ? {
      detected: true,
      todayTokens,
      baselineDailyTokens: round(baseline, 0),
      multiplier: round(todayTokens / baseline, 1),
    }
    : { detected: false };
}

function makeRecommendations(providers, costs, anomalies, nowMs) {
  const recommendations = [];
  for (const provider of ["codex", "claude"]) {
    const providerAnalysis = providers[provider];
    for (const [type, limit] of Object.entries(providerAnalysis.limits)) {
      if (!limit) {
        continue;
      }
      if (limit.remainingPercent <= 10) {
        recommendations.push({
          priority: "critical",
          provider,
          action: `${provider === "codex" ? "Codex" : "Claude"} ${type} 한도가 ${limit.remainingPercent}% 남았습니다. 큰 작업을 중단하고 reset 이후로 미루세요.`,
          reason: "critical_limit",
        });
      } else if (limit.willExhaustBeforeReset && limit.resetAt && limit.depletionRatePercentPerHour) {
        const hours = Math.max(0.1, (Date.parse(limit.resetAt) - nowMs) / HOUR_MS);
        const safeRate = limit.remainingPercent / hours;
        const reduction = Math.max(0, Math.min(100, (1 - safeRate / limit.depletionRatePercentPerHour) * 100));
        recommendations.push({
          priority: "warning",
          provider,
          action: `${provider === "codex" ? "Codex" : "Claude"} 사용 속도를 약 ${Math.ceil(reduction / 5) * 5}% 줄이면 reset 전 고갈을 피할 가능성이 큽니다.`,
          reason: "forecast_before_reset",
        });
      }
      if (limit.anomaly && limit.anomaly.detected) {
        recommendations.push({
          priority: "warning",
          provider,
          action: `최근 ${provider === "codex" ? "Codex" : "Claude"} 소진 속도가 평소의 ${limit.anomaly.multiplier}배입니다. 반복 루프나 과도한 서브에이전트를 확인하세요.`,
          reason: "limit_spike",
        });
      }
    }
    if (anomalies[provider].detected) {
      recommendations.push({
        priority: "warning",
        provider,
        action: `오늘 토큰 사용량이 최근 중앙값의 ${anomalies[provider].multiplier}배입니다. 자동 반복 작업과 큰 컨텍스트 입력을 점검하세요.`,
        reason: "token_spike",
      });
    }
    const savings = costs.providers[provider].savings;
    if (savings && savings.percent >= 20 && savings.estimatedUsd >= 0.01) {
      recommendations.push({
        priority: "info",
        provider,
        action: `단순 작업을 ${savings.toModel}로 보내면 같은 토큰 기준 오늘 약 $${savings.estimatedUsd.toFixed(2)} (${savings.percent}%)를 절약할 수 있습니다.`,
        reason: "model_savings",
      });
    }
  }
  if (recommendations.length === 0) {
    recommendations.push({
      priority: "ok",
      provider: null,
      action: "현재 속도에서는 즉시 바꿀 설정이 없습니다. 다음 작업 전 새로고침해 추세를 확인하세요.",
      reason: "healthy",
    });
  }
  const priorityOrder = { critical: 0, warning: 1, info: 2, ok: 3 };
  return recommendations.sort((left, right) => priorityOrder[left.priority] - priorityOrder[right.priority]).slice(0, 5);
}

function readHistoryRecords(historyDir, maximumFiles = 30) {
  let names = [];
  try {
    names = fs.readdirSync(historyDir)
      .filter((name) => name.endsWith(".jsonl"))
      .sort()
      .slice(-maximumFiles);
  } catch (error) {
    return [];
  }
  const records = [];
  for (const name of names) {
    let body = "";
    try {
      body = fs.readFileSync(path.join(historyDir, name), "utf8");
    } catch (error) {
      continue;
    }
    for (const line of body.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = JSON.parse(line);
        if (record && typeof record === "object") {
          records.push(record);
        }
      } catch (error) {
        // 손상된 단일 history 행은 나머지 분석을 막지 않는다.
      }
    }
  }
  return records;
}

function buildAnalytics(options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
  const historyRecords = Array.isArray(options.historyRecords) ? [...options.historyRecords] : [];
  const usageRows = Array.isArray(options.usageRows) ? options.usageRows : [];
  for (const status of Object.values(options.currentStatuses || {})) {
    if (status && typeof status === "object") {
      historyRecords.push(status);
    }
  }
  const providers = {};
  const alerts = [];
  for (const provider of ["codex", "claude"]) {
    const types = provider === "codex" ? ["five_hour", "weekly", "monthly"] : ["five_hour", "seven_day"];
    const limits = {};
    for (const type of types) {
      limits[type] = analyzeLimit(samplesFor(historyRecords, provider, type), nowMs);
      const alert = alertFor(provider, type, limits[type], thresholds);
      if (alert && alert.severity !== "none") {
        alerts.push(alert);
      }
    }
    providers[provider] = {
      limits,
      comparison: usageComparison(usageRows, provider, nowMs),
    };
  }
  const costs = estimateCosts(usageRows, nowMs);
  const anomalies = {
    codex: detectUsageAnomaly(usageRows, "codex", nowMs),
    claude: detectUsageAnomaly(usageRows, "claude", nowMs),
  };
  return {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    thresholds,
    historySampleCount: historyRecords.length,
    usageRowCount: usageRows.length,
    providers,
    alerts,
    anomalies,
    comparison: usageComparison(usageRows, null, nowMs),
    costs,
    recommendations: makeRecommendations(providers, costs, anomalies, nowMs),
  };
}

module.exports = {
  ALTERNATIVE_PRICES,
  DEFAULT_THRESHOLDS,
  MODEL_PRICES,
  PRICING_AS_OF,
  PRICING_SOURCES,
  alertFor,
  analyzeLimit,
  buildAnalytics,
  currentCycle,
  detectUsageAnomaly,
  estimateCosts,
  estimateRowCost,
  findPrice,
  intervalRates,
  localDate,
  median,
  parseResetAt,
  providerFromStatus,
  readHistoryRecords,
  round,
  samplesFor,
  usageComparison,
};
