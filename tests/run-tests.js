#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");

const ROOT = path.resolve(__dirname, "..");
const NODE_DIR = path.join(ROOT, "src", "node");
const PYTHON_DIR = path.join(ROOT, "src", "python");
const TEST_ENV = {
  ...process.env,
  PYTHONPATH: [PYTHON_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
};
const NODE = process.execPath;

function makeTempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath, timeoutMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForJson(filePath, predicate, timeoutMs = 8000) {
  const startedAt = Date.now();
  let lastValue = null;
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) {
      lastValue = readJson(filePath);
      if (predicate(lastValue)) {
        return lastValue;
      }
    }
    await wait(100);
  }
  throw new Error(`Timed out waiting for matching JSON in ${filePath}: ${JSON.stringify(lastValue)}`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readHistoryCount(historyDir) {
  if (!fs.existsSync(historyDir)) {
    return 0;
  }
  return fs
    .readdirSync(historyDir)
    .filter((name) => name.endsWith(".jsonl"))
    .reduce((count, name) => {
      const body = fs.readFileSync(path.join(historyDir, name), "utf8").trim();
      return count + (body ? body.split(/\r?\n/).length : 0);
    }, 0);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: TEST_ENV,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({ statusCode: response.statusCode, body });
        });
      })
      .on("error", (error) => {
        error.message = `${error.message} while requesting ${url}`;
        reject(error);
      });
  });
}

async function testParseRawStdin() {
  const tempDir = makeTempDir("codex-wrapper-parse");
  const statusPath = path.join(tempDir, "status.json");
  const historyDir = path.join(tempDir, "history");
  const child = spawn(
    NODE,
    [
      path.join("src", "node", "codex-wrapper.js"),
      "--parse-raw-stdin",
      "--status-path",
      statusPath,
      "--history-dir",
      historyDir,
    ],
    { cwd: ROOT, env: TEST_ENV, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.end("5-hour remaining: 71%, resets in 2h 18m\nWeekly remaining: 84%, resets in 3d 4h\n");
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`parse exited ${code}`))));
  });

  const status = readJson(statusPath);
  assert.strictEqual(status.parse_status, "ok");
  assert.strictEqual(status.limits.find((limit) => limit.type === "five_hour").remaining_percent, 71);
  assert.strictEqual(status.limits.find((limit) => limit.type === "weekly").remaining_percent, 84);
}

async function testDuplicateLimitsKeepFirstGeneralLimit() {
  const tempDir = makeTempDir("codex-wrapper-duplicates");
  const statusPath = path.join(tempDir, "status.json");
  const historyDir = path.join(tempDir, "history");
  const child = spawn(
    NODE,
    [
      path.join("src", "node", "codex-wrapper.js"),
      "--parse-raw-stdin",
      "--status-path",
      statusPath,
      "--history-dir",
      historyDir,
    ],
    { cwd: ROOT, env: TEST_ENV, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.end(
    [
      "5h limit: 53% left (resets 13:14)",
      "Weekly limit: 84% left (resets 16:06 on 14 Jul)",
      "GPT-5.3-Codex-Spark limit:",
      "5h limit: 100% left (resets 14:26)",
      "Weekly limit: 100% left (resets 09:26 on 15 Jul)",
      "",
    ].join("\n"),
  );
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`duplicates exited ${code}`))));
  });

  const status = readJson(statusPath);
  const fiveHour = status.limits.find((limit) => limit.type === "five_hour");
  const weekly = status.limits.find((limit) => limit.type === "weekly");
  assert.strictEqual(status.parse_status, "ok");
  assert.strictEqual(fiveHour.remaining_percent, 53);
  assert.strictEqual(fiveHour.reset_text, "resets 13:14");
  assert.strictEqual(weekly.remaining_percent, 84);
  assert.strictEqual(weekly.reset_text, "resets 07/14 16:06");
}

async function testPollerParseFailurePreservesPreviousOkStatus() {
  const tempDir = makeTempDir("codex-wrapper-preserve-ok");
  const statusPath = path.join(tempDir, "status.json");
  const historyDir = path.join(tempDir, "history");
  const { writeStatusPreservingPrevious } = require(path.join(NODE_DIR, "status-capture"));

  writeStatusPreservingPrevious(
    statusPath,
    historyDir,
    "5-hour remaining: 71%, resets in 2h 18m\nWeekly remaining: 84%, resets in 3d 4h\n",
    "test",
  );
  writeStatusPreservingPrevious(statusPath, historyDir, "not a status screen yet", "test");

  const status = readJson(statusPath);
  assert.strictEqual(status.parse_status, "ok");
  assert.strictEqual(status.limits.find((limit) => limit.type === "five_hour").remaining_percent, 71);
  assert.strictEqual(status.poller.state, "parse_failed");
  assert.strictEqual(status.last_failed_status.parse_status, "failed");
}

async function testManualUsageWrapper() {
  const tempDir = makeTempDir("codex-wrapper-manual");
  const statusPath = path.join(tempDir, "status.json");
  const historyDir = path.join(tempDir, "history");
  const child = spawn(
    NODE,
    [
      path.join("src", "node", "codex-wrapper.js"),
      "--codex-command",
      NODE,
      "--status-path",
      statusPath,
      "--history-dir",
      historyDir,
      "--capture-quiet-ms",
      "400",
      "--no-start-capture",
      "--no-idle-capture",
      "--",
      path.join("tests", "mock-codex.js"),
    ],
    { cwd: ROOT, env: TEST_ENV, stdio: ["pipe", "pipe", "pipe"] },
  );

  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });

  await wait(500);
  child.stdin.write(":usage\r");
  await waitForFile(statusPath);
  child.stdin.write("exit\r");
  await wait(300);
  child.kill();

  const status = readJson(statusPath);
  assert.strictEqual(status.parse_status, "ok");
  assert.strictEqual(status.limits.find((limit) => limit.type === "five_hour").remaining_percent, 71);
  assert.strictEqual(status.limits.find((limit) => limit.type === "weekly").remaining_percent, 84);
  assert.match(stdout, /captured status \(manual\)/);
}

async function testStartupCaptureWrapper() {
  const tempDir = makeTempDir("codex-wrapper-startup");
  const statusPath = path.join(tempDir, "status.json");
  const historyDir = path.join(tempDir, "history");
  const child = spawn(
    NODE,
    [
      path.join("src", "node", "codex-wrapper.js"),
      "--codex-command",
      NODE,
      "--status-path",
      statusPath,
      "--history-dir",
      historyDir,
      "--capture-quiet-ms",
      "400",
      "--start-capture-delay-ms",
      "700",
      "--no-idle-capture",
      "--no-after-output-capture",
      "--",
      path.join("tests", "mock-codex.js"),
    ],
    { cwd: ROOT, env: TEST_ENV, stdio: ["pipe", "pipe", "pipe"] },
  );

  await waitForFile(statusPath);
  child.stdin.write("exit\r");
  await wait(300);
  child.kill();

  const status = readJson(statusPath);
  assert.strictEqual(status.parse_status, "ok");
  assert.strictEqual(status.limits.find((limit) => limit.type === "five_hour").remaining_percent, 71);
}

