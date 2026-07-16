#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { app, BrowserWindow, ipcMain } = require("electron");

const ROOT = path.resolve(__dirname, "..");
const IMAGE_DIR = path.join(ROOT, "docs", "images");
const RENDERER_DIR = path.join(ROOT, "src", "electron", "renderer");
const PRELOAD_PATH = path.join(ROOT, "src", "electron", "preload.js");

const sampleSnapshot = {
  poller: { codexIntervalMs: 60_000, claudeIntervalMs: 180_000 },
  codex: {
    connected: true,
    ageMs: 42_000,
    status: { poller: { state: "idle" } },
    limits: {
      five_hour: { remaining_percent: 72, reset_text: "resets 07/17 18:30" },
      weekly: { remaining_percent: 48, reset_text: "resets 07/21 09:00" },
    },
  },
  claude: {
    connected: true,
    hookInstalled: true,
    ageMs: 68_000,
    status: { poller: { state: "idle" } },
    limits: {
      five_hour: { remaining_percent: 81, reset_text: "resets 07/17 20:00" },
      seven_day: { remaining_percent: 64, reset_text: "resets 07/23 10:00" },
    },
  },
  window: { alwaysOnTop: false, opacity: 0.96 },
  launchAtLogin: true,
};

const sampleSetupSnapshot = {
  ...sampleSnapshot,
  setup: {
    codexCommand: true,
    claudeCommand: true,
    uvicornCommand: true,
    runtimeBundled: true,
    hookCommand: "Codex Claude Usage --claude-status-hook",
  },
};

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function registerPreviewHandlers() {
  ipcMain.handle("status:snapshot", () => sampleSnapshot);
  ipcMain.handle("status:refresh", () => sampleSnapshot);
  ipcMain.handle("setup:snapshot", () => sampleSetupSnapshot);
  ipcMain.handle("setup:refresh", () => sampleSetupSnapshot);
  ipcMain.handle("window:setAlwaysOnTop", () => sampleSnapshot);
  ipcMain.handle("window:setOpacity", () => sampleSnapshot);
  ipcMain.handle("window:minimize", () => null);
  ipcMain.handle("dashboard:open", () => null);
  ipcMain.handle("setup:open", () => null);
  ipcMain.handle("setup:installClaudeHook", () => sampleSetupSnapshot);
  ipcMain.handle("setup:openCodexLogin", () => null);
  ipcMain.handle("setup:openClaudeAuth", () => null);
  ipcMain.handle("app:setLaunchAtLogin", () => sampleSetupSnapshot);
  ipcMain.handle("app:quit", () => null);
}

