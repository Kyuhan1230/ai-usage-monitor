"use strict";

// 백엔드 구현과 무관하게 동일한 snapshot 계약만 사용한다.

const { stateText } = window.usageStatusHealth;

const ids = [
  "codex-state",
  "codex-dial",
  "codex-value",
  "codex-five-hour",
  "codex-weekly",
  "codex-reset",
  "codex-stamp",
  "claude-state",
  "claude-dial",
  "claude-value",
  "claude-five-hour",
  "claude-seven-day",
  "claude-reset",
  "claude-stamp",
  "decision",
  "decision-status",
  "decision-action",
  "always-on-top",
  "opacity",
  "minimize",
  "close",
  "refresh",
  "open-setup",
  "open-insights",
  "open-details",
];

const el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));

function tone(percent) {
  if (!Number.isInteger(percent)) {
    return "var(--line)";
  }
  if (percent <= 10) {
    return "var(--bad)";
  }
  if (percent <= 50) {
    return "var(--warn)";
  }
  return "var(--ok)";
}

function percentText(limit) {
  if (!limit || !Number.isInteger(limit.remaining_percent)) {
    return "--";
  }
  return `${limit.remaining_percent}%`;
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

function renderDial(prefix, limit) {
  const percent = limit && Number.isInteger(limit.remaining_percent) ? limit.remaining_percent : null;
  el[`${prefix}-value`].textContent = percent === null ? "--" : `${percent}%`;
  el[`${prefix}-dial`].style.setProperty("--pct", percent === null ? 0 : percent);
  el[`${prefix}-dial`].style.setProperty("--tone", tone(percent));
}

function renderDecision(analytics) {
  if (!analytics) {
    el.decision.dataset.tone = "neutral";
    el["decision-status"].textContent = "분석 기록 없음";
    el["decision-action"].textContent = "새로고침하면 고갈 위험을 계산합니다.";
    return;
  }
  const critical = analytics.alerts.find((alert) => alert.severity === "critical");
  const warning = analytics.alerts.find((alert) => alert.severity === "warning");
  const action = analytics.recommendations && analytics.recommendations[0];
  if (critical) {
    el.decision.dataset.tone = "critical";
    el["decision-status"].textContent = `${critical.provider === "codex" ? "Codex" : "Claude"} 한도 위험 · ${critical.remainingPercent}% 남음`;
  } else if (warning) {
    el.decision.dataset.tone = "warning";
    el["decision-status"].textContent = warning.reason === "forecast_before_reset"
      ? `${warning.provider === "codex" ? "Codex" : "Claude"} 리셋 전 고갈 가능`
      : `${warning.provider === "codex" ? "Codex" : "Claude"} 한도 주의 · ${warning.remainingPercent}% 남음`;
  } else {
    el.decision.dataset.tone = "ok";
    el["decision-status"].textContent = "현재 기록에서 고갈 위험 없음";
  }
  el["decision-action"].textContent = action
    ? action.action
    : "작업 흐름이 달라진 뒤 다시 확인하세요.";
}

function render(snapshot) {
  const codexFiveHour = snapshot.codex.limits.five_hour;
  const codexWeekly = snapshot.codex.limits.weekly;
  const codexLimit = codexFiveHour || codexWeekly || snapshot.codex.limits.monthly;
  const claudeFiveHour = snapshot.claude.limits.five_hour;
  const claudeSevenDay = snapshot.claude.limits.seven_day;
  const claudeLimit = claudeFiveHour || claudeSevenDay;

  renderDial("codex", codexLimit);
  el["codex-state"].textContent = stateText({
    connected: snapshot.codex.connected,
    ageMs: snapshot.codex.ageMs,
    staleText: "지연",
    captureState: snapshot.codex.status && snapshot.codex.status.capture
      ? snapshot.codex.status.capture.state
      : null,
    freshnessMs: snapshot.capture.codexFreshnessMs,
  });
  el["codex-five-hour"].textContent = percentText(codexFiveHour);
  el["codex-weekly"].textContent = percentText(codexWeekly);
  el["codex-reset"].textContent = resetText(codexLimit);
  el["codex-stamp"].textContent = ageText(snapshot.codex.ageMs);

  renderDial("claude", claudeLimit);
  el["claude-state"].textContent = stateText({
    connected: snapshot.claude.connected,
    ageMs: snapshot.claude.ageMs,
    staleText: "오래됨",
    captureState: snapshot.claude.status && snapshot.claude.status.capture
      ? snapshot.claude.status.capture.state
      : null,
    freshnessMs: snapshot.capture.claudeFreshnessMs,
  });
  el["claude-five-hour"].textContent = percentText(claudeFiveHour);
  el["claude-seven-day"].textContent = percentText(claudeSevenDay);
  el["claude-reset"].textContent = firstResetText(claudeLimit, claudeSevenDay, claudeFiveHour);
  el["claude-stamp"].textContent = ageText(snapshot.claude.ageMs);
  renderDecision(snapshot.analytics);

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
el.refresh.addEventListener("click", () => refresh(true));
el["open-setup"].addEventListener("click", () => window.usageApp.openSetup());
el["open-insights"].addEventListener("click", () => window.usageApp.openInsights());
el["open-details"].addEventListener("click", () => window.usageApp.openDetails());
el.decision.addEventListener("click", () => window.usageApp.openInsights());

refresh();
setInterval(refresh, 10000);
