#!/usr/bin/env node
"use strict";

const path = require("path");
const pty = require("node-pty");
const {
  STATUS_PATH,
  HISTORY_DIR,
  UNSAFE_PROMPT_PATTERNS,
  stripAnsi,
  writeStatusPreservingPrevious,
  writePollerHeartbeat,
  typeIntoTerminal,
} = require("./status-capture");

const DEFAULT_POLL_INTERVAL_MS = 3 * 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 4000;
const DEFAULT_CAPTURE_QUIET_MS = 1600;
const DEFAULT_MAX_CAPTURE_MS = 15 * 1000;
const DEFAULT_RESPAWN_BACKOFF_MS = 30 * 1000;
const MAX_RESPAWN_BACKOFF_MS = 5 * 60 * 1000;
const FAILED_PARSE_RETRY_MS = 10 * 1000;
const MAX_FAILED_PARSE_RETRIES = 3;
const WATCHDOG_CHECK_MS = 60 * 1000;
const OUTPUT_TAIL_LIMIT = 8000;
const CAPTURE_METHOD = "codex_status_poller";

function parseArgs(argv) {
  const options = {
    statusPath: STATUS_PATH,
    historyDir: HISTORY_DIR,
    codexCommand: process.platform === "win32" ? "codex.exe" : "codex",
    codexArgs: [],
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    startupDelayMs: DEFAULT_STARTUP_DELAY_MS,
    captureQuietMs: DEFAULT_CAPTURE_QUIET_MS,
    maxCaptureMs: DEFAULT_MAX_CAPTURE_MS,
    respawnBackoffMs: DEFAULT_RESPAWN_BACKOFF_MS,
    failedParseRetryMs: FAILED_PARSE_RETRY_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      options.codexArgs.push(...argv.slice(index + 1));
      break;
    }
    if (arg === "--status-path") {
      options.statusPath = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--history-dir") {
      options.historyDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--codex-command") {
      options.codexCommand = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--poll-interval-ms") {
      options.pollIntervalMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--startup-delay-ms") {
      options.startupDelayMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--capture-quiet-ms") {
      options.captureQuietMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--max-capture-ms") {
      options.maxCaptureMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--respawn-backoff-ms") {
      options.respawnBackoffMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--failed-parse-retry-ms") {
      options.failedParseRetryMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    options.codexArgs.push(arg);
  }

  return options;
}

function printHelp() {
  process.stdout.write(`Codex status poller (headless)

Runs its own hidden Codex CLI session in the background and periodically
captures /status output into status.json, independent of any interactive
session the user is driving.

Usage:
  node codex-status-poller.js [OPTIONS] -- [CODEX_ARGS]

Options:
  --status-path <path>        status.json path
  --history-dir <path>        history JSONL directory
  --codex-command <command>   Codex executable (default: codex${process.platform === "win32" ? ".exe" : ""})
  --poll-interval-ms <ms>     interval between /status captures (default: ${DEFAULT_POLL_INTERVAL_MS})
  --startup-delay-ms <ms>     delay before first /status after Codex starts (default: ${DEFAULT_STARTUP_DELAY_MS})
  --capture-quiet-ms <ms>     /status capture quiet window (default: ${DEFAULT_CAPTURE_QUIET_MS})
  --max-capture-ms <ms>       force-finish a stuck capture after this long (default: ${DEFAULT_MAX_CAPTURE_MS})
  --respawn-backoff-ms <ms>    delay before restarting a failed Codex session (default: ${DEFAULT_RESPAWN_BACKOFF_MS})
  --failed-parse-retry-ms <ms> delay between parse failure retries (default: ${FAILED_PARSE_RETRY_MS})
`);
}

function log(message) {
  process.stdout.write(`[status-poller] ${message}\n`);
}

function isOutputQuiet(lastOutputAt, requiredMs) {
  return Date.now() - lastOutputAt >= requiredMs;
}

