"use strict";

const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage } = require("electron");
const { autoUpdater } = require("electron-updater");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { captureOnce: captureCodexAccountOnce } = require("../node/codex-account-reader");
const { captureOnceAsync: captureClaudeUsageOnce } = require("../node/claude-account-reader");
const { buildStatus, shouldPreserveUsageCommandStatus, summaryFromStatus } = require("../node/claude-status-hook");
const { appendHistoryIfChanged, writeJsonAtomic } = require("../node/status-capture");
const { scanTokenUsage } = require("../node/token-usage-reader");
const { buildAnalytics, readHistoryRecords } = require("../node/usage-analytics");
const { getLaunchAtLoginPreference, setLaunchAtLoginPreference } = require("./app-preferences");
const { installClaudeHookSettings } = require("./claude-hook-settings");
const { createUpdaterController } = require("./updater");

const APP_NAME = "Codex Claude Usage";
const ROOT = path.resolve(__dirname, "..", "..");
const APP_ICON_PATH = path.join(ROOT, "assets", "codex-claude-usage.ico");
const STATUS_DIR = path.join(os.homedir(), ".codex-usage-wrapper");
const PREFERENCES_PATH = path.join(STATUS_DIR, "preferences.json");
const CODEX_STATUS_PATH = path.join(STATUS_DIR, "status.json");
const CLAUDE_STATUS_PATH = path.join(STATUS_DIR, "claude-status.json");
const HISTORY_DIR = path.join(STATUS_DIR, "history");
const ANALYTICS_PATH = path.join(STATUS_DIR, "analytics.json");
const ON_DEMAND_FRESHNESS_MS = 10 * 60 * 1000;
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
const CLAUDE_HOOK_PATH = path.join(ROOT, "src", "node", "claude-status-hook.js");

let tray = null;
let compactWindow = null;
let insightsWindow = null;
let detailsWindow = null;
let setupWindow = null;
let refreshPromise = null;
let lastRefresh = { state: "idle", completedAt: null, errors: {} };
let analyticsSnapshot = null;
let lastAlertSignature = "";
const updaterController = createUpdaterController({
  app,
  autoUpdater,
  dialog,
  getWindow: () => compactWindow || insightsWindow || setupWindow || detailsWindow,
});

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function runClaudeStatusHookMode() {
  const statusPath = argValue("--status-path") || CLAUDE_STATUS_PATH;
  const rawInput = fs.readFileSync(0, "utf8");
  const status = buildStatus(rawInput);
  const previousStatus = readJsonSafe(statusPath);
  if (!shouldPreserveUsageCommandStatus(statusPath)) {
    writeJsonAtomic(statusPath, status);
    appendHistoryIfChanged(HISTORY_DIR, status, previousStatus);
  }
  process.stdout.write(`${summaryFromStatus(status)}\n`);
}

