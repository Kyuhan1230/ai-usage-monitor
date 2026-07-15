"use strict";

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

  function stateText({ connected, ageMs, staleText, pollerState, pollIntervalMs }) {
    if (RETRYING_STATES.has(pollerState)) {
      return "재시도";
    }
    if (UPDATING_STATES.has(pollerState) && !isFresh(ageMs, pollIntervalMs)) {
      return "갱신 중";
    }
    if (!connected) {
      return "확인 필요";
    }
    return isFresh(ageMs, pollIntervalMs) ? "최신" : staleText;
  }

  return { freshnessLimitMs, isFresh, stateText };
}));