function runSession(options, onSessionEnded, onCaptureSuccess) {
  writePollerHeartbeat(options.statusPath, "session_starting", "starting headless Codex session", {
    poll_interval_ms: options.pollIntervalMs,
  });

  const term = pty.spawn(options.codexCommand, options.codexArgs, {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd: process.cwd(),
    env: process.env,
  });

  let lastOutputAt = Date.now();
  let outputTail = "";
  let capture = null;
  let captureQuietTimer = null;
  let captureMaxTimer = null;
  let pollTimer = null;
  let watchdogTimer = null;
  let stopped = false;
  let failedParseRetries = 0;
  let lastSuccessfulCaptureAt = Date.now();

  function isUnsafePromptActive() {
    return UNSAFE_PROMPT_PATTERNS.some((pattern) => pattern.test(outputTail));
  }

  function clearCaptureTimers() {
    clearTimeout(captureQuietTimer);
    captureQuietTimer = null;
    clearTimeout(captureMaxTimer);
    captureMaxTimer = null;
  }

  function stopTimers() {
    clearTimeout(pollTimer);
    pollTimer = null;
    clearInterval(watchdogTimer);
    watchdogTimer = null;
    clearCaptureTimers();
  }

  function restartSession(detail) {
    if (stopped) {
      return;
    }
    stopped = true;
    stopTimers();
    writePollerHeartbeat(options.statusPath, "restarting_session", detail, {
      poll_interval_ms: options.pollIntervalMs,
    });
    log(`${detail}; restarting headless Codex session`);
    try {
      term.kill();
    } catch (error) {
      // session already gone
    }
  }

  function finishCapture(reason) {
    if (!capture) {
      return;
    }
    const rawStatusText = capture.buffer;
    capture = null;
    clearCaptureTimers();

    const status = writeStatusPreservingPrevious(options.statusPath, options.historyDir, rawStatusText, CAPTURE_METHOD);
    const limits = status.limits
      .filter((limit) => Number.isInteger(limit.remaining_percent))
      .map((limit) => `${limit.type} ${limit.remaining_percent}%`)
      .join(", ");
    log(`captured status (${reason}): ${limits || status.parse_status}`);

    if (status.parse_status === "ok") {
      failedParseRetries = 0;
      lastSuccessfulCaptureAt = Date.now();
      writePollerHeartbeat(options.statusPath, "captured_ok", reason, {
        poll_interval_ms: options.pollIntervalMs,
      });
      onCaptureSuccess();
      schedulePoll();
      return;
    }

    // /status가 입력창에만 찍히고 아직 실행되지 않았을 때(예: MCP 서버 초기화 직후)
    // 흔히 이렇게 실패한다. 다음 정기 poll까지 기다리지 않고 몇 번 더 빨리 재시도한다.
    if (failedParseRetries < MAX_FAILED_PARSE_RETRIES) {
      failedParseRetries += 1;
      writePollerHeartbeat(options.statusPath, "parse_failed_retrying", reason, {
        retry: failedParseRetries,
        max_retries: MAX_FAILED_PARSE_RETRIES,
        retry_ms: options.failedParseRetryMs,
        poll_interval_ms: options.pollIntervalMs,
      });
      log(`status parse failed, retrying in ${options.failedParseRetryMs / 1000}s (${failedParseRetries}/${MAX_FAILED_PARSE_RETRIES})`);
      setTimeout(() => tryRequestStatus("retry"), options.failedParseRetryMs);
      return;
    }

    failedParseRetries = 0;
    writePollerHeartbeat(options.statusPath, "parse_failed_waiting_next_poll", reason, {
      poll_interval_ms: options.pollIntervalMs,
    });
    restartSession(`status parse failed ${MAX_FAILED_PARSE_RETRIES + 1} times`);
  }

  function armCaptureQuietTimer() {
    clearTimeout(captureQuietTimer);
    captureQuietTimer = setTimeout(() => finishCapture(capture.reason), options.captureQuietMs);
  }

  function requestStatus(reason) {
    if (stopped || capture) {
      return;
    }
    capture = { buffer: "", reason };
    writePollerHeartbeat(options.statusPath, "capturing", reason, {
      poll_interval_ms: options.pollIntervalMs,
    });
    log(`requesting /status (${reason})`);
    typeIntoTerminal(term, "/status\r");
    armCaptureQuietTimer();
    captureMaxTimer = setTimeout(() => {
      if (capture) {
        log("/status output never went quiet, forcing capture");
        finishCapture(`${reason}-timeout`);
      }
    }, options.maxCaptureMs);
  }

  function tryRequestStatus(reason, attempt = 1) {
    if (stopped) {
      return;
    }
    if (!capture && isOutputQuiet(lastOutputAt, options.captureQuietMs) && !isUnsafePromptActive()) {
      requestStatus(reason);
      return;
    }
    if (attempt > 60) {
      writePollerHeartbeat(options.statusPath, "idle_wait_skipped", reason, {
        poll_interval_ms: options.pollIntervalMs,
      });
      log(`skipped /status (${reason}) because Codex output did not become idle`);
      restartSession(`Codex did not become idle for /status (${reason})`);
      return;
    }
    setTimeout(() => tryRequestStatus(reason, attempt + 1), 1000);
  }

  function schedulePoll() {
    if (stopped) {
      return;
    }
    clearTimeout(pollTimer);
    writePollerHeartbeat(options.statusPath, "waiting_next_poll", "scheduled", {
      next_poll_after_ms: options.pollIntervalMs,
      poll_interval_ms: options.pollIntervalMs,
    });
    pollTimer = setTimeout(() => tryRequestStatus("poll"), options.pollIntervalMs);
  }

  term.onData((data) => {
    lastOutputAt = Date.now();
    outputTail = `${outputTail}${stripAnsi(data)}`;
    if (outputTail.length > OUTPUT_TAIL_LIMIT) {
      outputTail = outputTail.slice(-OUTPUT_TAIL_LIMIT);
    }
    if (capture) {
      capture.buffer += data;
      armCaptureQuietTimer();
    }
  });

  term.onExit(({ exitCode }) => {
    stopped = true;
    stopTimers();
    writePollerHeartbeat(options.statusPath, "session_exited", `exit code ${exitCode}`, {
      poll_interval_ms: options.pollIntervalMs,
    });
    onSessionEnded(exitCode);
  });

  setTimeout(() => tryRequestStatus("startup"), options.startupDelayMs);
  watchdogTimer = setInterval(() => {
    if (stopped) {
      return;
    }
    const maxAgeMs = Math.max(options.pollIntervalMs * 2 + 60 * 1000, 10 * 60 * 1000);
    if (Date.now() - lastSuccessfulCaptureAt > maxAgeMs) {
      restartSession(`no successful /status capture for ${Math.round(maxAgeMs / 1000)}s`);
    }
  }, WATCHDOG_CHECK_MS);

  return {
    stop() {
      stopped = true;
      stopTimers();
      try {
        term.kill();
      } catch (error) {
        // session already gone
      }
    },
  };
}

