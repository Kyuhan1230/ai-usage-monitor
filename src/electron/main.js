"use strict";

const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage } = require("electron");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { parseArgs: parseClaudePollerArgs, startPoller: startClaudePoller } = require("../node/claude-usage-poller");
const { parseArgs: parsePollerArgs, startPoller } = require("../node/codex-status-poller");
const { buildStatus, shouldPreserveUsageCommandStatus, summaryFromStatus } = require("../node/claude-status-hook");
const { writeJsonAtomic } = require("../node/status-capture");

const APP_NAME = "Codex Claude Usage";
const ROOT = path.resolve(__dirname, "..", "..");
const DASHBOARD_URL = "http://127.0.0.1:8767";
const STATUS_DIR = path.join(os.homedir(), ".codex-usage-wrapper");
const CODEX_STATUS_PATH = path.join(STATUS_DIR, "status.json");
const CLAUDE_STATUS_PATH = path.join(STATUS_DIR, "claude-status.json");
const HISTORY_DIR = path.join(STATUS_DIR, "history");
const POLLER_PID_PATH = path.join(STATUS_DIR, "poller.pid");
const CLAUDE_POLLER_PID_PATH = path.join(STATUS_DIR, "claude-poller.pid");
const DEFAULT_FAST_POLL_INTERVAL_MS = 60 * 1000;
const CODEX_POLL_INTERVAL_MS = parsePositiveInt(process.env.CODEX_USAGE_CODEX_POLL_INTERVAL_MS)
  || parsePositiveInt(process.env.CODEX_USAGE_POLL_INTERVAL_MS)
  || DEFAULT_FAST_POLL_INTERVAL_MS;
const CLAUDE_POLL_INTERVAL_MS = parsePositiveInt(process.env.CODEX_USAGE_CLAUDE_POLL_INTERVAL_MS)
  || parsePositiveInt(process.env.CODEX_USAGE_POLL_INTERVAL_MS)
  || DEFAULT_FAST_POLL_INTERVAL_MS;
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const CLAUDE_HOOK_PATH = path.join(ROOT, "src", "node", "claude-status-hook.js");

let dashboardProcess = null;
let statusPollerProcess = null;
let claudePollerProcess = null;
let statusPollerRestartTimer = null;
let claudePollerRestartTimer = null;
let tray = null;
let compactWindow = null;
let dashboardWindow = null;
let setupWindow = null;
let isQuitting = false;

function parsePositiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function runClaudeStatusHookMode() {
  const statusPath = argValue("--status-path") || CLAUDE_STATUS_PATH;
  const rawInput = fs.readFileSync(0, "utf8");
  const status = buildStatus(rawInput);
  if (!shouldPreserveUsageCommandStatus(statusPath)) {
    writeJsonAtomic(statusPath, status);
  }
  process.stdout.write(`${summaryFromStatus(status)}\n`);
}

function argsAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv.slice(index + 1) : [];
}

function runCodexStatusPollerMode() {
  const options = parsePollerArgs(argsAfter("--codex-status-poller"));
  startPoller(options);
}

function runClaudeUsagePollerMode() {
  const options = parseClaudePollerArgs(argsAfter("--claude-usage-poller"));
  startClaudePoller(options);
}

if (process.argv.includes("--claude-status-hook")) {
  runClaudeStatusHookMode();
  process.exit(0);
}

if (process.argv.includes("--codex-status-poller")) {
  runCodexStatusPollerMode();
  return;
}

if (process.argv.includes("--claude-usage-poller")) {
  runClaudeUsagePollerMode();
  return;
}

app.setName(APP_NAME);
app.setAppUserModelId("local.codex-claude-usage");

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  return;
}

app.on("second-instance", () => {
  showCompactWindow();
});

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

function readPollerPid(pidPath) {
  try {
    const pid = Number(fs.readFileSync(pidPath, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    return null;
  }
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

function processCommandLine(pid) {
  if (process.platform !== "win32") {
    return "";
  }
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
  ], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 3000,
  });
  return result.status === 0 ? result.stdout : "";
}

function isKnownStatusPollerPid(pid) {
  const commandLine = processCommandLine(pid).toLowerCase();
  return commandLine.includes("--codex-status-poller")
    || commandLine.includes("codex-status-poller.js")
    || commandLine.includes("--claude-usage-poller")
    || commandLine.includes("claude-usage-poller.js");
}

