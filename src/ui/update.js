"use strict";

const currentVersion = document.getElementById("current-version");
const newVersion = document.getElementById("new-version");
const releaseNotes = document.getElementById("release-notes");
const progressSection = document.getElementById("progress-section");
const progressLabel = document.getElementById("progress-label");
const progressValue = document.getElementById("progress-value");
const downloadProgress = document.getElementById("download-progress");
const errorMessage = document.getElementById("error-message");
const postponeButton = document.getElementById("postpone");
const installButton = document.getElementById("install");

let availableUpdate = null;
let installing = false;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "";
  }
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderProgress(progress) {
  progressSection.hidden = false;
  if (progress.event === "preparing") {
    progressLabel.textContent = "서명된 업데이트 준비 중";
    progressValue.textContent = "";
    downloadProgress.removeAttribute("value");
    return;
  }
  if (progress.event === "downloaded") {
    progressLabel.textContent = "서명 확인 완료 · 설치 준비 중";
    progressValue.textContent = "";
    downloadProgress.value = 100;
    return;
  }
  if (progress.event === "installed") {
    progressLabel.textContent = "설치 완료 · 앱 다시 시작 중";
    progressValue.textContent = "100%";
    downloadProgress.value = 100;
    return;
  }

  const downloaded = Number(progress.downloadedBytes) || 0;
  const total = Number(progress.totalBytes);
  progressLabel.textContent = "업데이트 다운로드 중";
  if (Number.isFinite(total) && total > 0) {
    const percent = Math.min(100, Math.round(downloaded / total * 100));
    downloadProgress.value = percent;
    progressValue.textContent = `${percent}% · ${formatBytes(downloaded)} / ${formatBytes(total)}`;
  } else {
    downloadProgress.removeAttribute("value");
    progressValue.textContent = formatBytes(downloaded);
  }
}

function renderState(state) {
  availableUpdate = state.available;
  if (!availableUpdate) {
    throw new Error("표시할 업데이트 정보가 없습니다. 업데이트를 다시 확인하세요.");
  }
  currentVersion.textContent = availableUpdate.currentVersion || state.currentVersion;
  newVersion.textContent = availableUpdate.version;
  releaseNotes.textContent = availableUpdate.notes;
}

async function installAvailableUpdate() {
  if (!availableUpdate || installing) {
    return;
  }
  installing = true;
  installButton.disabled = true;
  postponeButton.disabled = true;
  installButton.textContent = "업데이트 중";
  errorMessage.hidden = true;
  progressSection.hidden = false;
  try {
    await window.usageApp.installUpdate(availableUpdate.version, renderProgress);
  } catch (error) {
    installing = false;
    installButton.disabled = false;
    postponeButton.disabled = false;
    installButton.textContent = "다시 시도";
    progressLabel.textContent = "업데이트 중단됨";
    errorMessage.textContent = `업데이트에 실패했습니다. 현재 앱과 사용 기록은 그대로 유지됩니다. 다시 시도해 주세요. ${String(error)}`;
    errorMessage.hidden = false;
  }
}

async function postponeAvailableUpdate() {
  if (!availableUpdate || installing) {
    return;
  }
  postponeButton.disabled = true;
  try {
    await window.usageApp.postponeUpdate(availableUpdate.version);
    await window.usageApp.close();
  } catch (error) {
    postponeButton.disabled = false;
    errorMessage.textContent = `업데이트 알림을 미루지 못했습니다. ${String(error)}`;
    errorMessage.hidden = false;
  }
}

async function loadUpdate() {
  try {
    renderState(await window.usageApp.getUpdateState());
  } catch (error) {
    installButton.disabled = true;
    errorMessage.textContent = String(error);
    errorMessage.hidden = false;
  }
}

installButton.addEventListener("click", installAvailableUpdate);
postponeButton.addEventListener("click", postponeAvailableUpdate);

loadUpdate();
