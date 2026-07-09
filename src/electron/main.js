"use strict";

const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } = require("electron");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildStatus, summaryFromStatus } = require("../node/claude-status-hook");
const { writeJsonAtomic } = require("../node/status-capture");

const APP_NAME = "Codex Claude Usage";
const ROOT = path.resolve(__dirname, "..", "..");
const DASHBOARD_URL = "http://127.0.0.1:8767";
const STATUS_DIR = path.join(os.homedir(), ".codex-usage-wrapper");
const CODEX_STATUS_PATH = path.join(STATUS_DIR, "status.json");
const CLAUDE_STATUS_PATH = path.join(STATUS_DIR, "claude-status.json");
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const CLAUDE_HOOK_PATH = path.join(ROOT, "src", "node", "claude-status-hook.js");

let dashboardProcess = null;
let tray = null;
let compactWindow = null;
let dashboardWindow = null;
let setupWindow = null;

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function runClaudeStatusHookMode() {
  const statusPath = argValue("--status-path") || CLAUDE_STATUS_PATH;
  const rawInput = fs.readFileSync(0, "utf8");
  const status = buildStatus(rawInput);
  writeJsonAtomic(statusPath, status);
  process.stdout.write(`${summaryFromStatus(status)}\n`);
}

if (process.argv.includes("--claude-status-hook")) {
  runClaudeStatusHookMode();
  process.exit(0);
}

app.setName(APP_NAME);
app.setAppUserModelId("local.codex-claude-usage");

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

function createTrayImage() {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">',
    '<rect width="32" height="32" rx="7" fill="#151820"/>',
    '<path d="M8 21V11h4.5c3 0 5 2 5 5s-2 5-5 5H8Z" fill="#9bd1ff"/>',
    '<path d="M19 21V11h5l-3 5 3 5h-5l-3-5 3-5Z" fill="#e4b363"/>',
    "</svg>",
  ].join("");
  return nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
}