function parseStatusTime(value) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isPollerStatusFresh(statusPath, pollIntervalMs, expectedCaptureMethod) {
  const status = readJsonSafe(statusPath);
  if (!status || typeof status !== "object") {
    return false;
  }
  if (expectedCaptureMethod && status.capture_method !== expectedCaptureMethod) {
    return false;
  }

  const poller = status.poller && typeof status.poller === "object" ? status.poller : null;
  const timestamp = parseStatusTime(poller && poller.heartbeat_at) || parseStatusTime(status.captured_at);
  if (timestamp === null) {
    return false;
  }

  const maxAgeMs = Math.max(pollIntervalMs * 2 + 60 * 1000, 10 * 60 * 1000);
  return Date.now() - timestamp <= maxAgeMs;
}

function childRuntime() {
  if (app.isPackaged) {
    return { command: process.execPath, entryArgs: [] };
  }
  if (process.env.npm_node_execpath) {
    return { command: process.env.npm_node_execpath, entryArgs: [path.join(__dirname, "main.js")] };
  }
  return { command: process.execPath, entryArgs: [ROOT] };
}

function pollerArgs(startupDelayMs = null) {
  const args = [
    "--codex-status-poller",
    "--status-path",
    CODEX_STATUS_PATH,
    "--history-dir",
    HISTORY_DIR,
    "--poll-interval-ms",
    String(CODEX_POLL_INTERVAL_MS),
    "--codex-command",
    process.platform === "win32" ? "codex.exe" : "codex",
  ];
  if (startupDelayMs !== null) {
    args.push("--startup-delay-ms", String(startupDelayMs));
  }
  return args;
}

function claudePollerArgs(startupDelayMs = null) {
  const args = [
    "--claude-usage-poller",
    "--status-path",
    CLAUDE_STATUS_PATH,
    "--poll-interval-ms",
    String(CLAUDE_POLL_INTERVAL_MS),
    "--claude-command",
    process.platform === "win32" ? "claude.exe" : "claude",
  ];
  if (startupDelayMs !== null) {
    args.push("--startup-delay-ms", String(startupDelayMs));
  }
  return args;
}

function startStatusPoller({ force = false, startupDelayMs = null } = {}) {
  if (statusPollerProcess && statusPollerProcess.exitCode === null) {
    if (force) {
      stopStatusPoller();
    } else {
      return;
    }
  }

  const existingPid = readPollerPid(POLLER_PID_PATH);
  if (
    !force
    && existingPid !== null
    && isPidRunning(existingPid)
    && isKnownStatusPollerPid(existingPid)
    && isPollerStatusFresh(CODEX_STATUS_PATH, CODEX_POLL_INTERVAL_MS, "codex_status_poller")
  ) {
    return;
  }
  if (existingPid !== null && isPidRunning(existingPid) && isKnownStatusPollerPid(existingPid)) {
    try {
      process.kill(existingPid);
    } catch (error) {
      // Ignore stale poller cleanup failures; the new child can still take over the pid file.
    }
  }

  fs.mkdirSync(STATUS_DIR, { recursive: true });
  const runtime = childRuntime();
  statusPollerProcess = spawn(runtime.command, [...runtime.entryArgs, ...pollerArgs(startupDelayMs)], {
    cwd: ROOT,
    env: process.env,
    windowsHide: true,
    stdio: "ignore",
  });
  fs.writeFileSync(POLLER_PID_PATH, String(statusPollerProcess.pid), "utf8");

  statusPollerProcess.on("error", () => {
    statusPollerProcess = null;
    scheduleStatusPollerRestart();
  });
  statusPollerProcess.on("exit", () => {
    statusPollerProcess = null;
    scheduleStatusPollerRestart();
  });
}

function startClaudeUsagePoller({ force = false, startupDelayMs = null } = {}) {
  if (claudePollerProcess && claudePollerProcess.exitCode === null) {
    if (force) {
      stopClaudeUsagePoller();
    } else {
      return;
    }
  }

  const existingPid = readPollerPid(CLAUDE_POLLER_PID_PATH);
  if (
    !force
    && existingPid !== null
    && isPidRunning(existingPid)
    && isKnownStatusPollerPid(existingPid)
    && isPollerStatusFresh(CLAUDE_STATUS_PATH, CLAUDE_POLL_INTERVAL_MS, "claude_usage_command")
  ) {
    return;
  }
  if (existingPid !== null && isPidRunning(existingPid) && isKnownStatusPollerPid(existingPid)) {
    try {
      process.kill(existingPid);
    } catch (error) {
      // Ignore stale poller cleanup failures; the new child can still take over the pid file.
    }
  }

  fs.mkdirSync(STATUS_DIR, { recursive: true });
  const runtime = childRuntime();
  claudePollerProcess = spawn(runtime.command, [...runtime.entryArgs, ...claudePollerArgs(startupDelayMs)], {
    cwd: ROOT,
    env: process.env,
    windowsHide: true,
    stdio: "ignore",
  });
  fs.writeFileSync(CLAUDE_POLLER_PID_PATH, String(claudePollerProcess.pid), "utf8");

  claudePollerProcess.on("error", () => {
    claudePollerProcess = null;
    scheduleClaudePollerRestart();
  });
  claudePollerProcess.on("exit", () => {
    claudePollerProcess = null;
    scheduleClaudePollerRestart();
  });
}

