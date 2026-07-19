"use strict";

// Rust 분석기가 만든 결정용 snapshot을 렌더링한다.

const PROVIDER_LABELS = { codex: "Codex", claude: "Claude" };
const LIMIT_LABELS = {
  five_hour: "5시간",
  weekly: "주간",
  monthly: "월간",
  seven_day: "주간",
};
const CONFIDENCE_LABELS = { high: "높음", medium: "보통", low: "낮음" };
const ALERT_REASON_LABELS = {
  threshold_critical: "위험 임계치",
  threshold_warning: "주의 임계치",
  forecast_before_reset: "리셋 전 고갈 예측",
};

function formatNumber(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat("ko-KR").format(value) : "--";
}

function formatPercent(value, signed = false) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  const prefix = signed && value > 0 ? "+" : "";
  return `${prefix}${value}%`;
}

function formatDateTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "예측 불가";
  }
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatForecastRange(limit) {
  const earliest = Date.parse(limit.expectedExhaustionEarliestAt);
  const latest = Date.parse(limit.expectedExhaustionLatestAt);
  if (Number.isFinite(earliest) && Number.isFinite(latest)) {
    return `${formatDateTime(limit.expectedExhaustionEarliestAt)} ~ ${formatDateTime(limit.expectedExhaustionLatestAt)}`;
  }
  const expected = formatDateTime(limit.expectedExhaustionAt);
  return expected === "예측 불가" ? expected : `약 ${expected} · 범위 기록 부족`;
}

function appendListItem(list, text, className = "") {
  const item = document.createElement("li");
  item.textContent = text;
  item.className = className;
  list.appendChild(item);
}

function renderForecasts(analytics) {
  const container = document.getElementById("forecasts");
  container.replaceChildren();
  for (const provider of ["codex", "claude"]) {
    for (const [type, limit] of Object.entries(analytics.providers[provider].limits)) {
      if (!limit) {
        continue;
      }
      const card = document.createElement("article");
      card.className = "forecast";
      const head = document.createElement("div");
      head.className = "forecast-head";
      const title = document.createElement("strong");
      title.textContent = `${PROVIDER_LABELS[provider]} · ${LIMIT_LABELS[type] || type}`;
      const badge = document.createElement("span");
      badge.className = `badge ${limit.remainingPercent <= 10 ? "critical" : limit.forecastStatus === "risk" ? "warning" : ""}`;
      badge.textContent = `${limit.remainingPercent}% 남음`;
      head.append(title, badge);
      const details = document.createElement("dl");
      const pairs = [
        ["소진 속도", Number.isFinite(limit.depletionRatePercentPerHour) ? `${limit.depletionRatePercentPerHour}%p/시간` : "기록 부족"],
        ["예상 범위", formatForecastRange(limit)],
        ["리셋", formatDateTime(limit.resetAt)],
        ["판정", limit.forecastStatus === "risk" ? "리셋 전 고갈 위험" : limit.forecastStatus === "safe" ? "현재 속도 양호" : "판단할 기록 부족"],
        ["신뢰 근거", `${CONFIDENCE_LABELS[limit.confidence] || limit.confidence} · ${limit.sampleCount}개 표본${Number.isFinite(limit.rateVariabilityPercent) ? ` · 속도 변동 ${limit.rateVariabilityPercent}%` : " · 변동 기록 부족"}`],
      ];
      for (const [label, value] of pairs) {
        const term = document.createElement("dt");
        term.textContent = label;
        const description = document.createElement("dd");
        description.textContent = value;
        details.append(term, description);
      }
      card.append(head, details);
      container.appendChild(card);
    }
  }
  if (!container.children.length) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "고갈 시각을 계산하려면 같은 한도를 두 번 이상 수집해야 합니다.";
    container.appendChild(note);
  }
}

