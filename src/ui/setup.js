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
const codexDeviceButton = document.getElementById("codex-device-login");
const codexBrowseButton = document.getElementById("codex-browse");
const codexCancelButton = document.getElementById("codex-cancel");
const codexMeta = document.getElementById("codex-meta");
const codexResponsibility = document.getElementById("codex-responsibility");
const codexCandidates = document.getElementById("codex-candidates");
const codexCandidateList = document.getElementById("codex-candidate-list");
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
let codexPoll = null;
let hookEnsureAttempted = false;
let windowIntent = {
  setupMode: null,
  claudeSectionExpanded: false,
};

const CODEX_POLL_INTERVAL_MS = 750;
const CODEX_POLL_MAX_MS = 10 * 60 * 1000;

function localizedText(value) {
  return window.usageLanguage.readLanguage() === "en"
    ? window.usageLanguage.translateText(value)
    : value;
}

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
      ? `${running} · v${version} 업데이트 가능 · 마지막 확인은 실패했습니다.`
      : `${running} · v${version} 업데이트 가능 · 마지막 확인 ${checkedAt}`;
    checkUpdateButton.textContent = `v${version} 업데이트 열기`;
    return;
  }
  checkUpdateButton.textContent = state.lastCheckError ? "다시 확인" : "업데이트 확인";
  if (state.lastCheckError) {
    updateDetail.textContent = `${running} · 마지막 업데이트 확인에 실패했습니다.`;
  } else if (state.lastSuccessfulCheckAt) {
    updateDetail.textContent = `${running} · 최신 버전입니다 · 마지막 확인 ${checkedAt}`;
  } else {
    updateDetail.textContent = `${running} · 아직 업데이트 확인을 완료하지 못했습니다.`;
  }
}

