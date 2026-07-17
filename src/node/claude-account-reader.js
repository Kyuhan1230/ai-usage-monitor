"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { appendHistoryIfChanged, nowKstIso, writeJsonAtomic } = require("./status-capture");

const DEFAULT_STATUS_PATH = path.join(os.homedir(), ".codex-usage-wrapper", "claude-status.json");
const DEFAULT_HISTORY_DIR = path.join(os.homedir(), ".codex-usage-wrapper", "history");
const DEFAULT_TIMEOUT_MS = 60 * 1000;
const CAPTURE_METHOD = "claude_usage_command";

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function monthNumber(monthName) {
  const months = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12",
  };
  return months[String(monthName || "").slice(0, 3).toLowerCase()] || null;
}

function formatResetText(monthName, dayText, hourText, minuteText, meridiem) {
  const month = monthNumber(monthName);
  if (!month) {
    return null;
  }
  const day = String(Number(dayText)).padStart(2, "0");
  let hour = Number(hourText);
  const lowerMeridiem = String(meridiem || "").toLowerCase();
  if (lowerMeridiem === "pm" && hour < 12) {
    hour += 12;
  } else if (lowerMeridiem === "am" && hour === 12) {
    hour = 0;
  }
  return `resets ${month}/${day} ${String(hour).padStart(2, "0")}:${minuteText || "00"}`;
}

function parseLimitLine(line, type) {
  const match = line.match(/:\s*(\d{1,3})%\s+used(?:\s+[·•]\s+resets\s+([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?(am|pm))?/i);
  if (!match) {
    return null;
  }
  const usedPercent = clampPercent(match[1]);
  if (usedPercent === null) {
    return null;
  }
  return {
    type,
    used_percent: usedPercent,
    remaining_percent: 100 - usedPercent,
    reset_text: match[2] ? formatResetText(match[2], match[3], match[4], match[5], match[6]) : null,
  };
}

function parseUsageText(rawText) {
  const limits = [];
  for (const line of String(rawText || "").split(/\r?\n/)) {
    const type = /^Current session:/i.test(line)
      ? "five_hour"
      : /^Current week \(all models\):/i.test(line)
        ? "seven_day"
        : null;
    if (type) {
      const limit = parseLimitLine(line, type);
      if (limit) {
        limits.push(limit);
      }
    }
  }
  return limits;
}

function parseUsageWindows(rawText) {
  const windows = [];
  const pattern = /^Last\s+(\d+\w*)\s+\S+\s+(\d+)\s+requests\s+\S+\s+(\d+)\s+sessions$/i;
  for (const line of String(rawText || "").split(/\r?\n/)) {
    const match = line.trim().match(pattern);
    if (match) {
      windows.push({ window: match[1], requests: Number(match[2]), sessions: Number(match[3]) });
    }
  }
  return windows;
}

function buildStatus(rawText, parseError = null) {
  const limits = parseError ? [] : parseUsageText(rawText);
  const usageWindows = parseError ? [] : parseUsageWindows(rawText);
  const hasSubscriptionSummary = !parseError
    && /using your subscription to power your Claude Code usage/i.test(String(rawText || ""));
  return {
    schema_version: 1,
    captured_at: nowKstIso(),
    source: "claude_usage_command",
    capture_method: CAPTURE_METHOD,
    parse_status: limits.length > 0 || usageWindows.length > 0 || hasSubscriptionSummary ? "ok" : "failed",
    error: parseError,
    limits,
    usage_windows: usageWindows,
    summary_status: hasSubscriptionSummary ? "subscription_usage_summary" : null,
    raw_status_text: "",
  };
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    return null;
  }
}

function mergePreviousLimits(statusPath, status) {
  if (status.parse_status !== "ok" || status.limits.length > 0) {
    return status;
  }
  const previous = readJsonSafe(statusPath);
  if (!previous || !Array.isArray(previous.limits) || previous.limits.length === 0) {
    return status;
  }
  return { ...status, limits: previous.limits, limits_preserved_from: previous.captured_at || null };
}

function captureOnce(options = {}, callback = () => {}) {
  const statusPath = options.statusPath || DEFAULT_STATUS_PATH;
  const historyDir = options.historyDir || DEFAULT_HISTORY_DIR;
  const claudeCommand = options.claudeCommand || (process.platform === "win32" ? "claude.exe" : "claude");
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  execFile(claudeCommand, ["/usage"], {
    windowsHide: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 512 * 1024,
  }, (error, stdout, stderr) => {
    const previousStatus = readJsonSafe(statusPath);
    const rawText = [stdout, stderr].filter(Boolean).join("\n");
    const status = mergePreviousLimits(statusPath, buildStatus(rawText, error ? error.message : null));
    const attemptedStatus = {
      ...status,
      capture: {
        state: status.parse_status === "ok" ? "on_demand_ok" : "on_demand_failed",
        heartbeat_at: nowKstIso(),
        mode: "on_demand",
      },
    };
    if (status.parse_status === "ok") {
      writeJsonAtomic(statusPath, attemptedStatus);
      appendHistoryIfChanged(historyDir, attemptedStatus, previousStatus);
    } else if (previousStatus && previousStatus.parse_status === "ok") {
      writeJsonAtomic(statusPath, {
        ...previousStatus,
        capture: attemptedStatus.capture,
        last_failed_status: {
          captured_at: attemptedStatus.captured_at,
          error: attemptedStatus.error,
        },
      });
    } else {
      writeJsonAtomic(statusPath, attemptedStatus);
    }
    callback(attemptedStatus);
  });
}

function captureOnceAsync(options = {}) {
  return new Promise((resolve) => captureOnce(options, resolve));
}

module.exports = {
  CAPTURE_METHOD,
  DEFAULT_HISTORY_DIR,
  DEFAULT_STATUS_PATH,
  buildStatus,
  captureOnce,
  captureOnceAsync,
  clampPercent,
  mergePreviousLimits,
  parseUsageText,
  parseUsageWindows,
};
