"use strict";

const fs = require("fs");
const { writeJsonAtomic } = require("../node/status-capture");

function readPreferences(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function getLaunchAtLoginPreference(filePath) {
  return readPreferences(filePath).launchAtLogin === true;
}

function setLaunchAtLoginPreference(filePath, enabled) {
  const preferences = readPreferences(filePath);
  preferences.launchAtLogin = Boolean(enabled);
  writeJsonAtomic(filePath, preferences);
  return preferences.launchAtLogin;
}

module.exports = {
  getLaunchAtLoginPreference,
  readPreferences,
  setLaunchAtLoginPreference,
};
