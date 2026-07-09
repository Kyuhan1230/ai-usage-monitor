"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const STATUS_DIR = path.join(os.homedir(), ".codex-usage-wrapper");
const STATUS_PATH = path.join(STATUS_DIR, "status.json");
const HISTORY_DIR = path.join(STATUS_DIR, "history");

const UNSAFE_PROMPT_PATTERNS = [
  /do you want to/i,
  /would you like to/i,
  /allow .*?\?/i,
  /approve/i,
  /approval/i,
  /confirm/i,
  /confirmation/i,
  /permission/i,
  /continue\?/i,
  /\by\/n\b/i,
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /press .* to continue/i,
];

const LIMIT_ALIASES = {
  five_hour: ["5-hour", "5 hour", "five-hour", "five hour", "5h"],
  weekly: ["weekly", "week"],
  monthly: ["monthly", "month"],
};

const MONTH_NUMBERS = {
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

function stripAnsi(text) {
  return text
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function nowKstIso() {
  const now = new Date();
  const kstTime = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${kstTime.toISOString().slice(0, 19)}+09:00`;
}

function normalizeLimitName(text) {
  const lowered = text.toLowerCase();
  for (const [type, aliases] of Object.entries(LIMIT_ALIASES)) {
    if (aliases.some((alias) => lowered.includes(alias))) {
      return type;
    }
  }
  return null;
}

function clampPercent(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.min(100, parsed));
}

function extractRemainingPercent(text) {
  const remainingMatch = text.match(
    /remaining[^0-9]{0,30}(\d{1,3})\s*%|(\d{1,3})\s*%[^A-Za-z0-9]{0,30}remaining/i,
  );
  if (remainingMatch) {
    return clampPercent(remainingMatch[1] || remainingMatch[2]);
  }
  const percentMatch = text.match(/(\d{1,3})\s*%/);
  return percentMatch ? clampPercent(percentMatch[1]) : null;
}

function extractResetText(text) {
  const resetMatch = text.match(/(resets?\s+(?:in\s+)?[^,\n)]+|reset\s+(?:in\s+)?[^,\n)]+)/i);
  return resetMatch ? normalizeResetText(trimResetText(resetMatch[1].trim())) : null;
}

function trimResetText(resetText) {
  return resetText
    .split(/\s+(?=(?:weekly|monthly|5[- ]?hour|five[- ]?hour|5h)\b|>)/i)[0]
    .trim();
}

function normalizeResetText(resetText) {
  const isoMatch = resetText.match(/^resets?\s+(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/i);
  if (isoMatch) {
    return `resets ${isoMatch[2]}/${isoMatch[3]} ${isoMatch[4].padStart(2, "0")}:${isoMatch[5]}`;
  }

  const monthNameMatch = resetText.match(/^resets?\s+(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+([A-Za-z]{3})/i);
  if (monthNameMatch) {
    const month = MONTH_NUMBERS[monthNameMatch[4].toLowerCase()];
    if (month) {
      const day = monthNameMatch[3].padStart(2, "0");
      const hour = monthNameMatch[1].padStart(2, "0");
      return `resets ${month}/${day} ${hour}:${monthNameMatch[2]}`;
    }
  }

  return resetText;
}

function parseStatusText(rawStatusText, captureMethod = "codex_wrapper") {
  const cleanText = stripAnsi(rawStatusText);
  const lines = cleanText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const limits = new Map();

  lines.forEach((line, index) => {
    const limitType = normalizeLimitName(line);
    if (!limitType) {
      return;
    }
    if (limits.has(limitType)) {
      return;
    }
    const nextLine = index + 1 < lines.length ? ` ${lines[index + 1]}` : "";
    const context = `${line}${nextLine}`;
    limits.set(limitType, {
      type: limitType,
      remaining_percent: extractRemainingPercent(context),
      reset_text: extractResetText(context),
    });
  });

  const parsedLimits = Array.from(limits.values());
  const hasPercent = parsedLimits.some((limit) => Number.isInteger(limit.remaining_percent));

  return {
    schema_version: 1,
    captured_at: nowKstIso(),
    source: "codex_cli_status",
    capture_method: captureMethod,
    parse_status: hasPercent ? "ok" : "failed",
    limits: parsedLimits,
    raw_status_text: cleanText.trim(),
  };
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function appendHistory(historyDir, status) {
  fs.mkdirSync(historyDir, { recursive: true });
  const date = String(status.captured_at || nowKstIso()).slice(0, 10);
  const historyPath = path.join(historyDir, `${date}.jsonl`);
  fs.appendFileSync(historyPath, `${JSON.stringify(status)}\n`, "utf8");
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

function writePollerHeartbeat(statusPath, state, detail = "", extra = {}) {
  const current = readJsonSafe(statusPath) || {
    schema_version: 1,
    source: "codex_cli_status",
    parse_status: "missing",
    limits: [],
  };
  const next = {
    ...current,
    poller: {
      ...(current.poller || {}),
      state,
      detail,
      heartbeat_at: nowKstIso(),
      pid: process.pid,
      ...extra,
    },
  };
  writeJsonAtomic(statusPath, next);
  return next;
}

function writeStatus(statusPath, historyDir, rawStatusText, captureMethod = "codex_wrapper") {
  const status = parseStatusText(rawStatusText, captureMethod);
  writeJsonAtomic(statusPath, status);
  appendHistory(historyDir, status);
  return status;
}

function writeStatusPreservingPrevious(statusPath, historyDir, rawStatusText, captureMethod = "codex_wrapper") {
  const status = parseStatusText(rawStatusText, captureMethod);
  appendHistory(historyDir, status);

  if (status.parse_status === "ok") {
    writeJsonAtomic(statusPath, {
      ...status,
      poller: {
        state: "captured_ok",
        detail: "",
        heartbeat_at: status.captured_at,
        pid: process.pid,
      },
    });
    return status;
  }

  const current = readJsonSafe(statusPath);
  if (current && current.parse_status === "ok") {
    writeJsonAtomic(statusPath, {
      ...current,
      poller: {
        ...(current.poller || {}),
        state: "parse_failed",
        detail: "kept previous successful status",
        heartbeat_at: status.captured_at,
        pid: process.pid,
      },
      last_failed_status: {
        captured_at: status.captured_at,
        capture_method: status.capture_method,
        parse_status: status.parse_status,
      },
    });
    return status;
  }

  writeJsonAtomic(statusPath, {
    ...status,
    poller: {
      state: "parse_failed",
      detail: "no previous successful status",
      heartbeat_at: status.captured_at,
      pid: process.pid,
    },
  });
  return status;
}

function typeIntoTerminal(term, text, delayMs = 15) {
  // 한 번에 term.write(text)로 밀어넣으면 일부 TUI가 이를 붙여넣기로 인식해서
  // 마지막 \r을 "제출"이 아니라 그냥 줄바꿈 문자로 처리해버린다.
  // 실제 타이핑처럼 한 글자씩 지연을 두고 보내야 명령이 확실히 제출된다.
  let index = 0;
  const timer = setInterval(() => {
    if (index >= text.length) {
      clearInterval(timer);
      return;
    }
    term.write(text[index]);
    index += 1;
  }, delayMs);
  return timer;
}

module.exports = {
  STATUS_DIR,
  STATUS_PATH,
  HISTORY_DIR,
  UNSAFE_PROMPT_PATTERNS,
  stripAnsi,
  nowKstIso,
  normalizeLimitName,
  clampPercent,
  extractRemainingPercent,
  extractResetText,
  normalizeResetText,
  trimResetText,
  parseStatusText,
  writeJsonAtomic,
  appendHistory,
  writeStatus,
  writeStatusPreservingPrevious,
  writePollerHeartbeat,
  typeIntoTerminal,
};
