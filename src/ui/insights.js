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

function formatRate(value) {
  return Number.isFinite(value) ? `시간당 ${value}%p` : "계산 전";
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
    return `빠르면 ${formatDateTime(limit.expectedExhaustionEarliestAt)} · 늦으면 ${formatDateTime(limit.expectedExhaustionLatestAt)}`;
  }
  const expected = formatDateTime(limit.expectedExhaustionAt);
  return expected === "예측 불가" ? "소진 속도 계산 전" : `${expected} 전후`;
}

function formatForecastEvidence(limit) {
  const parts = [CONFIDENCE_LABELS[limit.confidence] || "확인 전"];
  if (Number.isFinite(limit.observedHours)) {
    parts.push(`${limit.observedHours}시간 관찰`);
  }
  if (Number.isFinite(limit.depletionEventCount)) {
    parts.push(`잔여량 감소 ${limit.depletionEventCount}회`);
  }
  if (Number.isFinite(limit.forecastSpreadPercent)) {
    parts.push(`평균 속도 오차 약 ±${limit.forecastSpreadPercent}%`);
  }
  return parts.join(" · ");
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) {
    return "시간 차이 계산 불가";
  }
  const minutes = Math.max(0, Math.round(milliseconds / 60000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const parts = [];
  if (days) parts.push(`${days}일`);
  if (hours) parts.push(`${hours}시간`);
  if (rest || !parts.length) parts.push(`${rest}분`);
  return parts.slice(0, 2).join(" ");
}

function allLimits(analytics) {
  return ["codex", "claude"].flatMap((provider) =>
    Object.entries((analytics.providers[provider] && analytics.providers[provider].limits) || {})
      .filter(([, limit]) => Boolean(limit))
      .map(([type, limit]) => ({ provider, type, limit })));
}

function limitPriority(candidate) {
  const { limit } = candidate;
  let score = Number.isFinite(limit.remainingPercent) ? 100 - limit.remainingPercent : 0;
  if (limit.remainingPercent <= 10) score += 1000;
  else if (limit.forecastStatus === "risk") score += 800;
  else if (limit.forecastStatus === "unknown") score += 300;
  else score += 100;
  if (Date.parse(limit.resetAt)) score += 50;
  return score;
}

function primaryLimit(analytics) {
  return allLimits(analytics).sort((left, right) => limitPriority(right) - limitPriority(left))[0] || null;
}

function limitIsStale(snapshot, candidate) {
  const state = snapshot[candidate.provider];
  const threshold = Number.isFinite(candidate.limit.staleAfterMs)
    ? candidate.limit.staleAfterMs
    : snapshot.capture[`${candidate.provider}FreshnessMs`];
  return !state.connected || !Number.isFinite(state.ageMs) || state.ageMs > threshold;
}

function renderPlaceholder(container, text) {
  const placeholder = document.createElement("div");
  placeholder.className = "timeline-placeholder";
  placeholder.textContent = text;
  container.replaceChildren(placeholder);
  container.removeAttribute("role");
  container.removeAttribute("aria-label");
}

function setVizState(id, text, tone = "") {
  const state = document.getElementById(id);
  state.textContent = text;
  state.className = `viz-state ${tone}`.trim();
}

function renderSurvivalTimeline(candidate, snapshot) {
  const container = document.getElementById("survival-timeline");
  const summary = document.getElementById("timeline-summary");
  const { limit } = candidate;
  const source = Date.parse(limit.sourceCapturedAt);
  const reset = Date.parse(limit.resetAt);
  const earliest = Date.parse(limit.expectedExhaustionEarliestAt);
  const latest = Date.parse(limit.expectedExhaustionLatestAt);
  const stale = limitIsStale(snapshot, candidate);

  if (stale) {
    setVizState("timeline-state", "판정 보류", "unknown");
    renderPlaceholder(container, "최신 사용량을 다시 수집해야 합니다");
    summary.textContent = "오래된 예상값은 현재 상태처럼 표시하지 않습니다.";
    return;
  }
  if (!Number.isFinite(source) || !Number.isFinite(reset) || reset <= source) {
    setVizState("timeline-state", "리셋 정보 없음", "unknown");
    renderPlaceholder(container, "리셋 시각을 확인할 수 없습니다");
    summary.textContent = "공급자가 리셋 시각을 제공한 뒤 생존 여부를 계산합니다.";
    return;
  }

  const labels = document.createElement("div");
  labels.className = "timeline-labels";
  const startLabel = document.createElement("span");
  startLabel.textContent = `수집 ${formatDateTime(limit.sourceCapturedAt)}`;
  const resetLabel = document.createElement("span");
  resetLabel.textContent = `리셋 ${formatDateTime(limit.resetAt)}`;
  labels.append(startLabel, resetLabel);
  const track = document.createElement("div");
  track.className = "timeline-track";
  container.replaceChildren(labels, track);

  if (!Number.isFinite(earliest) || !Number.isFinite(latest)) {
    setVizState("timeline-state", "소진 속도 계산 전", "unknown");
    renderPlaceholder(container, "잔여량이 실제로 줄어들면 고갈 시점을 계산합니다");
    summary.textContent = "수집 횟수보다 잔여량이 변한 기록이 필요합니다.";
    return;
  }

  const span = reset - source;
  const left = Math.max(0, Math.min(100, (earliest - source) / span * 100));
  const right = Math.max(left, Math.min(100, (latest - source) / span * 100));
  if (limit.forecastStatus !== "safe") {
    const range = document.createElement("div");
    range.className = `timeline-range ${limit.forecastStatus === "risk" ? "" : "unknown"}`.trim();
    range.style.left = `${left}%`;
    range.style.width = `${Math.max(2, right - left)}%`;
    track.appendChild(range);
  }

  if (limit.forecastStatus === "risk") {
    setVizState("timeline-state", "리셋 전 소진 가능성 큼", "risk");
    summary.textContent = `늦게 소진돼도 리셋보다 ${formatDuration(reset - latest)} 빠릅니다. ${formatForecastEvidence(limit)}.`;
  } else if (limit.forecastStatus === "safe") {
    setVizState("timeline-state", "리셋까지 유지 가능", "safe");
    summary.textContent = `빠르게 소진돼도 리셋보다 ${formatDuration(earliest - reset)} 늦습니다. ${formatForecastEvidence(limit)}.`;
  } else {
    setVizState("timeline-state", "판단 유보", "unknown");
    summary.textContent = `빠른 경우와 느린 경우가 리셋 전후로 갈립니다. ${formatForecastEvidence(limit)}.`;
  }
  container.setAttribute("role", "img");
  container.setAttribute("aria-label", `${PROVIDER_LABELS[candidate.provider]} ${LIMIT_LABELS[candidate.type] || candidate.type}. ${summary.textContent}`);
}

function renderSlowdownBullet(candidate, snapshot) {
  const container = document.getElementById("slowdown-bullet");
  const summary = document.getElementById("slowdown-summary");
  const { limit } = candidate;
  const current = limit.currentRatePercentPerHour;
  const safe = limit.safeRatePercentPerHour;
  const reduction = limit.requiredReductionPercent;
  if (limitIsStale(snapshot, candidate)) {
    setVizState("slowdown-state", "판정 보류", "unknown");
    renderPlaceholder(container, "최신 속도를 다시 계산해야 합니다");
    summary.textContent = "오래된 데이터에는 감속 목표를 제시하지 않습니다.";
    return;
  }
  if (!Number.isFinite(current) || !Number.isFinite(safe) || !Number.isFinite(reduction)) {
    setVizState("slowdown-state", "속도 계산 전", "unknown");
    renderPlaceholder(container, "잔여량 변화가 확인되면 필요한 속도를 계산합니다");
    summary.textContent = "아직 사용량이 줄어든 기록이 없어 감속 목표를 계산할 수 없습니다.";
    return;
  }

  const maximum = Math.max(current, safe, 0.1) * 1.15;
  const safePosition = Math.min(100, safe / maximum * 100);
  const currentPosition = Math.min(100, current / maximum * 100);
  const track = document.createElement("div");
  track.className = "bullet-track";
  const safeZone = document.createElement("div");
  safeZone.className = "bullet-safe-zone";
  safeZone.style.width = `${safePosition}%`;
  const targetMarker = document.createElement("div");
  targetMarker.className = "bullet-marker target";
  targetMarker.style.left = `${safePosition}%`;
  const currentMarker = document.createElement("div");
  currentMarker.className = `bullet-marker current ${current > safe ? "risk" : ""}`.trim();
  currentMarker.style.left = `${currentPosition}%`;
  track.append(safeZone, targetMarker, currentMarker);
  const labels = document.createElement("div");
  labels.className = "bullet-labels";
  const targetLabel = document.createElement("span");
  targetLabel.textContent = `허용 ${safe.toFixed(2)}%p/시간`;
  const currentLabel = document.createElement("span");
  currentLabel.textContent = `현재 ${current.toFixed(2)}%p/시간`;
  labels.append(targetLabel, currentLabel);
  container.replaceChildren(track, labels);
  container.setAttribute("role", "img");
  container.setAttribute("aria-label", `현재 속도 ${current.toFixed(2)} 퍼센트포인트 매시간, 허용 속도 ${safe.toFixed(2)} 퍼센트포인트 매시간.`);

  if (limit.confidence === "low") {
    setVizState("slowdown-state", "참고용 비교", "unknown");
    summary.textContent = `최근 평균은 ${formatRate(current)}입니다. 관찰 기간이 짧아 정확한 감속률은 아직 제시하지 않습니다.`;
  } else if (reduction > 0) {
    setVizState("slowdown-state", `최소 약 ${Math.ceil(reduction / 5) * 5}% 감속`, "risk");
    summary.textContent = `최근 속도를 약 ${Math.ceil(reduction / 5) * 5}% 낮추면 다음 리셋까지 한도를 유지할 가능성이 커집니다.`;
  } else {
    setVizState("slowdown-state", "감속 불필요", "safe");
    summary.textContent = "현재 속도라면 다음 리셋까지 한도를 유지할 가능성이 큽니다.";
  }
}

function renderDecisionVisuals(analytics, snapshot) {
  const candidate = primaryLimit(analytics);
  const source = document.getElementById("decision-visual-source");
  if (!candidate) {
    source.textContent = "표시할 한도 없음";
    setVizState("timeline-state", "기록 없음", "unknown");
    setVizState("slowdown-state", "기록 없음", "unknown");
    renderPlaceholder(document.getElementById("survival-timeline"), "한도 기록이 없습니다");
    renderPlaceholder(document.getElementById("slowdown-bullet"), "한도 기록이 없습니다");
    return;
  }
  source.textContent = `${PROVIDER_LABELS[candidate.provider]} · ${LIMIT_LABELS[candidate.type] || candidate.type} · ${formatDateTime(candidate.limit.sourceCapturedAt)} 수집`;
  renderSurvivalTimeline(candidate, snapshot);
  renderSlowdownBullet(candidate, snapshot);
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
        ["최근 소진 속도", formatRate(limit.depletionRatePercentPerHour)],
        ["고갈 예상", formatForecastRange(limit)],
        ["다음 리셋", formatDateTime(limit.resetAt)],
        ["판정", limit.forecastStatus === "risk" ? "리셋 전 소진 가능성 큼" : limit.forecastStatus === "safe" ? "리셋까지 유지 가능" : Number.isFinite(limit.depletionRatePercentPerHour) ? "리셋 전후가 겹쳐 판단 유보" : "소진 속도 계산 전"],
        ["판정 근거", formatForecastEvidence(limit)],
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
    note.textContent = "잔여량이 실제로 줄어든 뒤 고갈 시점을 계산할 수 있습니다.";
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
  const priorityLimit = priority
    ? analytics.providers[priority.provider].limits[priority.limitType]
    : null;

  panel.className = "decision-panel";
  if (stalePriority || (!priority && stale.size)) {
    badge.textContent = "판정 보류";
    title.textContent = "최신 사용량을 확인한 뒤 다시 판단하겠습니다";
  } else if (critical) {
    panel.classList.add("critical");
    badge.textContent = "위험";
    title.textContent = `${PROVIDER_LABELS[critical.provider]} ${LIMIT_LABELS[critical.limitType] || critical.limitType} 한도가 거의 소진됐습니다`;
  } else if (warning) {
    panel.classList.add("warning");
    badge.textContent = warning.reason === "forecast_before_reset" ? "리셋 전 소진" : "주의";
    title.textContent = warning.reason === "forecast_before_reset"
      ? `현재 사용 흐름이면 ${PROVIDER_LABELS[warning.provider]} ${LIMIT_LABELS[warning.limitType] || warning.limitType} 한도가 리셋 전에 소진될 가능성이 큽니다`
      : `${PROVIDER_LABELS[warning.provider]} ${LIMIT_LABELS[warning.limitType] || warning.limitType} 한도를 확인하세요`;
  } else if (!hasKnownForecast) {
    badge.textContent = "속도 계산 전";
    title.textContent = "잔여량 변화가 확인되면 고갈 시점을 계산할 수 있습니다";
  } else {
    badge.textContent = "유지 가능";
    title.textContent = "현재 사용 흐름이면 다음 리셋까지 한도를 유지할 가능성이 큽니다";
  }

  detail.textContent = stalePriority || (!priority && stale.size)
    ? "마지막 수집 후 10분이 지났습니다. 이전 값 대신 최신 사용량으로 다시 계산하세요."
    : priority
    ? `${PROVIDER_LABELS[priority.provider]} ${LIMIT_LABELS[priority.limitType] || priority.limitType} ${priority.remainingPercent}% 남음${priorityLimit && Number.isFinite(priorityLimit.depletionRatePercentPerHour) ? ` · 최근 평균 ${formatRate(priorityLimit.depletionRatePercentPerHour)}` : ""}${priorityLimit && Date.parse(priorityLimit.resetAt) ? ` · ${formatDateTime(priorityLimit.resetAt)} 리셋` : ""}`
    : hasKnownForecast
      ? "최근 평균 사용 속도를 기준으로 한 결과입니다. 작업량이 크게 달라지면 다시 계산하세요."
      : "수집 횟수가 아니라 실제 잔여량 변화가 있어야 소진 속도를 계산할 수 있습니다.";
  primaryAction.textContent = stalePriority || (!priority && stale.size)
    ? "지금 다시 계산해 최신 사용량을 확인하세요."
    : warning && warning.reason === "forecast_before_reset" && warning.confidence === "low"
    ? "고갈 시점의 오차가 큽니다. 큰 작업을 나누고 사용량을 줄이세요."
    : !hasKnownForecast && !priority
    ? "잔여량이 줄어든 뒤 다시 계산하거나 활동 기반 자동 확인을 켜세요."
    : recommendation
    ? recommendation.action
    : "현재 속도를 유지해도 됩니다. 작업량이 달라지면 다시 확인하세요.";
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
  document.getElementById("generated-at").textContent = `${formatDateTime(analytics.generatedAt)} 계산 · 한도 기록 ${analytics.historySampleCount}개 · 토큰 기록 ${analytics.usageRowCount}개`;
  document.getElementById("alert-count").textContent = String(analytics.alerts.length);
  const hasKnownForecast = ["codex", "claude"].some((provider) =>
    Object.values((analytics.providers[provider] && analytics.providers[provider].limits) || {})
      .filter(Boolean)
      .some((limit) => limit.forecastStatus === "safe" || limit.forecastStatus === "risk"));
  document.getElementById("alert-detail").textContent = analytics.alerts.length
    ? "확인 필요"
    : hasKnownForecast ? "위험 알림 없음" : "소진 속도 계산 전";
  document.getElementById("total-cost").textContent = `$${analytics.costs.estimatedUsd.toFixed(2)}`;
  document.getElementById("day-change").textContent = formatPercent(analytics.comparison.dayOverDayPercent, true);
  document.getElementById("day-tokens").textContent = `${formatNumber(analytics.comparison.todayTokens)} vs ${formatNumber(analytics.comparison.yesterdayTokens)} tokens`;
  document.getElementById("week-change").textContent = formatPercent(analytics.comparison.weekOverWeekPercent, true);
  document.getElementById("week-tokens").textContent = `${formatNumber(analytics.comparison.currentSevenDaysTokens)} vs ${formatNumber(analytics.comparison.previousSevenDaysTokens)} tokens`;
  renderDecision(analytics, snapshot);
  renderDecisionVisuals(analytics, snapshot);
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