async function testIdleCaptureWrapper() {
  const tempDir = makeTempDir("codex-wrapper-idle");
  const statusPath = path.join(tempDir, "status.json");
  const historyDir = path.join(tempDir, "history");
  const child = spawn(
    NODE,
    [
      path.join("src", "node", "codex-wrapper.js"),
      "--codex-command",
      NODE,
      "--status-path",
      statusPath,
      "--history-dir",
      historyDir,
      "--capture-quiet-ms",
      "400",
      "--idle-capture-ms",
      "800",
      "--auto-capture-min-ms",
      "100",
      "--no-start-capture",
      "--no-after-output-capture",
      "--",
      path.join("tests", "mock-codex.js"),
    ],
    { cwd: ROOT, env: TEST_ENV, stdio: ["pipe", "pipe", "pipe"] },
  );

  await waitForFile(statusPath);
  child.stdin.write("exit\r");
  await wait(300);
  child.kill();

  const status = readJson(statusPath);
  assert.strictEqual(status.parse_status, "ok");
  assert.strictEqual(status.limits.find((limit) => limit.type === "weekly").remaining_percent, 84);
}

async function testDashboardReadsWrapperStatus() {
  const tempDir = makeTempDir("codex-dashboard");
  const statusPath = path.join(tempDir, "status.json");
  const sessionsDir = path.join(tempDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  fs.writeFileSync(
    statusPath,
    `${JSON.stringify({
      schema_version: 1,
      captured_at: "2026-07-08T13:42:10+09:00",
      source: "codex_cli_status",
      capture_method: "test",
      parse_status: "ok",
      limits: [
        { type: "five_hour", remaining_percent: 71, reset_text: "resets in 2h 18m" },
        { type: "weekly", remaining_percent: 84, reset_text: "resets in 3d 4h" },
      ],
      raw_status_text: "5-hour remaining: 71%\nWeekly remaining: 84%",
    })}\n`,
    "utf8",
  );

  const port = 8781;
  const server = spawn(
    "python",
    [
      path.join("src", "python", "codex_status_dashboard.py"),
      "--serve",
      "--status-path",
      statusPath,
      "--sessions-dir",
      sessionsDir,
      "--no-auto-status-poll",
      "--port",
      String(port),
      "--refresh-seconds",
      "1",
    ],
    { cwd: ROOT, env: TEST_ENV, stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await wait(1000);
    const response = await httpGet(`http://127.0.0.1:${port}/`);
    assert.strictEqual(response.statusCode, 200);
    assert.match(response.body, /71%/);
    assert.match(response.body, /84%/);
  } finally {
    server.kill();
  }
}

async function testHeadlessStatusPoller() {
  const tempDir = makeTempDir("codex-status-poller");
  const statusPath = path.join(tempDir, "status.json");
  const historyDir = path.join(tempDir, "history");
  const child = spawn(
    NODE,
    [
      path.join("src", "node", "codex-status-poller.js"),
      "--codex-command",
      NODE,
      "--status-path",
      statusPath,
      "--history-dir",
      historyDir,
      "--startup-delay-ms",
      "300",
      "--capture-quiet-ms",
      "300",
      "--poll-interval-ms",
      "1500",
      "--",
      path.join("tests", "mock-codex.js"),
    ],
    { cwd: ROOT, env: TEST_ENV, stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    const status = await waitForJson(statusPath, (value) => value.parse_status === "ok", 20000);
    assert.strictEqual(status.parse_status, "ok");
    assert.strictEqual(status.capture_method, "codex_status_poller");
    assert.strictEqual(status.limits.find((limit) => limit.type === "five_hour").remaining_percent, 71);

    // 별개 세션과 무관하게 poll 주기로 다시 캡처되는지 확인 (파일이 새로 갱신됨).
    fs.unlinkSync(statusPath);
    const polled = await waitForJson(statusPath, (value) => value.parse_status === "ok", 10000);
    assert.strictEqual(polled.limits.find((limit) => limit.type === "weekly").remaining_percent, 84);

    await waitForJson(statusPath, () => readHistoryCount(historyDir) >= 3, 15000);
    assert.ok(readHistoryCount(historyDir) >= 3, "poller must keep capturing on its interval");
  } finally {
    child.kill();
  }
}

async function testCodexPollerAddsFastServiceTierForCodexCommand() {
  const { buildCodexArgs, parseArgs } = require(path.join(ROOT, "src", "node", "codex-status-poller.js"));
  const codexOptions = parseArgs(["--codex-command", "codex.exe"]);
  assert.deepStrictEqual(
    buildCodexArgs(codexOptions).slice(0, 3),
    ["-c", 'service_tier="fast"', "--no-alt-screen"],
  );

  const nodeOptions = parseArgs(["--codex-command", NODE, "--", path.join("tests", "mock-codex.js")]);
  assert.deepStrictEqual(buildCodexArgs(nodeOptions), [path.join("tests", "mock-codex.js")]);

  const customOptions = parseArgs(["--codex-command", "codex.exe", "--", "-c", 'service_tier="flex"']);
  assert.deepStrictEqual(buildCodexArgs(customOptions), ["--no-alt-screen", "-c", 'service_tier="flex"']);
}

async function testClaudeUsageDeduplicatesMessageIds() {
  const tempDir = makeTempDir("claude-usage-dedup");
  const fixturePath = path.join(tempDir, "session.jsonl");
  const records = [
    {
      type: "assistant",
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        id: "msg-1",
        model: "claude-sonnet-test",
        usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 40 },
      },
    },
    {
      type: "assistant",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        id: "msg-1",
        model: "claude-sonnet-test",
        usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 40 },
      },
    },
    {
      type: "assistant",
      timestamp: "2026-01-01T00:00:02Z",
      message: {
        id: "msg-2",
        model: "claude-sonnet-test",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  ];
  fs.writeFileSync(fixturePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

  const script = [
    "from pathlib import Path",
    "import claude_usage_report as c",
    `result = c.compute_file_usage(Path(${JSON.stringify(fixturePath)}))`,
    "total = c.sum_totals(result)",
    "assert total.input_tokens == 110, total.input_tokens",
    "assert total.cache_read_input_tokens == 20, total.cache_read_input_tokens",
    "assert total.cache_creation_input_tokens == 30, total.cache_creation_input_tokens",
    "assert total.output_tokens == 45, total.output_tokens",
    "assert total.total_tokens == 205, total.total_tokens",
    "assert total.events == 2, total.events",
  ].join("\n");
  await run("python", ["-c", script]);
}

async function testClaudeUsageFieldsModelsAndSubagents() {
  const tempDir = makeTempDir("claude-usage-fields");
  const sessionsDir = path.join(tempDir, "projects", "proj");
  const subagentsDir = path.join(sessionsDir, "subagents");
  fs.mkdirSync(subagentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, "main.jsonl"),
    [
      {
        type: "assistant",
        timestamp: "2026-02-01T00:00:00Z",
        message: {
          id: "main-1",
          model: "claude-opus-test",
          usage: { input_tokens: 7, cache_creation_input_tokens: 11, output_tokens: 13 },
        },
      },
      {
        type: "assistant",
        timestamp: "2026-02-01T00:01:00Z",
        message: {
          id: "main-2",
          model: "<synthetic>",
          usage: { input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 5 },
        },
      },
    ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(subagentsDir, "agent.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-02-01T00:02:00Z",
      message: {
        id: "agent-1",
        model: "claude-subagent-test",
        usage: { input_tokens: 17, output_tokens: 19 },
      },
    })}\n`,
    "utf8",
  );

  const script = [
    "from pathlib import Path",
    "import claude_usage_report as c",
    `aggregate = c.aggregate_usage(Path(${JSON.stringify(path.join(tempDir, "projects"))}), {})`,
    "html = c.render_report_body(aggregate, Path('fixture'))",
    "total = c.sum_totals(aggregate)",
    "assert total.input_tokens == 26, total.input_tokens",
    "assert total.cache_creation_input_tokens == 11, total.cache_creation_input_tokens",
    "assert total.cache_read_input_tokens == 3, total.cache_read_input_tokens",
    "assert total.output_tokens == 37, total.output_tokens",
    "assert '&lt;synthetic&gt;' not in html, html",
    "assert 'Cache Write' in html, html",
    "assert 'claude-subagent-test' in html, html",
  ].join("\n");
  await run("python", ["-c", script]);
}

async function testUsageDatesUseKstMidnight() {
  const tempDir = makeTempDir("usage-kst-date");
  const claudePath = path.join(tempDir, "claude.jsonl");
  const codexPath = path.join(tempDir, "rollout-2026-02-01T15-00-00-kst.jsonl");
  fs.writeFileSync(
    claudePath,
    `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-02-01T15:00:00Z",
      message: {
        id: "kst-claude",
        model: "claude-kst-test",
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    })}\n`,
    "utf8",
  );
  fs.writeFileSync(
    codexPath,
    `${JSON.stringify({
      timestamp: "2026-02-01T15:00:00Z",
      payload: { model: "gpt-kst-test", info: { last_token_usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } },
    })}\n`,
    "utf8",
  );

  const script = [
    "from pathlib import Path",
    "import claude_usage_report as claude",
    "import codex_usage_report as codex",
    `claude_result = claude.compute_file_usage(Path(${JSON.stringify(claudePath)}))`,
    `codex_result = codex.compute_file_usage(Path(${JSON.stringify(codexPath)}))`,
    "assert ('2026-02-02', 'claude-kst-test') in claude_result, claude_result",
    "assert ('2026-02-02', 'gpt-kst-test') in codex_result, codex_result",
  ].join("\n");
  await run("python", ["-c", script]);
}

async function testCodexUsageUsesPersistentFileCache() {
  const tempDir = makeTempDir("codex-persistent-cache");
  const sessionsDir = path.join(tempDir, "sessions", "2026", "01", "01");
  const cachePath = path.join(tempDir, "codex-file-cache.json");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, "rollout-2026-01-01T00-00-00-cache.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-01-01T00:00:00Z",
      payload: { model: "gpt-cache-test", info: { last_token_usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } } },
    })}\n`,
    "utf8",
  );

  const script = [
    "from pathlib import Path",
    "import codex_usage_report as c",
    `sessions = Path(${JSON.stringify(path.join(tempDir, "sessions"))})`,
    `cache = Path(${JSON.stringify(cachePath)})`,
    "first = c.aggregate_usage(sessions, disk_cache_path=cache)",
    "assert cache.exists(), cache",
    "def fail_compute(path):",
    "    raise AssertionError('cache miss')",
    "c.compute_file_usage = fail_compute",
    "second = c.aggregate_usage(sessions, disk_cache_path=cache)",
    "total = c.sum_totals(second)",
    "assert total.total_tokens == 12, total.total_tokens",
    "assert first.keys() == second.keys(), (first, second)",
  ].join("\n");
  await run("python", ["-c", script]);
}

