#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, ipcMain } = require("electron");

const ROOT = path.resolve(__dirname, "..");
const IMAGE_DIR = path.join(ROOT, "docs", "images");
const RENDERER_DIR = path.join(ROOT, "src", "electron", "renderer");
const PRELOAD_PATH = path.join(ROOT, "src", "electron", "preload.js");

const usageRows = [
  { provider: "codex", date: "2026-07-17", model: "gpt-5.3-codex", inputTokens: 182400, cachedInputTokens: 126000, cacheCreationInputTokens: 0, outputTokens: 28900, totalTokens: 211300, estimatedUsd: 0.8421 },
  { provider: "codex", date: "2026-07-17", model: "gpt-5.4-mini", inputTokens: 96200, cachedInputTokens: 64500, cacheCreationInputTokens: 0, outputTokens: 18400, totalTokens: 114600, estimatedUsd: 0.1115 },
  { provider: "claude", date: "2026-07-17", model: "claude-sonnet-4.6", inputTokens: 74000, cachedInputTokens: 52000, cacheCreationInputTokens: 8500, outputTokens: 12600, totalTokens: 147100, estimatedUsd: 0.4477 },
  { provider: "claude", date: "2026-07-16", model: "claude-haiku-4.5", inputTokens: 31500, cachedInputTokens: 18300, cacheCreationInputTokens: 3200, outputTokens: 7900, totalTokens: 60900, estimatedUsd: 0.0768 },
];

const sampleAnalytics = {
  generatedAt: "2026-07-17T09:20:00Z",
  historySampleCount: 28,
  usageRowCount: usageRows.length,
  usage: { rows: usageRows },
  alerts: [{ provider: "codex", limitType: "five_hour", severity: "warning", remainingPercent: 22, reason: "forecast_before_reset" }],
  comparison: { todayTokens: 376200, yesterdayTokens: 298100, dayOverDayPercent: 26.2, currentSevenDaysTokens: 1842200, previousSevenDaysTokens: 1570300, weekOverWeekPercent: 17.3 },
  providers: {
    codex: { limits: {
      five_hour: { remainingPercent: 22, sampleCount: 10, depletionRatePercentPerHour: 12.4, expectedExhaustionAt: "2026-07-17T11:06:00Z", resetAt: "2026-07-17T12:30:00Z", willExhaustBeforeReset: true, confidence: "high", anomaly: { detected: false } },
      weekly: { remainingPercent: 48, sampleCount: 16, depletionRatePercentPerHour: 0.31, expectedExhaustionAt: "2026-07-23T20:00:00Z", resetAt: "2026-07-21T00:00:00Z", willExhaustBeforeReset: false, confidence: "high", anomaly: { detected: false } },
      monthly: null,
    } },
    claude: { limits: {
      five_hour: { remainingPercent: 56, sampleCount: 8, depletionRatePercentPerHour: 5.8, expectedExhaustionAt: "2026-07-17T18:59:00Z", resetAt: "2026-07-17T13:00:00Z", willExhaustBeforeReset: false, confidence: "medium", anomaly: { detected: false } },
      seven_day: { remainingPercent: 64, sampleCount: 12, depletionRatePercentPerHour: 0.22, expectedExhaustionAt: "2026-07-29T12:00:00Z", resetAt: "2026-07-23T01:00:00Z", willExhaustBeforeReset: false, confidence: "high", anomaly: { detected: false } },
    } },
  },
  anomalies: { codex: { detected: true, multiplier: 2.4 }, claude: { detected: false } },
  costs: {
    estimatedUsd: 1.4823,
    providers: {
      codex: { estimatedUsd: 0.8421, totalTokens: 211300, coveragePercent: 100, savings: { fromModel: "gpt-5.3-codex", toModel: "codex-mini-latest", estimatedUsd: 0.19, percent: 31.4 } },
      claude: { estimatedUsd: 0.6402, totalTokens: 164900, coveragePercent: 100, savings: { fromModel: "claude-sonnet-4.6", toModel: "claude-haiku-4.5", estimatedUsd: 0.37, percent: 58.1 } },
    },
  },
  recommendations: [
    { priority: "warning", action: "Codex 사용 속도를 약 20% 줄이면 reset 전 고갈을 피할 가능성이 큽니다." },
    { priority: "warning", action: "오늘 Codex 토큰 사용량이 최근 중앙값의 2.4배입니다. 자동 반복 작업과 큰 컨텍스트 입력을 점검하세요." },
    { priority: "info", action: "단순 Claude 작업을 claude-haiku-4.5로 보내면 같은 토큰 기준 오늘 약 $0.37를 절약할 수 있습니다." },
  ],
};

const sampleSnapshot = {
  analytics: sampleAnalytics,
  capture: { codexFreshnessMs: 600000, claudeFreshnessMs: 600000 },
  codex: {
    connected: true,
    ageMs: 42000,
    status: { capture: { state: "on_demand_ok" } },
    limits: {
      five_hour: { remaining_percent: 72, reset_text: "resets 07/17 18:30" },
      weekly: { remaining_percent: 48, reset_text: "resets 07/21 09:00" },
    },
  },
  claude: {
    connected: true,
    hookInstalled: true,
    ageMs: 68000,
    status: { capture: { state: "on_demand_ok" } },
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
    hookCommand: "Codex Claude Usage --claude-status-hook",
  },
};

function registerPreviewHandlers() {
  ipcMain.handle("status:snapshot", () => sampleSnapshot);
  ipcMain.handle("status:refresh", () => sampleSnapshot);
  ipcMain.handle("setup:snapshot", () => sampleSetupSnapshot);
  ipcMain.handle("setup:refresh", () => sampleSetupSnapshot);
  ipcMain.handle("window:setAlwaysOnTop", () => sampleSnapshot);
  ipcMain.handle("window:setOpacity", () => sampleSnapshot);
  for (const channel of ["window:minimize", "details:open", "insights:open", "setup:open", "setup:openCodexLogin", "setup:openClaudeAuth", "app:quit"]) {
    ipcMain.handle(channel, () => true);
  }
  ipcMain.handle("setup:installClaudeHook", () => sampleSetupSnapshot);
  ipcMain.handle("app:setLaunchAtLogin", () => sampleSetupSnapshot);
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

async function captureWindow(window, width, height, outputName, fileName) {
  window.setContentSize(width, height);
  await window.loadFile(path.join(RENDERER_DIR, fileName));
  await window.webContents.executeJavaScript("document.fonts.ready.then(() => true)");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const image = await window.webContents.capturePage();
  fs.writeFileSync(path.join(IMAGE_DIR, outputName), image.toPNG());
}

async function main() {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  registerPreviewHandlers();
  const window = createPreviewWindow();
  try {
    await captureWindow(window, 360, 430, "app-compact.png", "compact.html");
    await captureWindow(window, 560, 720, "app-setup.png", "setup.html");
    await captureWindow(window, 820, 1280, "app-insights.png", "insights.html");
    await captureWindow(window, 1180, 760, "app-details.png", "details.html");
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