function renderDetections(analytics) {
  const list = document.getElementById("detections");
  list.replaceChildren();
  for (const alert of analytics.alerts) {
    appendListItem(
      list,
      `${PROVIDER_LABELS[alert.provider]} ${LIMIT_LABELS[alert.limitType] || alert.limitType}: ${alert.remainingPercent}% 남음 · ${ALERT_REASON_LABELS[alert.reason] || alert.reason}`,
      alert.severity,
    );
  }
  for (const provider of ["codex", "claude"]) {
    const anomaly = analytics.anomalies[provider];
    if (anomaly.detected) {
      appendListItem(list, `${PROVIDER_LABELS[provider]} 오늘 토큰이 최근 기준의 ${anomaly.multiplier}배입니다.`, "warning");
    }
  }
  if (!list.children.length) {
    appendListItem(list, "임계치 초과나 이상 급증이 감지되지 않았습니다.", "ok");
  }
}

function renderCosts(analytics) {
  const container = document.getElementById("costs");
  container.replaceChildren();
  for (const provider of ["codex", "claude"]) {
    const cost = analytics.costs.providers[provider];
    const row = document.createElement("div");
    row.className = "cost-row";
    const copy = document.createElement("div");
    const title = document.createElement("span");
    title.textContent = PROVIDER_LABELS[provider];
    const detail = document.createElement("small");
    detail.textContent = cost.coveragePercent === null
      ? "오늘 토큰 기록 없음"
      : `가격 매칭 ${cost.coveragePercent}% · ${formatNumber(cost.totalTokens)} tokens`;
    copy.append(title, detail);
    const value = document.createElement("strong");
    value.textContent = `$${cost.estimatedUsd.toFixed(2)}`;
    row.append(copy, value);
    container.appendChild(row);
    if (cost.savings) {
      const savings = document.createElement("p");
      savings.className = "muted";
      savings.textContent = `${cost.savings.fromModel} → ${cost.savings.toModel}: 같은 토큰 기준 약 $${cost.savings.estimatedUsd.toFixed(2)} (${cost.savings.percent}%) 절약 가능`;
      container.appendChild(savings);
    }
  }
}

function staleProviders(snapshot) {
  return new Set(["codex", "claude"].filter((provider) => {
    const state = snapshot[provider];
    const freshness = snapshot.capture[`${provider}FreshnessMs`];
    return state.connected && Number.isFinite(state.ageMs) && state.ageMs > freshness;
  }));
}

function renderDecision(analytics, snapshot) {
  const panel = document.getElementById("decision");
  const badge = document.getElementById("decision-badge");
  const title = document.getElementById("decision-title");
  const detail = document.getElementById("decision-detail");
  const primaryAction = document.getElementById("primary-action");
  const critical = analytics.alerts.find((alert) => alert.severity === "critical");
  const warning = analytics.alerts.find((alert) => alert.severity === "warning");
  const priority = critical || warning;
  const recommendation = analytics.recommendations[0];
  const limits = ["codex", "claude"].flatMap((provider) =>
    Object.values((analytics.providers[provider] && analytics.providers[provider].limits) || {}).filter(Boolean));
  const hasKnownForecast = limits.some((limit) => limit.forecastStatus === "safe" || limit.forecastStatus === "risk");
  const stale = staleProviders(snapshot);
  const stalePriority = priority && stale.has(priority.provider);

  panel.className = "decision-panel";
  if (stalePriority || (!priority && stale.size)) {
    badge.textContent = "판정 보류";
    title.textContent = "일부 사용량 데이터가 오래돼 현재 위험을 판단할 수 없습니다";
  } else if (critical) {
    panel.classList.add("critical");
    badge.textContent = "위험";
    title.textContent = `${PROVIDER_LABELS[critical.provider]} ${LIMIT_LABELS[critical.limitType] || critical.limitType} 한도가 거의 소진됐습니다`;
  } else if (warning) {
    panel.classList.add("warning");
    badge.textContent = warning.confidence === "low" && warning.reason === "forecast_before_reset" ? "예비 추세" : "주의";
    title.textContent = warning.reason === "forecast_before_reset"
      ? `${PROVIDER_LABELS[warning.provider]} 한도가 리셋 전에 바닥날 수 있습니다`
      : `${PROVIDER_LABELS[warning.provider]} ${LIMIT_LABELS[warning.limitType] || warning.limitType} 한도를 확인하세요`;
  } else if (!hasKnownForecast) {
    badge.textContent = "판단 불가";
    title.textContent = "리셋 전 고갈 여부를 판단할 기록이 부족합니다";
  } else {
    badge.textContent = "현재 양호";
    title.textContent = "현재 기록에서는 리셋 전 고갈 위험이 보이지 않습니다";
  }

  detail.textContent = stalePriority || (!priority && stale.size)
    ? "마지막 성공 수집 후 10분이 지났습니다. 이전 값은 현재 잔여량과 다를 수 있습니다."
    : priority
    ? `${PROVIDER_LABELS[priority.provider]} ${LIMIT_LABELS[priority.limitType] || priority.limitType} 한도 ${priority.remainingPercent}% 남음 · ${ALERT_REASON_LABELS[priority.reason] || priority.reason}`
    : hasKnownForecast
      ? "표본이 적거나 사용 패턴이 달라지면 판정도 바뀔 수 있습니다. 작업 흐름이 바뀐 뒤에는 다시 계산하세요."
      : "같은 한도의 잔여량과 리셋 시각을 두 번 이상 수집해야 예측할 수 있습니다.";
  primaryAction.textContent = stalePriority || (!priority && stale.size)
    ? "지금 다시 계산해 최신 사용량을 확인하세요."
    : !hasKnownForecast && !priority
    ? "작업을 조금 더 진행한 뒤 새로고침하거나 활동 기반 자동 확인을 켜세요."
    : recommendation
    ? recommendation.action
    : "현재 즉시 바꿀 설정이 없습니다.";
}

