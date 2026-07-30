"use strict";

// Setup의 표시 상태와 허용 행동을 DOM·Tauri API에서 분리한다.
(function exposeSetupView(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.usageSetupView = api;
}(typeof window !== "undefined" ? window : globalThis, () => {
  const AUTHENTICATED = "authenticated";
  const CLI_STATES = new Set([
    "probing",
    "missing",
    "desktop_bundle_only",
    "invalid_candidate",
    "runtime_dependency_missing",
    "runtime_dependency_incompatible",
    "unsupported",
    "conflict",
    "ready",
    "probe_error",
  ]);
  const AUTH_STATES = new Set([
    "unavailable",
    "checking",
    "unauthenticated",
    "authenticated",
    "error",
  ]);
  const INSTALL_STATES = new Set([
    "idle",
    "consent_required",
    "starting",
    "running",
    "long_running",
    "succeeded",
    "failed",
    "cancelled",
    "detached",
  ]);
  const LOGIN_STATES = new Set([
    "idle",
    "starting",
    "running",
    "long_running",
    "exited",
    "failed",
    "cancelled",
    "detached",
  ]);
  const ACTIVE_INSTALL_STATES = new Set(["starting", "running", "long_running"]);
  const ACTIVE_LOGIN_STATES = new Set(["starting", "running", "long_running"]);
  const LAUNCHERS = new Set(["exe", "cmd", "bat", "extensionless"]);
  const COMPATIBILITIES = new Set([
    "supported",
    "untested_newer",
    "unsupported",
    "invalid",
    "runtime_dependency_missing",
    "runtime_dependency_incompatible",
  ]);
  const SAFE_ERROR_COPY = Object.freeze({
    codex_not_found: "독립 실행 Codex CLI를 찾지 못했습니다.",
    desktop_bundle_only: "Codex 데스크톱 앱과 별도로 독립 실행 CLI가 필요합니다.",
    candidate_not_executable: "발견한 Codex 후보를 안전하게 실행할 수 없습니다.",
    candidate_version_unrecognized: "Codex 후보의 버전을 확인하지 못했습니다.",
    candidate_unsupported: "설치된 Codex CLI가 필요한 명령을 지원하지 않습니다.",
    candidate_conflict: "사용 가능한 Codex CLI가 여러 개라 자동으로 선택하지 않았습니다.",
    runtime_dependency_missing: "예전 npm 설치에 필요한 Node.js를 찾지 못했습니다.",
    runtime_dependency_incompatible: "예전 npm 설치와 현재 Node.js가 호환되지 않습니다.",
    candidate_provenance_invalid: "Codex 후보의 게시자 확인에 실패해 실행을 차단했습니다.",
    path_refresh_failed: "Windows의 최신 CLI 경로를 확인하지 못했습니다.",
    install_target_invalid: "사용자 지정 Codex 설치 경로가 올바르지 않습니다.",
    install_spawn_failed: "Codex 설치 프로세스를 시작하지 못했습니다.",
    install_exit_nonzero: "Codex 설치 프로세스가 정상적으로 끝나지 않았습니다.",
    install_no_valid_cli: "설치 뒤에도 실행 가능한 Codex CLI를 확인하지 못했습니다.",
    install_cancelled: "Codex 설치를 취소했습니다.",
    login_spawn_failed: "Codex 로그인 프로세스를 시작하지 못했습니다.",
    login_cancelled: "Codex 로그인을 취소했습니다.",
    login_unconfirmed: "로그인 프로세스는 끝났지만 인증 완료를 확인하지 못했습니다.",
    auth_probe_timeout: "Codex 로그인 상태 확인 시간이 초과됐습니다.",
    auth_probe_failed: "Codex 로그인 상태를 안전하게 판정하지 못했습니다.",
    usage_capability_missing: "이 Codex CLI에서는 사용량 확인 명령을 사용할 수 없습니다.",
    usage_capture_failed: "Codex 사용량을 확인하지 못했습니다.",
    usage_capture_timeout: "Codex 사용량 확인 시간이 초과됐습니다.",
    operation_already_running: "이미 Codex 작업이 진행 중입니다.",
    unknown_setup_error: "Codex 설정 상태를 확인하지 못했습니다.",
  });
  const SOURCE_LABELS = Object.freeze({
    current_path: "현재 PATH",
    user_path: "사용자 PATH",
    machine_path: "시스템 PATH",
    default_standalone_path: "기본 standalone 경로",
    legacy_npm: "npm 전역 launcher",
    local_bin: "사용자 local bin",
    custom_install_dir: "사용자 지정 설치 경로",
    manual: "직접 선택한 CLI",
  });
  const PROVENANCE_LABELS = Object.freeze({
    verified_publisher: "게시자 확인",
    tracked_official_install: "이 앱에서 시작한 공식 설치",
    unverified: "공급자 출처 미확인",
    invalid: "게시자 확인 실패",
  });
  const SOURCE_DISPLAY_PATTERNS = Object.freeze({
    current_path: /^현재 PATH #[1-9]\d{0,3}$/,
    user_path: /^사용자 PATH #[1-9]\d{0,3}$/,
    machine_path: /^시스템 PATH #[1-9]\d{0,3}$/,
    default_standalone_path: /^기본 standalone 경로$/,
    legacy_npm: /^npm 전역 launcher$/,
    local_bin: /^\.local launcher$/,
    custom_install_dir: /^사용자 지정 설치 경로$/,
    manual: /^직접 선택한 Codex CLI$/,
  });

  function knownState(value, allowed, fallback) {
    return typeof value === "string" && allowed.has(value) ? value : fallback;
  }

  function safeErrorCode(value) {
    const candidate = value && typeof value === "object" ? value.code : value;
    return typeof candidate === "string" && Object.hasOwn(SAFE_ERROR_COPY, candidate)
      ? candidate
      : null;
  }

  function safeErrorText(value, fallback = "Codex 설정 상태를 확인하지 못했습니다.") {
    const code = safeErrorCode(value);
    return code ? SAFE_ERROR_COPY[code] : fallback;
  }

  function normalizeOperation(value, allowed) {
    const operation = value && typeof value === "object" ? value : {};
    const operationId = operation.operationId ?? operation.id;
    const error = operation.safeErrorCode ?? operation.error;
    return {
      state: knownState(operation.state, allowed, "idle"),
      operationId: typeof operationId === "string" ? operationId : null,
      safeErrorCode: safeErrorCode(error),
      cancelable: operation.cancelable === true,
    };
  }

  function safeSource(value) {
    return typeof value === "string" && Object.hasOwn(SOURCE_LABELS, value)
      ? value
      : null;
  }

  function safeCandidateId(value) {
    return typeof value === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
      ? value
      : null;
  }

  function safeCandidateTag(value) {
    return typeof value === "string" && /^CLI-[A-Z0-9]{1,12}$/.test(value)
      ? value
      : null;
  }

  function safeVersion(value) {
    return typeof value === "string"
      && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
      ? value
      : null;
  }

  function safeDisplayLabel(value, source) {
    if (!source) return null;
    const pattern = SOURCE_DISPLAY_PATTERNS[source];
    return typeof value === "string" && pattern && pattern.test(value)
      ? value
      : SOURCE_LABELS[source];
  }

  // 공개 DTO의 privacy-safe 필드만 새 객체에 복사한다. path 계열이나 임의 필드는 보존하지 않는다.
  function safeCandidate(value) {
    const candidate = value && typeof value === "object" ? value : {};
    const source = safeSource(candidate.source);
    return {
      candidateId: safeCandidateId(candidate.candidateId),
      candidateTag: safeCandidateTag(candidate.candidateTag),
      displayLabel: safeDisplayLabel(candidate.displayLabel, source),
      source,
      launcher: LAUNCHERS.has(candidate.launcher) ? candidate.launcher : null,
      version: safeVersion(candidate.version),
      compatibility: COMPATIBILITIES.has(candidate.compatibility)
        ? candidate.compatibility
        : null,
      provenance: Object.hasOwn(PROVENANCE_LABELS, candidate.provenance)
        ? candidate.provenance
        : null,
      safeErrorCode: safeErrorCode(candidate.safeErrorCode),
    };
  }

  function normalizeCodexSetup(setup) {
    const value = setup && typeof setup === "object" ? setup : {};
    const modern = value.codexSetup && typeof value.codexSetup === "object"
      ? value.codexSetup
      : null;
    if (modern) {
      const candidates = Array.isArray(modern.candidates)
        ? modern.candidates.map(safeCandidate)
        : [];
      const candidateCount = Number.isSafeInteger(modern.candidateCount)
        && modern.candidateCount >= candidates.length
        ? modern.candidateCount
        : candidates.length;
      const conflictCount = Number.isSafeInteger(modern.conflictCount)
        && modern.conflictCount >= 0
        ? modern.conflictCount
        : modern.cliState === "conflict" ? candidates.length : 0;
      return {
        cliState: knownState(modern.cliState, CLI_STATES, "probe_error"),
        selected: safeCandidate(modern.selected),
        candidates,
        candidateCount,
        conflictCount,
        deviceAuthSupported: modern.deviceAuthSupported === true,
        install: normalizeOperation(modern.install, INSTALL_STATES),
        login: normalizeOperation(modern.login, LOGIN_STATES),
        auth: {
          state: knownState(modern.auth && modern.auth.state, AUTH_STATES, "error"),
          safeErrorCode: safeErrorCode(
            modern.auth && (modern.auth.safeErrorCode ?? modern.auth.error),
          ),
        },
        safeErrorCode: safeErrorCode(modern.safeErrorCode ?? modern.error),
        modern: true,
      };
    }

    const legacyCliState = value.codexCommandState
      || (value.codexCommand ? "ready" : "missing");
    const legacyAuth = value.codexAuth && typeof value.codexAuth === "object"
      ? value.codexAuth
      : {};
    return {
      cliState: knownState(legacyCliState, CLI_STATES, "probe_error"),
      selected: safeCandidate(null),
      candidates: [],
      candidateCount: 0,
      conflictCount: 0,
      deviceAuthSupported: false,
      install: normalizeOperation(null, INSTALL_STATES),
      login: normalizeOperation(null, LOGIN_STATES),
      auth: {
        state: knownState(legacyAuth.state, AUTH_STATES, "error"),
        safeErrorCode: safeErrorCode(legacyAuth.safeErrorCode ?? legacyAuth.error),
      },
      safeErrorCode: safeErrorCode(value.safeErrorCode ?? value.error),
      modern: false,
    };
  }

  function candidateSummary(candidate) {
    const parts = [];
    if (candidate.displayLabel) {
      parts.push(candidate.displayLabel);
    } else if (candidate.source) {
      parts.push(SOURCE_LABELS[candidate.source]);
    }
    if (candidate.candidateTag) parts.push(candidate.candidateTag);
    if (candidate.launcher) parts.push(`${candidate.launcher} launcher`);
    if (candidate.version) parts.push(`v${candidate.version}`);
    if (candidate.provenance) parts.push(PROVENANCE_LABELS[candidate.provenance]);
    return parts.join(" · ");
  }

  function selectedSummary(state) {
    return state.cliState === "ready" ? candidateSummary(state.selected) : "";
  }

  function candidateOptions(state) {
    if (
      state.cliState !== "conflict"
      || ACTIVE_INSTALL_STATES.has(state.install.state)
      || ACTIVE_LOGIN_STATES.has(state.login.state)
    ) {
      return [];
    }
    return state.candidates
      .filter((candidate) => (
        candidate.compatibility === "supported"
        || candidate.compatibility === "untested_newer"
      ))
      .map((candidate, index) => ({
        action: "select_candidate",
        candidateId: candidate.candidateId,
        label: candidateSummary(candidate) || `Codex CLI 후보 ${index + 1}`,
        disabled: !candidate.candidateId,
      }));
  }

  function baseCliView(state) {
    switch (state.cliState) {
      case "probing":
        return {
          kind: "progress",
          text: "Codex CLI 후보를 확인하는 중입니다.",
          primary: { action: "none", label: "확인 중", disabled: true },
        };
      case "missing":
        return {
          kind: "warning",
          text: "독립 실행 Codex CLI가 없습니다.",
          primary: { action: "install", label: "Codex 설치", disabled: false },
        };
      case "desktop_bundle_only":
        return {
          kind: "warning",
          text: "Codex 데스크톱 앱만 있습니다. 사용량 확인에는 독립 실행 Codex CLI가 필요합니다.",
          primary: { action: "install", label: "독립 CLI 설치", disabled: false },
        };
      case "invalid_candidate":
        return {
          kind: "error",
          text: "Codex로 보이는 파일을 실행하거나 버전을 확인할 수 없습니다.",
          primary: { action: "install", label: "공식 CLI 다시 설치", disabled: false },
        };
      case "runtime_dependency_missing":
        return {
          kind: "error",
          text: "예전 npm Codex 설치가 있지만 필요한 Node.js가 없습니다.",
          primary: { action: "install", label: "standalone 설치", disabled: false },
        };
      case "runtime_dependency_incompatible":
        return {
          kind: "error",
          text: "예전 npm Codex 설치와 현재 Node.js가 호환되지 않습니다.",
          primary: { action: "install", label: "standalone 설치", disabled: false },
        };
      case "unsupported":
        return {
          kind: "warning",
          text: "설치된 Codex CLI가 로그인 또는 사용량 확인에 필요한 명령을 지원하지 않습니다.",
          primary: { action: "install", label: "Codex 업데이트", disabled: false },
        };
      case "conflict":
        return {
          kind: "warning",
          text: state.conflictCount > 1
            ? `사용 가능한 Codex CLI ${state.conflictCount}개가 충돌합니다. 사용할 CLI를 아래에서 직접 선택하세요.`
            : "사용 가능한 Codex CLI가 여러 개입니다. 사용할 CLI를 아래에서 직접 선택하세요.",
          primary: { action: "refresh", label: "상태 다시 확인", disabled: false },
        };
      case "ready":
        break;
      case "probe_error":
      default:
        return {
          kind: "error",
          text: safeErrorText(
            state.safeErrorCode,
            "Codex CLI 상태를 안전하게 판정하지 못했습니다.",
          ),
          primary: { action: "refresh", label: "상태 다시 확인", disabled: false },
        };
    }

    const summary = selectedSummary(state);
    const suffix = summary ? ` · ${summary}` : "";
    switch (state.auth.state) {
      case "authenticated":
        return {
          kind: "ok",
          text: `Codex CLI 확인 완료 · 로그인 확인 완료${suffix}`,
          primary: { action: "none", label: "로그인 완료", disabled: true },
        };
      case "checking":
        return {
          kind: "progress",
          text: `Codex CLI 확인 완료 · 로그인 상태 확인 중${suffix}`,
          primary: { action: "none", label: "확인 중", disabled: true },
        };
      case "unauthenticated":
        return {
          kind: "warning",
          text: `Codex CLI 확인 완료 · 로그인이 필요합니다${suffix}`,
          primary: { action: "login", label: "Codex 로그인", disabled: false },
        };
      case "unavailable":
      case "error":
      default:
        return {
          kind: "error",
          text: `${safeErrorText(state.auth.safeErrorCode, "Codex 로그인 상태를 확인하지 못했습니다.")}${suffix}`,
          primary: { action: "refresh", label: "상태 다시 확인", disabled: false },
        };
    }
  }

  function codexActionPlan(input) {
    const state = input && input.cliState ? input : normalizeCodexSetup(input);

    if (ACTIVE_INSTALL_STATES.has(state.install.state)) {
      const longRunning = state.install.state === "long_running";
      const cancelable = state.install.cancelable;
      return {
        kind: longRunning && cancelable ? "warning" : "progress",
        text: !cancelable
          ? "Codex 설치 작업의 실행·취소 결과와 설치된 CLI를 검증하는 중입니다."
          : longRunning
          ? "Codex 설치가 오래 걸리고 있습니다. PowerShell 진행 상황을 확인하거나 취소할 수 있습니다."
          : "Codex 공식 설치 프로그램을 실행하고 있습니다.",
        primary: {
          action: "none",
          label: cancelable ? "설치 진행 중" : "설치 확인 중",
          disabled: true,
        },
        secondary: cancelable
          ? { action: "cancel_install", label: "설치 취소", hidden: false }
          : { action: "none", label: "", hidden: true },
        poll: { kind: "install", operationId: state.install.operationId },
      };
    }

    if (ACTIVE_LOGIN_STATES.has(state.login.state)) {
      const longRunning = state.login.state === "long_running";
      const cancelable = state.login.cancelable;
      return {
        kind: longRunning && cancelable ? "warning" : "progress",
        text: !cancelable
          ? "로그인 작업의 실행·취소 결과와 같은 Codex CLI의 인증 상태를 확인하는 중입니다."
          : longRunning
          ? "로그인이 오래 걸리고 있습니다. 브라우저 인증을 완료하거나 작업을 취소할 수 있습니다."
          : "Codex가 연 브라우저에서 로그인을 완료하세요. 계정과 MFA는 사용자가 직접 입력합니다.",
        primary: {
          action: "none",
          label: cancelable ? "로그인 진행 중" : "로그인 확인 중",
          disabled: true,
        },
        secondary: cancelable
          ? { action: "cancel_login", label: "로그인 취소", hidden: false }
          : { action: "none", label: "", hidden: true },
        poll: { kind: "login", operationId: state.login.operationId },
      };
    }

    if (state.login.state === "exited" && state.auth.state === "checking") {
      return {
        kind: "progress",
        text: "로그인 명령이 끝났습니다. Codex 인증 상태를 다시 확인하는 중입니다.",
        primary: { action: "none", label: "확인 중", disabled: true },
        secondary: { action: "none", label: "", hidden: true },
        poll: { kind: "auth", operationId: state.login.operationId },
      };
    }

    const base = baseCliView(state);
    let text = base.text;
    let kind = base.kind;
    if (
      state.install.state === "succeeded"
      && state.install.safeErrorCode === "install_exit_nonzero"
    ) {
      text = "Codex 설치 프로세스는 비정상 종료했지만, 앱이 실행 가능한 Codex CLI를 별도로 확인했습니다.";
      kind = "warning";
    } else if (state.install.state === "failed") {
      text = safeErrorText(state.install.safeErrorCode, "Codex 설치를 완료하지 못했습니다.");
      kind = "error";
    } else if (state.install.state === "cancelled") {
      text = safeErrorText(state.install.safeErrorCode, SAFE_ERROR_COPY.install_cancelled);
      kind = "warning";
    } else if (state.install.state === "detached") {
      text = "이전 설치 작업의 추적이 끊겼습니다. 현재 CLI 상태를 다시 확인하세요.";
      kind = "warning";
    } else if (state.login.state === "failed") {
      text = safeErrorText(state.login.safeErrorCode, SAFE_ERROR_COPY.login_spawn_failed);
      kind = "error";
    } else if (state.login.state === "cancelled") {
      text = safeErrorText(state.login.safeErrorCode, SAFE_ERROR_COPY.login_cancelled);
      kind = "warning";
    } else if (state.login.state === "detached") {
      text = "이전 로그인 작업의 추적이 끊겼습니다. 현재 로그인 상태를 다시 확인하세요.";
      kind = "warning";
    } else if (
      state.login.state === "exited"
      && state.auth.state !== "authenticated"
      && state.auth.state !== "checking"
    ) {
      text = safeErrorText(
        state.auth.safeErrorCode || state.login.safeErrorCode || "login_unconfirmed",
        SAFE_ERROR_COPY.login_unconfirmed,
      );
      kind = state.auth.state === "error" ? "error" : "warning";
    }
    if (
      state.cliState === "ready"
      && state.conflictCount > 0
      && text === base.text
    ) {
      text += ` · 추가 Codex 후보 ${state.conflictCount}개는 우선순위가 낮아 선택하지 않았습니다. 호환 가능한 다른 설치이거나 예전 npm 설치일 수 있으므로 원치 않으면 업데이트하거나 제거하세요.`;
      if (kind === "ok") kind = "warning";
    }

    const deviceLoginAvailable = state.cliState === "ready"
      && state.deviceAuthSupported
      && state.auth.state !== "authenticated"
      && state.auth.state !== "checking";
    return {
      kind,
      text,
      primary: base.primary,
      secondary: deviceLoginAvailable
        ? { action: "device_login", label: "Device code 로그인", hidden: false }
        : { action: "none", label: "", hidden: true },
      poll: null,
    };
  }

  function deriveCodexView(setup) {
    const state = normalizeCodexSetup(setup);
    return {
      ...state,
      ...codexActionPlan(state),
      authenticated: state.auth.state === AUTHENTICATED,
      selectedSummary: selectedSummary(state),
      candidateOptions: candidateOptions(state),
      manualSelectionAvailable: state.cliState !== "probing"
        && !ACTIVE_INSTALL_STATES.has(state.install.state)
        && !ACTIVE_LOGIN_STATES.has(state.login.state),
      responsibility: "앱은 선택된 Codex CLI에서 로그인 명령까지만 시작합니다. 브라우저의 계정 입력, MFA와 승인은 사용자가 직접 완료합니다.",
    };
  }

  function authState(setup, provider) {
    if (provider === "codex") {
      return normalizeCodexSetup(setup).auth.state;
    }
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
    const codexView = deriveCodexView(setup);
    const codexAuthenticated = codexView.authenticated;
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
      codexView,
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
    codexActionPlan,
    connectedProviders,
    deriveCodexView,
    deriveSetupView,
    normalizeCodexSetup,
    safeErrorCode,
    safeErrorText,
  };
}));
