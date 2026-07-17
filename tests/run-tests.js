#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-monitor-test-"));

const { captureOnce: captureCodexOnce } = require("../src/node/codex-account-reader");
const claudeReader = require("../src/node/claude-account-reader");
const claudeHook = require("../src/node/claude-status-hook");
const {
  appendHistoryIfChanged,
  writeJsonAtomic,
} = require("../src/node/status-capture");
const tokenReader = require("../src/node/token-usage-reader");
const analytics = require("../src/node/usage-analytics");
const preferences = require("../src/electron/app-preferences");
const hookSettings = require("../src/electron/claude-hook-settings");
const { createUpdaterController } = require("../src/electron/updater");
const { refreshReleaseMetadata } = require("../scripts/refresh-release-metadata");

const tests = [];

function test(name, run) {
  tests.push({ name, run });
}

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function walkFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

test("현재 JavaScript 파일의 구문이 유효하다", () => {
  const files = ["src", "scripts", "tests"]
    .flatMap((directory) => walkFiles(path.join(ROOT, directory)))
    .filter((filePath) => filePath.endsWith(".js"));
  for (const filePath of files) {
    execFileSync(process.execPath, ["--check", filePath], { stdio: "pipe" });
  }
  assert(files.length >= 15);
});

test("Codex app-server를 단발 실행하고 공식 계정 한도를 저장한다", async () => {
  const directory = path.join(TEMP_ROOT, "codex");
  const statusPath = path.join(directory, "status.json");
  const historyDir = path.join(directory, "history");
  const protocolLog = path.join(directory, "protocol.jsonl");
  fs.mkdirSync(directory, { recursive: true });
  const status = await captureCodexOnce({
    codexCommand: process.execPath,
    codexArgsPrefix: [path.join(ROOT, "tests", "mock-codex-app-server.js")],
    statusPath,
    historyDir,
    timeoutMs: 5000,
    env: { ...process.env, MOCK_CODEX_APP_SERVER_LOG: protocolLog },
  });
  assert.strictEqual(status.parse_status, "ok");
  assert.strictEqual(status.capture_method, "codex_app_server");
  assert.strictEqual(status.limits[0].remaining_percent, 73);
  assert.strictEqual(status.limits[1].remaining_percent, 39);
  assert.strictEqual(status.capture.mode, "on_demand");
  assert.strictEqual(status.raw_status_text, "");
  assert.strictEqual(JSON.parse(fs.readFileSync(statusPath, "utf8")).parse_status, "ok");
  assert.strictEqual(fs.readdirSync(historyDir).length, 1);
  const methods = fs.readFileSync(protocolLog, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line).method);
  assert.deepStrictEqual(methods, ["initialize", "initialized", "account/rateLimits/read", "account/usage/read"]);
});

test("Codex 실행 파일이 없으면 무한 대기하지 않고 실패한다", async () => {
  await assert.rejects(
    captureCodexOnce({ codexCommand: path.join(TEMP_ROOT, "missing-codex.exe"), timeoutMs: 1000 }),
  );
});

test("Claude /usage 출력을 한도와 사용 창으로 변환한다", () => {
  const raw = [
    "Current session: 42% used · resets Jul 18, 9:30pm",
    "Current week (all models): 71% used • resets Jul 20, 12am",
    "Last 7d | 123 requests | 9 sessions",
  ].join("\n");
  const status = claudeReader.buildStatus(raw);
  assert.strictEqual(status.parse_status, "ok");
  assert.deepStrictEqual(status.limits.map((limit) => limit.remaining_percent), [58, 29]);
  assert.strictEqual(status.limits[0].reset_text, "resets 07/18 21:30");
  assert.strictEqual(status.usage_windows[0].requests, 123);
  assert.strictEqual(status.raw_status_text, "");
});