function scheduleStatusPollerRestart() {
  if (isQuitting || statusPollerRestartTimer) {
    return;
  }
  statusPollerRestartTimer = setTimeout(() => {
    statusPollerRestartTimer = null;
    startStatusPoller();
  }, 30 * 1000);
}

function scheduleClaudePollerRestart() {
  if (isQuitting || claudePollerRestartTimer) {
    return;
  }
  claudePollerRestartTimer = setTimeout(() => {
    claudePollerRestartTimer = null;
    startClaudeUsagePoller();
  }, 30 * 1000);
}

function stopStatusPoller() {
  clearTimeout(statusPollerRestartTimer);
  statusPollerRestartTimer = null;
  if (!statusPollerProcess || statusPollerProcess.exitCode !== null) {
    return;
  }
  statusPollerProcess.kill();
  statusPollerProcess = null;
}

function stopClaudeUsagePoller() {
  clearTimeout(claudePollerRestartTimer);
  claudePollerRestartTimer = null;
  if (!claudePollerProcess || claudePollerProcess.exitCode !== null) {
    return;
  }
  claudePollerProcess.kill();
  claudePollerProcess = null;
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
    alwaysOnTop: false,
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

function executableCandidates(command) {
  if (path.extname(command)) {
    return [command];
  }
  const pathExt = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  return pathExt.split(";").filter(Boolean).map((extension) => `${command}${extension.toLowerCase()}`);
}

function commandExists(command) {
  const pathEntries = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    for (const candidate of executableCandidates(command)) {
      try {
        if (fs.existsSync(path.join(entry, candidate))) {
          return true;
        }
      } catch (error) {
        // Ignore invalid PATH entries and keep checking the rest.
      }
    }
  }
  return false;
}

function commandExistsAny(...commands) {
  return commands.some((command) => commandExists(command));
}

function claudeHookCommand() {
  const runtime = childRuntime();
  const exe = runtime.command.replace(/"/g, '\\"');
  if (app.isPackaged) {
    return `"${exe}" --claude-status-hook`;
  }
  return `"${exe}" "${path.join(__dirname, "main.js").replace(/"/g, '\\"')}" --claude-status-hook`;
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
    poller: {
      codexRunning: Boolean(statusPollerProcess && statusPollerProcess.exitCode === null)
        || isPollerStatusFresh(CODEX_STATUS_PATH, CODEX_POLL_INTERVAL_MS, "codex_status_poller"),
      claudeRunning: Boolean(claudePollerProcess && claudePollerProcess.exitCode === null)
        || isPollerStatusFresh(CLAUDE_STATUS_PATH, CLAUDE_POLL_INTERVAL_MS, "claude_usage_command"),
      codexIntervalMs: CODEX_POLL_INTERVAL_MS,
      claudeIntervalMs: CLAUDE_POLL_INTERVAL_MS,
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
      alwaysOnTop: compactWindow ? compactWindow.isAlwaysOnTop() : false,
      opacity: compactWindow ? compactWindow.getOpacity() : 0.96,
    },
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
  };
}

function buildSetupSnapshot() {
  return {
    ...buildSnapshot(),
    setup: {
      codexCommand: commandExistsAny("codex.exe", "codex"),
      claudeCommand: commandExistsAny("claude.exe", "claude"),
      uvicornCommand: commandExistsAny("uvicorn.exe", "uvicorn"),
      hookCommand: claudeHookCommand(),
    }
  };
}

function refreshUsageSnapshot() {
  startStatusPoller({ force: true, startupDelayMs: 0 });
  startClaudeUsagePoller({ force: true, startupDelayMs: 0 });
  return buildSnapshot();
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
ipcMain.handle("status:refresh", () => refreshUsageSnapshot());
ipcMain.handle("setup:snapshot", () => buildSetupSnapshot());
ipcMain.handle("setup:refresh", () => buildSetupSnapshot());
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
  return true;
});
ipcMain.handle("setup:installClaudeHook", () => {
  installClaudeHook();
  return buildSetupSnapshot();
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
  startStatusPoller();
  startClaudeUsagePoller();
  createTray();
  showCompactWindow();
});

app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  isQuitting = true;
  stopStatusPoller();
  stopClaudeUsagePoller();
  stopDashboardServer();
});
