#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createManifest, projectVersion } = require("../scripts/create-updater-manifest");
const { verifyManifest } = require("../scripts/verify-updater-manifest");

const releaseWorkflow = fs.readFileSync(
  path.join(__dirname, "..", ".github", "workflows", "release.yml"),
  "utf8",
);
assert.match(releaseWorkflow, /Authenticode 코드 서명이 적용되지 않았습니다/);
assert.match(releaseWorkflow, /v1\.1\.1 사용자는 현재 릴리스 설치 파일을 한 번 직접 내려받아 설치/);
assert.match(releaseWorkflow, /--notes \$releaseNotice --generate-notes/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "updater-manifest-"));
try {
  const version = projectVersion();
  const installer = path.join(root, `Codex-Claude-Usage-Setup-${version}.exe`);
  const signature = `${installer}.sig`;
  const manifest = path.join(root, "latest.json");
  fs.writeFileSync(installer, Buffer.from("signed-installer-fixture"));
  fs.writeFileSync(signature, "trusted-signature-fixture\n", "utf8");

  createManifest(signature, manifest, "업데이트 manifest 테스트");
  const result = verifyManifest(manifest, installer, signature, `v${version}`);
  assert.strictEqual(result.version, version);

  const changed = JSON.parse(fs.readFileSync(manifest, "utf8"));
  changed.platforms["windows-x86_64"].signature = "tampered";
  fs.writeFileSync(manifest, JSON.stringify(changed), "utf8");
  assert.throws(() => verifyManifest(manifest, installer, signature, `v${version}`), /signature/);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write("PASS updater manifest 생성과 변조 거부 계약을 검증했습니다.\n");