test("Claude 단발 수집 실패 시 마지막 성공 상태를 보존한다", async () => {
  const directory = path.join(TEMP_ROOT, "claude-failure");
  const statusPath = path.join(directory, "status.json");
  const historyDir = path.join(directory, "history");
  const previous = {
    captured_at: "2026-07-18T10:00:00+09:00",
    capture_method: "claude_usage_command",
    source: "claude_usage_command",
    parse_status: "ok",
    limits: [{ type: "five_hour", remaining_percent: 66 }],
  };
  writeJsonAtomic(statusPath, previous);
  const attempted = await claudeReader.captureOnceAsync({
    claudeCommand: path.join(TEMP_ROOT, "missing-claude.exe"),
    statusPath,
    historyDir,
    timeoutMs: 1000,
  });
  const saved = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  assert.strictEqual(attempted.parse_status, "failed");
  assert.strictEqual(saved.parse_status, "ok");
  assert.strictEqual(saved.limits[0].remaining_percent, 66);
  assert(saved.last_failed_status);
  assert(!fs.existsSync(historyDir));
});

test("Claude statusLine 이벤트는 원문 없이 한도를 기록한다", () => {
  const raw = JSON.stringify({
    rate_limits: {
      five_hour: { used_percentage: 35, resets_at: 1784334600 },
      seven_day: { remaining_percentage: 22, reset_at: 1784766600 },
    },
  });
  const status = claudeHook.buildStatus(raw);
  assert.strictEqual(status.parse_status, "ok");
  assert.deepStrictEqual(status.limits.map((limit) => limit.remaining_percent), [65, 22]);
  assert.strictEqual(status.raw_status_text, "");
  assert.match(claudeHook.summaryFromStatus(status), /5h:35% used/);

  const statusPath = path.join(TEMP_ROOT, "hook", "status.json");
  writeJsonAtomic(statusPath, {
    capture_method: "claude_usage_command",
    captured_at: new Date().toISOString(),
    parse_status: "ok",
    limits: [],
  });
  assert.strictEqual(claudeHook.shouldPreserveUsageCommandStatus(statusPath), true);
});

test("동일 한도는 30분 이내 중복 기록하지 않는다", () => {
  const historyDir = path.join(TEMP_ROOT, "history-dedupe");
  const previous = {
    captured_at: "2026-07-18T09:00:00+09:00",
    parse_status: "ok",
    limits: [{ type: "five_hour", remaining_percent: 50, reset_text: "resets 07/18 20:00" }],
  };
  const same = { ...previous, captured_at: "2026-07-18T09:10:00+09:00" };
  const changed = {
    ...previous,
    captured_at: "2026-07-18T09:11:00+09:00",
    limits: [{ ...previous.limits[0], remaining_percent: 49 }],
  };
  assert.strictEqual(appendHistoryIfChanged(historyDir, previous, null), true);
  assert.strictEqual(appendHistoryIfChanged(historyDir, same, previous), false);
  assert.strictEqual(appendHistoryIfChanged(historyDir, changed, same), true);
  const lines = fs.readFileSync(path.join(historyDir, "2026-07-18.jsonl"), "utf8").trim().split(/\r?\n/);
  assert.strictEqual(lines.length, 2);
});

test("Codex와 Claude JSONL 토큰을 로컬에서 증분 집계한다", () => {
  const directory = path.join(TEMP_ROOT, "tokens");
  const codexDir = path.join(directory, "codex");
  const claudeDir = path.join(directory, "claude");
  const cachePath = path.join(directory, "cache.json");
  writeJsonl(path.join(codexDir, "rollout-2026-07-18T100000.jsonl"), [
    { timestamp: "2026-07-18T01:00:00Z", payload: { model: "gpt-5.3-codex" } },
    { timestamp: "2026-07-18T01:01:00Z", payload: { info: { last_token_usage: {
      input_tokens: 1000, cached_input_tokens: 400, output_tokens: 250, reasoning_output_tokens: 50, total_tokens: 1250,
    } } } },
  ]);
  const claudeMessage = {
    type: "assistant",
    timestamp: "2026-07-18T02:00:00Z",
    message: {
      id: "msg-1",
      model: "claude-sonnet-4-5",
      usage: { input_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 100, output_tokens: 300 },
    },
  };
  writeJsonl(path.join(claudeDir, "session.jsonl"), [claudeMessage, claudeMessage]);
  const rows = tokenReader.scanTokenUsage({ codexSessionsDir: codexDir, claudeSessionsDir: claudeDir, cachePath });
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows.find((row) => row.provider === "codex").totalTokens, 1250);
  assert.strictEqual(rows.find((row) => row.provider === "claude").totalTokens, 1100);
  assert(fs.existsSync(cachePath));
  assert.deepStrictEqual(
    tokenReader.scanTokenUsage({ codexSessionsDir: codexDir, claudeSessionsDir: claudeDir, cachePath }),
    rows,
  );
});

