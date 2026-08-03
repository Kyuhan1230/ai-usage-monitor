"use strict";

// 설치와 로그인은 사용자 동작으로 실행하고, 앱 전용 Claude hook은 기존 사용자 설정을 덮어쓰지 않는 범위에서 자동 연결한다.

const { deriveSetupView } = window.usageSetupView;
const codexDetail = document.getElementById("codex-detail");
const claudeDetail = document.getElementById("claude-detail");
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
const claudeVisibilityButton = document.getElementById("claude-visibility");
const claudeVisibilityDetail = document.getElementById("claude-visibility-detail");
const codexVisibilityCard = document.getElementById("codex-visibility-card");
const codexVisibilityButton = document.getElementById("codex-visibility");
const codexVisibilityDetail = document.getElementById("codex-visibility-detail");
const actionMessage = document.getElementById("action-message");
const checkUpdateButton = document.getElementById("check-update");
const updateDetail = document.getElementById("update-detail");
const codexCard = document.getElementById("codex-card");
const claudeActions = document.getElementById("claude-actions");
const claudeAddButton = document.getElementById("claude-add");
const claudeOnlyButton = document.getElementById("claude-only");
const claudeSection = document.getElementById("claude-section");
const codexAddAction = document.getElementById("codex-add-action");
const codexAddButton = document.getElementById("codex-add");
const setupHeadline = document.getElementById("setup-headline");
const setupSummary = document.getElementById("setup-summary");
const providerSelectionStatus = document.getElementById("provider-selection-status");
const themeSelect = document.getElementById("theme-select");
const languageSelect = document.getElementById("language-select");

let latestSnapshot = null;
let latestView = null;
let hookEnsureAttempted = false;
let windowIntent = {
  setupMode: null,
  claudeSectionExpanded: false,
};

