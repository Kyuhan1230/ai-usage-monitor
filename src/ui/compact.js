"use strict";

// 백엔드 구현과 무관하게 동일한 snapshot 계약만 사용한다.

const { stateText } = window.usageStatusHealth;
const { activeProviders, visibleRecommendations } = window.usageProviderView;

const ids = [
  "meters",
  "no-provider",
  "codex-state",
  "codex-decision",
  "codex-decision-status",
  "codex-decision-action",
  "codex-five-hour",
  "codex-five-hour-bar",
  "codex-five-hour-rate",
  "codex-weekly",
  "codex-weekly-bar",
  "codex-weekly-rate",
  "codex-reset",
  "codex-stamp",
  "claude-state",
  "claude-decision",
  "claude-decision-status",
  "claude-decision-action",
  "claude-five-hour",
  "claude-five-hour-bar",
  "claude-five-hour-rate",
  "claude-seven-day",
  "claude-seven-day-bar",
  "claude-seven-day-rate",
  "claude-reset",
  "claude-stamp",
  "always-on-top",
  "opacity",
  "minimize",
  "close",
  "resize-grip",
  "refresh",
  "open-setup",
  "open-insights",
  "open-details",
];

const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

function level(percent) {
  if (!Number.isInteger(percent)) {
    return "neutral";
  }
  if (percent <= 10) {
    return "critical";
  }
  if (percent <= 50) {
    return "warning";
  }
  return "neutral";
}

function resetText(limit) {
  if (!limit || typeof limit.reset_text !== "string" || !limit.reset_text) {
    return "reset 정보 없음";
  }
  return normalizeResetText(limit.reset_text);
}

function firstResetText(...limits) {
  const limit = limits.find((candidate) => (
    candidate && typeof candidate.reset_text === "string" && candidate.reset_text
  ));
  return resetText(limit);
}

