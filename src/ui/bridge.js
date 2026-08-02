"use strict";

// Tauri 명령을 기존 renderer가 사용하는 작은 계약으로 감싼다.
const invoke = window.__TAURI__.core.invoke;
const INSIGHTS_PROVIDER_KEY = "ai-usage-monitor-insights-provider";

function openInsights(provider = null) {
  const requestedProvider = provider === "codex" || provider === "claude"
    ? provider
    : "all";
  try {
    // Insights가 이미 열려 있으면 storage 이벤트로, 새 창이면 초기 로드에서 이 요청을 받는다.
    window.localStorage.setItem(INSIGHTS_PROVIDER_KEY, requestedProvider);
  } catch (_error) {
    // 저장소를 사용할 수 없어도 전역 Insights 창은 계속 열 수 있다.
  }
  return invoke("show_window", { label: "insights" });
}

window.usageApp = {
  snapshot: () => invoke("snapshot"),
  refreshSnapshot: () => invoke("refresh_snapshot"),
  setupSnapshot: () => invoke("setup_snapshot"),
  codexOperationSnapshot: () => invoke("codex_operation_snapshot"),
  refreshSetupSnapshot: () => invoke("refresh_setup_snapshot"),
  setAlwaysOnTop: (enabled) => invoke("set_always_on_top", { enabled }),
  setOpacity: (value) => invoke("set_opacity", { value }),
  minimize: () => invoke("minimize_window"),
  close: () => invoke("close_window"),
  startResize: () => window.__TAURI__.window.getCurrentWindow().startResizeDragging("SouthEast"),
  openCompact: () => invoke("show_window", { label: "compact" }),
  openDetails: () => invoke("show_window", { label: "details" }),
  openInsights,
  openSetup: () => invoke("show_window", { label: "setup" }),
  checkForUpdate: (manual = true) => invoke("check_for_update", { manual }),
  getUpdateState: () => invoke("get_update_state"),
  postponeUpdate: (version) => invoke("postpone_update", { version }),
  installUpdate: (expectedVersion, onProgress) => {
    const channel = new window.__TAURI__.core.Channel();
    channel.onmessage = onProgress;
    return invoke("install_update", { expectedVersion, onProgress: channel });
  },
  ensureClaudeHook: () => invoke("install_claude_hook", { force: false }),
  startCodexInstall: () => invoke("start_codex_install"),
  startCodexLogin: (deviceAuth = false) => invoke("start_codex_login", { deviceAuth }),
  cancelCodexOperation: (kind) => invoke("cancel_codex_operation", { kind }),
  selectCodexCandidate: (candidateId) => invoke("select_codex_candidate", { candidateId }),
  browseCodexCandidate: () => invoke("browse_codex_candidate"),
  openCodexLogin: () => invoke("start_codex_login", { deviceAuth: false }),
  openClaudeAuth: () => invoke("open_login_terminal", { provider: "claude" }),
  installProvider: (provider) => invoke("open_install_terminal", { provider }),
  openOfficialGuide: (provider) => invoke("open_official_guide", { provider }),
  completeOnboarding: (skipped) => invoke("complete_onboarding", { skipped }),
  setActivityMonitoring: (enabled) => invoke("set_activity_monitoring", { enabled }),
  setLaunchAtLogin: (enabled) => invoke("set_launch_at_login", { enabled }),
  setProviderHidden: (provider, hidden) => invoke("set_provider_hidden", { provider, hidden }),
};
