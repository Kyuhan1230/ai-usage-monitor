"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("usageApp", {
  snapshot: () => ipcRenderer.invoke("status:snapshot"),
  refreshSnapshot: () => ipcRenderer.invoke("status:refresh"),
  setupSnapshot: () => ipcRenderer.invoke("setup:snapshot"),
  refreshSetupSnapshot: () => ipcRenderer.invoke("setup:refresh"),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke("window:setAlwaysOnTop", enabled),
  setOpacity: (value) => ipcRenderer.invoke("window:setOpacity", value),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  openDashboard: () => ipcRenderer.invoke("dashboard:open"),
  openSetup: () => ipcRenderer.invoke("setup:open"),
  installClaudeHook: () => ipcRenderer.invoke("setup:installClaudeHook"),
  openCodexLogin: () => ipcRenderer.invoke("setup:openCodexLogin"),
  openClaudeAuth: () => ipcRenderer.invoke("setup:openClaudeAuth"),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke("app:setLaunchAtLogin", enabled),
  quit: () => ipcRenderer.invoke("app:quit"),
});
