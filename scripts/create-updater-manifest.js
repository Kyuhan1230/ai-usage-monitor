#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const REPOSITORY = "Kyuhan1230/ai-usage-monitor";

function projectVersion() {
  const packageJson = require(path.join(ROOT, "package.json"));
  const tauriConfig = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
  const cargoToml = fs.readFileSync(path.join(ROOT, "src-tauri", "Cargo.toml"), "utf8");
  const cargoVersion = cargoToml.match(/^version\s*=\s*"([^"]+)"/m);
  if (!cargoVersion) {
    throw new Error("Cargo package version is missing");
  }
  const versions = [packageJson.version, tauriConfig.version, cargoVersion[1]];
  if (!versions.every((version) => version === versions[0])) {
    throw new Error(`Project versions do not match: ${versions.join(", ")}`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(versions[0])) {
    throw new Error(`Invalid SemVer: ${versions[0]}`);
  }
  return versions[0];
}

function createManifest(signaturePath, outputPath, notes) {
  const version = projectVersion();
  const installerName = `Codex-Claude-Usage-Setup-${version}.exe`;
  const signature = fs.readFileSync(signaturePath, "utf8").trim();
  if (!signature || /^https?:\/\//i.test(signature)) {
    throw new Error("Updater signature must be the .sig file content, not a URL");
  }
  const manifest = {
    version,
    notes: notes || "안정성과 사용 경험을 개선한 새 버전입니다.",
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": {
        signature,
        url: `https://github.com/${REPOSITORY}/releases/download/v${version}/${installerName}`,
      },
    },
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

if (require.main === module) {
  const [, , signaturePath, outputPath, ...noteParts] = process.argv;
  if (!signaturePath || !outputPath) {
    process.stderr.write("Usage: create-updater-manifest.js <signature-file> <output-file> [notes]\n");
    process.exit(1);
  }
  const manifest = createManifest(path.resolve(signaturePath), path.resolve(outputPath), noteParts.join(" ").trim());
  process.stdout.write(`Created latest.json for ${manifest.version}.\n`);
}

module.exports = { createManifest, projectVersion };