async function testCodexUsageSurvivesDiskCacheWriteFailure() {
  const tempDir = makeTempDir("codex-cache-write-failure");
  const sessionsDir = path.join(tempDir, "sessions", "2026", "01", "01");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, "rollout-2026-01-01T00-00-00-cache-fail.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-01-01T00:00:00Z",
      payload: { model: "gpt-cache-fail-test", info: { last_token_usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } },
    })}\n`,
    "utf8",
  );

  const script = [
    "from pathlib import Path",
    "import codex_usage_report as c",
    `sessions = Path(${JSON.stringify(path.join(tempDir, "sessions"))})`,
    "def fail_save(*args, **kwargs):",
    "    raise OSError('cache write failed')",
    "c.save_file_cache = fail_save",
    `aggregate = c.aggregate_usage(sessions, disk_cache_path=Path(${JSON.stringify(path.join(tempDir, "cache.json"))}))`,
    "total = c.sum_totals(aggregate)",
    "assert total.total_tokens == 5, total.total_tokens",
  ].join("\n");
  await run("python", ["-c", script]);
}

async function testStatusPollerRestartsUnhealthySession() {
  const tempDir = makeTempDir("codex-status-poller-unhealthy");
  const statusPath = path.join(tempDir, "status.json");
  const historyDir = path.join(tempDir, "history");
  const child = spawn(
    NODE,
    [
      path.join("src", "node", "codex-status-poller.js"),
      "--codex-command",
      NODE,
      "--status-path",
      statusPath,
      "--history-dir",
      historyDir,
      "--startup-delay-ms",
      "100",
      "--capture-quiet-ms",
      "100",
      "--poll-interval-ms",
      "500",
      "--respawn-backoff-ms",
      "300",
      "--failed-parse-retry-ms",
      "200",
      "--",
      path.join("tests", "mock-codex-fail-status.js"),
    ],
    { cwd: ROOT, env: TEST_ENV, stdio: ["ignore", "pipe", "pipe"] },
  );

  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });

  try {
    await waitForJson(statusPath, (value) => value.poller && value.poller.state === "retrying_session", 8000);
    assert.match(stdout, /restarting headless Codex session/);
    assert.strictEqual(child.exitCode, null);
  } finally {
    child.kill();
  }
}

async function testStatusPollerSurvivesBadCodexCommand() {
  const tempDir = makeTempDir("codex-status-poller-bad-command");
  const statusPath = path.join(tempDir, "status.json");
  const historyDir = path.join(tempDir, "history");
  const child = spawn(
    NODE,
    [
      path.join("src", "node", "codex-status-poller.js"),
      "--codex-command",
      "definitely-does-not-exist.exe",
      "--status-path",
      statusPath,
      "--history-dir",
      historyDir,
      "--startup-delay-ms",
      "200",
    ],
    { cwd: ROOT, env: TEST_ENV, stdio: ["ignore", "pipe", "pipe"] },
  );

  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });

  try {
    await wait(1000);
    assert.strictEqual(child.exitCode, null, "poller process must not crash on an unresolvable codex command");
    assert.match(stdout, /failed to start headless Codex session/);
  } finally {
    child.kill();
  }
}

async function testClaudeStatusHookWritesRemainingPercents() {
  const tempDir = makeTempDir("claude-status-hook");
  const statusPath = path.join(tempDir, "claude-status.json");
  const child = spawn(
    NODE,
    [path.join("src", "node", "claude-status-hook.js"), "--status-path", statusPath],
    { cwd: ROOT, env: TEST_ENV, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.end(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 29, resets_at: 1783503600 }, seven_day: { used_percentage: 66 } } }));
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`claude hook exited ${code}`))));
  });

  const status = readJson(statusPath);
  assert.strictEqual(status.parse_status, "ok");
  assert.strictEqual(status.source, "claude_statusline_hook");
  assert.strictEqual(status.limits.find((limit) => limit.type === "five_hour").used_percent, 29);
  assert.strictEqual(status.limits.find((limit) => limit.type === "five_hour").remaining_percent, 71);
  assert.strictEqual(status.limits.find((limit) => limit.type === "five_hour").reset_text, "resets 07/08 18:40");
  assert.strictEqual(status.limits.find((limit) => limit.type === "seven_day").used_percent, 66);
  assert.strictEqual(status.limits.find((limit) => limit.type === "seven_day").remaining_percent, 34);
}

async function testClaudeStatusHookAcceptsAlternatePercentFields() {
  const tempDir = makeTempDir("claude-status-hook-alias");
  const statusPath = path.join(tempDir, "claude-status.json");
  const child = spawn(
    NODE,
    [path.join("src", "node", "claude-status-hook.js"), "--status-path", statusPath],
    { cwd: ROOT, env: TEST_ENV, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.end(JSON.stringify({ rateLimits: { five_hour: { usedPercentage: 25 }, seven_day: { remaining_percentage: 88 } } }));
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`claude hook alias exited ${code}`))));
  });

  const status = readJson(statusPath);
  assert.strictEqual(status.parse_status, "ok");
  assert.strictEqual(status.limits.find((limit) => limit.type === "five_hour").used_percent, 25);
  assert.strictEqual(status.limits.find((limit) => limit.type === "five_hour").remaining_percent, 75);
  assert.strictEqual(status.limits.find((limit) => limit.type === "seven_day").used_percent, 12);
  assert.strictEqual(status.limits.find((limit) => limit.type === "seven_day").remaining_percent, 88);
}

async function testClaudeStatusHookSurvivesMalformedPayload() {
  const tempDir = makeTempDir("claude-status-hook-bad");
  const statusPath = path.join(tempDir, "claude-status.json");
  const child = spawn(
    NODE,
    [path.join("src", "node", "claude-status-hook.js"), "--status-path", statusPath],
    { cwd: ROOT, env: TEST_ENV, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stdin.end("{not-json");
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`claude hook bad exited ${code}`))));
  });

  const status = readJson(statusPath);
  assert.strictEqual(status.parse_status, "failed");
  assert.deepStrictEqual(status.limits, []);
  assert.match(stdout, /N\/A/);
}

async function testClaudeStatusHookPreservesFreshUsageCommandStatus() {
  const tempDir = makeTempDir("claude-status-hook-preserve-usage");
  const statusPath = path.join(tempDir, "claude-status.json");
  fs.writeFileSync(
    statusPath,
    `${JSON.stringify({
      schema_version: 1,
      captured_at: new Date().toISOString(),
      source: "claude_usage_command",
      capture_method: "claude_usage_command",
      parse_status: "ok",
      limits: [{ type: "five_hour", used_percent: 10, remaining_percent: 90, reset_text: "resets 07/09 18:30" }],
      poller: { state: "captured_ok", heartbeat_at: new Date().toISOString(), poll_interval_ms: 180000 },
    })}\n`,
    "utf8",
  );

  const child = spawn(
    NODE,
    [path.join("src", "node", "claude-status-hook.js"), "--status-path", statusPath],
    { cwd: ROOT, env: TEST_ENV, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.end(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 29 } } }));
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`claude hook preserve exited ${code}`))));
  });

  const status = readJson(statusPath);
  assert.strictEqual(status.capture_method, "claude_usage_command");
  assert.strictEqual(status.limits.find((limit) => limit.type === "five_hour").remaining_percent, 90);
}

async function testClaudeUsagePollerParsesUsageCommand() {
  const { buildStatus } = require(path.join(ROOT, "src", "node", "claude-usage-poller.js"));
  const rawText = [
    "You are currently using your subscription to power your Claude Code usage",
    "",
    "Current session: 19% used · resets Jul 9, 6:29pm (Asia/Seoul)",
    "Current week (all models): 43% used · resets Jul 14, 9am (Asia/Seoul)",
    "Current week (Fable): 0% used",
  ].join("\n");

  const status = buildStatus(rawText);
  const session = status.limits.find((limit) => limit.type === "five_hour");
  const week = status.limits.find((limit) => limit.type === "seven_day");
  assert.strictEqual(status.parse_status, "ok");
  assert.strictEqual(status.capture_method, "claude_usage_command");
  assert.strictEqual(session.used_percent, 19);
  assert.strictEqual(session.remaining_percent, 81);
  assert.strictEqual(session.reset_text, "resets 07/09 18:29");
  assert.strictEqual(week.used_percent, 43);
  assert.strictEqual(week.remaining_percent, 57);
  assert.strictEqual(week.reset_text, "resets 07/14 09:00");
}

function testElectronIconConfiguration() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const iconPath = "assets/codex-claude-usage.ico";

  assert.ok(packageJson.build.files.includes("assets/**/*"));
  assert.strictEqual(packageJson.build.win.icon, iconPath);
  assert.strictEqual(packageJson.build.nsis.installerIcon, iconPath);
  assert.strictEqual(packageJson.build.nsis.uninstallerIcon, iconPath);
  assert.ok(fs.existsSync(path.join(ROOT, iconPath)));
}

function testElectronReleaseConfiguration() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const publish = packageJson.build.publish[0];

  assert.ok(packageJson.dependencies["electron-updater"]);
  assert.strictEqual(packageJson.repository.url, "https://github.com/Kyuhan1230/ai-usage-monitor.git");
  assert.strictEqual(packageJson.build.artifactName, "Codex-Claude-Usage-Setup-${version}.${ext}");
  assert.strictEqual(publish.provider, "github");
  assert.strictEqual(publish.owner, "Kyuhan1230");
  assert.strictEqual(publish.repo, "ai-usage-monitor");
  assert.strictEqual(publish.releaseType, "draft");
  assert.strictEqual(packageJson.build.asar, true);
  assert.ok(packageJson.build.asarUnpack.includes("runtime/**/*"));
  assert.ok(packageJson.build.asarUnpack.includes("src/python/**/*"));
  assert.ok(packageJson.build.files.includes("runtime/**/*"));
  assert.ok(packageJson.build.files.includes("LICENSE"));
  assert.ok(packageJson.build.files.includes("THIRD_PARTY_NOTICES.md"));
  assert.match(packageJson.scripts["prepare:runtime"], /prepare-python-runtime\.ps1/);
  assert.match(packageJson.scripts.dist, /prepare:runtime/);
  assert.ok(fs.existsSync(path.join(ROOT, "scripts", "prepare-python-runtime.ps1")));
  assert.ok(fs.existsSync(path.join(ROOT, ".github", "workflows", "ci.yml")));
  assert.ok(fs.existsSync(path.join(ROOT, ".github", "workflows", "release.yml")));
  assert.ok(fs.existsSync(path.join(ROOT, "docs", "CODE_SIGNING_POLICY.md")));
  assert.ok(fs.existsSync(path.join(ROOT, "docs", "PRIVACY.md")));
}

function testDashboardRuntimePrefersBundledPython() {
  const { resolveDashboardRuntime } = require(path.join(ROOT, "src", "electron", "dashboard-runtime.js"));
  const root = path.join("C:\\", "app", "resources", "app");
  const bundledPath = path.join(root, "runtime", "python", "python.exe");

  const bundled = resolveDashboardRuntime({
    root,
    isPackaged: true,
    platform: "win32",
    commandExists: () => false,
    fileExists: (candidate) => candidate === bundledPath,
  });
  assert.strictEqual(bundled.command, bundledPath);
  assert.deepStrictEqual(bundled.entryArgs, ["-m", "uvicorn"]);
  assert.strictEqual(bundled.bundled, true);

  const fallback = resolveDashboardRuntime({
    root,
    isPackaged: false,
    platform: "win32",
    commandExists: (candidate) => candidate === "python.exe",
    fileExists: () => false,
  });
  assert.strictEqual(fallback.command, "python.exe");
  assert.deepStrictEqual(fallback.entryArgs, ["-m", "uvicorn"]);
  assert.strictEqual(fallback.bundled, false);
}

async function testElectronUpdaterPromptsAndInstalls() {
  class MockUpdater extends EventEmitter {
    constructor() {
      super();
      this.checkCount = 0;
      this.downloadCount = 0;
      this.installCount = 0;
    }

    async checkForUpdates() {
      this.checkCount += 1;
    }

    async downloadUpdate() {
      this.downloadCount += 1;
    }

    quitAndInstall() {
      this.installCount += 1;
    }
  }

  const updater = new MockUpdater();
  const messages = [];
  const fakeWindow = { isDestroyed: () => false };
  const dialog = {
    showMessageBox: async (...args) => {
      messages.push(args.length === 2 ? args[1] : args[0]);
      return { response: 0 };
    },
  };
  const inertTimer = () => ({ unref() {} });
  const { createUpdaterController } = require(path.join(ROOT, "src", "electron", "updater.js"));
  const controller = createUpdaterController({
    app: { isPackaged: true, getVersion: () => "0.1.0" },
    autoUpdater: updater,
    dialog,
    getWindow: () => fakeWindow,
    logger: { error() {} },
    platform: "win32",
    setTimeoutFn: inertTimer,
    setIntervalFn: inertTimer,
  });

  assert.strictEqual(controller.start(), true);
  assert.strictEqual(updater.autoDownload, false);
  assert.strictEqual(updater.autoInstallOnAppQuit, true);
  assert.strictEqual(await controller.check(true), true);
  assert.strictEqual(updater.checkCount, 1);

  updater.emit("update-available", { version: "0.2.0" });
  await wait(0);
  assert.strictEqual(updater.downloadCount, 1);
  assert.match(messages[0].message, /0\.2\.0/);

  updater.emit("update-downloaded", { version: "0.2.0" });
  await wait(0);
  assert.strictEqual(updater.installCount, 1);
  assert.match(messages[1].message, /0\.2\.0/);
}

function testElectronLaunchAtLoginPreferencePersists() {
  const tempDir = makeTempDir("electron-preferences");
  const preferencesPath = path.join(tempDir, "preferences.json");
  const {
    getLaunchAtLoginPreference,
    readPreferences,
    setLaunchAtLoginPreference,
  } = require(path.join(ROOT, "src", "electron", "app-preferences.js"));

  assert.strictEqual(getLaunchAtLoginPreference(preferencesPath), false);
  assert.strictEqual(setLaunchAtLoginPreference(preferencesPath, true), true);
  assert.strictEqual(getLaunchAtLoginPreference(preferencesPath), true);
  assert.strictEqual(setLaunchAtLoginPreference(preferencesPath, false), false);
  assert.strictEqual(getLaunchAtLoginPreference(preferencesPath), false);
  assert.deepStrictEqual(readPreferences(preferencesPath), { launchAtLogin: false });
}

async function testElectronClaudeHookPreservesAndBacksUpExistingCommand() {
  const tempDir = makeTempDir("electron-claude-hook");
  const settingsPath = path.join(tempDir, "settings.json");
  const originalSettings = {
    statusLine: { type: "command", command: "node existing-statusline.js" },
    theme: "dark",
  };
  fs.writeFileSync(settingsPath, `${JSON.stringify(originalSettings, null, 2)}\n`, "utf8");
  const { installClaudeHookSettings } = require(path.join(
    ROOT,
    "src",
    "electron",
    "claude-hook-settings.js",
  ));

  const preserved = await installClaudeHookSettings({
    settingsPath,
    command: '"app.exe" --claude-status-hook',
    confirmReplace: async () => false,
  });
  assert.strictEqual(preserved.status, "preserved");
  assert.deepStrictEqual(readJson(settingsPath), originalSettings);

  const installed = await installClaudeHookSettings({
    settingsPath,
    command: '"app.exe" --claude-status-hook',
    confirmReplace: async () => true,
    now: new Date("2026-07-16T00:00:00.000Z"),
  });
  assert.strictEqual(installed.status, "installed");
  assert.ok(installed.backupPath);
  assert.deepStrictEqual(readJson(installed.backupPath), originalSettings);
  const updated = readJson(settingsPath);
  assert.strictEqual(updated.theme, "dark");
  assert.strictEqual(updated.statusLine.command, '"app.exe" --claude-status-hook');
}

function testCompactStatusHealthUsesPollIntervalAndPollerState() {
  const { isFresh, stateText } = require(path.join(
    ROOT,
    "src",
    "electron",
    "renderer",
    "status-health.js",
  ));

  assert.strictEqual(isFresh(120000, 60000), true);
  assert.strictEqual(isFresh(240000, 60000), false);
  assert.strictEqual(stateText({
    connected: true,
    ageMs: 30000,
    staleText: "지연",
    pollerState: "parse_failed_retrying",
    pollIntervalMs: 60000,
  }), "재시도");
  assert.strictEqual(stateText({
    connected: true,
    ageMs: 240000,
    staleText: "지연",
    pollerState: "waiting_next_poll",
    pollIntervalMs: 60000,
  }), "지연");
}

async function testClaudeUsageCaptureAsyncWaitsForStatusWrite() {
  const tempDir = makeTempDir("claude-usage-capture-async");
  const statusPath = path.join(tempDir, "claude-status.json");
  const { captureOnceAsync } = require(path.join(ROOT, "src", "node", "claude-usage-poller.js"));

  await captureOnceAsync({
    statusPath,
    claudeCommand: path.join(tempDir, "missing-claude-command"),
    pollIntervalMs: 60000,
    timeoutMs: 1000,
  });

  const status = readJson(statusPath);
  assert.strictEqual(status.parse_status, "failed");
  assert.strictEqual(status.poller.state, "capture_failed");
  assert.ok(status.poller.heartbeat_at);
}

async function testClaudeUsagePollerAcceptsSubscriptionSummary() {
  const { buildStatus } = require(path.join(ROOT, "src", "node", "claude-usage-poller.js"));
  const rawText = [
    "You are currently using your subscription to power your Claude Code usage",
    "",
    "What's contributing to your limits usage?",
    "Approximate, based on local sessions on this machine - does not include other devices or claude.ai.",
    "",
    "Last 24h - 242 requests - 16 sessions",
    "  75% of your usage was at >150k context",
    "",
    "Last 7d - 1991 requests - 42 sessions",
    "  82% of your usage was at >150k context",
  ].join("\n");

  const status = buildStatus(rawText);
  assert.strictEqual(status.parse_status, "ok");
  assert.strictEqual(status.summary_status, "subscription_usage_summary");
  assert.deepStrictEqual(status.limits, []);
  assert.deepStrictEqual(status.usage_windows, [
    { window: "24h", requests: 242, sessions: 16 },
    { window: "7d", requests: 1991, sessions: 42 },
  ]);
}

async function testClaudeUsagePollerPreservesLimitsOnSummaryOnly() {
  const tempDir = makeTempDir("claude-summary-preserve-limits");
  const statusPath = path.join(tempDir, "claude-status.json");
  fs.writeFileSync(
    statusPath,
    `${JSON.stringify({
      captured_at: "2026-07-10T10:00:00+09:00",
      parse_status: "ok",
      limits: [
        { type: "five_hour", used_percent: 40, remaining_percent: 60, reset_text: "resets 07/10 18:00" },
        { type: "seven_day", used_percent: 10, remaining_percent: 90, reset_text: "resets 07/14 09:00" },
      ],
    })}\n`,
    "utf8",
  );
  const { buildStatus, mergePreviousLimits } = require(path.join(ROOT, "src", "node", "claude-usage-poller.js"));
  const rawText = [
    "You are currently using your subscription to power your Claude Code usage",
    "",
    "Last 24h - 242 requests - 16 sessions",
    "Last 7d - 1991 requests - 42 sessions",
  ].join("\n");

  const status = mergePreviousLimits(statusPath, buildStatus(rawText));
  assert.strictEqual(status.parse_status, "ok");
  assert.strictEqual(status.limits.find((limit) => limit.type === "five_hour").remaining_percent, 60);
  assert.strictEqual(status.limits.find((limit) => limit.type === "seven_day").remaining_percent, 90);
  assert.strictEqual(status.limits_preserved_from, "2026-07-10T10:00:00+09:00");
}

async function testClaudeStatusHookInstallDoesNotOverwriteExistingCommand() {
  const tempDir = makeTempDir("claude-status-hook-install");
  const settingsPath = path.join(tempDir, "settings.json");
  const existingSettings = {
    statusLine: {
      type: "command",
      command: "node existing-statusline.js",
    },
  };
  fs.writeFileSync(settingsPath, `${JSON.stringify(existingSettings, null, 2)}\n`, "utf8");

  const result = await run(
    NODE,
    [path.join("src", "node", "claude-status-hook.js"), "--install", "--settings-path", settingsPath],
    { capture: true },
  );
  const settings = readJson(settingsPath);
  assert.deepStrictEqual(settings, existingSettings);
  assert.match(result.stdout, /Existing statusLine\.command found/);
}

async function testClaudeStatusHookInstallReplacesLegacyAppCommand() {
  const tempDir = makeTempDir("claude-status-hook-install-legacy");
  const settingsPath = path.join(tempDir, "settings.json");
  fs.writeFileSync(
    settingsPath,
    `${JSON.stringify({
      statusLine: {
        type: "command",
        command: '"C:\\Users\\me\\AppData\\Local\\Programs\\Codex Claude Usage\\Codex Claude Usage.exe" --claude-status-hook',
      },
    }, null, 2)}\n`,
    "utf8",
  );

  await run(
    NODE,
    [path.join("src", "node", "claude-status-hook.js"), "--install", "--settings-path", settingsPath],
    { capture: true },
  );
  const settings = readJson(settingsPath);
  assert.match(settings.statusLine.command, /node ".*claude-status-hook\.js"/);
}

async function testDashboardRingsUseRemainingThresholds() {
  const script = [
    "import codex_status_dashboard as d",
    "critical = d.render_limit_ring('Critical', {'remaining_percent': 10})",
    "warn = d.render_limit_ring('Warn', {'remaining_percent': 50})",
    "ok = d.render_limit_ring('Ok', {'remaining_percent': 51})",
    "with_used = d.render_limit_ring('Claude', {'remaining_percent': 34, 'used_percent': 66, 'reset_text': 'resets test'}, True)",
    "assert 'ring-critical' in critical, critical",
    "assert 'ring-warn' in warn, warn",
    "assert 'ring-ok' in ok, ok",
    "assert '34%' in with_used, with_used",
    "assert 'ring-detail' in with_used, with_used",
    "assert '사용 66%' in with_used, with_used",
    "assert 'resets test' in with_used, with_used",
    "assert d.normalize_reset_text('resets 2026-07-09 18:40 KST') == 'resets 07/09 18:40'",
    "assert d.normalize_reset_text('resets 16:06 on 14 Jul') == 'resets 07/14 16:06'",
  ].join("\n");
  await run("python", ["-c", script]);
}

async function testMergedDashboardShowsUsageAndStatus() {
  const tempDir = makeTempDir("codex-merged-dashboard");
  const statusPath = path.join(tempDir, "status.json");
  const claudeStatusPath = path.join(tempDir, "claude-status.json");
  const sessionsDir = path.join(tempDir, "sessions", "2026", "01", "01");
  const claudeSessionsDir = path.join(tempDir, "claude-projects", "proj");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(claudeSessionsDir, { recursive: true });

  fs.writeFileSync(
    statusPath,
    `${JSON.stringify({
      schema_version: 1,
      captured_at: "2026-07-08T13:42:10+09:00",
      source: "codex_cli_status",
      capture_method: "test",
      parse_status: "ok",
      limits: [{ type: "five_hour", remaining_percent: 62, reset_text: "resets in 1h 5m" }],
      raw_status_text: "5-hour remaining: 62%",
    })}\n`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(sessionsDir, "rollout-2026-01-01T00-00-00-merged-test.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-01-01T00:00:00Z",
      payload: { model: "gpt-5.4-merged-test", info: { last_token_usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 } } },
    })}\n`,
    "utf8",
  );

  fs.writeFileSync(
    claudeStatusPath,
    `${JSON.stringify({
      schema_version: 1,
      captured_at: "2026-07-08T13:42:10+09:00",
      source: "claude_statusline_hook",
      capture_method: "test",
      parse_status: "ok",
      limits: [
        { type: "five_hour", used_percent: 29, remaining_percent: 71, reset_text: null },
        { type: "seven_day", used_percent: 66, remaining_percent: 34, reset_text: null },
      ],
      raw_status_text: "{}",
    })}\n`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(claudeSessionsDir, "claude-session.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-01-01T00:00:00Z",
      message: {
        id: "claude-merged-1",
        model: "claude-merged-test",
        usage: { input_tokens: 21, cache_creation_input_tokens: 8, output_tokens: 13 },
      },
    })}\n`,
    "utf8",
  );

  const port = 8782;
  const server = spawn(
    "python",
    [
      path.join("src", "python", "codex_status_dashboard.py"),
      "--serve",
      "--status-path",
      statusPath,
      "--sessions-dir",
      path.join(tempDir, "sessions"),
      "--claude-sessions-dir",
      path.join(tempDir, "claude-projects"),
      "--claude-status-path",
      claudeStatusPath,
      "--no-auto-status-poll",
      "--port",
      String(port),
      "--refresh-seconds",
      "1",
    ],
    { cwd: ROOT, env: TEST_ENV, stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await wait(1000);
    const response = await httpGet(`http://127.0.0.1:${port}/`);
    assert.strictEqual(response.statusCode, 200);
    assert.match(response.body, /Codex, Claude Usage Dashboard/);
    assert.match(response.body, /theme-toggle/);
    assert.match(response.body, /dashboard-note/);
    assert.match(response.body, /62%/);
    assert.match(response.body, /날짜별 요약/);
    assert.match(response.body, /오늘 모델별 사용량/);
    assert.match(response.body, /Total Tokens/);
    assert.match(response.body, /Cached Input/);
    assert.match(response.body, /gpt-5\.4-merged-test/);
    assert.match(response.body, /Claude 사용량/);
    assert.match(response.body, /tool-grid/);
    assert.match(response.body, /tool-panel-codex/);
    assert.match(response.body, /tool-panel-claude/);
    assert.match(response.body, /Current week/);
    assert.match(response.body, /34%/);
    assert.match(response.body, /사용 66%/);
    assert.match(response.body, /claude-merged-test/);
    assert.match(response.body, /Cache Write/);
    assert.match(response.body, /data-tip="모델에 전달된 입력 토큰입니다/);
    assert.match(response.body, /floating-tooltip/);
    assert.ok(response.body.includes('fetch("/fragment"'));
    assert.doesNotMatch(response.body, /http-equiv="refresh"/i);
    assert.doesNotMatch(response.body, /location\\.reload/);
    assert.match(response.body, /poll-dot off/);
    assert.match(response.body, /자동 폴링 꺼짐/);
  } finally {
    server.kill();
  }
}

