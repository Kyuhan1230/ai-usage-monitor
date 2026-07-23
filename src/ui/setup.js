"use strict";

// 설치, 로그인, 설정 변경은 모두 명시적인 사용자 동작으로만 실행한다.

const codexDetail = document.getElementById("codex-detail");
const claudeDetail = document.getElementById("claude-detail");
const hookDetail = document.getElementById("hook-detail");
const detailsDetail = document.getElementById("details-detail");
const startupDetail = document.getElementById("startup-detail");
const monitoringDetail = document.getElementById("monitoring-detail");
const launchAtLogin = document.getElementById("launch-at-login");
const activityMonitoring = document.getElementById("activity-monitoring");
const refreshButton = document.getElementById("refresh");
const collectButton = document.getElementById("collect");
const completeButton = document.getElementById("setup-complete");
const laterButton = document.getElementById("setup-later");
const codexButton = document.getElementById("codex-login");
const claudeButton = document.getElementById("claude-auth");
const hookButton = document.getElementById("install-hook");
const actionMessage = document.getElementById("action-message");
const checkUpdateButton = document.getElementById("check-update");
const updateDetail = document.getElementById("update-detail");

let latestSnapshot = null;

function hasAuthenticatedProvider(setup) {
  return setup.codexAuth.state === "authenticated"
    || setup.claudeAuth.state === "authenticated";
}

function isFresh(ageMs) {
  return Number.isFinite(ageMs) && ageMs <= 10 * 60 * 1000;
}

function ageText(ageMs) {
  if (!Number.isFinite(ageMs)) {
    return "사용량 미수집";
  }
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) {
    return "사용량 방금 확인";
  }
  if (minutes < 60) {
    return `사용량 ${minutes}분 전 확인`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `사용량 ${hours}시간 ${rest}분 전 확인` : `사용량 ${hours}시간 전 확인`;
}

function setStatus(element, text, kind) {
  element.textContent = text;
  element.dataset.kind = kind;
}

function updateCheckTime(value) {
  const checkedAt = value ? new Date(value) : null;
  if (!checkedAt || Number.isNaN(checkedAt.getTime())) {
    return "확인 기록 없음";
  }
  return checkedAt.toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function renderUpdateState(state) {
  const availableVersion = (state.available && state.available.version) || state.availableVersion;
  const checkedAt = updateCheckTime(state.lastSuccessfulCheckAt);
  if (availableVersion) {
    const version = String(availableVersion).replace(/^v/, "");
    updateDetail.textContent = state.lastCheckError
      ? `v${version} 업데이트 가능 · 마지막 확인 실패: ${state.lastCheckError}`
      : `v${version} 업데이트 가능 · 마지막 확인 ${checkedAt}`;
    checkUpdateButton.textContent = `v${version} 업데이트 열기`;
    return;
  }
  checkUpdateButton.textContent = state.lastCheckError ? "다시 확인" : "업데이트 확인";
  if (state.lastCheckError) {
    updateDetail.textContent = `마지막 업데이트 확인 실패 · ${state.lastCheckError}`;
  } else if (state.lastSuccessfulCheckAt) {
    updateDetail.textContent = `현재 최신 버전 · 마지막 확인 ${checkedAt}`;
  } else {
    updateDetail.textContent = "아직 업데이트 확인을 완료하지 못했습니다.";
  }
}

async function loadUpdateState() {
  try {
    renderUpdateState(await window.usageApp.getUpdateState());
  } catch (error) {
    updateDetail.textContent = `업데이트 상태를 불러오지 못했습니다. ${String(error)}`;
    checkUpdateButton.textContent = "다시 확인";
  }
}

function providerStatus(provider, commandState, auth, connected, ageMs) {
  const name = provider === "codex" ? "Codex CLI" : "Claude Code";
  if (commandState === "desktop_bundle_only") {
    return {
      kind: "warning",
      text: "Codex 데스크톱 앱만 있습니다. 사용량 확인에는 독립 실행 Codex CLI가 필요합니다.",
    };
  }
  if (commandState !== "ready") {
    return { kind: "warning", text: `${name}가 설치되어 있지 않습니다.` };
  }
  const authState = auth && auth.state ? auth.state : "error";
  if (authState === "authenticated") {
    const usage = connected
      ? `${ageText(ageMs)}${isFresh(ageMs) ? "" : " · 다시 확인 권장"}`
      : "사용량 미수집";
    return { kind: "ok", text: `설치됨 · 로그인 완료 · ${usage}` };
  }
  if (authState === "unauthenticated") {
    return { kind: "warning", text: "설치됨 · 로그인이 필요합니다." };
  }
  return {
    kind: "error",
    text: "설치됨 · 로그인 상태를 확인하지 못했습니다. 상태를 다시 확인하세요.",
  };
}

function configureProviderButton(button, provider, commandReady, authState) {
  button.dataset.provider = provider;
  if (!commandReady) {
    button.dataset.action = "install";
    button.textContent = provider === "codex" ? "Codex 설치" : "Claude 설치";
    button.disabled = false;
    return;
  }
  if (authState === "authenticated") {
    button.dataset.action = "complete";
    button.textContent = "로그인 완료";
    button.disabled = true;
    return;
  }
  button.dataset.action = "login";
  button.textContent = provider === "codex" ? "Codex 로그인" : "Claude 로그인";
  button.disabled = false;
}

async function runProviderAction(button) {
  const provider = button.dataset.provider;
  const action = button.dataset.action;
  if (action === "complete") {
    return;
  }
  button.disabled = true;
  actionMessage.dataset.kind = "progress";
  try {
    if (action === "install") {
      const name = provider === "codex" ? "OpenAI Codex CLI" : "Anthropic Claude Code";
      const approved = window.confirm(`${name} 공식 설치 프로그램을 실행할까요?\n\n인터넷에서 CLI를 내려받으며, 설치 진행 상황은 새 PowerShell 창에 표시됩니다.`);
      if (!approved) {
        actionMessage.textContent = "CLI 설치를 취소했습니다.";
        actionMessage.dataset.kind = "warning";
        return;
      }
      await window.usageApp.installProvider(provider);
      actionMessage.textContent = `${name} 설치 창을 열었습니다. 설치가 끝나면 '상태 다시 확인'을 누르세요.`;
    } else {
      if (provider === "codex") {
        await window.usageApp.openCodexLogin();
      } else {
        await window.usageApp.openClaudeAuth();
      }
      actionMessage.textContent = `새 터미널에서 ${provider === "codex" ? "Codex" : "Claude"} 로그인을 시작했습니다. 완료한 뒤 '상태 다시 확인'을 누르세요.`;
    }
    actionMessage.dataset.kind = "ok";
  } catch (error) {
    actionMessage.dataset.kind = "error";
    actionMessage.textContent = `실행 실패: ${String(error)}`;
  } finally {
    button.disabled = false;
  }
}

function render(snapshot) {
  latestSnapshot = snapshot;
  const codexState = snapshot.setup.codexCommandState || (snapshot.setup.codexCommand ? "ready" : "missing");
  const claudeState = snapshot.setup.claudeCommandState || (snapshot.setup.claudeCommand ? "ready" : "missing");
  const codexAuth = snapshot.setup.codexAuth || { state: "error" };
  const claudeAuth = snapshot.setup.claudeAuth || { state: "error" };
  const codexStatus = providerStatus("codex", codexState, codexAuth, snapshot.codex.connected, snapshot.codex.ageMs);
  const claudeStatus = providerStatus("claude", claudeState, claudeAuth, snapshot.claude.connected, snapshot.claude.ageMs);

  setStatus(codexDetail, codexStatus.text, codexStatus.kind);
  setStatus(claudeDetail, claudeStatus.text, claudeStatus.kind);
  configureProviderButton(codexButton, "codex", snapshot.setup.codexCommand, codexAuth.state);
  configureProviderButton(claudeButton, "claude", snapshot.setup.claudeCommand, claudeAuth.state);

  hookDetail.textContent = snapshot.claude.hookInstalled
    ? "연결됨: Claude 사용 중 statusLine 이벤트로 최신 값이 로컬에 기록됩니다."
    : snapshot.setup.claudeCommand
      ? "권장: Claude를 사용할 때만 최신 사용량을 받는 로컬 이벤트 연결입니다."
      : "Claude Code 설치 후 연결할 수 있습니다.";
  hookButton.disabled = !snapshot.setup.claudeCommand;
  detailsDetail.textContent = "정상: 별도 서버 없이 로컬 세션 파일에서 모델·날짜별 토큰을 표시합니다.";
  startupDetail.textContent = snapshot.launchAtLogin
    ? "켜짐: 앱만 시작하며 사용량 CLI는 상주시켜 두지 않습니다."
    : "꺼짐: 사용자가 직접 실행할 때만 앱이 시작됩니다.";
  launchAtLogin.checked = snapshot.launchAtLogin;
  monitoringDetail.textContent = snapshot.monitoring.enabled
    ? "켜짐: 로컬 세션 활동이 있을 때만, 최소 5분 간격으로 사용량을 확인합니다."
    : "꺼짐: 새로고침 버튼을 눌렀을 때만 사용량을 확인합니다.";
  activityMonitoring.checked = snapshot.monitoring.enabled;

  const ready = hasAuthenticatedProvider(snapshot.setup);
  completeButton.disabled = !ready;
  completeButton.title = ready ? "첫 설정을 마치고 사용량 화면을 엽니다." : "Codex 또는 Claude 중 사용하는 도구 하나에 로그인하세요.";
  completeButton.hidden = snapshot.setup.onboardingComplete;
  laterButton.hidden = snapshot.setup.onboardingComplete;
}

async function refresh(collectUsage = false) {
  refreshButton.disabled = true;
  collectButton.disabled = true;
  actionMessage.dataset.kind = "progress";
  actionMessage.textContent = collectUsage
    ? "연결된 도구의 사용량을 한 번씩 확인하는 중입니다."
    : "설치 및 로그인 상태를 확인하는 중입니다.";
  try {
    const snapshot = collectUsage
      ? await window.usageApp.refreshSetupSnapshot()
      : await window.usageApp.setupSnapshot();
    render(snapshot);
    actionMessage.dataset.kind = "ok";
    actionMessage.textContent = collectUsage ? "사용량 확인을 마쳤습니다." : "설치 및 로그인 상태를 확인했습니다.";
  } catch (error) {
    actionMessage.dataset.kind = "error";
    actionMessage.textContent = `상태 확인 실패: ${String(error)}`;
  } finally {
    refreshButton.disabled = false;
    collectButton.disabled = false;
  }
}

async function finishOnboarding(skipped) {
  if (!skipped) {
    const setup = latestSnapshot && latestSnapshot.setup;
    const ready = setup && hasAuthenticatedProvider(setup);
    if (!ready) {
      return;
    }
  }
  await window.usageApp.completeOnboarding(skipped);
  await window.usageApp.openCompact();
  await window.usageApp.close();
}

async function checkForUpdate() {
  checkUpdateButton.disabled = true;
  actionMessage.dataset.kind = "progress";
  actionMessage.textContent = "새 버전을 확인하는 중입니다.";
  try {
    const result = await window.usageApp.checkForUpdate(true);
    await loadUpdateState();
    if (result.status === "up_to_date") {
      actionMessage.textContent = "현재 최신 버전을 사용하고 있습니다.";
    } else if (result.status === "available") {
      actionMessage.textContent = "업데이트 안내 창을 열었습니다.";
    } else {
      actionMessage.textContent = "다른 업데이트 확인이 진행 중입니다. 잠시 후 다시 시도하세요.";
    }
    actionMessage.dataset.kind = "ok";
  } catch (error) {
    await loadUpdateState();
    actionMessage.dataset.kind = "error";
    actionMessage.textContent = `업데이트 확인 실패: ${String(error)} 네트워크를 확인한 뒤 다시 시도하세요.`;
  } finally {
    checkUpdateButton.disabled = false;
  }
}

codexButton.addEventListener("click", () => runProviderAction(codexButton));
claudeButton.addEventListener("click", () => runProviderAction(claudeButton));
hookButton.addEventListener("click", async () => {
  try {
    await window.usageApp.installClaudeHook();
    await refresh(false);
  } catch (error) {
    actionMessage.dataset.kind = "error";
    actionMessage.textContent = `이벤트 연결 실패: ${String(error)}`;
  }
});
document.getElementById("open-details").addEventListener("click", () => window.usageApp.openDetails());
launchAtLogin.addEventListener("change", async () => {
  await window.usageApp.setLaunchAtLogin(launchAtLogin.checked);
  await refresh(false);
});
activityMonitoring.addEventListener("change", async () => {
  activityMonitoring.disabled = true;
  try {
    await window.usageApp.setActivityMonitoring(activityMonitoring.checked);
    await refresh(false);
  } finally {
    activityMonitoring.disabled = false;
  }
});
refreshButton.addEventListener("click", () => refresh(false));
collectButton.addEventListener("click", () => refresh(true));
completeButton.addEventListener("click", () => finishOnboarding(false));
laterButton.addEventListener("click", () => finishOnboarding(true));
checkUpdateButton.addEventListener("click", checkForUpdate);

refresh(false);
loadUpdateState();