function normalizeResetText(value) {
  const isoMatch = value.match(/^resets?\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/i);
  if (isoMatch) {
    return `resets ${isoMatch[2]}/${isoMatch[3]} ${isoMatch[4].padStart(2, "0")}:${isoMatch[5]}`;
  }

  const shortMatch = value.match(/^resets?\s+(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/i);
  if (shortMatch) {
    return `resets ${shortMatch[1].padStart(2, "0")}/${shortMatch[2].padStart(2, "0")} ${shortMatch[3].padStart(2, "0")}:${shortMatch[4]}`;
  }

  return value;
}

function ageText(ageMs) {
  if (!Number.isFinite(ageMs)) {
    return "갱신 기록 없음";
  }
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) {
    return "방금 갱신";
  }
  if (minutes < 60) {
    return `${minutes}분 전 갱신`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}시간 ${rest}분 전 갱신` : `${hours}시간 전 갱신`;
}

function renderLimitBar(id, limit) {
  const percent = limit && Number.isInteger(limit.remaining_percent) ? limit.remaining_percent : null;
  el[id].textContent = percent === null ? "--" : `${percent}%`;
  el[id].dataset.level = level(percent);
  const bar = el[`${id}-bar`];
  bar.style.setProperty("--pct", percent === null ? 0 : percent);
  if (percent === null) {
    bar.removeAttribute("aria-valuenow");
    bar.setAttribute("aria-valuetext", "수집 중");
  } else {
    bar.setAttribute("aria-valuenow", String(percent));
    bar.setAttribute("aria-valuetext", `${percent}% 남음`);
  }
}

function renderLimitRate(id, limit, stale) {
  if (stale) {
    el[id].textContent = "속도 갱신 필요";
    return;
  }
  const rate = limit && limit.depletionRatePercentPerHour;
  el[id].textContent = Number.isFinite(rate)
    ? `시간당 ${rate}%p`
    : "속도 계산 전";
}

function staleProviders(snapshot, providers) {
  return new Set(providers.filter((provider) => {
    const state = snapshot[provider];
    const freshness = snapshot.capture[`${provider}FreshnessMs`];
    return state.connected && Number.isFinite(state.ageMs) && state.ageMs > freshness;
  }));
}

function renderProviderDecision(provider, analytics, snapshot, stale) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const container = el[`${provider}-decision`];
  const status = el[`${provider}-decision-status`];
  const action = el[`${provider}-decision-action`];
  if (!analytics) {
    container.dataset.tone = "neutral";
    status.textContent = `${label} 사용 흐름 확인 전`;
    action.textContent = "최근 사용 속도를 계산하는 중입니다.";
    return;
  }
  if (stale.has(provider)) {
    container.dataset.tone = "neutral";
    status.textContent = `${label} 최신 사용량 확인 필요`;
    action.textContent = "마지막 수집 후 시간이 지났습니다. 지금 새로고침하세요.";
    return;
  }

  const alerts = (analytics.alerts || []).filter((alert) => alert.provider === provider);
  const critical = alerts.find((alert) => alert.severity === "critical");
  const warning = alerts.find((alert) => alert.severity === "warning");
  const priority = critical || warning;
  const recommendation = visibleRecommendations(analytics, [provider])
    .find((item) => item.provider === provider);
  const limits = Object.values((analytics.providers[provider] && analytics.providers[provider].limits) || {})
    .filter(Boolean);
  const hasKnownForecast = limits.some((limit) => limit.forecastStatus === "safe" || limit.forecastStatus === "risk");

  if (critical) {
    container.dataset.tone = "critical";
    status.textContent = `${label} 한도 위험 · ${critical.remainingPercent}% 남음`;
  } else if (warning) {
    container.dataset.tone = "warning";
    status.textContent = warning.reason === "forecast_before_reset"
      ? `${label} 리셋 전 소진 가능성`
      : `${label} 한도 주의 · ${warning.remainingPercent}% 남음`;
  } else if (!hasKnownForecast) {
    container.dataset.tone = "neutral";
    status.textContent = `${label} 소진 속도 계산 전`;
    action.textContent = "잔여량이 줄어들면 리셋 전 고갈 여부를 계산합니다.";
    return;
  } else {
    container.dataset.tone = "ok";
    status.textContent = `${label} 현재 속도 유지 가능`;
  }

  action.textContent = warning && warning.reason === "forecast_before_reset" && warning.confidence === "low"
    ? "고갈 시점의 오차가 큽니다. 큰 작업을 나누고 사용량을 줄이세요."
    : recommendation
    ? recommendation.action
    : "현재 속도를 유지해도 됩니다. 작업량이 달라지면 다시 확인하세요.";
}

function render(snapshot) {
  const providers = activeProviders(snapshot);
  const hasCodex = providers.includes("codex");
  const hasClaude = providers.includes("claude");
  document.querySelector('[data-tool="codex"]').hidden = !hasCodex;
  document.querySelector('[data-tool="claude"]').hidden = !hasClaude;
  el.meters.hidden = !providers.length;
  el["no-provider"].hidden = providers.length > 0;
  // 열 수는 표시 대상 공급자 수에서 파생한다. 한쪽이 빈 2열 그리드를 남기지 않는다.
  el.meters.dataset.providerCount = String(providers.length);

  const codexFiveHour = snapshot.codex.limits.five_hour;
  const codexWeekly = snapshot.codex.limits.weekly;
  const codexLimit = codexFiveHour || codexWeekly || snapshot.codex.limits.monthly;
  const claudeFiveHour = snapshot.claude.limits.five_hour;
  const claudeSevenDay = snapshot.claude.limits.seven_day;
  const claudeLimit = claudeFiveHour || claudeSevenDay;
  const analytics = snapshot.analytics;
  const stale = staleProviders(snapshot, providers);
  const codexAnalytics = analytics && analytics.providers && analytics.providers.codex
    ? analytics.providers.codex.limits
    : {};
  const claudeAnalytics = analytics && analytics.providers && analytics.providers.claude
    ? analytics.providers.claude.limits
    : {};

  if (hasCodex) {
    renderLimitBar("codex-five-hour", codexFiveHour);
    renderLimitBar("codex-weekly", codexWeekly);
    renderLimitRate("codex-five-hour-rate", codexAnalytics.five_hour, stale.has("codex"));
    renderLimitRate("codex-weekly-rate", codexAnalytics.weekly, stale.has("codex"));
    el["codex-state"].textContent = stateText({
      connected: snapshot.codex.connected,
      ageMs: snapshot.codex.ageMs,
      staleText: "지연",
      captureState: snapshot.codex.status && snapshot.codex.status.capture
        ? snapshot.codex.status.capture.state
        : null,
      freshnessMs: snapshot.capture.codexFreshnessMs,
    });
    el["codex-reset"].textContent = resetText(codexLimit);
    el["codex-stamp"].textContent = ageText(snapshot.codex.ageMs);
    renderProviderDecision("codex", analytics, snapshot, stale);
  }

  if (hasClaude) {
    renderLimitBar("claude-five-hour", claudeFiveHour);
    renderLimitBar("claude-seven-day", claudeSevenDay);
    renderLimitRate("claude-five-hour-rate", claudeAnalytics.five_hour, stale.has("claude"));
    renderLimitRate("claude-seven-day-rate", claudeAnalytics.seven_day, stale.has("claude"));
    el["claude-state"].textContent = stateText({
      connected: snapshot.claude.connected,
      ageMs: snapshot.claude.ageMs,
      staleText: "오래됨",
      captureState: snapshot.claude.status && snapshot.claude.status.capture
        ? snapshot.claude.status.capture.state
        : null,
      freshnessMs: snapshot.capture.claudeFreshnessMs,
    });
    el["claude-reset"].textContent = firstResetText(claudeLimit, claudeSevenDay, claudeFiveHour);
    el["claude-stamp"].textContent = ageText(snapshot.claude.ageMs);
    renderProviderDecision("claude", analytics, snapshot, stale);
  }
  el["always-on-top"].checked = Boolean(snapshot.window.alwaysOnTop);
  el.opacity.value = Math.round((snapshot.window.opacity || 0.96) * 100);
}

async function refresh(force = false) {
  if (!force) {
    render(await window.usageApp.snapshot());
    return;
  }

  el.refresh.disabled = true;
  let progressPending = false;
  const progressTimer = setInterval(async () => {
    if (progressPending) {
      return;
    }
    progressPending = true;
    try {
      render(await window.usageApp.snapshot());
    } finally {
      progressPending = false;
    }
  }, 1000);

  try {
    render(await window.usageApp.refreshSnapshot());
  } finally {
    clearInterval(progressTimer);
    el.refresh.disabled = false;
  }
}

el["always-on-top"].addEventListener("change", async () => {
  render(await window.usageApp.setAlwaysOnTop(el["always-on-top"].checked));
});

let opacityTimer = null;
el.opacity.addEventListener("input", () => {
  clearTimeout(opacityTimer);
  opacityTimer = setTimeout(async () => {
    render(await window.usageApp.setOpacity(Number(el.opacity.value) / 100));
  }, 120);
});

el.minimize.addEventListener("click", () => window.usageApp.minimize());
el.close.addEventListener("click", () => window.usageApp.close());
el["resize-grip"].addEventListener("pointerdown", (event) => {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  window.usageApp.startResize().catch(() => {});
});
el.refresh.addEventListener("click", () => refresh(true));
el["open-setup"].addEventListener("click", () => window.usageApp.openSetup());
el["open-insights"].addEventListener("click", () => window.usageApp.openInsights());
el["open-details"].addEventListener("click", () => window.usageApp.openDetails());
for (const provider of ["codex", "claude"]) {
  const decision = el[`${provider}-decision`];
  decision.addEventListener("click", () => window.usageApp.openInsights());
  decision.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      window.usageApp.openInsights();
    }
  });
}
refresh();
setInterval(refresh, 10000);