test("예상 고갈·알림·비교·급증·비용·절약·추천을 한 번에 만든다", () => {
  const nowMs = Date.parse("2026-07-18T12:00:00Z");
  const resetEpoch = Math.floor((nowMs + 20 * 60 * 60 * 1000) / 1000);
  const historyRecords = [60, 55, 50, 45, 40].map((remaining, index) => ({
    source: "codex_app_server",
    captured_at: new Date(nowMs - (4 - index) * 60 * 60 * 1000).toISOString(),
    parse_status: "ok",
    limits: [{ type: "five_hour", remaining_percent: remaining, resets_at: resetEpoch }],
  }));
  historyRecords.push({
    source: "claude_statusline_hook",
    captured_at: new Date(nowMs).toISOString(),
    parse_status: "ok",
    limits: [{ type: "five_hour", remaining_percent: 8, reset_text: "resets 07/19 18:00" }],
  });
  const date = (offset) => analytics.localDate(nowMs, offset);
  const usageRows = [
    { provider: "codex", date: date(0), model: "gpt-5.3-codex", inputTokens: 40000, cachedInputTokens: 10000, outputTokens: 10000, totalTokens: 50000 },
    { provider: "claude", date: date(0), model: "claude-opus-4-6", inputTokens: 20000, outputTokens: 10000, totalTokens: 30000 },
    ...Array.from({ length: 14 }, (_, index) => ({
      provider: "codex",
      date: date(-index - 1),
      model: "gpt-5.3-codex",
      inputTokens: index < 7 ? 8000 : 4000,
      outputTokens: index < 7 ? 2000 : 1000,
      totalTokens: index < 7 ? 10000 : 5000,
    })),
  ];
  const report = analytics.buildAnalytics({ nowMs, historyRecords, usageRows });
  const limit = report.providers.codex.limits.five_hour;
  assert.strictEqual(limit.depletionRatePercentPerHour, 5);
  assert.strictEqual(limit.willExhaustBeforeReset, true);
  assert(report.alerts.some((alert) => alert.reason === "forecast_before_reset"));
  assert(report.alerts.some((alert) => alert.reason === "threshold_critical"));
  assert.strictEqual(report.providers.codex.comparison.dayOverDayPercent, 400);
  assert.strictEqual(report.anomalies.codex.detected, true);
  assert(report.costs.estimatedUsd > 0);
  assert(report.costs.providers.codex.savings.estimatedUsd > 0);
  assert(report.recommendations.some((item) => item.reason === "forecast_before_reset"));
  assert.strictEqual(report.usage.rows.length, usageRows.length);
  assert(report.usage.rows[0].estimatedUsd !== null);
});

test("환경설정과 Claude hook 교체는 사용자 선택과 백업을 지킨다", async () => {
  const directory = path.join(TEMP_ROOT, "settings");
  const preferencePath = path.join(directory, "preferences.json");
  assert.strictEqual(preferences.getLaunchAtLoginPreference(preferencePath), false);
  assert.strictEqual(preferences.setLaunchAtLoginPreference(preferencePath, true), true);
  assert.strictEqual(preferences.getLaunchAtLoginPreference(preferencePath), true);

  const settingsPath = path.join(directory, "claude-settings.json");
  writeJsonAtomic(settingsPath, { statusLine: { type: "command", command: "my-existing-status" }, theme: "dark" });
  const preserved = await hookSettings.installClaudeHookSettings({
    settingsPath,
    command: "new-hook --claude-status-hook",
    confirmReplace: async () => false,
  });
  assert.strictEqual(preserved.status, "preserved");
  const installed = await hookSettings.installClaudeHookSettings({
    settingsPath,
    command: "new-hook --claude-status-hook",
    confirmReplace: async () => true,
    now: new Date("2026-07-18T00:00:00Z"),
  });
  assert.strictEqual(installed.status, "installed");
  assert(fs.existsSync(installed.backupPath));
  assert.strictEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")).theme, "dark");
});