if (process.argv.includes("--claude-status-hook")) {
  runClaudeStatusHookMode();
  process.exit(0);
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
  const image = nativeImage.createFromPath(APP_ICON_PATH);
  if (image.isEmpty()) {
    throw new Error(`App icon could not be loaded: ${APP_ICON_PATH}`);
  }
  return image;
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
    icon: APP_ICON_PATH,
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

function showDetailsWindow() {
  if (detailsWindow) {
    detailsWindow.show();
    detailsWindow.focus();
    return;
  }

  detailsWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#11141b",
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  detailsWindow.loadFile(path.join(__dirname, "renderer", "details.html"));
  detailsWindow.on("closed", () => {
    detailsWindow = null;
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

async function installClaudeHook() {
  return installClaudeHookSettings({
    settingsPath: CLAUDE_SETTINGS_PATH,
    command: claudeHookCommand(),
    confirmReplace: async (existingCommand) => {
      const options = {
        type: "warning",
        title: "기존 Claude statusLine 설정 발견",
        message: "다른 statusLine 명령이 이미 설정되어 있습니다.",
        detail: `기존 명령:\n${existingCommand}\n\n교체하면 원본 settings.json을 먼저 백업합니다.`,
        buttons: ["기존 설정 유지", "백업 후 교체"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
      const result = setupWindow
        ? await dialog.showMessageBox(setupWindow, options)
        : await dialog.showMessageBox(options);
      return result.response === 1;
    },
  });
}

function applyLaunchAtLoginPreference() {
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
    openAtLogin: getLaunchAtLoginPreference(PREFERENCES_PATH),
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

function notifyAnalyticsAlerts(analytics) {
  const alerts = analytics && Array.isArray(analytics.alerts)
    ? analytics.alerts.filter((alert) => alert.severity === "critical" || alert.reason === "forecast_before_reset")
    : [];
  const signature = JSON.stringify(alerts.map((alert) => [alert.provider, alert.limitType, alert.reason, alert.remainingPercent]));
  if (!alerts.length || signature === lastAlertSignature || !Notification.isSupported()) {
    lastAlertSignature = signature;
    return;
  }
  lastAlertSignature = signature;
  const first = alerts[0];
  const provider = first.provider === "codex" ? "Codex" : "Claude";
  const reason = first.reason === "forecast_before_reset" ? "현재 속도면 reset 전에 고갈됩니다." : `${first.remainingPercent}% 남았습니다.`;
  new Notification({
    title: `${provider} 사용량 경고`,
    body: `${reason}${alerts.length > 1 ? ` 외 ${alerts.length - 1}건` : ""}`,
  }).show();
}

function showInsightsWindow() {
  if (insightsWindow) {
    insightsWindow.show();
    insightsWindow.focus();
    return;
  }

  insightsWindow = new BrowserWindow({
    width: 820,
    height: 760,
    minWidth: 680,
    minHeight: 600,
    backgroundColor: "#0f131a",
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  insightsWindow.loadFile(path.join(__dirname, "renderer", "insights.html"));
  insightsWindow.on("closed", () => {
    insightsWindow = null;
  });
}

function refreshAnalyticsSnapshot() {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      try {
        const next = buildAnalytics({
          historyRecords: readHistoryRecords(HISTORY_DIR),
          usageRows: scanTokenUsage(),
          currentStatuses: {
            codex: readJsonSafe(CODEX_STATUS_PATH),
            claude: readJsonSafe(CLAUDE_STATUS_PATH),
          },
        });
        writeJsonAtomic(ANALYTICS_PATH, next);
        analyticsSnapshot = next;
        notifyAnalyticsAlerts(next);
        resolve(next);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function buildSnapshot() {
  const codex = readJsonSafe(CODEX_STATUS_PATH);
  const claude = readJsonSafe(CLAUDE_STATUS_PATH);
  return {
    capturedAt: new Date().toISOString(),
    details: {
      running: Boolean(detailsWindow),
      mode: "embedded",
    },
    capture: {
      mode: "on_demand",
      codexFreshnessMs: ON_DEMAND_FRESHNESS_MS,
      claudeFreshnessMs: ON_DEMAND_FRESHNESS_MS,
    },
    refresh: lastRefresh,
    analytics: analyticsSnapshot,
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
      hookCommand: claudeHookCommand(),
    }
  };
}

async function refreshUsageSnapshot() {
  if (refreshPromise) {
    return refreshPromise;
  }

  lastRefresh = { state: "running", completedAt: null, errors: {} };
  refreshPromise = Promise.allSettled([
    captureCodexAccountOnce({
      codexCommand: process.platform === "win32" ? "codex.exe" : "codex",
      statusPath: CODEX_STATUS_PATH,
      historyDir: HISTORY_DIR,
      clientVersion: app.getVersion(),
    }),
    captureClaudeUsageOnce({
      claudeCommand: process.platform === "win32" ? "claude.exe" : "claude",
      statusPath: CLAUDE_STATUS_PATH,
      historyDir: HISTORY_DIR,
      pollIntervalMs: 0,
    }),
  ]).then(async (results) => {
    const errors = {};
    if (results[0].status === "rejected") {
      errors.codex = results[0].reason instanceof Error
        ? results[0].reason.message
        : String(results[0].reason);
    }
    if (results[1].status === "rejected") {
      errors.claude = results[1].reason instanceof Error
        ? results[1].reason.message
        : String(results[1].reason);
    } else if (!results[1].value || results[1].value.parse_status !== "ok") {
      errors.claude = results[1].value && results[1].value.error
        ? results[1].value.error
        : "Claude /usage did not return a usable account snapshot";
    }
    try {
      await refreshAnalyticsSnapshot();
    } catch (error) {
      errors.analytics = error instanceof Error ? error.message : String(error);
    }
    lastRefresh = {
      state: Object.keys(errors).length === 0 ? "ok" : "partial",
      completedAt: new Date().toISOString(),
      errors,
    };
    return buildSnapshot();
  }).finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
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
    icon: APP_ICON_PATH,
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
      { label: "Usage insights", click: showInsightsWindow },
      { label: "Token details", click: showDetailsWindow },
      { label: "Setup", click: showSetupWindow },
      { label: "Check for updates...", click: () => updaterController.check(true) },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", showCompactWindow);
}

ipcMain.handle("status:snapshot", () => buildSnapshot());
ipcMain.handle("status:refresh", () => refreshUsageSnapshot());
ipcMain.handle("setup:snapshot", () => buildSetupSnapshot());
ipcMain.handle("setup:refresh", async () => {
  await refreshUsageSnapshot();
  return buildSetupSnapshot();
});
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
ipcMain.handle("details:open", () => {
  showDetailsWindow();
  return buildSnapshot();
});
ipcMain.handle("setup:open", () => {
  showSetupWindow();
  return true;
});
ipcMain.handle("setup:installClaudeHook", async () => {
  const result = await installClaudeHook();
  return { result, snapshot: buildSetupSnapshot() };
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
  const openAtLogin = setLaunchAtLoginPreference(PREFERENCES_PATH, enabled);
  app.setLoginItemSettings({
    openAtLogin,
    path: process.execPath,
    args: app.isPackaged ? [] : [ROOT],
  });
  return buildSnapshot();
});
ipcMain.handle("app:quit", () => {
  app.quit();
});

app.whenReady().then(() => {
  applyLaunchAtLoginPreference();
  analyticsSnapshot = readJsonSafe(ANALYTICS_PATH);
  createTray();
  showCompactWindow();
  refreshUsageSnapshot().catch(() => {});
  updaterController.start();
});

app.on("window-all-closed", () => {});

ipcMain.handle("insights:open", () => {
  showInsightsWindow();
  return true;
});
