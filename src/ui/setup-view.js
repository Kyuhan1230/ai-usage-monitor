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
      showClaudeHook: claudeSectionExpanded && claudeAuthenticated,
      showClaudeAddAction: mode === "codex" && !claudeSectionExpanded,
      showClaudeOnlyAction: mode === "codex" && !canComplete,
      showCodexAddAction: mode === "claudeOnly",
      headline: mode === "claudeOnly" ? "Claude Code 사용량을 확인하세요" : "Codex 사용량을 확인하세요",
      summary: mode === "claudeOnly"
        ? "Claude Code만 사용한다면 여기서 시작할 수 있습니다. 필요하면 Codex도 나중에 연결할 수 있습니다."
        : "Claude Code 연결은 선택 사항입니다. Codex 사용량 확인부터 시작하세요.",
      completionLabel: mode === "claudeOnly" ? "Claude 시작하기" : "Codex 시작하기",
      incompleteMessage: mode === "claudeOnly"
        ? "Claude Code에 로그인해 시작하세요."
        : "Codex에 로그인해 시작하세요. Claude Code만 사용한다면 아래에서 선택할 수 있습니다.",
    };
  }

  return {
    authState,
    connectedProviders,
    deriveSetupView,
  };
}));