test("업데이터는 개발 실행에서 네트워크 확인을 시작하지 않는다", async () => {
  const messages = [];
  const controller = createUpdaterController({
    app: { isPackaged: false },
    autoUpdater: {},
    dialog: { showMessageBox: async (options) => { messages.push(options); return { response: 0 }; } },
    platform: "win32",
  });
  assert.strictEqual(controller.isSupported(), false);
  assert.strictEqual(await controller.check(true), false);
  assert.strictEqual(messages.length, 1);
});

test("릴리스 메타데이터와 태그 검증이 현재 버전을 따른다", async () => {
  const packageJson = require("../package.json");
  const directory = path.join(TEMP_ROOT, "release");
  fs.mkdirSync(directory, { recursive: true });
  const installer = path.join(directory, `Codex-Claude-Usage-Setup-${packageJson.version}.exe`);
  fs.writeFileSync(installer, Buffer.alloc(8192, 7));
  const result = await refreshReleaseMetadata(installer, packageJson.version);
  assert(fs.existsSync(result.blockmapPath));
  assert.match(fs.readFileSync(result.metadataPath, "utf8"), new RegExp(`version: ${packageJson.version.replace(/\./g, "\\.")}`));
  assert.match(
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "verify-release-tag.js"), `v${packageJson.version}`], { encoding: "utf8" }),
    /matches package version/,
  );
});

test("배포 구성에는 Python·서버·지속 폴러가 없다", () => {
  const packageJson = require("../package.json");
  const packageText = JSON.stringify(packageJson);
  const mainText = fs.readFileSync(path.join(ROOT, "src", "electron", "main.js"), "utf8");
  const workflowText = ["ci.yml", "release.yml"]
    .map((name) => fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8"))
    .join("\n");
  const sourceText = walkFiles(path.join(ROOT, "src"))
    .filter((filePath) => /\.(?:js|html|css)$/.test(filePath))
    .map((filePath) => fs.readFileSync(filePath, "utf8"))
    .join("\n");
  assert(!packageText.includes("node-pty"));
  assert(!packageText.includes("python"));
  assert(!packageText.includes("dashboard"));
  assert(!/uvicorn|fastapi|http\.createServer|listen\s*\(/i.test(sourceText));
  assert(!mainText.includes("setInterval("));
  assert(!mainText.includes("status-poller"));
  assert(!sourceText.includes("0.0.0.0"));
  assert(!/setup-python|pip install|requirements\.txt/i.test(workflowText));
  for (const legacyPath of [
    "requirements.txt",
    "requirements.in",
    "src/python",
    "src/electron/dashboard-runtime.js",
    "src/node/codex-status-poller.js",
    "src/node/claude-usage-poller.js",
    "scripts/prepare-python-runtime.ps1",
  ]) {
    assert(!fs.existsSync(path.join(ROOT, legacyPath)), `${legacyPath} should be removed`);
  }
  assert(fs.existsSync(path.join(ROOT, "src", "electron", "renderer", "details.html")));
  assert(fs.readFileSync(path.join(ROOT, "scripts", "capture-readme-screenshots.js"), "utf8").includes("app-details.png"));
});

async function main() {
  let failures = 0;
  for (const item of tests) {
    try {
      await item.run();
      process.stdout.write(`PASS ${item.name}\n`);
    } catch (error) {
      failures += 1;
      process.stderr.write(`FAIL ${item.name}\n${error.stack || error}\n`);
    }
  }
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  if (failures > 0) {
    process.stderr.write(`\n${failures}/${tests.length} tests failed\n`);
    process.exit(1);
  }
  process.stdout.write(`\n${tests.length} tests passed\n`);
}

main().catch((error) => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
