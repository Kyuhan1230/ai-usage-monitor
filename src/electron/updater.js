"use strict";

const DEFAULT_STARTUP_DELAY_MS = 15 * 1000;
const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function createUpdaterController({
  app,
  autoUpdater,
  dialog,
  getWindow = () => null,
  logger = console,
  platform = process.platform,
  setTimeoutFn = setTimeout,
  setIntervalFn = setInterval,
  startupDelayMs = DEFAULT_STARTUP_DELAY_MS,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
}) {
  let started = false;
  let checking = false;
  let manualCheck = false;
  let downloading = false;

  function isSupported() {
    return platform === "win32" && app.isPackaged;
  }

  function parentWindow() {
    const candidate = getWindow();
    return candidate && !candidate.isDestroyed() ? candidate : null;
  }

  function showMessage(options) {
    const parent = parentWindow();
    return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  }

  async function showUnsupportedMessage() {
    await showMessage({
      type: "info",
      title: "업데이트 확인",
      message: "업데이트 확인은 Windows 설치본에서 사용할 수 있습니다.",
      detail: "개발 실행 중에는 GitHub Releases 자동 업데이트가 비활성화됩니다.",
      buttons: ["확인"],
    });
  }

  async function check(manual = false) {
    if (!isSupported()) {
      if (manual) {
        await showUnsupportedMessage();
      }
      return false;
    }

    if (checking || downloading) {
      if (manual) {
        await showMessage({
          type: "info",
          title: "업데이트 확인",
          message: downloading ? "업데이트를 다운로드하고 있습니다." : "이미 업데이트를 확인하고 있습니다.",
          buttons: ["확인"],
        });
      }
      return false;
    }

    checking = true;
    manualCheck = manual;
    try {
      await autoUpdater.checkForUpdates();
      return true;
    } catch (error) {
      checking = false;
      logger.error("Update check failed", error);
      if (manual) {
        await showMessage({
          type: "warning",
          title: "업데이트 확인 실패",
          message: "GitHub에서 업데이트 정보를 확인하지 못했습니다.",
          detail: String(error && error.message ? error.message : error),
          buttons: ["확인"],
        });
      }
      return false;
    }
  }

  function start() {
    if (started || !isSupported()) {
      return false;
    }
    started = true;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.disableWebInstaller = true;

    autoUpdater.on("update-available", async (info) => {
      checking = false;
      manualCheck = false;
      const version = info && info.version ? info.version : "새 버전";
      const result = await showMessage({
        type: "info",
        title: "새 업데이트 발견",
        message: `Codex Claude Usage ${version} 버전이 있습니다.`,
        detail: "지금 다운로드할까요? 앱을 사용하는 동안 백그라운드에서 다운로드됩니다.",
        buttons: ["다운로드", "나중에"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response !== 0) {
        return;
      }
      downloading = true;
      try {
        await autoUpdater.downloadUpdate();
      } catch (error) {
        downloading = false;
        logger.error("Update download failed", error);
        await showMessage({
          type: "warning",
          title: "업데이트 다운로드 실패",
          message: "업데이트 설치 파일을 다운로드하지 못했습니다.",
          detail: String(error && error.message ? error.message : error),
          buttons: ["확인"],
        });
      }
    });

    autoUpdater.on("update-not-available", async () => {
      checking = false;
      if (!manualCheck) {
        return;
      }
      manualCheck = false;
      await showMessage({
        type: "info",
        title: "업데이트 확인",
        message: "현재 최신 버전을 사용하고 있습니다.",
        detail: `설치된 버전: ${app.getVersion()}`,
        buttons: ["확인"],
      });
    });

    autoUpdater.on("update-downloaded", async (info) => {
      downloading = false;
      const version = info && info.version ? info.version : "새 버전";
      const result = await showMessage({
        type: "info",
        title: "업데이트 준비 완료",
        message: `${version} 버전 다운로드가 완료되었습니다.`,
        detail: "지금 앱을 재시작해 설치하거나, 앱을 종료할 때 설치할 수 있습니다.",
        buttons: ["재시작 후 설치", "종료할 때 설치"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response === 0) {
        // The user already approved the update in our dialog. Run the assisted
        // NSIS installer silently so it does not ask for installation options
        // a second time before replacing the current version.
        autoUpdater.quitAndInstall(true, true);
      }
    });

    autoUpdater.on("error", (error) => {
      checking = false;
      manualCheck = false;
      logger.error("Auto updater error", error);
    });

    const startupTimer = setTimeoutFn(() => check(false), startupDelayMs);
    if (startupTimer && typeof startupTimer.unref === "function") {
      startupTimer.unref();
    }
    const intervalTimer = setIntervalFn(() => check(false), checkIntervalMs);
    if (intervalTimer && typeof intervalTimer.unref === "function") {
      intervalTimer.unref();
    }
    return true;
  }

  return { check, isSupported, start };
}

module.exports = {
  DEFAULT_CHECK_INTERVAL_MS,
  DEFAULT_STARTUP_DELAY_MS,
  createUpdaterController,
};
