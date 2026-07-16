#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { serializeToYaml } = require("builder-util");
const { buildBlockMap } = require("app-builder-lib/out/targets/blockmap/blockmap");

const ROOT = path.resolve(__dirname, "..");

async function refreshReleaseMetadata(installerPath, version) {
  const resolvedInstaller = path.resolve(installerPath);
  const installerName = path.basename(resolvedInstaller);
  const expectedName = `Codex-Claude-Usage-Setup-${version}.exe`;

  if (installerName !== expectedName) {
    throw new Error(`Expected installer name ${expectedName}, received ${installerName}`);
  }
  if (!fs.statSync(resolvedInstaller).isFile()) {
    throw new Error(`Installer is not a file: ${resolvedInstaller}`);
  }

  const blockmapPath = `${resolvedInstaller}.blockmap`;
  const metadataPath = path.join(path.dirname(resolvedInstaller), "latest.yml");
  const { sha512, size } = await buildBlockMap(resolvedInstaller, "gzip", blockmapPath);
  const metadata = {
    version,
    files: [{ url: installerName, sha512, size }],
    path: installerName,
    sha512,
    releaseDate: new Date().toISOString(),
  };

  fs.writeFileSync(metadataPath, serializeToYaml(metadata, false, true), "utf8");
  return { blockmapPath, metadataPath, sha512, size };
}

async function main() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const installerPath = process.argv[2] || path.join(ROOT, "dist", `Codex-Claude-Usage-Setup-${packageJson.version}.exe`);
  const result = await refreshReleaseMetadata(installerPath, packageJson.version);
  process.stdout.write(`refreshed ${result.blockmapPath} and ${result.metadataPath}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exit(1);
  });
}

module.exports = { refreshReleaseMetadata };