function startDashboardServer() {
  if (dashboardProcess && dashboardProcess.exitCode === null) {
    return;
  }

  dashboardProcess = spawn(
    "uvicorn",
    ["--app-dir", path.join(ROOT, "src", "python"), "codex_dashboard_fastapi:app", "--host", "127.0.0.1", "--port", "8767"],
    {
      cwd: ROOT,
      env: { ...process.env, PYTHONPATH: path.join(ROOT, "src", "python") },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  dashboardProcess.on("error", () => {
    dashboardProcess = null;
  });
  dashboardProcess.on("exit", () => {
    dashboardProcess = null;
  });
}

function stopDashboardServer() {
  if (!dashboardProcess || dashboardProcess.exitCode !== null) {
    return;
  }
  dashboardProcess.kill();
  dashboardProcess = null;
}

function showCompactWindow() {
  if (compactWindow) {
    compactWindow.show();
    compactWindow.focus();
    return;
  }

  compactWindow = new BrowserWindow({
    width: 360,
    height: 430,
    minWidth: 320,
    minHeight: 280,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    opacity: 0.96,
    backgroundColor: "#12151c",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  compactWindow.loadFile(path.join(__dirname, "renderer", "compact.html"));
  compactWindow.on("closed", () => {
    compactWindow = null;
  });
}

function showDashboardWindow() {
  startDashboardServer();
  if (dashboardWindow) {
    dashboardWindow.show();
    dashboardWindow.focus();
    return;
  }

  dashboardWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#11141b",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  dashboardWindow.loadURL(DASHBOARD_URL);
  dashboardWindow.webContents.on("did-fail-load", (_event, _code, _description, url) => {
    if (url === DASHBOARD_URL && dashboardWindow) {
      setTimeout(() => {
        if (dashboardWindow) {
          dashboardWindow.loadURL(DASHBOARD_URL);
        }
      }, 1200);
    }
  });
  dashboardWindow.on("closed", () => {
    dashboardWindow = null;
  });
}

function statusByType(status) {
  const result = {};
  const limits = status && Array.isArray(status.limits) ? status.limits : [];
  for (const limit of limits) {
    if (limit && typeof limit.type === "string") {
      result[limit.type] = limit;
    }
  }
  return result;
}

function detectClaudeHook() {
  const settings = readJsonSafe(CLAUDE_SETTINGS_PATH);
  const command = settings && settings.statusLine && settings.statusLine.command;
  if (typeof command !== "string") {
    return false;
  }
  const normalizedCommand = command.replace(/\//g, "\\").toLowerCase();
  return normalizedCommand.includes("--claude-status-hook") || normalizedCommand.includes(CLAUDE_HOOK_PATH.toLowerCase());
}

function commandExists(command) {
  const result = spawnSync("where.exe", [command], {
    windowsHide: true,
    encoding: "utf8",
  });
  return result.status === 0;
}

function claudeHookCommand() {
  const exe = process.execPath.replace(/"/g, '\\"');
  if (app.isPackaged) {
    return `"${exe}" --claude-status-hook`;
  }
  return `"${exe}" "${ROOT.replace(/"/g, '\\"')}" --claude-status-hook`;
}

function installClaudeHook() {
  const settings = readJsonSafe(CLAUDE_SETTINGS_PATH) || {};
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("Claude settings.json is not an object");
  }
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_PATH), { recursive: true });
  settings.statusLine = {
    type: "command",
    command: claudeHookCommand(),
  };
  writeJsonAtomic(CLAUDE_SETTINGS_PATH, settings);
}

function ensureLaunchAtLogin() {
  if (process.platform === "win32") {
    const legacyName = "electron.app.Electron";
    const runKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
    const query = spawnSync("reg.exe", ["query", runKey, "/v", legacyName], {
      windowsHide: true,
      encoding: "utf8",
    });
    if (query.status === 0 && query.stdout.includes("CodexUsage")) {
      spawnSync("reg.exe", ["delete", runKey, "/v", legacyName, "/f"], {
        windowsHide: true,
        encoding: "utf8",
      });
    }
  }
  app.setLoginItemSettings({
    openAtLogin: true,
    path: process.execPath,
    args: app.isPackaged ? [] : [ROOT],
  });
}

function statusAgeMs(status) {
  const capturedAt = status && status.captured_at;
  if (typeof capturedAt !== "string") {
    return null;
  }
  const parsed = Date.parse(capturedAt);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Date.now() - parsed);
}

function buildSnapshot() {
  const codex = readJsonSafe(CODEX_STATUS_PATH);
  const claude = readJsonSafe(CLAUDE_STATUS_PATH);
  return {
    capturedAt: new Date().toISOString(),
    dashboard: {
      running: Boolean(dashboardProcess && dashboardProcess.exitCode === null),
      url: DASHBOARD_URL,
    },
    codex: {
      connected: Boolean(codex && codex.parse_status === "ok"),
      ageMs: statusAgeMs(codex),
      status: codex || null,
      limits: statusByType(codex),
    },
    claude: {
      connected: Boolean(claude && claude.parse_status === "ok"),
      hookInstalled: detectClaudeHook(),
      ageMs: statusAgeMs(claude),
      status: claude || null,
      limits: statusByType(claude),
    },
    window: {
      alwaysOnTop: compactWindow ? compactWindow.isAlwaysOnTop() : true,
      opacity: compactWindow ? compactWindow.getOpacity() : 0.96,
    },
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    setup: {
      codexCommand: commandExists("codex.exe") || commandExists("codex"),
      claudeCommand: commandExists("claude.exe") || commandExists("claude"),
      uvicornCommand: commandExists("uvicorn.exe") || commandExists("uvicorn"),
      hookCommand: claudeHookCommand(),
    },
  };
}

function showSetupWindow() {
  if (setupWindow) {
    setupWindow.show();
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 560,
    height: 620,
    minWidth: 500,
    minHeight: 520,
    backgroundColor: "#12151c",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWindow.loadFile(path.join(__dirname, "renderer", "setup.html"));
  setupWindow.on("closed", () => {
    setupWindow = null;
  });
}

function openCommand(command) {
  spawn("powershell.exe", ["-NoExit", "-Command", command], {
    detached: true,
    windowsHide: false,
    stdio: "ignore",
  }).unref();
}

function createTray() {
  tray = new Tray(createTrayImage());
  tray.setToolTip("Codex, Claude Usage");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Compact window", click: showCompactWindow },
      { label: "Full dashboard", click: showDashboardWindow },
      { label: "Setup", click: showSetupWindow },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", showCompactWindow);
}

ipcMain.handle("status:snapshot", () => buildSnapshot());
ipcMain.handle("window:setAlwaysOnTop", (_event, enabled) => {
  if (compactWindow) {
    compactWindow.setAlwaysOnTop(Boolean(enabled), "floating");
  }
  return buildSnapshot();
});
ipcMain.handle("window:setOpacity", (_event, value) => {
  const numeric = Number(value);
  const opacity = Number.isFinite(numeric) ? Math.max(0.55, Math.min(1, numeric)) : 0.96;
  if (compactWindow) {
    compactWindow.setOpacity(opacity);
  }
  return buildSnapshot();
});
ipcMain.handle("window:minimize", () => {
  if (compactWindow) {
    compactWindow.minimize();
  }
  return true;
});
ipcMain.handle("dashboard:open", () => {
  showDashboardWindow();
  return buildSnapshot();
});
ipcMain.handle("setup:open", () => {
  showSetupWindow();
  return buildSnapshot();
});
ipcMain.handle("setup:installClaudeHook", () => {
  installClaudeHook();
  return buildSnapshot();
});
ipcMain.handle("setup:openCodexLogin", () => {
  openCommand("codex login");
  return true;
});
ipcMain.handle("setup:openClaudeAuth", () => {
  openCommand("claude auth");
  return true;
});
ipcMain.handle("app:setLaunchAtLogin", (_event, enabled) => {
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    path: process.execPath,
    args: app.isPackaged ? [] : [ROOT],
  });
  return buildSnapshot();
});
ipcMain.handle("app:quit", () => {
  app.quit();
});

app.whenReady().then(() => {
  ensureLaunchAtLogin();
  startDashboardServer();
  createTray();
  showCompactWindow();
  const snapshot = buildSnapshot();
  if (!snapshot.claude.hookInstalled || !snapshot.setup.codexCommand || !snapshot.setup.claudeCommand || !snapshot.setup.uvicornCommand) {
    showSetupWindow();
  }
});

app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  stopDashboardServer();
});
