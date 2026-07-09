#!/usr/bin/env node
"use strict";

const path = require("path");
const pty = require("node-pty");
const {
  STATUS_PATH,
  HISTORY_DIR,
  UNSAFE_PROMPT_PATTERNS,
  stripAnsi,
  writeStatus,
  typeIntoTerminal,
} = require("./status-capture");

const DEFAULT_CAPTURE_QUIET_MS = 1600;
const DEFAULT_START_CAPTURE_DELAY_MS = 2500;
const DEFAULT_IDLE_CAPTURE_MS = 5 * 60 * 1000;
const DEFAULT_AFTER_OUTPUT_DELAY_MS = 4500;
const DEFAULT_AUTO_CAPTURE_MIN_MS = 60 * 1000;
const DEFAULT_AUTO_OUTPUT_QUIET_MS = 1200;
const DEFAULT_START_CAPTURE_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_CAPTURE_MS = 15 * 1000;
const USAGE_COMMAND = ":usage";
const OUTPUT_TAIL_LIMIT = 8000;

function parseArgs(argv) {
  const options = {
    statusPath: STATUS_PATH,
    historyDir: HISTORY_DIR,
    captureQuietMs: DEFAULT_CAPTURE_QUIET_MS,
    startCaptureDelayMs: DEFAULT_START_CAPTURE_DELAY_MS,
    idleCaptureMs: DEFAULT_IDLE_CAPTURE_MS,
    startCapture: true,
    idleCapture: true,
    parseRawStdin: false,
    afterOutputCapture: true,
    afterOutputDelayMs: DEFAULT_AFTER_OUTPUT_DELAY_MS,
    autoCaptureMinMs: DEFAULT_AUTO_CAPTURE_MIN_MS,
    autoOutputQuietMs: DEFAULT_AUTO_OUTPUT_QUIET_MS,
    maxCaptureMs: DEFAULT_MAX_CAPTURE_MS,
    codexCommand: process.platform === "win32" ? "codex.exe" : "codex",
    codexArgs: [],
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
    if (arg === "--codex-command") {
      options.codexCommand = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--history-dir") {
      options.historyDir = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--capture-quiet-ms") {
      options.captureQuietMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--start-capture-delay-ms") {
      options.startCaptureDelayMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--idle-capture-ms") {
      options.idleCaptureMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--no-start-capture") {
      options.startCapture = false;
      continue;
    }
    if (arg === "--no-idle-capture") {
      options.idleCapture = false;
      continue;
    }
    if (arg === "--after-output-capture") {
      options.afterOutputCapture = true;
      continue;
    }
    if (arg === "--no-after-output-capture") {
      options.afterOutputCapture = false;
      continue;
    }
    if (arg === "--after-output-delay-ms") {
      options.afterOutputDelayMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--auto-capture-min-ms") {
      options.autoCaptureMinMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--auto-output-quiet-ms") {
      options.autoOutputQuietMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--max-capture-ms") {
      options.maxCaptureMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--parse-raw-stdin") {
      options.parseRawStdin = true;
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
  process.stdout.write(`Codex usage wrapper

Usage:
  node codex-wrapper.js [WRAPPER_OPTIONS] -- [CODEX_ARGS]

Wrapper options:
  --status-path <path>              status.json path
  --history-dir <path>              history JSONL directory
  --codex-command <command>         Codex executable path for testing
  --capture-quiet-ms <ms>           /status capture quiet window
  --start-capture-delay-ms <ms>     delay before first /status
  --idle-capture-ms <ms>            idle refresh interval
  --no-start-capture                disable first automatic capture
  --no-idle-capture                 disable idle capture
  --after-output-capture            enable capture after quiet output
  --no-after-output-capture         disable capture after quiet output
  --after-output-delay-ms <ms>       quiet output delay for opt-in capture
  --auto-capture-min-ms <ms>         minimum gap between automatic captures
  --auto-output-quiet-ms <ms>        output quiet window for automatic captures
  --max-capture-ms <ms>              force-finish a stuck capture after this long
  --parse-raw-stdin                 parse stdin as /status text and exit

Inside Codex:
  Type :usage at the beginning of a line to refresh usage.
`);
}

function createWrapper(options) {
  const term = pty.spawn(options.codexCommand, options.codexArgs, {
    name: "xterm-256color",
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 30,
    cwd: process.cwd(),
    env: process.env,
  });

  let atLineStart = true;
  let candidateBuffer = "";
  let capture = null;
  let captureQuietTimer = null;
  let captureMaxTimer = null;
  let idleTimer = null;
  let afterOutputTimer = null;
  let startupTimer = null;
  let pendingStatusTimer = null;
  let userInputCount = 0;
  let lastUserInputAt = 0;
  let lastOutputAt = Date.now();
  let lastAutoCaptureAt = 0;
  let outputTail = "";

  function updateOutputTail(data) {
    outputTail = `${outputTail}${stripAnsi(data)}`;
    if (outputTail.length > OUTPUT_TAIL_LIMIT) {
      outputTail = outputTail.slice(-OUTPUT_TAIL_LIMIT);
    }
  }

  function isUnsafePromptActive() {
    return UNSAFE_PROMPT_PATTERNS.some((pattern) => pattern.test(outputTail));
  }

  function isOutputQuiet(requiredMs = options.autoOutputQuietMs) {
    return Date.now() - lastOutputAt >= requiredMs;
  }

  function canAutoCapture(requiredOutputQuietMs = options.autoOutputQuietMs) {
    return (
      !capture &&
      candidateBuffer.length === 0 &&
      isOutputQuiet(requiredOutputQuietMs) &&
      !isUnsafePromptActive()
    );
  }

  function canManualCapture() {
    return !capture && candidateBuffer.length === 0 && isOutputQuiet() && !isUnsafePromptActive();
  }

  function scheduleIdleCapture() {
    if (!options.idleCapture || !Number.isFinite(options.idleCaptureMs) || options.idleCaptureMs <= 0) {
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const idleEnough = Date.now() - lastUserInputAt >= options.idleCaptureMs;
      const gapEnough = Date.now() - lastAutoCaptureAt >= options.autoCaptureMinMs;
      if (idleEnough && gapEnough && canAutoCapture()) {
        requestStatus("idle");
      }
      scheduleIdleCapture();
    }, options.idleCaptureMs);
  }

  function scheduleStartupCapture(attempt = 1) {
    clearTimeout(startupTimer);
    startupTimer = setTimeout(() => {
      if (userInputCount > 0) {
        process.stdout.write("\r\n[usage-wrapper] skipped startup status capture after user input\r\n");
        return;
      }

      if (canAutoCapture()) {
        requestStatus("startup");
        return;
      }

      if (attempt < DEFAULT_START_CAPTURE_MAX_ATTEMPTS) {
        scheduleStartupCapture(attempt + 1);
        return;
      }

      process.stdout.write("\r\n[usage-wrapper] skipped startup status capture because Codex was not idle\r\n");
    }, options.startCaptureDelayMs);
  }

  function finishCapture(reason) {
    if (!capture) {
      return;
    }
    const rawStatusText = capture.buffer;
    capture = null;
    clearTimeout(captureQuietTimer);
    captureQuietTimer = null;
    clearTimeout(captureMaxTimer);
    captureMaxTimer = null;

    const status = writeStatus(options.statusPath, options.historyDir, rawStatusText);
    const limits = status.limits
      .filter((limit) => Number.isInteger(limit.remaining_percent))
      .map((limit) => `${limit.type} ${limit.remaining_percent}%`)
      .join(", ");
    const summary = limits || status.parse_status;
    process.stdout.write(`\r\n[usage-wrapper] captured status (${reason}): ${summary}\r\n`);
  }

  function armCaptureQuietTimer(reason) {
    clearTimeout(captureQuietTimer);
    captureQuietTimer = setTimeout(() => finishCapture(reason), options.captureQuietMs);
  }

  function requestStatus(reason) {
    if (capture) {
      process.stdout.write("\r\n[usage-wrapper] status capture already running\r\n");
      return;
    }
    capture = { buffer: "", reason };
    if (reason !== "manual") {
      lastAutoCaptureAt = Date.now();
    }
    process.stdout.write(`\r\n[usage-wrapper] requesting /status (${reason})\r\n`);
    typeIntoTerminal(term, "/status\r");
    armCaptureQuietTimer(reason);

    clearTimeout(captureMaxTimer);
    if (Number.isFinite(options.maxCaptureMs) && options.maxCaptureMs > 0) {
      captureMaxTimer = setTimeout(() => {
        if (capture) {
          process.stdout.write("\r\n[usage-wrapper] /status output never went quiet, forcing capture\r\n");
          finishCapture(`${reason}-timeout`);
        }
      }, options.maxCaptureMs);
    }
  }

  function queueStatus(reason, attempt = 1) {
    clearTimeout(pendingStatusTimer);
    if (canManualCapture()) {
      requestStatus(reason);
      return;
    }

    if (attempt === 1) {
      process.stdout.write(`\r\n[usage-wrapper] queued /status (${reason}) until Codex output is idle\r\n`);
    }

    if (attempt > 120) {
      process.stdout.write(`\r\n[usage-wrapper] skipped /status (${reason}) because Codex output did not become idle\r\n`);
      return;
    }

    pendingStatusTimer = setTimeout(() => queueStatus(reason, attempt + 1), 500);
  }

  function scheduleAfterOutputCapture() {
    if (
      !options.afterOutputCapture ||
      capture ||
      !Number.isFinite(options.afterOutputDelayMs) ||
      options.afterOutputDelayMs <= 0
    ) {
      return;
    }
    clearTimeout(afterOutputTimer);
    afterOutputTimer = setTimeout(() => {
      const noRecentUserInput = Date.now() - lastUserInputAt >= options.afterOutputDelayMs;
      const gapEnough = Date.now() - lastAutoCaptureAt >= options.autoCaptureMinMs;
      if (noRecentUserInput && gapEnough && canAutoCapture(options.afterOutputDelayMs)) {
        requestStatus("after-output");
      }
    }, options.afterOutputDelayMs);
  }

  function flushCandidate() {
    if (candidateBuffer.length > 0) {
      term.write(candidateBuffer);
      atLineStart = false;
      candidateBuffer = "";
    }
  }

  function handleInput(data) {
    userInputCount += 1;
    lastUserInputAt = Date.now();

    for (const char of data) {
      if (char === "\u0003") {
        flushCandidate();
        term.write(char);
        continue;
      }

      if (candidateBuffer.length > 0) {
        if (char === "\r" || char === "\n") {
          if (candidateBuffer === USAGE_COMMAND) {
            candidateBuffer = "";
            atLineStart = true;
            queueStatus("manual");
          } else {
            term.write(`${candidateBuffer}\r`);
            outputTail = "";
            candidateBuffer = "";
            atLineStart = true;
          }
          continue;
        }

        if (char === "\b" || char === "\u007f") {
          candidateBuffer = candidateBuffer.slice(0, -1);
          if (candidateBuffer.length === 0) {
            atLineStart = true;
          }
          continue;
        }

        const nextCandidate = `${candidateBuffer}${char}`;
        if (USAGE_COMMAND.startsWith(nextCandidate)) {
          candidateBuffer = nextCandidate;
          continue;
        }

        term.write(nextCandidate);
        outputTail = "";
        atLineStart = false;
        candidateBuffer = "";
        continue;
      }

      if (atLineStart && char === ":") {
        candidateBuffer = ":";
        continue;
      }

      term.write(char);
      outputTail = "";
      atLineStart = char === "\r" || char === "\n";
    }
  }

  term.onData((data) => {
    lastOutputAt = Date.now();
    updateOutputTail(data);
    process.stdout.write(data);
    if (capture) {
      capture.buffer += data;
      armCaptureQuietTimer(capture.reason);
    } else {
      scheduleAfterOutputCapture();
    }
  });

  term.onExit(({ exitCode }) => {
    clearTimeout(idleTimer);
    clearTimeout(captureQuietTimer);
    clearTimeout(captureMaxTimer);
    clearTimeout(afterOutputTimer);
    clearTimeout(startupTimer);
    clearTimeout(pendingStatusTimer);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.exit(exitCode ?? 0);
  });

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", handleInput);

  process.stdout.on("resize", () => {
    term.resize(process.stdout.columns || 120, process.stdout.rows || 30);
  });

  if (options.startCapture) {
    scheduleStartupCapture();
  }
  scheduleIdleCapture();
}

const options = parseArgs(process.argv.slice(2));

if (options.parseRawStdin) {
  let rawInput = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    rawInput += chunk;
  });
  process.stdin.on("end", () => {
    const status = writeStatus(options.statusPath, options.historyDir, rawInput);
    process.stdout.write(`wrote ${options.statusPath} (${status.parse_status})\n`);
  });
} else {
  createWrapper(options);
}