function sendAndAbortRequest(port, requestPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
      socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n`);
      // 응답을 읽지 않고 바로 연결을 끊어서, 서버가 헤더/본문을 쓰는 도중
      // 클라이언트가 먼저 연결을 끊는 상황(탭 이동, 새로고침 등)을 재현한다.
      setImmediate(() => {
        socket.destroy();
        resolve();
      });
    });
    socket.on("error", () => resolve());
  });
}

async function testDashboardSurvivesClientDisconnect() {
  const tempDir = makeTempDir("codex-dashboard-disconnect");
  const statusPath = path.join(tempDir, "status.json");
  const sessionsDir = path.join(tempDir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  fs.writeFileSync(
    statusPath,
    `${JSON.stringify({
      schema_version: 1,
      captured_at: "2026-07-08T13:42:10+09:00",
      source: "codex_cli_status",
      capture_method: "test",
      parse_status: "ok",
      limits: [{ type: "five_hour", remaining_percent: 50, reset_text: "resets in 1h" }],
      raw_status_text: "5-hour remaining: 50%",
    })}\n`,
    "utf8",
  );

  const port = 8783;
  const server = spawn(
    "python",
    [
      path.join("src", "python", "codex_status_dashboard.py"),
      "--serve",
      "--status-path",
      statusPath,
      "--sessions-dir",
      sessionsDir,
      "--no-auto-status-poll",
      "--port",
      String(port),
      "--refresh-seconds",
      "1",
    ],
    { cwd: ROOT, env: TEST_ENV, stdio: ["ignore", "pipe", "pipe"] },
  );

  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  server.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await wait(1000);

    for (let i = 0; i < 20; i += 1) {
      await sendAndAbortRequest(port, i % 3 === 0 ? "/status.json" : i % 3 === 1 ? "/fragment" : "/");
    }
    await wait(500);

    assert.doesNotMatch(stderr, /Traceback/);
    assert.doesNotMatch(stdout, /Traceback/);

    // 연결이 끊긴 요청들 뒤에도 서버가 여전히 살아서 정상 응답하는지 확인한다.
    const response = await httpGet(`http://127.0.0.1:${port}/status.json`);
    assert.strictEqual(response.statusCode, 200);
    assert.match(response.body, /50%/);
  } finally {
    server.kill();
  }
}

