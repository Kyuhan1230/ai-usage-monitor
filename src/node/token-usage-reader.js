"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { writeJsonAtomic } = require("./status-capture");

const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const DEFAULT_CLAUDE_SESSIONS_DIR = path.join(os.homedir(), ".claude", "projects");
const DEFAULT_CACHE_PATH = path.join(os.homedir(), ".codex-usage-wrapper", "token-usage-cache.json");

function safeInteger(value) {
  if (typeof value === "boolean") {
    return 0;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

function kstDate(value, fallback = "unknown") {
  if (typeof value !== "string" || !value) {
    return fallback;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value.length >= 10 ? value.slice(0, 10) : fallback;
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function listJsonlFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  }
  return files.sort();
}

function readJsonLines(filePath) {
  let body = "";
  try {
    body = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return [];
  }
  const records = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record)) {
        records.push(record);
      }
    } catch (error) {
      // 작성 중인 마지막 JSONL 행이나 손상된 한 줄만 건너뛴다.
    }
  }
  return records;
}

function codexDate(record, filePath) {
  const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
  const timestamp = record.timestamp || payload.timestamp;
  const filenameMatch = path.basename(filePath).match(/rollout-(\d{4}-\d{2}-\d{2})T/);
  return kstDate(timestamp, filenameMatch ? filenameMatch[1] : "unknown");
}

function codexModel(record) {
  const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
  if (typeof payload.model === "string" && payload.model) {
    return payload.model;
  }
  const collaboration = payload.collaboration_mode;
  const settings = collaboration && typeof collaboration === "object" ? collaboration.settings : null;
  return settings && typeof settings.model === "string" && settings.model ? settings.model : null;
}

function codexUsage(record, key) {
  const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
  const info = payload.info && typeof payload.info === "object" ? payload.info : {};
  return info[key] && typeof info[key] === "object" ? info[key] : null;
}

function codexRow(date, model, usage) {
  return {
    provider: "codex",
    date,
    model,
    inputTokens: safeInteger(usage.input_tokens),
    cachedInputTokens: safeInteger(usage.cached_input_tokens),
    cacheCreationInputTokens: 0,
    outputTokens: safeInteger(usage.output_tokens),
    reasoningOutputTokens: safeInteger(usage.reasoning_output_tokens),
    totalTokens: safeInteger(usage.total_tokens),
    events: 1,
  };
}

function parseCodexFile(filePath) {
  const records = readJsonLines(filePath);
  const rows = [];
  let currentModel = "unknown";
  let matched = 0;
  let lastTotal = null;
  for (const record of records) {
    currentModel = codexModel(record) || currentModel;
    lastTotal = codexUsage(record, "total_token_usage") || lastTotal;
    const usage = codexUsage(record, "last_token_usage");
    if (!usage) {
      continue;
    }
    rows.push(codexRow(codexDate(record, filePath), currentModel, usage));
    matched += 1;
  }
  if (matched === 0 && lastTotal && records.length > 0) {
    rows.push(codexRow(codexDate(records[records.length - 1], filePath), currentModel, lastTotal));
  }
  return rows;
}

function claudeRow(date, model, usage) {
  const inputTokens = safeInteger(usage.input_tokens);
  const cachedInputTokens = safeInteger(usage.cache_read_input_tokens);
  const cacheCreationInputTokens = safeInteger(usage.cache_creation_input_tokens);
  const outputTokens = safeInteger(usage.output_tokens);
  return {
    provider: "claude",
    date,
    model,
    inputTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + cachedInputTokens + cacheCreationInputTokens + outputTokens,
    events: 1,
  };
}

function parseClaudeFile(filePath) {
  const deduped = new Map();
  let currentModel = "unknown";
  for (const record of readJsonLines(filePath)) {
    if (record.type !== "assistant") {
      continue;
    }
    const message = record.message && typeof record.message === "object" ? record.message : {};
    currentModel = typeof message.model === "string" && message.model ? message.model : currentModel;
    const usage = message.usage && typeof message.usage === "object" ? message.usage : null;
    if (!usage) {
      continue;
    }
    const messageId = typeof message.id === "string" && message.id
      ? message.id
      : `__missing_id__:${deduped.size}`;
    deduped.set(messageId, claudeRow(kstDate(record.timestamp), currentModel, usage));
  }
  return Array.from(deduped.values());
}

function rowKey(row) {
  return `${row.provider}\u0000${row.date}\u0000${row.model}`;
}

function mergeRows(rows) {
  const merged = new Map();
  for (const row of rows) {
    const key = rowKey(row);
    const current = merged.get(key) || {
      provider: row.provider,
      date: row.date,
      model: row.model,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      events: 0,
    };
    for (const field of [
      "inputTokens",
      "cachedInputTokens",
      "cacheCreationInputTokens",
      "outputTokens",
      "reasoningOutputTokens",
      "totalTokens",
      "events",
    ]) {
      current[field] += safeInteger(row[field]);
    }
    merged.set(key, current);
  }
  return Array.from(merged.values()).sort((left, right) => (
    left.date.localeCompare(right.date) || left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model)
  ));
}

function readCache(cachePath) {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return cache && cache.schemaVersion === CACHE_SCHEMA_VERSION && cache.files && typeof cache.files === "object"
      ? cache.files
      : {};
  } catch (error) {
    return {};
  }
}

function scanProvider(provider, root, parser, cache) {
  const rows = [];
  const seen = new Set();
  for (const filePath of listJsonlFiles(root)) {
    seen.add(filePath);
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      continue;
    }
    const signature = `${stat.mtimeMs}:${stat.size}`;
    let entry = cache[filePath];
    if (!entry || entry.provider !== provider || entry.signature !== signature || !Array.isArray(entry.rows)) {
      entry = { provider, signature, rows: parser(filePath) };
      cache[filePath] = entry;
    }
    rows.push(...entry.rows);
  }
  for (const [filePath, entry] of Object.entries(cache)) {
    if (entry && entry.provider === provider && !seen.has(filePath)) {
      delete cache[filePath];
    }
  }
  return rows;
}

function scanTokenUsage(options = {}) {
  const codexSessionsDir = options.codexSessionsDir || DEFAULT_CODEX_SESSIONS_DIR;
  const claudeSessionsDir = options.claudeSessionsDir || DEFAULT_CLAUDE_SESSIONS_DIR;
  const cachePath = options.cachePath || DEFAULT_CACHE_PATH;
  const cache = readCache(cachePath);
  const rows = [
    ...scanProvider("codex", codexSessionsDir, parseCodexFile, cache),
    ...scanProvider("claude", claudeSessionsDir, parseClaudeFile, cache),
  ];
  try {
    writeJsonAtomic(cachePath, { schemaVersion: CACHE_SCHEMA_VERSION, files: cache });
  } catch (error) {
    // 읽기 전용 환경에서도 현재 메모리 집계 결과는 계속 반환한다.
  }
  return mergeRows(rows);
}

module.exports = {
  CACHE_SCHEMA_VERSION,
  DEFAULT_CACHE_PATH,
  DEFAULT_CLAUDE_SESSIONS_DIR,
  DEFAULT_CODEX_SESSIONS_DIR,
  kstDate,
  listJsonlFiles,
  mergeRows,
  parseClaudeFile,
  parseCodexFile,
  safeInteger,
  scanTokenUsage,
};
