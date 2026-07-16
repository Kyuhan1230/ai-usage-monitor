"use strict";

const fs = require("fs");
const path = require("path");
const { writeJsonAtomic } = require("../node/status-capture");

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("Claude settings.json is not an object");
  }
  return settings;
}

function isManagedHookCommand(command) {
  const normalized = String(command || "").replace(/\//g, "\\").toLowerCase();
  return normalized.includes("--claude-status-hook")
    || normalized.includes("claude-status-hook.js");
}

function backupPathFor(settingsPath, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return `${settingsPath}.backup-${stamp}`;
}

async function installClaudeHookSettings({
  settingsPath,
  command,
  confirmReplace = async () => false,
  now = new Date(),
}) {
  const settings = readSettings(settingsPath);
  const existingCommand = settings.statusLine && settings.statusLine.command;
  let backupPath = null;

  if (
    typeof existingCommand === "string"
    && existingCommand.trim()
    && !isManagedHookCommand(existingCommand)
  ) {
    const shouldReplace = await confirmReplace(existingCommand);
    if (!shouldReplace) {
      return { status: "preserved", existingCommand, backupPath: null };
    }
    backupPath = backupPathFor(settingsPath, now);
    fs.copyFileSync(settingsPath, backupPath);
  }

  settings.statusLine = {
    type: "command",
    command,
  };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  writeJsonAtomic(settingsPath, settings);
  return { status: "installed", existingCommand: existingCommand || null, backupPath };
}

module.exports = {
  backupPathFor,
  installClaudeHookSettings,
  isManagedHookCommand,
  readSettings,
};
