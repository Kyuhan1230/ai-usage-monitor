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

  function isActiveProvider(snapshot, provider) {
    if (isHiddenProvider(snapshot, provider)) {
      return false;
    }
    const authState = providerAuthState(snapshot, provider);
    if (authState === "authenticated") {
      return true;
    }
    if (authState === "unauthenticated" || authState === "unavailable") {
      return false;
    }
    return Boolean(snapshot && snapshot[provider] && snapshot[provider].connected);
  }

  function activeProviders(snapshot) {
    return PROVIDERS.filter((provider) => isActiveProvider(snapshot, provider));
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

  return {
    PROVIDERS,
    providerAuthState,
    isHiddenProvider,
    isActiveProvider,
    activeProviders,
    providersWithUsageRows,
    detailProviders,
    visibleRecommendations,
  };
}));
