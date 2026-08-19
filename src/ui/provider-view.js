"use strict";

// 현재 인증 상태와 보존된 사용 이력을 화면마다 같은 기준으로 해석한다.
(function exposeProviderView(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.usageProviderView = api;
}(typeof window !== "undefined" ? window : globalThis, () => {
  const PROVIDERS = ["codex", "claude"];

  function providerAuthState(snapshot, provider) {
    const providers = snapshot && snapshot.providers;
    const state = providers && providers[provider] && providers[provider].authState;
    return typeof state === "string" ? state : "unknown";
  }

  // 이 앱에서만 숨긴 공급자다. CLI 인증은 그대로이므로 다시 표시하면 즉시 복귀한다.
  function isHiddenProvider(snapshot, provider) {
    const list = snapshot && snapshot.hiddenProviders;
    if (Array.isArray(list)) {
      return list.includes(provider);
    }
    const providers = snapshot && snapshot.providers;
    return Boolean(providers && providers[provider] && providers[provider].hidden);
  }

  // 사용량 수집은 인증 없이는 불가능하다. 수집에 성공한 기록이 있다는 것은
  // 그 시점에 인증이 살아 있었다는 직접 증거다.
  function hasCollectedUsage(snapshot, provider) {
    return Boolean(snapshot && snapshot[provider] && snapshot[provider].connected);
  }

  // 인증 프로브 결과 하나로 카드를 삭제하지 않는다.
  // 프로브는 종료 코드만 보므로 "로그인 안 됨"과 "확인 자체가 실패"를 구분하지 못한다.
  // 잘못된 판정으로 멀쩡한 카드가 말없이 사라지면 사용자는 원인을 알 방법이 없으므로,
  // 수집 기록이 있으면 카드를 남기고 경고 상태로 전환해 직접 조치할 수 있게 한다.
  function providerPresentation(snapshot, provider) {
    if (isHiddenProvider(snapshot, provider)) {
      return { visible: false, degraded: false, reason: "hidden" };
    }
    const authState = providerAuthState(snapshot, provider);
    if (authState === "authenticated") {
      return { visible: true, degraded: false, reason: "authenticated" };
    }
    if (!hasCollectedUsage(snapshot, provider)) {
      // 보여줄 수집 결과가 없으면 경고할 대상도 없다.
      return { visible: false, degraded: false, reason: "no_data" };
    }
    if (authState === "unknown") {
      // 아직 인증을 확인한 적이 없다. Setup을 연 적 없는 평상시 상태이므로 경고하지 않는다.
      return { visible: true, degraded: false, reason: "unchecked" };
    }
    return {
      visible: true,
      degraded: true,
      // unauthenticated는 로그인 만료일 수도, 프로브 실패일 수도 있어 단정하지 않는다.
      reason: authState === "unauthenticated" ? "auth_lost" : "auth_uncheckable",
    };
  }

  function isActiveProvider(snapshot, provider) {
    return providerPresentation(snapshot, provider).visible;
  }

  function activeProviders(snapshot) {
    return PROVIDERS.filter((provider) => isActiveProvider(snapshot, provider));
  }

  function degradedProviders(snapshot) {
    return PROVIDERS.filter((provider) => providerPresentation(snapshot, provider).degraded);
  }

  // 확인 실패와 로그인 만료를 다른 문구로 안내한다. 앱이 모르는 것을 안다고 말하지 않는다.
  function providerAuthNotice(provider, reason) {
    const label = providerLabel(provider);
    // Compact는 세로 공간이 좁다. 카드를 덮지 않도록 한 줄로 유지한다.
    if (reason === "auth_lost") {
      return `${label} 로그인 만료 가능성 · 아래는 마지막 수집값`;
    }
    if (reason === "auth_uncheckable") {
      return `${label} 로그인 상태 확인 불가 · 아래는 마지막 수집값`;
    }
    return "";
  }

  function providersWithUsageRows(snapshot) {
    const rows = snapshot
      && snapshot.analytics
      && snapshot.analytics.usage
      && Array.isArray(snapshot.analytics.usage.rows)
      ? snapshot.analytics.usage.rows
      : [];
    return PROVIDERS.filter((provider) => rows.some((row) => row && row.provider === provider));
  }

  // 숨긴 공급자는 과거 이력까지 감춘다. 데이터는 지우지 않으므로 다시 표시하면 그대로 돌아온다.
  function detailProviders(snapshot) {
    const providers = new Set([...activeProviders(snapshot), ...providersWithUsageRows(snapshot)]);
    return PROVIDERS.filter((provider) => providers.has(provider) && !isHiddenProvider(snapshot, provider));
  }

  // 권장 문구도 경고와 같은 기준으로 거른다. 공급자가 없는 healthy 문구는 항상 통과시킨다.
  function visibleRecommendations(analytics, providers) {
    const list = analytics && Array.isArray(analytics.recommendations) ? analytics.recommendations : [];
    return list.filter((item) => item
      && (item.provider === null || item.provider === undefined || providers.includes(item.provider)));
  }

  function providerLabel(provider) {
    return provider === "codex" ? "Codex" : "Claude";
  }

  function limitLabel(provider, limitType) {
    if (limitType === "five_hour") {
      return provider === "claude" ? "세션" : "5시간";
    }
    if (limitType === "weekly" || limitType === "seven_day") {
      return "주간";
    }
    if (limitType === "monthly") {
      return "월간";
    }
    return "사용량";
  }

  function compactRecommendationAction(provider, recommendation) {
    const label = providerLabel(provider);
    if (!recommendation) {
      return `${label}는 현재 속도를 유지해도 됩니다.`;
    }
    if (recommendation.reason === "token_spike") {
      return `${label} 토큰 사용 급증. 반복 작업을 점검하세요.`;
    }
    if (recommendation.reason === "model_savings") {
      return `${label}의 단순 작업에는 저비용 모델을 고려하세요.`;
    }
    return recommendation.action || `${label}는 현재 속도를 유지해도 됩니다.`;
  }

  // Compact에서는 긴 분석 문장 대신 공급자·한도·즉시 행동만 두 줄 안팎으로 보여준다.
  function providerDecisionCopy(provider, analytics, stale = false) {
    const label = providerLabel(provider);
    if (!analytics) {
      return {
        tone: "neutral",
        status: `${label} 사용 흐름 확인 전`,
        action: `${label}의 최근 사용 속도를 계산 중입니다.`,
      };
    }
    if (stale) {
      return {
        tone: "neutral",
        status: `${label} 최신 사용량 확인 필요`,
        action: `${label} 사용량을 새로고침하세요.`,
      };
    }

    const alerts = Array.isArray(analytics.alerts)
      ? analytics.alerts.filter((alert) => alert && alert.provider === provider)
      : [];
    const exhausted = alerts.find((alert) => {
      const remaining = Number(alert.remainingPercent);
      return alert.reason === "limit_exhausted"
        || (Number.isFinite(remaining) && remaining <= 0);
    });
    const critical = exhausted || alerts.find((alert) => alert.severity === "critical");
    const warning = alerts.find((alert) => alert.severity === "warning");
    const recommendation = visibleRecommendations(analytics, [provider])
      .find((item) => item.provider === provider);
    const providerAnalytics = analytics.providers && analytics.providers[provider];
    const limitsByType = providerAnalytics && providerAnalytics.limits
      ? providerAnalytics.limits
      : {};
    const limits = Object.values(limitsByType).filter(Boolean);
    const hasKnownForecast = limits.some((limit) =>
      limit.forecastStatus === "safe" || limit.forecastStatus === "risk");

    if (exhausted) {
      const kind = limitLabel(provider, exhausted.limitType);
      return {
        tone: "critical",
        status: `${label} ${kind} 한도 소진`,
        action: `리셋 전까지 ${label}의 새 작업을 멈추세요.`,
      };
    }
    if (critical) {
      const kind = limitLabel(provider, critical.limitType);
      return {
        tone: "critical",
        status: `${label} ${kind} 한도 위험 · ${critical.remainingPercent}% 남음`,
        action: `${label}의 큰 작업을 줄여 ${kind} 한도를 아끼세요.`,
      };
    }
    if (warning) {
      const kind = limitLabel(provider, warning.limitType);
      if (warning.reason === "forecast_before_reset") {
        const limit = limitsByType[warning.limitType];
        const reduction = limit && Number.isFinite(limit.requiredReductionPercent)
          ? Math.ceil(limit.requiredReductionPercent / 5) * 5
          : null;
        return {
          tone: "warning",
          status: `${label} 리셋 전 소진 가능성`,
          action: warning.confidence === "low"
            ? `${label}의 큰 작업을 나누고 사용량을 줄이세요.`
            : reduction !== null
              ? `${label} ${kind} 사용량을 약 ${reduction}% 줄이세요.`
              : compactRecommendationAction(provider, recommendation),
        };
      }
      return {
        tone: "warning",
        status: `${label} ${kind} 한도 주의 · ${warning.remainingPercent}% 남음`,
        action: `${label}의 중요한 작업을 우선해 ${kind} 한도를 아끼세요.`,
      };
    }
    if (!hasKnownForecast) {
      return {
        tone: "neutral",
        status: `${label} 소진 속도 계산 전`,
        action: `${label} 잔여량 변화 후 소진 여부를 다시 계산합니다.`,
      };
    }
    return {
      tone: "ok",
      status: `${label} 현재 속도 유지 가능`,
      action: compactRecommendationAction(provider, recommendation),
    };
  }

  return {
    PROVIDERS,
    providerAuthState,
    isHiddenProvider,
    providerPresentation,
    providerAuthNotice,
    degradedProviders,
    isActiveProvider,
    activeProviders,
    providersWithUsageRows,
    detailProviders,
    visibleRecommendations,
    providerDecisionCopy,
  };
}));