function startPoller(options) {
  let backoffMs = Number.isFinite(options.respawnBackoffMs) ? options.respawnBackoffMs : DEFAULT_RESPAWN_BACKOFF_MS;
  let stopping = false;
  let activeSession = null;

  function resetBackoff() {
    backoffMs = Number.isFinite(options.respawnBackoffMs) ? options.respawnBackoffMs : DEFAULT_RESPAWN_BACKOFF_MS;
  }

  function retryAfterFailure(detail) {
    if (stopping) {
      return;
    }
    writePollerHeartbeat(options.statusPath, "retrying_session", detail, {
      retry_after_ms: backoffMs,
      poll_interval_ms: options.pollIntervalMs,
    });
    log(`${detail}, retrying in ${Math.round(backoffMs / 1000)}s`);
    setTimeout(spawnNext, backoffMs);
    backoffMs = Math.min(backoffMs * 2, MAX_RESPAWN_BACKOFF_MS);
  }

  function spawnNext() {
    if (stopping) {
      return;
    }
    log(`starting headless Codex session (${options.codexCommand})`);
    try {
      activeSession = runSession(
        options,
        (exitCode) => retryAfterFailure(`headless Codex session exited (code ${exitCode})`),
        resetBackoff,
      );
    } catch (error) {
      retryAfterFailure(`failed to start headless Codex session (${error.message})`);
    }
  }

  spawnNext();

  function stop() {
    stopping = true;
    if (activeSession) {
      activeSession.stop();
    }
  }

  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });

  return { stop };
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  startPoller(options);
}

module.exports = { parseArgs, startPoller };
