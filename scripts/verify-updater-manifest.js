#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { projectVersion } = require("./create-updater-manifest");

const REPOSITORY = "Kyuhan1230/ai-usage-monitor";
const MAX_INSTALLER_BYTES = 20 * 1024 * 1024;

function verifyManifest(manifestPath, installerPath, signaturePath, expectedTag) {
  const version = projectVersion();
  const installerName = `Codex-Claude-Usage-Setup-${version}.exe`;
  const signatureName = `${installerName}.sig`;
  if (path.basename(installerPath) !== installerName) {
    throw new Error(`Unexpected installer name: ${path.basename(installerPath)}`);
  }
  if (path.basename(signaturePath) !== signatureName) {
    throw new Error(`Unexpected signature name: ${path.basename(signaturePath)}`);
  }
  const installerSize = fs.statSync(installerPath).size;
  if (installerSize <= 0 || installerSize > MAX_INSTALLER_BYTES) {
    throw new Error(`Installer size is outside the 20 MB budget: ${installerSize}`);
  }
  const signature = fs.readFileSync(signaturePath, "utf8").trim();
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.version !== version) {
    throw new Error(`Manifest version ${manifest.version} does not match ${version}`);
  }
  if (expectedTag && expectedTag !== `v${version}`) {
    throw new Error(`Release tag ${expectedTag} does not match v${version}`);
  }
  if (!manifest.notes || Number.isNaN(Date.parse(manifest.pub_date))) {
    throw new Error("Manifest notes and RFC 3339 publication date are required");
  }
  if (Object.keys(manifest.platforms || {}).join(",") !== "windows-x86_64") {
    throw new Error("Manifest must contain exactly the windows-x86_64 platform");
  }
  const platform = manifest.platforms["windows-x86_64"];
  const expectedUrl = `https://github.com/${REPOSITORY}/releases/download/v${version}/${installerName}`;
  if (platform.url !== expectedUrl) {
    throw new Error(`Manifest URL does not match the release asset: ${platform.url}`);
  }
  if (platform.signature !== signature) {
    throw new Error("Manifest signature does not exactly match the .sig file");
  }
  return { version, installerName, signatureName, installerSize };
}

if (require.main === module) {
  const [, , manifestPath, installerPath, signaturePath, expectedTag] = process.argv;
  if (!manifestPath || !installerPath || !signaturePath) {
    process.stderr.write("Usage: verify-updater-manifest.js <latest.json> <installer> <signature> [tag]\n");
    process.exit(1);
  }
  const result = verifyManifest(
    path.resolve(manifestPath),
    path.resolve(installerPath),
    path.resolve(signaturePath),
    expectedTag,
  );
  process.stdout.write(`Verified updater manifest ${result.version} and ${result.installerSize} byte installer.\n`);
}

module.exports = { verifyManifest };