themeSelect.value = window.usageTheme.readTheme();
themeSelect.addEventListener("change", () => {
  themeSelect.value = window.usageTheme.setTheme(themeSelect.value);
});
languageSelect.value = window.usageLanguage.readLanguage();
languageSelect.addEventListener("change", () => {
  languageSelect.value = window.usageLanguage.setLanguage(languageSelect.value);
});

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
  return checkedAt.toLocaleString(window.usageLanguage.locale(), {
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// 지금 실행 중인 버전을 항상 먼저 밝힌다. 어떤 상태든 사용자가 자기 버전을 알 수 있어야 한다.
function runningVersionPrefix(state) {
  const current = state.currentVersion ? String(state.currentVersion).replace(/^v/, "") : "";
  return current ? `v${current} 사용 중` : "현재 버전 확인 불가";
}

function renderUpdateState(state) {
  const availableVersion = (state.available && state.available.version) || state.availableVersion;
  const checkedAt = updateCheckTime(state.lastSuccessfulCheckAt);
  const running = runningVersionPrefix(state);
  if (availableVersion) {
    const version = String(availableVersion).replace(/^v/, "");
    updateDetail.textContent = state.lastCheckError
      ? `${running} · v${version} 업데이트 가능 · 마지막 확인 실패: ${state.lastCheckError}`
      : `${running} · v${version} 업데이트 가능 · 마지막 확인 ${checkedAt}`;
    checkUpdateButton.textContent = `v${version} 업데이트 열기`;
    return;
  }
  checkUpdateButton.textContent = state.lastCheckError ? "다시 확인" : "업데이트 확인";
  if (state.lastCheckError) {
    updateDetail.textContent = `${running} · 마지막 업데이트 확인 실패 · ${state.lastCheckError}`;
  } else if (state.lastSuccessfulCheckAt) {
    updateDetail.textContent = `${running} · 최신 버전입니다 · 마지막 확인 ${checkedAt}`;
  } else {
    updateDetail.textContent = `${running} · 아직 업데이트 확인을 완료하지 못했습니다.`;
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
  latestView = deriveSetupView(snapshot, windowIntent);
  const setup = snapshot.setup || {};
  const codex = snapshot.codex || {};
  const claude = snapshot.claude || {};
  const codexState = setup.codexCommandState || (setup.codexCommand ? "ready" : "missing");
  const claudeState = setup.claudeCommandState || (setup.claudeCommand ? "ready" : "missing");
  const codexAuth = setup.codexAuth || { state: "error" };
  const claudeAuth = setup.claudeAuth || { state: "error" };
  const codexStatus = providerStatus("codex", codexState, codexAuth, codex.connected, codex.ageMs);
  const claudeStatus = providerStatus("claude", claudeState, claudeAuth, claude.connected, claude.ageMs);

  setStatus(codexDetail, codexStatus.text, codexStatus.kind);
  setStatus(claudeDetail, claudeStatus.text, claudeStatus.kind);
  configureProviderButton(codexButton, "codex", codexState === "ready", codexAuth.state);
  configureProviderButton(claudeButton, "claude", claudeState === "ready", claudeAuth.state);

  detailsDetail.textContent = "정상: 별도 서버 없이 로컬 세션 파일에서 모델·날짜별 토큰을 표시합니다.";
  startupDetail.textContent = snapshot.launchAtLogin
    ? "켜짐: 앱만 시작하며 사용량 CLI는 상주시켜 두지 않습니다."
    : "꺼짐: 사용자가 직접 실행할 때만 앱이 시작됩니다.";
  launchAtLogin.checked = Boolean(snapshot.launchAtLogin);
  monitoringDetail.textContent = snapshot.monitoring && snapshot.monitoring.enabled
    ? "켜짐: 로컬 세션 활동이 있을 때만, 최소 5분 간격으로 사용량을 확인합니다."
    : "꺼짐: 새로고침 버튼을 눌렀을 때만 사용량을 확인합니다.";
  activityMonitoring.checked = Boolean(snapshot.monitoring && snapshot.monitoring.enabled);

  setupHeadline.textContent = latestView.headline;
  setupSummary.textContent = latestView.summary;
  codexCard.hidden = !latestView.showCodexCard;
  claudeSection.hidden = !latestView.claudeSectionExpanded;
  claudeAddButton.hidden = !latestView.showClaudeAddAction;
  claudeOnlyButton.hidden = !latestView.showClaudeOnlyAction;
  claudeActions.hidden = claudeAddButton.hidden && claudeOnlyButton.hidden;
  codexAddAction.hidden = !latestView.showCodexAddAction;

  completeButton.textContent = latestView.completionLabel;
  completeButton.disabled = !latestView.canComplete;
  completeButton.title = latestView.canComplete
    ? "첫 설정을 마치고 사용량 화면을 엽니다."
    : latestView.incompleteMessage;
  renderVisibility(snapshot);
  completeButton.hidden = Boolean(setup.onboardingComplete);
  laterButton.hidden = Boolean(setup.onboardingComplete);
}

// 이 앱의 표시에서만 빼는 설정이다. CLI 로그아웃이 아니라는 점을 문구로 분명히 한다.
function renderVisibility(snapshot) {
  const hidden = Array.isArray(snapshot.hiddenProviders) ? snapshot.hiddenProviders : [];
  const claudeHidden = hidden.includes("claude");
  claudeVisibilityButton.textContent = claudeHidden ? "다시 표시" : "이 앱에서 숨기기";
  setStatus(
    claudeVisibilityDetail,
    claudeHidden
      ? "숨김: 이 앱에서만 가립니다. Claude Code 로그인은 그대로이며 기록도 지우지 않습니다."
      : "표시 중: 숨기면 이 앱에서만 가려집니다. Claude Code 로그인은 유지됩니다.",
    claudeHidden ? "warning" : "ok",
  );

  const codexHidden = hidden.includes("codex");
  codexVisibilityCard.hidden = !codexHidden && !latestView.claudeSectionExpanded;
  codexVisibilityButton.textContent = codexHidden ? "다시 표시" : "이 앱에서 숨기기";
  setStatus(
    codexVisibilityDetail,
    codexHidden
      ? "숨김: 이 앱에서만 가립니다. Codex 로그인은 그대로이며 기록도 지우지 않습니다."
      : "표시 중: 숨기면 이 앱에서만 가려집니다. Codex 로그인은 유지됩니다.",
    codexHidden ? "warning" : "ok",
  );
}

async function toggleProviderVisibility(provider, button) {
  const hidden = button.textContent !== "다시 표시";
  button.disabled = true;
  actionMessage.dataset.kind = "progress";
  try {
    await window.usageApp.setProviderHidden(provider, hidden);
    await refresh(false);
    actionMessage.dataset.kind = "ok";
    const name = provider === "codex" ? "Codex" : "Claude Code";
    actionMessage.textContent = hidden
      ? `${name}를 이 앱에서 숨겼습니다. CLI 로그인은 그대로입니다.`
      : `${name}를 다시 표시합니다.`;
  } catch (error) {
    actionMessage.dataset.kind = "error";
    actionMessage.textContent = `표시 설정 변경 실패: ${String(error)}`;
  } finally {
    button.disabled = false;
  }
}

function announceProviderChoice(message, headingId) {
  providerSelectionStatus.textContent = message;
  window.requestAnimationFrame(() => {
    const heading = document.getElementById(headingId);
    if (heading) {
      heading.focus();
    }
  });
}

function chooseClaudeAdd() {
  if (!latestSnapshot) {
    return;
  }
  windowIntent = {
    setupMode: "codex",
    claudeSectionExpanded: true,
  };
  render(latestSnapshot);
  announceProviderChoice("Claude Code 연결 영역을 열었습니다.", "claude-heading");
}

function chooseClaudeOnly() {
  if (!latestSnapshot) {
    return;
  }
  windowIntent = {
    setupMode: "claudeOnly",
    claudeSectionExpanded: true,
  };
  render(latestSnapshot);
  announceProviderChoice("Claude Code를 사용할 도구로 선택했습니다.", "claude-heading");
}

function chooseCodex() {
  if (!latestSnapshot) {
    return;
  }
  windowIntent = {
    setupMode: "codex",
    claudeSectionExpanded: Boolean(latestView && latestView.claudeSectionExpanded),
  };
  render(latestSnapshot);
  announceProviderChoice("Codex CLI를 사용할 도구로 선택했습니다.", "codex-heading");
}

async function ensureClaudeUsageHook(snapshot) {
  const setup = snapshot.setup || {};
  const authenticated = setup.claudeAuth && setup.claudeAuth.state === "authenticated";
  if (hookEnsureAttempted || !authenticated || (snapshot.claude && snapshot.claude.hookInstalled)) {
    return snapshot;
  }
  hookEnsureAttempted = true;
  try {
    const result = await window.usageApp.ensureClaudeHook();
    return result && result.status !== "replacement_required"
      ? await window.usageApp.setupSnapshot()
      : snapshot;
  } catch (_error) {
    return snapshot;
  }
}

async function refresh(collectUsage = false) {
  refreshButton.disabled = true;
  collectButton.disabled = true;
  actionMessage.dataset.kind = "progress";
  actionMessage.textContent = collectUsage
    ? "연결된 도구의 사용량을 한 번씩 확인하는 중입니다."
    : "설치 및 로그인 상태를 확인하는 중입니다.";
  try {
    let snapshot = collectUsage
      ? await window.usageApp.refreshSetupSnapshot()
      : await window.usageApp.setupSnapshot();
    snapshot = await ensureClaudeUsageHook(snapshot);
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
  if (!skipped && (!latestView || !latestView.canComplete)) {
    return;
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
      const current = result.currentVersion ? String(result.currentVersion).replace(/^v/, "") : "";
      actionMessage.textContent = current
        ? `v${current}이 최신 버전입니다.`
        : "현재 최신 버전을 사용하고 있습니다.";
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
claudeAddButton.addEventListener("click", chooseClaudeAdd);
claudeOnlyButton.addEventListener("click", chooseClaudeOnly);
codexAddButton.addEventListener("click", chooseCodex);
claudeVisibilityButton.addEventListener("click", () => toggleProviderVisibility("claude", claudeVisibilityButton));
codexVisibilityButton.addEventListener("click", () => toggleProviderVisibility("codex", codexVisibilityButton));
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
