"use strict";

// 설정 변경은 모두 명시적인 사용자 동작으로만 실행한다.

const codexDetail = document.getElementById("codex-detail");
const claudeDetail = document.getElementById("claude-detail");
const hookDetail = document.getElementById("hook-detail");
const detailsDetail = document.getElementById("details-detail");
const startupDetail = document.getElementById("startup-detail");
const launchAtLogin = document.getElementById("launch-at-login");
const refreshButton = document.getElementById("refresh");

function isFresh(ageMs) {
  return Number.isFinite(ageMs) && ageMs <= 10 * 60 * 1000;
}

function ageText(ageMs) {
  if (!Number.isFinite(ageMs)) {
    return "수집 기록 없음";
  }
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) {
    return "방금 수집";
  }
  if (minutes < 60) {
    return `${minutes}분 전 수집`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}시간 ${rest}분 전 수집` : `${hours}시간 전 수집`;
}

function statusText(commandOk, connected, ageMs, missingCommand, staleHelp, refreshError) {
  if (!commandOk) {
    return `필요: ${missingCommand}`;
  }
  if (refreshError) {
    return `수집 실패: ${refreshError}`;
  }
  if (!connected) {
    return "지금 수집을 눌러 계정 사용량을 확인하세요.";
  }
  if (!isFresh(ageMs)) {
    return `오래된 값: ${ageText(ageMs)}. ${staleHelp}`;
  }
  return `정상: ${ageText(ageMs)}`;
}

async function refresh(force = false) {
  refreshButton.disabled = true;
  try {
    const snapshot = force
      ? await window.usageApp.refreshSetupSnapshot()
      : await window.usageApp.setupSnapshot();
    const errors = snapshot.refresh && snapshot.refresh.errors ? snapshot.refresh.errors : {};
    codexDetail.textContent = statusText(
      snapshot.setup.codexCommand,
      snapshot.codex.connected,
      snapshot.codex.ageMs,
      "Codex CLI를 설치하고 로그인해야 합니다.",
      "지금 수집을 눌러 공식 app-server 스냅샷을 갱신하세요.",
      errors.codex,
    );
    claudeDetail.textContent = statusText(
      snapshot.setup.claudeCommand,
      snapshot.claude.connected,
      snapshot.claude.ageMs,
      "Claude Code를 설치하고 로그인해야 합니다.",
      "Claude를 사용하면 statusLine 이벤트가 갱신하며, 지금 수집은 /usage를 한 번 실행합니다.",
      errors.claude,
    );
    hookDetail.textContent = snapshot.claude.hookInstalled
      ? "연결됨: Claude가 statusLine을 그릴 때 받은 사용량을 로컬에 기록합니다. 추가 CLI 폴러는 실행하지 않습니다."
      : "권장: 이벤트 연결을 누르면 Claude 사용 중에만 값이 갱신됩니다. 기존 statusLine 명령은 동의 없이 덮어쓰지 않습니다.";
    detailsDetail.textContent = "정상: 별도 서버나 런타임 없이 Tauri 앱 내부에서 모델·날짜별 토큰을 표시합니다.";
    startupDetail.textContent = snapshot.launchAtLogin
      ? "켜짐: 앱만 시작하며, 사용량 CLI를 상주시켜 두지 않습니다."
      : "꺼짐: 사용자가 직접 실행할 때만 앱이 시작됩니다.";
    launchAtLogin.checked = snapshot.launchAtLogin;
  } finally {
    refreshButton.disabled = false;
  }
}

document.getElementById("codex-login").addEventListener("click", () => window.usageApp.openCodexLogin());
document.getElementById("claude-auth").addEventListener("click", () => window.usageApp.openClaudeAuth());
document.getElementById("install-hook").addEventListener("click", async () => {
  await window.usageApp.installClaudeHook();
  await refresh();
});
document.getElementById("open-details").addEventListener("click", () => window.usageApp.openDetails());
launchAtLogin.addEventListener("change", async () => {
  await window.usageApp.setLaunchAtLogin(launchAtLogin.checked);
  await refresh();
});
refreshButton.addEventListener("click", () => refresh(true));

refresh();