async function loadUpdateState() {
  try {
    renderUpdateState(await window.usageApp.getUpdateState());
  } catch (_error) {
    updateDetail.textContent = "업데이트 상태를 불러오지 못했습니다.";
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

function configureCodexControls(view) {
  setStatus(codexDetail, view.text, view.kind);
  codexResponsibility.textContent = view.responsibility;
  codexMeta.textContent = view.selectedSummary || "";
  codexMeta.hidden = !view.selectedSummary;

  codexButton.dataset.provider = "codex";
  codexButton.dataset.action = view.primary.action;
  codexButton.textContent = view.primary.label;
  codexButton.disabled = Boolean(view.primary.disabled);

  const secondary = view.secondary || { action: "none", hidden: true };
  codexDeviceButton.hidden = secondary.action !== "device_login";
  codexDeviceButton.disabled = secondary.action !== "device_login";
  if (secondary.action === "device_login") {
    codexDeviceButton.textContent = secondary.label;
  }
  codexBrowseButton.hidden = !view.manualSelectionAvailable;
  codexBrowseButton.disabled = !view.manualSelectionAvailable;

  const cancelKind = secondary.action === "cancel_install"
    ? "install"
    : secondary.action === "cancel_login" ? "login" : null;
  codexCancelButton.hidden = !cancelKind;
  codexCancelButton.disabled = !cancelKind;
  codexCancelButton.dataset.kind = cancelKind || "";
  if (cancelKind) {
    codexCancelButton.textContent = secondary.label;
  }

  codexCandidateList.replaceChildren();
  const options = Array.isArray(view.candidateOptions) ? view.candidateOptions : [];
  codexCandidates.hidden = options.length === 0;
  for (const option of options) {
    const item = document.createElement("div");
    item.setAttribute("role", "listitem");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "candidate-option secondary-action";
    button.textContent = option.label;
    button.disabled = Boolean(option.disabled);
    button.addEventListener("click", () => selectCodexCandidate(option.candidateId));
    item.appendChild(button);
    codexCandidateList.appendChild(item);
  }
}

function setCandidateButtonsDisabled(disabled) {
  for (const button of codexCandidateList.querySelectorAll("button")) {
    button.disabled = disabled;
  }
}

function stopCodexPolling() {
  if (codexPoll && codexPoll.timer) {
    window.clearTimeout(codexPoll.timer);
  }
  codexPoll = null;
}

function safeCodexOperation(value) {
  const operation = value && typeof value === "object" ? value : {};
  return {
    state: typeof operation.state === "string" ? operation.state : "idle",
    operationId: typeof operation.operationId === "string" ? operation.operationId : null,
    safeErrorCode: typeof operation.safeErrorCode === "string"
      ? operation.safeErrorCode
      : null,
    cancelable: operation.cancelable === true,
  };
}

function withCodexOperations(snapshot, operations) {
  if (!snapshot || !snapshot.setup || !snapshot.setup.codexSetup) {
    return null;
  }
  const value = operations && typeof operations === "object" ? operations : {};
  return {
    ...snapshot,
    setup: {
      ...snapshot.setup,
      codexSetup: {
        ...snapshot.setup.codexSetup,
        install: safeCodexOperation(value.install),
        login: safeCodexOperation(value.login),
      },
    },
  };
}

async function pollCodexOperation(poll) {
  if (codexPoll !== poll) {
    return;
  }
  const reachedPollingLimit = Date.now() - poll.startedAt >= CODEX_POLL_MAX_MS;
  try {
    const operations = await window.usageApp.codexOperationSnapshot();
    if (codexPoll !== poll) {
      return;
    }
    const snapshot = withCodexOperations(latestSnapshot, operations);
    if (!snapshot) {
      throw new Error("missing Codex setup snapshot");
    }
    const operationStillActive = Boolean(
      deriveSetupView(snapshot, windowIntent).codexView.poll,
    );
    if (!operationStillActive) {
      // Keep this poll token alive while the one terminal full refresh runs. This
      // prevents render() from cancelling the refresh we still need.
      poll.finalizing = true;
    }
    render(snapshot);
    if (!operationStillActive) {
      const refreshed = await window.usageApp.setupSnapshot();
      if (codexPoll !== poll) {
        return;
      }
      poll.finalizing = false;
      render(refreshed);
      return;
    }
  } catch (_error) {
    stopCodexPolling();
    actionMessage.dataset.kind = "error";
    actionMessage.textContent = "Codex 작업 상태를 자동으로 확인하지 못했습니다. 상태를 다시 확인하세요.";
    return;
  }
  if (codexPoll !== poll) {
    return;
  }
  if (reachedPollingLimit) {
    // Backend가 같은 10분 경계에서 long_running으로 바뀌므로 한 번 더 읽어 그 상태를
    // 화면에 반영한 뒤 polling만 중단한다. 실제 child process는 종료하지 않는다.
    if (!poll.expiryObserved) {
      poll.expiryObserved = true;
      poll.timer = window.setTimeout(() => pollCodexOperation(poll), CODEX_POLL_INTERVAL_MS);
      return;
    }
    stopCodexPolling();
    actionMessage.dataset.kind = "warning";
    actionMessage.textContent = "10분 동안 자동 확인했습니다. 작업은 종료하지 않았습니다. PowerShell을 확인하거나 상태를 다시 확인하세요.";
    return;
  }
  poll.timer = window.setTimeout(() => pollCodexOperation(poll), CODEX_POLL_INTERVAL_MS);
}

function ensureCodexPolling(view) {
  if (!view.poll) {
    if (!codexPoll || !codexPoll.finalizing) {
      stopCodexPolling();
    }
    return;
  }
  const key = `${view.poll.kind}:${view.poll.operationId || "pending"}`;
  if (codexPoll && codexPoll.key === key) {
    return;
  }
  stopCodexPolling();
  const poll = {
    key,
    startedAt: Date.now(),
    expiryObserved: false,
    finalizing: false,
    timer: null,
  };
  codexPoll = poll;
  poll.timer = window.setTimeout(() => pollCodexOperation(poll), CODEX_POLL_INTERVAL_MS);
}

async function refreshAfterCodexAction(message) {
  const snapshot = await window.usageApp.setupSnapshot();
  render(snapshot);
  actionMessage.dataset.kind = "progress";
  actionMessage.textContent = message;
}

async function runCodexAction(action) {
  if (!action || action === "none") {
    return;
  }
  if (action === "refresh") {
    await refresh(false);
    return;
  }

  codexButton.disabled = true;
  codexDeviceButton.disabled = true;
  setCandidateButtonsDisabled(true);
  actionMessage.dataset.kind = "progress";
  try {
    if (action === "install") {
      const approved = window.confirm(
        localizedText(`OpenAI Codex CLI 공식 설치 프로그램을 실행할까요?

출처: https://chatgpt.com/codex/install.ps1
인터넷에서 CLI를 내려받고 사용자 PATH를 변경할 수 있습니다.
CLI는 이 앱에 포함되지 않으며 일반 사용자는 Node.js, npm 또는 Rust를 설치할 필요가 없습니다.
실행 중에는 이 화면에서 취소를 요청할 수 있으며, 종료 확인 단계에 들어가면 취소할 수 없습니다.`),
      );
      if (!approved) {
        actionMessage.dataset.kind = "warning";
        actionMessage.textContent = "Codex 설치를 시작하지 않았습니다.";
        configureCodexControls(latestView.codexView);
        return;
      }
      await window.usageApp.startCodexInstall();
      await refreshAfterCodexAction("Codex 설치를 시작했습니다. 이 앱이 종료 결과와 설치된 CLI를 다시 확인합니다.");
      return;
    }

    const deviceAuth = action === "device_login";
    await window.usageApp.startCodexLogin(deviceAuth);
    await refreshAfterCodexAction(
      deviceAuth
        ? "Device code 로그인을 시작했습니다. 터미널의 안내에 따라 사용자가 직접 인증하세요."
        : "Codex 로그인을 시작했습니다. 브라우저의 계정 입력, MFA와 승인은 사용자가 직접 완료하세요.",
    );
  } catch (_error) {
    actionMessage.dataset.kind = "error";
    actionMessage.textContent = action === "install"
      ? "Codex 설치 프로세스를 시작하지 못했습니다. 상태를 다시 확인하세요."
      : "Codex 로그인 프로세스를 시작하지 못했습니다. 상태를 다시 확인하세요.";
    configureCodexControls(latestView.codexView);
  }
}

async function selectCodexCandidate(candidateId) {
  const option = latestView
    && latestView.codexView
    && latestView.codexView.candidateOptions.find(
      (candidate) => candidate.candidateId === candidateId && !candidate.disabled,
    );
  if (!option) {
    return;
  }

  setCandidateButtonsDisabled(true);
  codexButton.disabled = true;
  actionMessage.dataset.kind = "progress";
  actionMessage.textContent = "선택한 Codex CLI를 다시 검증하는 중입니다.";
  try {
    await window.usageApp.selectCodexCandidate(candidateId);
    await refreshAfterCodexAction(
      "Codex CLI 후보를 선택했습니다. 같은 CLI의 로그인 상태를 다시 확인했습니다.",
    );
  } catch (_error) {
    actionMessage.dataset.kind = "error";
    actionMessage.textContent = "Codex CLI 후보를 선택하지 못했습니다. 상태를 다시 확인하세요.";
    configureCodexControls(latestView.codexView);
  }
}

async function browseCodexCandidate() {
  if (!latestView || !latestView.codexView.manualSelectionAvailable) {
    return;
  }
  codexBrowseButton.disabled = true;
  codexButton.disabled = true;
  codexDeviceButton.disabled = true;
  setCandidateButtonsDisabled(true);
  actionMessage.dataset.kind = "progress";
  actionMessage.textContent = "선택한 Codex CLI 파일을 앱 안에서 다시 검증하는 중입니다.";
  try {
    const snapshot = await window.usageApp.browseCodexCandidate();
    render(snapshot);
    actionMessage.dataset.kind = "ok";
    actionMessage.textContent = "파일 선택 창을 닫고 현재 Codex 상태를 확인했습니다. 선택한 파일이 있으면 같은 경로로 검증했습니다.";
  } catch (_error) {
    actionMessage.dataset.kind = "error";
    actionMessage.textContent = "선택한 파일을 Codex CLI로 검증하지 못했습니다. 상태를 다시 확인하세요.";
    configureCodexControls(latestView.codexView);
  }
}

async function cancelCodexOperation() {
  const kind = codexCancelButton.dataset.kind;
  if (kind !== "install" && kind !== "login") {
    return;
  }
  codexCancelButton.disabled = true;
  actionMessage.dataset.kind = "progress";
  actionMessage.textContent = kind === "install"
    ? "Codex 설치 취소를 요청하는 중입니다."
    : "Codex 로그인 취소를 요청하는 중입니다.";
  try {
    await window.usageApp.cancelCodexOperation(kind);
    await refreshAfterCodexAction(
      kind === "install" ? "Codex 설치 취소를 요청했습니다." : "Codex 로그인 취소를 요청했습니다.",
    );
  } catch (_error) {
    actionMessage.dataset.kind = "error";
    actionMessage.textContent = "Codex 작업을 취소하지 못했습니다. PowerShell과 현재 상태를 확인하세요.";
    codexCancelButton.disabled = false;
  }
}

async function runProviderAction(button) {
  const provider = button.dataset.provider;
  const action = button.dataset.action;
  if (action === "complete") {
    return;
  }
  if (provider === "codex") {
    await runCodexAction(action);
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
  } catch (_error) {
    actionMessage.dataset.kind = "error";
    actionMessage.textContent = "CLI 작업을 시작하지 못했습니다. 상태를 다시 확인하세요.";
  } finally {
    button.disabled = false;
  }
}

function render(snapshot) {
  latestSnapshot = snapshot;
  latestView = deriveSetupView(snapshot, windowIntent);
  const setup = snapshot.setup || {};
  const claude = snapshot.claude || {};
  const claudeState = setup.claudeCommandState || (setup.claudeCommand ? "ready" : "missing");
  const claudeAuth = setup.claudeAuth || { state: "error" };
  const claudeStatus = providerStatus("claude", claudeState, claudeAuth, claude.connected, claude.ageMs);

  configureCodexControls(latestView.codexView);
  setStatus(claudeDetail, claudeStatus.text, claudeStatus.kind);
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
  ensureCodexPolling(latestView.codexView);
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
  } catch (_error) {
    actionMessage.dataset.kind = "error";
    actionMessage.textContent = "표시 설정을 변경하지 못했습니다.";
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
  } catch (_error) {
    actionMessage.dataset.kind = "error";
    actionMessage.textContent = "설치 및 로그인 상태를 확인하지 못했습니다.";
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
  } catch (_error) {
    await loadUpdateState();
    actionMessage.dataset.kind = "error";
    actionMessage.textContent = "업데이트 확인에 실패했습니다. 네트워크를 확인한 뒤 다시 시도하세요.";
  } finally {
    checkUpdateButton.disabled = false;
  }
}

codexButton.addEventListener("click", () => runProviderAction(codexButton));
codexDeviceButton.addEventListener("click", () => runCodexAction("device_login"));
codexBrowseButton.addEventListener("click", browseCodexCandidate);
codexCancelButton.addEventListener("click", cancelCodexOperation);
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
