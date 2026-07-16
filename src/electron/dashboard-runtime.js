"use strict";

const path = require("path");

function resolveDashboardRuntime({ root, isPackaged, platform, commandExists, fileExists }) {
  if (isPackaged && platform === "win32") {
    const bundledPython = path.join(root, "runtime", "python", "python.exe");
    if (fileExists(bundledPython)) {
      return {
        command: bundledPython,
        entryArgs: ["-m", "uvicorn"],
        bundled: true,
      };
    }
  }

  const uvicornCommand = platform === "win32" ? "uvicorn.exe" : "uvicorn";
  if (commandExists(uvicornCommand) || commandExists("uvicorn")) {
    return { command: "uvicorn", entryArgs: [], bundled: false };
  }

  const pythonCandidates = platform === "win32" ? ["python.exe", "python"] : ["python3", "python"];
  const pythonCommand = pythonCandidates.find((candidate) => commandExists(candidate));
  if (pythonCommand) {
    return { command: pythonCommand, entryArgs: ["-m", "uvicorn"], bundled: false };
  }

  return null;
}

module.exports = { resolveDashboardRuntime };
