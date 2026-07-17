"use strict";

const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const {
  appendHistory,
  nowKstIso,
  writeJsonAtomic,
} = require("./status-capture");

const DEFAULT_STATUS_PATH = path.join(os.homedir(), ".codex-usage-wrapper", "status.json");
const DEFAULT_HISTORY_DIR = path.join(os.homedir(), ".codex-usage-wrapper", "history");
const DEFAULT_TIMEOUT_MS = 20 * 1000;
const CAPTURE_METHOD = "codex_app_server";

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function formatResetText(resetAt) {
  const numeric = Number(resetAt);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  const kst = new Date(numeric * 1000 + 9 * 60 * 60 * 1000).toISOString();
  return `resets ${kst.slice(5, 10).replace("-", "/")} ${kst.slice(11, 16)}`;
}

function limitType(window, index) {
  const duration = Number(window && window.windowDurationMins);
  if (Number.isFinite(duration)) {
    if (duration <= 6 * 60) {
      return "five_hour";
    }
    if (duration <= 8 * 24 * 60) {
      return "weekly";
    }
    return "monthly";
  }
  return index === 0 ? "five_hour" : "weekly";
}

function normalizeLimit(window, index) {
  if (!window || typeof window !== "object") {
    return null;
  }
  const usedPercent = clampPercent(window.usedPercent);
  if (usedPercent === null) {
    return null;
  }
  return {
    type: limitType(window, index),
    used_percent: usedPercent,
    remaining_percent: 100 - usedPercent,
    reset_text: formatResetText(window.resetsAt),
    resets_at: Number.isFinite(Number(window.resetsAt)) ? Number(window.resetsAt) : null,
    window_duration_mins: Number.isFinite(Number(window.windowDurationMins))
      ? Number(window.windowDurationMins)
      : null,
  };
}

function buildStatus(rateLimitResult, usageResult = null) {
  const payload = rateLimitResult && typeof rateLimitResult === "object" ? rateLimitResult : {};
  const rateLimits = payload.rateLimits && typeof payload.rateLimits === "object"
    ? payload.rateLimits
    : {};
  const limits = [rateLimits.primary, rateLimits.secondary]
    .map(normalizeLimit)
    .filter(Boolean);
  const capturedAt = nowKstIso();

  return {
    schema_version: 1,
    captured_at: capturedAt,
    source: "codex_app_server",
    capture_method: CAPTURE_METHOD,
    parse_status: limits.length > 0 ? "ok" : "failed",
    limits,
    raw_status_text: "",
    account_usage: usageResult,
    rate_limit_reset_credits: payload.rateLimitResetCredits || null,
    spend_control_reached: typeof payload.spendControlReached === "boolean"
      ? payload.spendControlReached
      : null,
    poller: {
      state: limits.length > 0 ? "on_demand_ok" : "on_demand_failed",
      detail: "official Codex app-server account snapshot",
      heartbeat_at: capturedAt,
      poll_interval_ms: 0,
    },
  };
}

function writeMessage(child, message) {
  if (!child.stdin || child.stdin.destroyed) {
    return;
  }
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function captureOnce(options = {}) {
  const command = options.codexCommand || (process.platform === "win32" ? "codex.exe" : "codex");
  const commandArgs = Array.isArray(options.codexArgsPrefix) ? options.codexArgsPrefix : [];
  const statusPath = options.statusPath || DEFAULT_STATUS_PATH;
  const historyDir = options.historyDir || DEFAULT_HISTORY_DIR;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const clientVersion = options.clientVersion || "0.2.0";
  const spawnImpl = options.spawnImpl || spawn;

  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, [...commandArgs, "app-server", "--listen", "stdio://"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env || process.env,
    });
    let settled = false;
    let stdoutBuffer = "";
    let stderr = "";
    let rateLimitResult = null;
    let usageResult = null;
    let rateFinished = false;
    let usageFinished = false;

    function stopChild() {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.end();
      }
      if (child.exitCode === null && !child.killed) {
        child.kill();
      }
    }

    function finish(error = null) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      stopChild();
      if (error) {
        reject(error);
        return;
      }
      const status = buildStatus(rateLimitResult, usageResult);
      writeJsonAtomic(statusPath, status);
      appendHistory(historyDir, status);
      resolve(status);
    }

    function maybeFinish() {
      if (rateFinished && usageFinished) {
        if (!rateLimitResult) {
          finish(new Error("Codex app-server did not return account rate limits"));
          return;
        }
        finish();
      }
    }

    function handleMessage(message) {
      if (!message || typeof message !== "object") {
        return;
      }
      if (message.id === 1) {
        if (message.error) {
          finish(new Error(`Codex app-server initialize failed: ${message.error.message || "unknown error"}`));
          return;
        }
        writeMessage(child, { method: "initialized" });
        writeMessage(child, { method: "account/rateLimits/read", id: 2 });
        writeMessage(child, { method: "account/usage/read", id: 3 });
        return;
      }
      if (message.id === 2) {
        rateFinished = true;
        if (!message.error) {
          rateLimitResult = message.result;
        }
        maybeFinish();
        return;
      }
      if (message.id === 3) {
        usageFinished = true;
        if (!message.error) {
          usageResult = message.result;
        }
        maybeFinish();
      }
    }

    const timeout = setTimeout(() => {
      finish(new Error(`Codex app-server snapshot timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (error) => finish(error));
    child.stdin.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) {
        const detail = stderr.trim() ? `: ${stderr.trim().slice(-500)}` : "";
        finish(new Error(`Codex app-server exited before snapshot (code ${code})${detail}`));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          handleMessage(JSON.parse(line));
        } catch (error) {
          // app-server 로그나 알 수 없는 줄은 무시하고 JSON-RPC 응답을 계속 기다린다.
        }
      }
    });

    writeMessage(child, {
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "ai_usage_monitor",
          title: "AI Usage Monitor",
          version: clientVersion,
        },
      },
    });
  });
}

module.exports = {
  CAPTURE_METHOD,
  DEFAULT_HISTORY_DIR,
  DEFAULT_STATUS_PATH,
  buildStatus,
  captureOnce,
  clampPercent,
  formatResetText,
  limitType,
  normalizeLimit,
};
