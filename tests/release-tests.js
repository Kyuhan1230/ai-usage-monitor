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
const e2eWorkflow = fs.readFileSync(
  path.join(__dirname, "..", ".github", "workflows", "updater-e2e-release.yml"),
  "utf8",
);
const ciWorkflow = fs.readFileSync(
  path.join(__dirname, "..", ".github", "workflows", "ci.yml"),
  "utf8",
);
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
assert.match(releaseWorkflow, /Authenticode 코드 서명이 적용되지 않았습니다/);
assert.match(releaseWorkflow, /v1\.1\.1 사용자는 현재 릴리스 설치 파일을 한 번 직접 내려받아 설치/);
assert.match(releaseWorkflow, /--notes \$releaseNotice --generate-notes/);
assert.match(releaseWorkflow, /Invoke-RestMethod/);
assert.match(releaseWorkflow, /\$candidate\.version -eq \$version/);
assert.match(releaseWorkflow, /Published manifest signature is empty/);
assert.doesNotMatch(releaseWorkflow, /\$response\.Content \| ConvertFrom-Json/);
assert.match(releaseWorkflow, /group: release-publication/);
assert.match(releaseWorkflow, /environment: production-release/);
assert.match(releaseWorkflow, /RELEASE_TAG: \$\{\{ github\.ref_name \}\}/);
assert.strictEqual(
  (releaseWorkflow.match(/\$\{\{ github\.ref_name \}\}/g) || []).length,
  1,
);
assert.match(releaseWorkflow, /Draft release hash mismatch/);
assert.match(releaseWorkflow, /gh release download/);
assert.match(releaseWorkflow, /verify:updater-signature/);
assert.match(releaseWorkflow, /Remote updater manifest verification failed/);
assert.match(releaseWorkflow, /Remote updater signature verification failed/);
assert.match(releaseWorkflow, /Post-publish canary/);
assert.match(e2eWorkflow, /workflow_dispatch:/);
assert.match(e2eWorkflow, /PREPARE_SIGNED_E2E/);
assert.match(e2eWorkflow, /DELETE_SIGNED_E2E/);
assert.match(e2eWorkflow, /updater-e2e-\$\{\{ github\.run_id \}\}/);
assert.match(e2eWorkflow, /--prerelease/);
assert.match(e2eWorkflow, /--latest=false/);
assert.match(e2eWorkflow, /refs\/heads\/main/);
assert.doesNotMatch(e2eWorkflow, /if \('\$\{\{ github\.ref \}\}'/);
assert.match(e2eWorkflow, /origin\/main tip/);
assert.match(e2eWorkflow, /E2E_SEED_VERSION=\$baseVersion-e2e\.0/);
assert.match(e2eWorkflow, /tauri signer generate/);
assert.match(e2eWorkflow, /E2E_PUBLIC_KEY=\$publicKey/);
assert.doesNotMatch(e2eWorkflow, /ToBase64String/);
assert.doesNotMatch(e2eWorkflow, /secrets\.TAURI_SIGNING_PRIVATE_KEY/);
assert.match(e2eWorkflow, /local\.codex-claude-usage\.e2e/);
assert.strictEqual(
  (e2eWorkflow.match(/mainBinaryName = 'codex-claude-usage-e2e'/g) || []).length,
  2,
);
assert.match(e2eWorkflow, /--features updater-e2e/);
assert.match(
  fs.readFileSync(path.join(__dirname, "..", "src-tauri", "src", "storage.rs"), "utf8"),
  /cfg\(feature = "updater-e2e"\)[\s\S]*codex-claude-usage-updater-e2e/,
);
assert.match(e2eWorkflow, /verify:updater-signature/);
assert.match(e2eWorkflow, /latest-e2e\.json/);
assert.match(e2eWorkflow, /Production latest changed/);
assert.match(e2eWorkflow, /Remote E2E asset hash mismatch/);
assert.match(e2eWorkflow, /Remote E2E updater signature verification failed/);
assert.match(e2eWorkflow, /gh release delete/);
assert.match(e2eWorkflow, /group: release-publication/);
assert.strictEqual(
  packageJson.scripts["dist:ci"],
  "tauri build --bundles nsis --config src-tauri/tauri.ci.conf.json",
);
assert.match(ciWorkflow, /run: npm run dist:ci/);
assert.doesNotMatch(ciWorkflow, /npm run dist -- --config/);

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