async function testDashboardSurvivesMissingClaudeSessionsDir() {
  const tempDir = makeTempDir("codex-dashboard-no-claude");
  const statusPath = path.join(tempDir, "status.json");
  const sessionsDir = path.join(tempDir, "sessions", "2026", "01", "01");
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    statusPath,
    `${JSON.stringify({
      schema_version: 1,
      captured_at: "2026-07-08T13:42:10+09:00",
      source: "codex_cli_status",
      capture_method: "test",
      parse_status: "ok",
      limits: [{ type: "five_hour", remaining_percent: 62, reset_text: "resets in 1h" }],
      raw_status_text: "5-hour remaining: 62%",
    })}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(sessionsDir, "rollout-2026-01-01T00-00-00-codex.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-01-01T00:00:00Z",
      payload: { model: "gpt-codex-intact", info: { last_token_usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 } } },
    })}\n`,
    "utf8",
  );

  const port = 8784;
  const server = spawn(
    "python",
    [
      path.join("src", "python", "codex_status_dashboard.py"),
      "--serve",
      "--status-path",
      statusPath,
      "--sessions-dir",
      path.join(tempDir, "sessions"),
      "--claude-sessions-dir",
      path.join(tempDir, "does-not-exist"),
      "--claude-status-path",
      path.join(tempDir, "missing-claude-status.json"),
      "--no-auto-status-poll",
      "--port",
      String(port),
      "--refresh-seconds",
      "1",
    ],
    { cwd: ROOT, env: TEST_ENV, stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await wait(1000);
    const response = await httpGet(`http://127.0.0.1:${port}/`);
    assert.strictEqual(response.statusCode, 200);
    assert.match(response.body, /gpt-codex-intact/);
    assert.match(response.body, /Claude 사용량/);
    assert.match(response.body, /Claude statusLine hook이 아직 실행되지 않았습니다/);
    assert.match(response.body, /집계할 usage\/token 이벤트가 없습니다/);
  } finally {
    server.kill();
  }
}

