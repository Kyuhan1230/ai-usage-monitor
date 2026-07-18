"use strict";

// Tauri 명령을 기존 renderer가 사용하는 작은 계약으로 감싼다.
const invoke = window.__TAURI__.core.invoke;

window.usageApp = {
  snapshot: () => invoke("snapshot"),
  refreshSnapshot: () => invoke("refresh_snapshot"),
  setupSnapshot: () => invoke("setup_snapshot"),
  refreshSetupSnapshot: () => invoke("refresh_setup_snapshot"),
  setAlwaysOnTop: (enabled) => invoke("set_always_on_top", { enabled }),
  setOpacity: (value) => invoke("set_opacity", { value }),
  minimize: () => invoke("minimize_window"),
  close: () => invoke("close_window"),
  openDetails: () => invoke("show_window", { label: "details" }),
  openInsights: () => invoke("show_window", { label: "insights" }),
  openSetup: () => invoke("show_window", { label: "setup" }),
  installClaudeHook: async () => {
    const first = await invoke("install_claude_hook", { force: false });
    if (first.status !== "replacement_required") {
      return first;
    }
    const approved = window.confirm(`기존 Claude statusLine 명령을 백업하고 교체할까요?\n\n${first.existingCommand}`);
    return approved ? invoke("install_claude_hook", { force: true }) : first;
  },
  openCodexLogin: () => invoke("open_login_terminal", { provider: "codex" }),
  openClaudeAuth: () => invoke("open_login_terminal", { provider: "claude" }),
  setLaunchAtLogin: (enabled) => invoke("set_launch_at_login", { enabled }),
};
