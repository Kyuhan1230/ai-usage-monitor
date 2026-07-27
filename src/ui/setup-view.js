"use strict";

// Setup의 표시 상태와 완료 조건을 DOM·Tauri API에서 분리한다.
(function exposeSetupView(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.usageSetupView = api;
}(typeof window !== "undefined" ? window : globalThis, () => {
  const AUTHENTICATED = "authenticated";

  function authState(setup, provider) {
    const auth = setup && setup[`${provider}Auth`];
    return auth && typeof auth.state === "string" ? auth.state : "error";
  }

  function isAuthenticated(setup, provider) {
    return authState(setup, provider) === AUTHENTICATED;
  }

  function connectedProviders(setup) {
    const codex = isAuthenticated(setup, "codex");
    const claude = isAuthenticated(setup, "claude");
    if (codex && claude) return "both";
    if (codex) return "codex";
    if (claude) return "claude";
    return "none";
  }

  function defaultSetupMode(setup) {
    return isAuthenticated(setup, "claude") && !isAuthenticated(setup, "codex")
      ? "claudeOnly"
      : "codex";
  }

  function explicitMode(intent) {
    return intent && (intent.setupMode === "codex" || intent.setupMode === "claudeOnly")
      ? intent.setupMode
      : null;
  }

  function deriveSetupView(snapshot, intent = {}) {
    const setup = (snapshot && snapshot.setup) || {};
    const mode = explicitMode(intent) || defaultSetupMode(setup);
    const codexAuthenticated = isAuthenticated(setup, "codex");
    const claudeAuthenticated = isAuthenticated(setup, "claude");
    const claudeSectionExpanded = claudeAuthenticated || Boolean(intent.claudeSectionExpanded);
    const canComplete = mode === "claudeOnly" ? claudeAuthenticated : codexAuthenticated;
    const primaryProvider = mode === "claudeOnly" ? "claude" : "codex";

    return {
      setupMode: mode,
      primaryProvider,
      connectedProviders: connectedProviders(setup),
      codexAuthenticated,
      claudeAuthenticated,
      claudeSectionExpanded,
      canComplete,
      showCodexCard: mode === "codex",
      showClaudeAddAction: mode === "codex" && !claudeSectionExpanded,
      showClaudeOnlyAction: mode === "codex" && !canComplete,
      showCodexAddAction: mode === "claudeOnly",
      headline: "사용할 도구를 연결하세요",
      summary: "Codex CLI와 Claude Code 중 사용하는 도구 하나만 연결해도 시작할 수 있습니다.",
      completionLabel: "사용량 화면 열기",
      incompleteMessage: mode === "claudeOnly"
        ? "사용할 Claude Code에 로그인하세요."
        : "Codex CLI에 로그인하거나 Claude Code를 사용할 도구로 선택하세요.",
    };
  }

  return {
    authState,
    connectedProviders,
    deriveSetupView,
  };
}));
