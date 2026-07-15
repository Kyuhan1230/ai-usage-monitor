"use strict";

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
  "always-on-top",
  "opacity",
  "minimize",
  "quit",
  "refresh",
  "open-setup",
  "open-dashboard",
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
    pollerState: snapshot.codex.status && snapshot.codex.status.poller
      ? snapshot.codex.status.poller.state
      : null,
    pollIntervalMs: snapshot.poller.codexIntervalMs,
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
    pollerState: snapshot.claude.status && snapshot.claude.status.poller
      ? snapshot.claude.status.poller.state
      : null,
    pollIntervalMs: snapshot.poller.claudeIntervalMs,
  });
  el["claude-five-hour"].textContent = percentText(claudeFiveHour);
  el["claude-seven-day"].textContent = percentText(claudeSevenDay);
  el["claude-reset"].textContent = firstResetText(claudeLimit, claudeSevenDay, claudeFiveHour);
  el["claude-stamp"].textContent = ageText(snapshot.claude.ageMs);

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
el.quit.addEventListener("click", () => window.usageApp.quit());
el.refresh.addEventListener("click", () => refresh(true));
el["open-setup"].addEventListener("click", () => window.usageApp.openSetup());
el["open-dashboard"].addEventListener("click", () => window.usageApp.openDashboard());

refresh();
setInterval(refresh, 10000);
