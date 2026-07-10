#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { nowKstIso, writeJsonAtomic } = require("./status-capture");

const DEFAULT_STATUS_PATH = path.join(os.homedir(), ".codex-usage-wrapper", "claude-status.json");
const DEFAULT_POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 3000;
const DEFAULT_TIMEOUT_MS = 60 * 1000;
const CAPTURE_METHOD = "claude_usage_command";

function parseArgs(argv) {
  const options = {
    statusPath: DEFAULT_STATUS_PATH,
    claudeCommand: process.platform === "win32" ? "claude.exe" : "claude",
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    startupDelayMs: DEFAULT_STARTUP_DELAY_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--status-path") {
      options.statusPath = path.resolve(argv[index + 1]);
      index += 1;
    } else if (arg === "--claude-command") {
      options.claudeCommand = argv[index + 1];
      index += 1;
    } else if (arg === "--poll-interval-ms") {
      options.pollIntervalMs = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--startup-delay-ms") {
      options.startupDelayMs = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[index + 1]);
      index += 1;
    }
  }

  return options;
}

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
  const minute = minuteText || "00";
  return `resets ${month}/${day} ${String(hour).padStart(2, "0")}:${minute}`;
}

function parseLimitLine(line, type) {
  const pattern = /:\s*(\d{1,3})%\s+used(?:\s+·\s+resets\s+([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?(am|pm))?/i;
  const match = line.match(pattern);
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
    remaining_percent: Math.max(0, Math.min(100, 100 - usedPercent)),
    reset_text: match[2] ? formatResetText(match[2], match[3], match[4], match[5], match[6]) : null,
  };
}

function parseUsageText(rawText) {
  const limits = [];
  for (const line of String(rawText || "").split(/\r?\n/)) {
    if (/^Current session:/i.test(line)) {
      const limit = parseLimitLine(line, "five_hour");
      if (limit) {
        limits.push(limit);
      }
    } else if (/^Current week \(all models\):/i.test(line)) {
      const limit = parseLimitLine(line, "seven_day");
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
    if (!match) {
      continue;
    }
    windows.push({
      window: match[1],
      requests: Number(match[2]),
      sessions: Number(match[3]),
    });
  }
  return windows;
}

function isSubscriptionUsageSummary(rawText) {
  return /using your subscription to power your Claude Code usage/i.test(String(rawText || ""));
}

function buildStatus(rawText, parseError = null) {
  const limits = parseError ? [] : parseUsageText(rawText);
  const usageWindows = parseError ? [] : parseUsageWindows(rawText);
  const hasSubscriptionSummary = !parseError && isSubscriptionUsageSummary(rawText);
  const parseStatus = limits.length > 0 || usageWindows.length > 0 || hasSubscriptionSummary ? "ok" : "failed";
  return {
    schema_version: 1,
    captured_at: nowKstIso(),
    source: "claude_usage_command",
    capture_method: CAPTURE_METHOD,
    parse_status: parseStatus,
    error: parseError,
    limits,
    usage_windows: usageWindows,
    summary_status: hasSubscriptionSummary ? "subscription_usage_summary" : null,
    raw_status_text: rawText,
  };
}

function captureOnce(options, callback) {
  execFile(options.claudeCommand, ["/usage"], {
    windowsHide: true,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 512 * 1024,
  }, (error, stdout, stderr) => {
    const rawText = [stdout, stderr].filter(Boolean).join("\n");
    const status = buildStatus(rawText, error ? error.message : null);
    fs.mkdirSync(path.dirname(options.statusPath), { recursive: true });
    writeJsonAtomic(options.statusPath, {
      ...status,
      poller: {
        state: status.parse_status === "ok" ? "captured_ok" : "capture_failed",
        heartbeat_at: nowKstIso(),
        poll_interval_ms: options.pollIntervalMs,
      },
    });
    callback(status);
  });
}

function startPoller(options) {
  let stopped = false;
  let timer = null;

  function schedule(delayMs) {
    if (stopped) {
      return;
    }
    timer = setTimeout(run, delayMs);
  }

  function run() {
    if (stopped) {
      return;
    }
    captureOnce(options, () => schedule(options.pollIntervalMs));
  }

  function stop() {
    stopped = true;
    clearTimeout(timer);
  }

  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });

  schedule(options.startupDelayMs);
  return { stop };
}

if (require.main === module) {
  startPoller(parseArgs(process.argv.slice(2)));
}

module.exports = {
  buildStatus,
  captureOnce,
  parseArgs,
  parseUsageText,
  parseUsageWindows,
  startPoller,
};
