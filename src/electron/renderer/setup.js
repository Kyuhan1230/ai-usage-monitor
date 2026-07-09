"use strict";

const codexDetail = document.getElementById("codex-detail");
const claudeDetail = document.getElementById("claude-detail");
const hookDetail = document.getElementById("hook-detail");
const runtimeDetail = document.getElementById("runtime-detail");
const startupDetail = document.getElementById("startup-detail");
const startupBadge = document.getElementById("startup-badge");

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

function statusText(commandOk, connected, ageMs, missingCommand, staleHelp) {
  if (!commandOk) {
    return `필요: ${missingCommand}`;
  }
  if (!connected) {
    return "주의: CLI는 있지만 status 파일이 아직 없습니다. 로그인 후 대시보드가 한 번 캡처해야 합니다.";
  }
  if (!isFresh(ageMs)) {
    return `주의: 오래된 값입니다. ${ageText(ageMs)}. ${staleHelp}`;
  }
  return `정상: ${ageText(ageMs)}`;
}

async function refresh() {
  const snapshot = await window.usageApp.snapshot();
  codexDetail.textContent = statusText(
    snapshot.setup.codexCommand,
    snapshot.codex.connected,
    snapshot.codex.ageMs,
    "codex 명령을 찾지 못했습니다. Codex CLI 설치가 필요합니다.",
    "백그라운드 poller가 다음 주기에 다시 캡처합니다.",
  );
  claudeDetail.textContent = statusText(
    snapshot.setup.claudeCommand,
    snapshot.claude.connected,
    snapshot.claude.ageMs,
    "claude 명령을 찾지 못했습니다. Claude Code 설치가 필요합니다.",
    "Claude Code 창이 statusLine을 다시 그리면 갱신됩니다.",
  );
  hookDetail.textContent = snapshot.claude.hookInstalled
    ? `정상: 현재 앱으로 연결됨. ${snapshot.setup.hookCommand}`
    : "필요: statusLine hook이 현재 앱을 가리키지 않습니다. hook 설치를 누르세요.";
  runtimeDetail.textContent = snapshot.setup.uvicornCommand
    ? "정상: uvicorn을 찾았습니다. 내부 대시보드 서버를 띄울 수 있습니다."
    : "필요: uvicorn 명령을 찾지 못했습니다. Python 환경에 fastapi/uvicorn 설치가 필요합니다.";
  startupDetail.textContent = snapshot.launchAtLogin
    ? "정상: Windows 로그인 후 앱이 자동 실행됩니다."
    : "주의: 자동 실행 등록이 확인되지 않았습니다. 앱을 다시 시작하면 재등록을 시도합니다.";
  startupBadge.textContent = snapshot.launchAtLogin ? "정상" : "주의";
}

document.getElementById("codex-login").addEventListener("click", () => window.usageApp.openCodexLogin());
document.getElementById("claude-auth").addEventListener("click", () => window.usageApp.openClaudeAuth());
document.getElementById("install-hook").addEventListener("click", async () => {
  await window.usageApp.installClaudeHook();
  await refresh();
});
document.getElementById("open-dashboard").addEventListener("click", () => window.usageApp.openDashboard());
document.getElementById("refresh").addEventListener("click", refresh);

refresh();
