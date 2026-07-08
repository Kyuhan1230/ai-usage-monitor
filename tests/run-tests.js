#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
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
      .on("error", reject);
  });
}

async function testParseRawStdin() {
  const tempDir = makeTempDir("codex-wrapper-parse");
  const statusPath = path.join(tempDir, "status.json");
  const historyDir = path.join(tempDir, "history");
  const child = spawn(
    NODE,
    [
      "codex-wrapper.js",
      "--parse-raw-stdin",
      "--status-path",
      statusPath,
      "--history-dir",
      historyDir,
    ],
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
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
      "codex-wrapper.js",
      "--parse-raw-stdin",
      "--status-path",
      statusPath,
      "--history-dir",
      historyDir,
    ],
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
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
  assert.strictEqual(weekly.reset_text, "resets 16:06 on 14 Jul");
}

async function testPollerParseFailurePreservesPreviousOkStatus() {
  const tempDir = makeTempDir("codex-wrapper-preserve-ok");
  const statusPath = path.join(tempDir, "status.json");
  const historyDir = path.join(tempDir, "history");
  const { writeStatusPreservingPrevious } = require(path.join(ROOT, "status-capture"));

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
      "codex-wrapper.js",
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
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
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
      "codex-wrapper.js",
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
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
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
      "codex-wrapper.js",
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
    { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] },
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
      "codex_status_dashboard.py",
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
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
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
      "codex-status-poller.js",
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
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    const status = await waitForJson(statusPath, (value) => value.parse_status === "ok");
    assert.strictEqual(status.parse_status, "ok");
    assert.strictEqual(status.capture_method, "codex_status_poller");
    assert.strictEqual(status.limits.find((limit) => limit.type === "five_hour").remaining_percent, 71);

    // 별개 세션과 무관하게 poll 주기로 다시 캡처되는지 확인 (파일이 새로 갱신됨).
    fs.unlinkSync(statusPath);
    const polled = await waitForJson(statusPath, (value) => value.parse_status === "ok", 5000);
    assert.strictEqual(polled.limits.find((limit) => limit.type === "weekly").remaining_percent, 84);

    await waitForJson(statusPath, () => readHistoryCount(historyDir) >= 3, 8000);
    assert.ok(readHistoryCount(historyDir) >= 3, "poller must keep capturing on its interval");
  } finally {
    child.kill();
  }
}

async function testStatusPollerRestartsUnhealthySession() {
  const tempDir = makeTempDir("codex-status-poller-unhealthy");
  const statusPath = path.join(tempDir, "status.json");
  const historyDir = path.join(tempDir, "history");
  const child = spawn(
    NODE,
    [
      "codex-status-poller.js",
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
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
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
      "codex-status-poller.js",
      "--codex-command",
      "definitely-does-not-exist.exe",
      "--status-path",
      statusPath,
      "--history-dir",
      historyDir,
      "--startup-delay-ms",
      "200",
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
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

async function testMergedDashboardShowsUsageAndStatus() {
  const tempDir = makeTempDir("codex-merged-dashboard");
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

  const port = 8782;
  const server = spawn(
    "python",
    [
      "codex_status_dashboard.py",
      "--serve",
      "--status-path",
      statusPath,
      "--sessions-dir",
      path.join(tempDir, "sessions"),
      "--no-auto-status-poll",
      "--port",
      String(port),
      "--refresh-seconds",
      "1",
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await wait(1000);
    const response = await httpGet(`http://127.0.0.1:${port}/`);
    assert.strictEqual(response.statusCode, 200);
    assert.match(response.body, /62%/);
    assert.match(response.body, /날짜별 요약/);
    assert.match(response.body, /오늘 모델별 사용량/);
    assert.match(response.body, /Total Tokens/);
    assert.match(response.body, /Cached Input/);
    assert.match(response.body, /gpt-5\.4-merged-test/);
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
      "codex_status_dashboard.py",
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
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
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

async function main() {
  await run(NODE, ["--check", "codex-wrapper.js"]);
  await run(NODE, ["--check", "codex-status-poller.js"]);
  await run(NODE, ["--check", "status-capture.js"]);
  await run("python", ["-m", "py_compile", "codex_status_dashboard.py", "codex_usage_report.py"]);
  await testParseRawStdin();
  await testDuplicateLimitsKeepFirstGeneralLimit();
  await testPollerParseFailurePreservesPreviousOkStatus();
  await testManualUsageWrapper();
  await testStartupCaptureWrapper();
  await testIdleCaptureWrapper();
  await testDashboardReadsWrapperStatus();
  await testHeadlessStatusPoller();
  await testStatusPollerRestartsUnhealthySession();
  await testStatusPollerSurvivesBadCodexCommand();
  await testMergedDashboardShowsUsageAndStatus();
  await testDashboardSurvivesClientDisconnect();
  process.stdout.write("all tests passed\n");
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
