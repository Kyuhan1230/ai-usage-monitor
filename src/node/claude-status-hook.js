#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { nowKstIso, writeJsonAtomic } = require("./status-capture");

const DEFAULT_STATUS_PATH = path.join(os.homedir(), ".codex-usage-wrapper", "claude-status.json");
const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const USAGE_COMMAND_FRESH_MS = 10 * 60 * 1000;

function parseArgs(argv) {
  const args = {
    statusPath: DEFAULT_STATUS_PATH,
    settingsPath: DEFAULT_SETTINGS_PATH,
    install: false,
    originalCommand: process.env.CLAUDE_STATUSLINE_ORIGINAL_COMMAND || "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--status-path") {
      args.statusPath = argv[index + 1];
      index += 1;
    } else if (arg === "--settings-path") {
      args.settingsPath = argv[index + 1];
      index += 1;
    } else if (arg === "--install") {
      args.install = true;
    } else if (arg === "--original-command") {
      args.originalCommand = argv[index + 1] || "";
      index += 1;
    }
  }
  return args;
}

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function parsePayload(rawInput) {
  try {
    const parsed = JSON.parse(rawInput || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function looksLikeResetField(key, value) {
  if (value === null || value === undefined) {
    return false;
  }
  return /reset|expires?|renew|window|at/i.test(key) && (typeof value === "string" || typeof value === "number");
}

function formatEpochSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const millis = numeric > 1000000000000 ? numeric : numeric * 1000;
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `resets ${byType.month}/${byType.day} ${byType.hour}:${byType.minute}`;
}

function formatResetText(key, value) {
  if (/(_at|At|expires?|reset)/.test(key)) {
    const formatted = formatEpochSeconds(value);
    if (formatted !== null) {
      return formatted;
    }
  }
  return String(value);
}

function findResetText(limitPayload) {
  if (!limitPayload || typeof limitPayload !== "object") {
    return null;
  }
  for (const [key, value] of Object.entries(limitPayload)) {
    if (looksLikeResetField(key, value)) {
      return formatResetText(key, value);
    }
  }
  return null;
}

function rateLimitsFromPayload(payload) {
  for (const key of ["rate_limits", "rateLimits", "limits"]) {
    const value = payload[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
  }
  return {};
}

function readPercent(limitPayload) {
  for (const key of ["used_percentage", "usedPercentage", "used_percent", "usedPercent"]) {
    const usedPercent = clampPercent(limitPayload[key]);
    if (usedPercent !== null) {
      return {
        usedPercent,
        remainingPercent: Math.max(0, Math.min(100, Math.round(100 - usedPercent))),
      };
    }
  }

  for (const key of ["remaining_percentage", "remainingPercentage", "remaining_percent", "remainingPercent"]) {
    const remainingPercent = clampPercent(limitPayload[key]);
    if (remainingPercent !== null) {
      return {
        usedPercent: Math.max(0, Math.min(100, Math.round(100 - remainingPercent))),
        remainingPercent,
      };
    }
  }
  return null;
}

function limitFromPayload(payload, type) {
  const rateLimits = rateLimitsFromPayload(payload);
  const limitPayload = rateLimits[type] && typeof rateLimits[type] === "object" ? rateLimits[type] : null;
  if (!limitPayload) {
    return null;
  }
  const percent = readPercent(limitPayload);
  if (percent === null) {
    return null;
  }
  return {
    type,
    used_percent: percent.usedPercent,
    remaining_percent: percent.remainingPercent,
    reset_text: findResetText(limitPayload),
  };
}

function buildStatus(rawInput) {
  const payload = parsePayload(rawInput);
  const limits = ["five_hour", "seven_day"]
    .map((type) => limitFromPayload(payload, type))
    .filter(Boolean);

  return {
    schema_version: 1,
    captured_at: nowKstIso(),
    source: "claude_statusline_hook",
    capture_method: "claude_statusline_hook",
    parse_status: limits.length > 0 ? "ok" : "failed",
    limits,
    raw_status_text: rawInput,
  };
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

function parseStatusTime(value) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldPreserveUsageCommandStatus(statusPath) {
  const current = readJsonSafe(statusPath);
  if (!current || current.capture_method !== "claude_usage_command") {
    return false;
  }
  const poller = current.poller && typeof current.poller === "object" ? current.poller : null;
  const timestamp = parseStatusTime(poller && poller.heartbeat_at) || parseStatusTime(current.captured_at);
  return timestamp !== null && Date.now() - timestamp <= USAGE_COMMAND_FRESH_MS;
}

function summaryFromStatus(status) {
  if (!status.limits.length) {
    return "Claude limits: N/A";
  }
  return status.limits
    .map((limit) => {
      const label = limit.type === "five_hour" ? "5h" : "7d";
      return `${label}:${limit.used_percent}% used`;
    })
    .join(" ");
}

function splitCommand(command) {
  const matches = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return matches.map((part) => part.replace(/^"|"$/g, ""));
}

function runOriginalCommand(command, rawInput) {
  if (!command) {
    return "";
  }
  const parts = splitCommand(command);
  if (!parts.length) {
    return "";
  }
  try {
    return execFileSync(parts[0], parts.slice(1), {
      input: rawInput,
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
    }).trim();
  } catch (error) {
    return "";
  }
}

function isThisHookCommand(command, hookPath) {
  return String(command || "").includes(path.basename(hookPath));
}

function isLegacyAppHookCommand(command) {
  return /Codex Claude Usage\.exe/i.test(String(command || ""));
}

function install(settingsPath) {
  const hookPath = path.resolve(__filename);
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    settings = {};
  }

  const existing = settings.statusLine && settings.statusLine.command;
  if (
    typeof existing === "string" &&
    existing &&
    !isThisHookCommand(existing, hookPath) &&
    !isLegacyAppHookCommand(existing)
  ) {
    process.stdout.write(
      [
        "Existing statusLine.command found; settings.json was not modified.",
        `Original command: ${existing}`,
        "Option 1: keep the original command and skip this hook.",
        `Option 2: chain manually by setting CLAUDE_STATUSLINE_ORIGINAL_COMMAND to the original command and command to: node \"${hookPath}\"`,
        "",
      ].join("\n"),
    );
    return;
  }

  settings.statusLine = {
    type: "command",
    command: `node "${hookPath}"`,
  };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeJsonAtomic(settingsPath, settings);
  process.stdout.write(`Installed Claude statusLine hook in ${settingsPath}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.install) {
    install(args.settingsPath);
    return;
  }

  const rawInput = readStdin();
  const status = buildStatus(rawInput);
  if (!shouldPreserveUsageCommandStatus(args.statusPath)) {
    writeJsonAtomic(args.statusPath, status);
  }

  const originalOutput = runOriginalCommand(args.originalCommand, rawInput);
  const summary = summaryFromStatus(status);
  process.stdout.write(originalOutput ? `${originalOutput} | ${summary}\n` : `${summary}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildStatus,
  shouldPreserveUsageCommandStatus,
  summaryFromStatus,
  isLegacyAppHookCommand,
  parseArgs,
};