function createPreviewWindow() {
  return new BrowserWindow({
    width: 360,
    height: 430,
    useContentSize: true,
    show: false,
    frame: false,
    backgroundColor: "#12151c",
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
}

async function captureWindow(window, { width, height, outputName, load }) {
  window.setContentSize(width, height);
  await load(window);
  await window.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
  await delay(300);
  const image = await window.webContents.capturePage();
  fs.writeFileSync(path.join(IMAGE_DIR, outputName), image.toPNG());
}

function writeJsonLine(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function createDashboardFixture() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-usage-monitor-readme-"));
  const statusPath = path.join(tempDir, "status.json");
  const claudeStatusPath = path.join(tempDir, "claude-status.json");
  const sessionsDir = path.join(tempDir, "sessions");
  const claudeSessionsDir = path.join(tempDir, "claude-projects");
  const dateParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  const today = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const capturedAt = new Date().toISOString();

  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(claudeSessionsDir, { recursive: true });
  writeJsonLine(statusPath, {
    schema_version: 1,
    captured_at: capturedAt,
    source: "codex_cli_status",
    capture_method: "readme_preview",
    parse_status: "ok",
    limits: [
      { type: "five_hour", remaining_percent: 72, reset_text: "resets in 2h 15m" },
      { type: "weekly", remaining_percent: 48, reset_text: "resets in 4d 9h" },
    ],
    raw_status_text: "README preview data",
  });
  writeJsonLine(claudeStatusPath, {
    schema_version: 1,
    captured_at: capturedAt,
    source: "claude_usage_command",
    capture_method: "readme_preview",
    parse_status: "ok",
    limits: [
      { type: "five_hour", used_percent: 19, remaining_percent: 81, reset_text: "resets in 3h" },
      { type: "seven_day", used_percent: 36, remaining_percent: 64, reset_text: "resets in 5d" },
    ],
    raw_status_text: "README preview data",
  });

  const codexRecords = [
    {
      timestamp: `${today}T01:00:00Z`,
      payload: {
        model: "gpt-5.4",
        info: { last_token_usage: { input_tokens: 182_400, cached_input_tokens: 126_000, output_tokens: 28_900, reasoning_output_tokens: 7_800, total_tokens: 211_300 } },
      },
    },
    {
      timestamp: `${today}T02:00:00Z`,
      payload: {
        model: "gpt-5.3-codex",
        info: { last_token_usage: { input_tokens: 96_200, cached_input_tokens: 64_500, output_tokens: 18_400, reasoning_output_tokens: 4_200, total_tokens: 114_600 } },
      },
    },
  ];
  fs.writeFileSync(
    path.join(sessionsDir, `rollout-${today}T00-00-00-readme-preview.jsonl`),
    `${codexRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );

  const claudeRecords = [
    {
      type: "assistant",
      timestamp: `${today}T03:00:00Z`,
      message: {
        id: "readme-claude-1",
        model: "claude-sonnet-4",
        usage: { input_tokens: 74_000, cache_read_input_tokens: 52_000, cache_creation_input_tokens: 8_500, output_tokens: 12_600 },
      },
    },
    {
      type: "assistant",
      timestamp: `${today}T04:00:00Z`,
      message: {
        id: "readme-claude-2",
        model: "claude-opus-4",
        usage: { input_tokens: 31_500, cache_read_input_tokens: 18_300, cache_creation_input_tokens: 3_200, output_tokens: 7_900 },
      },
    },
  ];
  fs.writeFileSync(
    path.join(claudeSessionsDir, "readme-preview.jsonl"),
    `${claudeRecords.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );

  return { tempDir, statusPath, claudeStatusPath, sessionsDir, claudeSessionsDir, today };
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(url, server, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (server.exitCode !== null) {
      throw new Error(`Dashboard preview server exited with code ${server.exitCode}`);
    }
    try {
      await new Promise((resolve, reject) => {
        http.get(url, (response) => {
          response.resume();
          response.on("end", () => response.statusCode === 200 ? resolve() : reject(new Error(`HTTP ${response.statusCode}`)));
        }).on("error", reject);
      });
      return;
    } catch (_error) {
      await delay(150);
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopServer(server, timeoutMs = 3_000) {
  if (server.exitCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    server.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    server.kill();
  });
}

async function captureDashboard(window) {
  const fixture = createDashboardFixture();
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;
  const server = spawn("python", [
    path.join("src", "python", "codex_status_dashboard.py"),
    "--serve",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--status-path", fixture.statusPath,
    "--claude-status-path", fixture.claudeStatusPath,
    "--sessions-dir", fixture.sessionsDir,
    "--claude-sessions-dir", fixture.claudeSessionsDir,
    "--no-auto-status-poll",
    "--refresh-seconds", "60",
  ], {
    cwd: ROOT,
    windowsHide: true,
    stdio: "ignore",
  });

  try {
    await waitForServer(url, server);
    await captureWindow(window, {
      width: 1280,
      height: 900,
      outputName: "dashboard-overview.png",
      load: async (previewWindow) => {
        await previewWindow.loadURL(url);
        await previewWindow.webContents.executeJavaScript(`
          new Promise((resolve, reject) => {
            const startedAt = Date.now();
            const timer = setInterval(() => {
              const content = document.getElementById("dashboard-content");
              if (content && !content.classList.contains("is-loading") && content.textContent.includes("72%")) {
                clearInterval(timer);
                resolve(true);
              } else if (Date.now() - startedAt > 10000) {
                clearInterval(timer);
                reject(new Error("Dashboard preview did not finish rendering"));
              }
            }, 100);
          })
        `);
        const replacements = [
          [fixture.statusPath, "~/.codex-usage-wrapper/status.json"],
          [fixture.claudeStatusPath, "~/.codex-usage-wrapper/claude-status.json"],
          [fixture.sessionsDir, "~/.codex/sessions"],
          [fixture.claudeSessionsDir, "~/.claude/projects"],
          [fixture.today, "2026-07-17"],
        ];
        await previewWindow.webContents.executeJavaScript(`
          (() => {
            const replacements = ${JSON.stringify(replacements)};
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              for (const [source, replacement] of replacements) {
                walker.currentNode.nodeValue = walker.currentNode.nodeValue.split(source).join(replacement);
              }
            }
          })()
        `);
      },
    });
  } finally {
    await stopServer(server);
    const expectedPrefix = path.join(os.tmpdir(), "ai-usage-monitor-readme-");
    if (!fixture.tempDir.startsWith(expectedPrefix)) {
      throw new Error(`Refusing to remove unexpected preview directory: ${fixture.tempDir}`);
    }
    fs.rmSync(fixture.tempDir, { recursive: true, force: true });
  }
}

async function main() {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  registerPreviewHandlers();
  const window = createPreviewWindow();

  try {
    await captureWindow(window, {
      width: 360,
      height: 430,
      outputName: "app-compact.png",
      load: (previewWindow) => previewWindow.loadFile(path.join(RENDERER_DIR, "compact.html")),
    });
    await captureWindow(window, {
      width: 560,
      height: 720,
      outputName: "app-setup.png",
      load: (previewWindow) => previewWindow.loadFile(path.join(RENDERER_DIR, "setup.html")),
    });
    await captureDashboard(window);
  } finally {
    window.destroy();
  }
}

app.disableHardwareAcceleration();
app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });
