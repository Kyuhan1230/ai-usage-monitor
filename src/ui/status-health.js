"use strict";

// 최신성 판정은 수집 프로세스 유무가 아니라 마지막 단발 캡처 시각을 사용한다.

(function exposeStatusHealth(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
    return;
  }
  root.usageStatusHealth = api;
}(typeof globalThis !== "undefined" ? globalThis : window, () => {
  const RETRYING_STATES = new Set([
    "capture_failed",
    "idle_wait_skipped",
    "parse_failed_retrying",
    "parse_failed_waiting_next_poll",
    "restarting_session",
    "retrying_session",
    "session_exited",
  ]);
  const UPDATING_STATES = new Set(["capturing", "session_starting"]);

  function freshnessLimitMs(pollIntervalMs) {
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
      return 10 * 60 * 1000;
    }
    return Math.max(pollIntervalMs * 2 + 30 * 1000, 150 * 1000);
  }

  function isFresh(ageMs, pollIntervalMs) {
    return Number.isFinite(ageMs) && ageMs <= freshnessLimitMs(pollIntervalMs);
  }

  function stateText({ connected, ageMs, staleText, captureState, freshnessMs }) {
    if (RETRYING_STATES.has(captureState)) {
      return "재시도";
    }
    if (UPDATING_STATES.has(captureState) && !isFresh(ageMs, freshnessMs)) {
      return "갱신 중";
    }
    if (!connected) {
      return "확인 필요";
    }
    return isFresh(ageMs, freshnessMs) ? "최신" : staleText;
  }

  return { freshnessLimitMs, isFresh, stateText };
}));