function render(snapshot) {
  const analytics = snapshot.analytics;
  const empty = document.getElementById("empty");
  const content = document.getElementById("content");
  if (!analytics) {
    empty.hidden = false;
    content.hidden = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;
  document.getElementById("generated-at").textContent = `${formatDateTime(analytics.generatedAt)} 계산 · 한도 ${analytics.historySampleCount}개 / 토큰 ${analytics.usageRowCount}개 집계`;
  document.getElementById("alert-count").textContent = String(analytics.alerts.length);
  const hasKnownForecast = ["codex", "claude"].some((provider) =>
    Object.values((analytics.providers[provider] && analytics.providers[provider].limits) || {})
      .filter(Boolean)
      .some((limit) => limit.forecastStatus === "safe" || limit.forecastStatus === "risk"));
  document.getElementById("alert-detail").textContent = analytics.alerts.length
    ? "확인 필요"
    : hasKnownForecast ? "위험 알림 없음" : "판정 기록 부족";
  document.getElementById("total-cost").textContent = `$${analytics.costs.estimatedUsd.toFixed(2)}`;
  document.getElementById("day-change").textContent = formatPercent(analytics.comparison.dayOverDayPercent, true);
  document.getElementById("day-tokens").textContent = `${formatNumber(analytics.comparison.todayTokens)} vs ${formatNumber(analytics.comparison.yesterdayTokens)} tokens`;
  document.getElementById("week-change").textContent = formatPercent(analytics.comparison.weekOverWeekPercent, true);
  document.getElementById("week-tokens").textContent = `${formatNumber(analytics.comparison.currentSevenDaysTokens)} vs ${formatNumber(analytics.comparison.previousSevenDaysTokens)} tokens`;
  renderDecision(analytics, snapshot);
  renderForecasts(analytics);
  renderDetections(analytics);
  renderCosts(analytics);
  const recommendations = document.getElementById("recommendations");
  recommendations.replaceChildren();
  for (const recommendation of analytics.recommendations) {
    appendListItem(recommendations, recommendation.action, recommendation.priority);
  }
}

async function refresh(force = false) {
  const button = document.getElementById("refresh");
  button.disabled = true;
  try {
    const snapshot = force
      ? await window.usageApp.refreshSnapshot()
      : await window.usageApp.snapshot();
    render(snapshot);
  } finally {
    button.disabled = false;
  }
}

document.getElementById("refresh").addEventListener("click", () => refresh(true));
refresh();