async function testFastApiDashboardRendersWithClaudeArguments() {
  const script = [
    "import codex_dashboard_fastapi as app",
    "app.STATUS_PATH = app.Path('missing-status.json')",
    "app.CLAUDE_STATUS_PATH = app.Path('missing-claude-status.json')",
    "app.SESSIONS_DIR = app.Path('missing-codex-sessions')",
    "app.CLAUDE_SESSIONS_DIR = app.Path('missing-claude-sessions')",
    "html = app.index()",
    "fragment = app.fragment()",
    "assert 'id=\"dashboard-content\" class=\"is-loading\"' in html",
    "assert 'refresh();' in html",
    "assert 'is-loading' not in fragment",
    "assert 'Claude 사용량' in html",
    "assert 'Claude 사용량' in fragment",
  ].join("\n");
  await run("python", ["-c", script]);
}

async function main() {
  await run(NODE, ["--check", path.join("src", "node", "codex-wrapper.js")]);
  await run(NODE, ["--check", path.join("src", "node", "codex-status-poller.js")]);
  await run(NODE, ["--check", path.join("src", "node", "status-capture.js")]);
  await run(NODE, ["--check", path.join("src", "node", "claude-status-hook.js")]);
  await run(NODE, ["--check", path.join("src", "node", "claude-usage-poller.js")]);
  await run(NODE, ["--check", path.join("src", "electron", "main.js")]);
  await run(NODE, ["--check", path.join("src", "electron", "app-preferences.js")]);
  await run(NODE, ["--check", path.join("src", "electron", "claude-hook-settings.js")]);
  await run(NODE, ["--check", path.join("src", "electron", "dashboard-runtime.js")]);
  await run(NODE, ["--check", path.join("src", "electron", "updater.js")]);
  await run(NODE, ["--check", path.join("src", "electron", "preload.js")]);
  await run(NODE, ["--check", path.join("src", "electron", "renderer", "compact.js")]);
  await run(NODE, ["--check", path.join("src", "electron", "renderer", "setup.js")]);
  await run("python", ["-m", "py_compile", path.join("src", "python", "codex_status_dashboard.py"), path.join("src", "python", "codex_usage_report.py"), path.join("src", "python", "claude_usage_report.py"), path.join("src", "python", "dashboard_common.py")]);
  await testParseRawStdin();
  await testDuplicateLimitsKeepFirstGeneralLimit();
  await testPollerParseFailurePreservesPreviousOkStatus();
  await testManualUsageWrapper();
  await testStartupCaptureWrapper();
  await testIdleCaptureWrapper();
  await testDashboardReadsWrapperStatus();
  await testHeadlessStatusPoller();
  await testCodexPollerAddsFastServiceTierForCodexCommand();
  await testStatusPollerRestartsUnhealthySession();
  await testStatusPollerSurvivesBadCodexCommand();
  await testClaudeUsageDeduplicatesMessageIds();
  await testClaudeUsageFieldsModelsAndSubagents();
  await testUsageDatesUseKstMidnight();
  await testCodexUsageUsesPersistentFileCache();
  await testCodexUsageSurvivesDiskCacheWriteFailure();
  await testClaudeStatusHookWritesRemainingPercents();
  await testClaudeStatusHookAcceptsAlternatePercentFields();
  await testClaudeStatusHookSurvivesMalformedPayload();
  await testClaudeStatusHookPreservesFreshUsageCommandStatus();
  await testClaudeUsagePollerParsesUsageCommand();
  testElectronIconConfiguration();
  testElectronReleaseConfiguration();
  testDashboardRuntimePrefersBundledPython();
  await testElectronUpdaterPromptsAndInstalls();
  testElectronLaunchAtLoginPreferencePersists();
  await testElectronClaudeHookPreservesAndBacksUpExistingCommand();
  const releaseVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
  await run(NODE, [path.join("scripts", "verify-release-tag.js"), `v${releaseVersion}`]);
  testCompactStatusHealthUsesPollIntervalAndPollerState();
  await testClaudeUsageCaptureAsyncWaitsForStatusWrite();
  await testClaudeUsagePollerAcceptsSubscriptionSummary();
  await testClaudeUsagePollerPreservesLimitsOnSummaryOnly();
  await testClaudeStatusHookInstallDoesNotOverwriteExistingCommand();
  await testClaudeStatusHookInstallReplacesLegacyAppCommand();
  await testDashboardRingsUseRemainingThresholds();
  await testMergedDashboardShowsUsageAndStatus();
  await testDashboardSurvivesClientDisconnect();
  await testDashboardSurvivesMissingClaudeSessionsDir();
  await testFastApiDashboardRendersWithClaudeArguments();
  process.stdout.write("all tests passed\n");
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
