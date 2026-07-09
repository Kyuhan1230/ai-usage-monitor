"use strict";

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

function limitText(limit, fallback) {
  if (!limit || !Number.isInteger(limit.remaining_percent)) {
    return fallback;
  }
  return `${limit.remaining_percent}% 남음`;
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

function isFresh(ageMs) {
  return Number.isFinite(ageMs) && ageMs <= 10 * 60 * 1000;
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

function stateText(connected, ageMs, staleText) {
  if (!connected) {
    return "확인 필요";
  }
  return isFresh(ageMs) ? "최신" : staleText;
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
  el["codex-state"].textContent = stateText(snapshot.codex.connected, snapshot.codex.ageMs, "지연");
  el["codex-five-hour"].textContent = percentText(codexFiveHour);
  el["codex-weekly"].textContent = percentText(codexWeekly);
  el["codex-reset"].textContent = resetText(codexLimit);
  el["codex-stamp"].textContent = ageText(snapshot.codex.ageMs);

  renderDial("claude", claudeLimit);
  el["claude-state"].textContent = stateText(snapshot.claude.connected, snapshot.claude.ageMs, "오래됨");
  el["claude-five-hour"].textContent = percentText(claudeFiveHour);
  el["claude-seven-day"].textContent = percentText(claudeSevenDay);
  el["claude-reset"].textContent = resetText(claudeLimit);
  el["claude-stamp"].textContent = snapshot.claude.hookInstalled ? ageText(snapshot.claude.ageMs) : "Claude hook 설정 필요";

  el["always-on-top"].checked = Boolean(snapshot.window.alwaysOnTop);
  el.opacity.value = Math.round((snapshot.window.opacity || 0.96) * 100);
}

async function refresh() {
  const snapshot = await window.usageApp.snapshot();
  render(snapshot);
}

el["always-on-top"].addEventListener("change", async () => {
  render(await window.usageApp.setAlwaysOnTop(el["always-on-top"].checked));
});
el.opacity.addEventListener("input", async () => {
  render(await window.usageApp.setOpacity(Number(el.opacity.value) / 100));
});
el.minimize.addEventListener("click", () => window.usageApp.minimize());
el.quit.addEventListener("click", () => window.usageApp.quit());
el.refresh.addEventListener("click", refresh);
el["open-dashboard"].addEventListener("click", () => window.usageApp.openDashboard());

refresh();
setInterval(refresh, 3000);
