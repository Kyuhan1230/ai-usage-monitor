#!/usr/bin/env node
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createManifest, projectVersion } = require("../scripts/create-updater-manifest");
const {
  EVIDENCE_FILE,
  createEvidence,
  verifyEvidence,
} = require("../scripts/release-evidence");
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
const codexInstallerSmokeWorkflow = fs.readFileSync(
  path.join(__dirname, "..", ".github", "workflows", "codex-cli-installer-smoke.yml"),
  "utf8",
);
assert.match(
  codexInstallerSmokeWorkflow,
  /ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
);
assert.match(
  codexInstallerSmokeWorkflow,
  /AI_USAGE_MONITOR_T2_APP_COMMIT: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
);
assert.match(
  codexInstallerSmokeWorkflow,
  /\$checkedOutCommit -cne \$env:AI_USAGE_MONITOR_T2_APP_COMMIT/,
);
assert.match(
  codexInstallerSmokeWorkflow,
  /Emit sanitized installer failure diagnostics[\s\S]*steps\.install\.outcome == 'failure'/,
);
assert.match(
  codexInstallerSmokeWorkflow,
  /CODEX_INSTALL_FAILURE_CATEGORY=installer_process_failed/,
);
assert.match(
  codexInstallerSmokeWorkflow,
  /System32\\WindowsPowerShell\\v1\.0\\Modules/,
);
assert.match(
  codexInstallerSmokeWorkflow,
  /Get-Command Get-FileHash -ErrorAction Stop/,
);
assert.match(
  codexInstallerSmokeWorkflow,
  /CODEX_WINDOWS_POWERSHELL_MODULE_PATH_NORMALIZED=true/,
);
assert.match(
  codexInstallerSmokeWorkflow,
  /Validate the installed real Codex CLI without credentials[\s\S]*if: steps\.install\.outcome == 'success'/,
);
assert.doesNotMatch(
  codexInstallerSmokeWorkflow,
  /app_commit = '\$\{\{ github\.sha \}\}'/,
);
const betaReleaseChecklist = fs.readFileSync(
  path.join(__dirname, "..", "docs", "BETA_RELEASE_CHECKLIST.md"),
  "utf8",
);
const codexReleaseGate = fs.readFileSync(
  path.join(__dirname, "..", "docs", "codex-cli-onboarding", "RELEASE_GATE.md"),
  "utf8",
);
const remoteWindowsTest = fs.readFileSync(
  path.join(__dirname, "..", "docs", "codex-cli-onboarding", "REMOTE_WINDOWS_TEST.md"),
  "utf8",
);
const installSmokeTemplate = fs.readFileSync(
  path.join(__dirname, "..", "docs", "community", "INSTALL_SMOKE_REPORT_TEMPLATE.md"),
  "utf8",
);
const codexLiveHarness = fs.readFileSync(
  path.join(__dirname, "..", "src-tauri", "examples", "codex_live_install.rs"),
  "utf8",
);
const nodeVersion = fs
  .readFileSync(path.join(__dirname, "..", ".node-version"), "utf8")
  .trim();
const rustToolchain = fs.readFileSync(
  path.join(__dirname, "..", "rust-toolchain.toml"),
  "utf8",
);
const verifyToolchain = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "verify-toolchain.js"),
  "utf8",
);
const checkDevEnvironment = fs.readFileSync(
  path.join(__dirname, "..", "scripts", "check-dev-environment.ps1"),
  "utf8",
);
const nsisHooks = fs.readFileSync(
  path.join(__dirname, "..", "src-tauri", "windows", "hooks.nsh"),
  "utf8",
);
const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const tauriConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src-tauri", "tauri.conf.json"), "utf8"));
const cargoToml = fs.readFileSync(path.join(__dirname, "..", "src-tauri", "Cargo.toml"), "utf8");
assert.strictEqual(packageJson.productName, "Codex Claude Usage");
assert.strictEqual(tauriConfig.productName, "Codex Claude Usage");
assert.match(cargoToml, /ProductName = "Codex Claude Usage"/);
assert.doesNotMatch(
  codexLiveHarness,
  /inventory\.candidates\.clear\(\)/,
  "T2 live harness must select from the complete discovered inventory.",
);
assert.match(codexLiveHarness, /selected_index != matching_index/);
assert.match(codexLiveHarness, /t2_unexpected_candidate_selected/);
assert.match(
  nsisHooks,
  /StrCmp \$1 "\$LOCALAPPDATA\\Microsoft\\WindowsApps\\codex\.exe" cli_search_path_is_desktop/,
  "The exact Windows App Execution Alias must continue to the missing-CLI offer flow.",
);
assert.doesNotMatch(
  nsisHooks,
  /StrCmp \$1 "\$LOCALAPPDATA\\Microsoft\\WindowsApps\\codex\.exe" cli_offer_done/,
  "The Windows App Execution Alias must never suppress the Codex CLI offer.",
);
const silentNsisExitOffset = nsisHooks.indexOf("IfSilent cli_offer_done");
const nsisNetworkOffsets = [...nsisHooks.matchAll(/https?:\/\//g)].map(
  (match) => match.index,
);
assert.ok(silentNsisExitOffset >= 0, "Silent NSIS installs must exit the Codex offer hook");
assert.ok(
  nsisNetworkOffsets.length > 0 &&
    nsisNetworkOffsets.every((offset) => offset > silentNsisExitOffset),
  "The silent-install exit must precede every interactive Codex download path",
);
const publishJobMarker = "\n  publish-existing-draft:";
const publishJobOffset = releaseWorkflow.indexOf(publishJobMarker);
assert.ok(publishJobOffset > 0, "publish-existing-draft job is missing");
const prepareDraftJob = releaseWorkflow.slice(0, publishJobOffset);
const publishExistingDraftJob = releaseWorkflow.slice(publishJobOffset);

assert.match(releaseWorkflow, /\n  prepare-draft:/);
assert.match(releaseWorkflow, /\n  publish-existing-draft:/);
assert.match(releaseWorkflow, /\n  validate-invocation:/);
assert.match(
  releaseWorkflow,
  /\[\[ "\$REQUESTED_OPERATION" != "prepare" && "\$REQUESTED_OPERATION" != "publish" \]\]/,
);
assert.strictEqual((releaseWorkflow.match(/needs: validate-invocation/g) || []).length, 2);
assert.match(
  prepareDraftJob,
  /if: \$\{\{ github\.event_name == 'push' \|\| inputs\.operation == 'prepare' \}\}/,
);
assert.match(
  publishExistingDraftJob,
  /if: \$\{\{ github\.event_name != 'push' && inputs\.operation == 'publish' \}\}/,
);
assert.match(prepareDraftJob, /run: npm run dist/);
assert.doesNotMatch(publishExistingDraftJob, /run: npm run dist/);
assert.match(prepareDraftJob, /deployments: read/);
assert.match(
  prepareDraftJob,
  /Verify protected production environment before using signing secrets[\s\S]*prevent_self_review[\s\S]*can_admins_bypass[\s\S]*Build Tauri NSIS installer/,
);
assert.match(releaseWorkflow, /Codex Claude Usage \$env:RELEASE_VERSION/);
assert.match(
  releaseWorkflow,
  /Codex-Claude-Usage-Setup-\$env:RELEASE_VERSION\.exe/,
);
assert.match(releaseWorkflow, /release-assets\/Codex-Claude-Usage-Setup\.exe/);
assert.match(releaseWorkflow, /release-evidence\.json/);
assert.match(prepareDraftJob, /gh release create \$env:RELEASE_TAG/);
assert.match(prepareDraftJob, /--draft/);
assert.match(prepareDraftJob, /Preserve verified preparation evidence/);
assert.match(
  prepareDraftJob,
  /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/,
);
assert.match(
  prepareDraftJob,
  /release-preparation-evidence-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
);
assert.match(prepareDraftJob, /path: release-assets\/release-evidence\.json/);
assert.doesNotMatch(releaseWorkflow, /gh release upload/);
assert.doesNotMatch(releaseWorkflow, /--clobber/);
assert.match(publishExistingDraftJob, /PUBLISH_VERIFIED_DRAFT/);
assert.match(
  publishExistingDraftJob,
  /PUBLICATION_CONFIRMATION: \$\{\{ inputs\.confirmation \}\}/,
);
assert.match(
  publishExistingDraftJob,
  /\$env:PUBLICATION_CONFIRMATION -cne 'PUBLISH_VERIFIED_DRAFT'/,
);
assert.doesNotMatch(
  publishExistingDraftJob,
  /if \('\$\{\{ inputs\.confirmation \}\}'/,
);
assert.match(
  publishExistingDraftJob,
  /\$env:EXPECTED_RELEASE_COMMIT -notmatch '\^\[0-9a-fA-F\]\{40\}\$'/,
);
assert.match(
  publishExistingDraftJob,
  /\$env:EXPECTED_INSTALLER_SHA256 -notmatch '\^\[0-9a-fA-F\]\{64\}\$'/,
);
assert.match(releaseWorkflow, /release_evidence_sha256:/);
assert.match(
  publishExistingDraftJob,
  /\$env:EXPECTED_RELEASE_EVIDENCE_SHA256 -notmatch '\^\[0-9a-fA-F\]\{64\}\$'/,
);
assert.match(
  publishExistingDraftJob,
  /Draft bytes changed after T2\/T3 verification/,
);
assert.match(publishExistingDraftJob, /prevent_self_review/);
assert.match(publishExistingDraftJob, /\$configuration\.can_admins_bypass/);
assert.match(
  publishExistingDraftJob,
  /X-GitHub-Api-Version: 2026-03-10[\s\S]*repos\/\$\{\{ github\.repository \}\}\/immutable-releases/,
);
assert.match(publishExistingDraftJob, /\$immutability\.enabled -ne \$true/);
assert.match(
  publishExistingDraftJob,
  /Repository release immutability must be enabled before publication/,
);
assert.match(
  publishExistingDraftJob,
  /\.github\/workflows\/codex-cli-installer-smoke\.yml/,
);
assert.match(
  publishExistingDraftJob,
  /Verify release evidence came from a successful prepare run/,
);
assert.match(
  publishExistingDraftJob,
  /\$preparationRunId = \[string\]\$evidence\.preparation_run_id/,
);
assert.match(
  publishExistingDraftJob,
  /actions\/runs\/\$preparationRunId/,
);
assert.match(
  publishExistingDraftJob,
  /\$run\.status -ne 'completed'[\s\S]*\$run\.conclusion -ne 'success'[\s\S]*\$run\.head_sha[\s\S]*\$env:EXPECTED_RELEASE_COMMIT/,
);
assert.match(
  publishExistingDraftJob,
  /\$workflow\.path -ceq '\.github\/workflows\/release\.yml'/,
);
assert.match(
  publishExistingDraftJob,
  /\$referencePrefix = "\$\{\{ github\.repository \}\}\/\.github\/workflows\/release\.yml@"/,
);
assert.match(
  publishExistingDraftJob,
  /\$referenceSha -ceq \$env:EXPECTED_RELEASE_COMMIT/,
);
assert.match(
  publishExistingDraftJob,
  /Prepare updater-signed immutable draft assets/,
);
assert.match(
  publishExistingDraftJob,
  /Recorded preparation run does not contain one successful prepare-draft job/,
);
assert.match(
  publishExistingDraftJob,
  /release-preparation-evidence-\$preparationRunId-\$\(\$run\.run_attempt\)/,
);
assert.match(
  publishExistingDraftJob,
  /actions\/runs\/\$preparationRunId\/artifacts\?per_page=100/,
);
assert.match(
  publishExistingDraftJob,
  /gh run download \$preparationRunId[\s\S]*--name \$artifactName/,
);
assert.match(
  publishExistingDraftJob,
  /\$artifactEvidenceHash -cne \$env:EXPECTED_RELEASE_EVIDENCE_SHA256/,
);
assert.match(
  publishExistingDraftJob,
  /Draft release evidence does not match the successful preparation run artifact/,
);
assert.match(
  publishExistingDraftJob,
  /PREPARATION_RUN_ID=\$preparationRunId/,
);
assert.match(
  publishExistingDraftJob,
  /PREPARATION_ARTIFACT_ID=\$preparationArtifactId/,
);
assert.match(
  publishExistingDraftJob,
  /Preparation run changed or is no longer successful before publication/,
);
assert.match(
  publishExistingDraftJob,
  /Preparation job changed or is no longer successful before publication/,
);
assert.match(
  publishExistingDraftJob,
  /actions\/artifacts\/\$env:PREPARATION_ARTIFACT_ID/,
);
assert.match(
  publishExistingDraftJob,
  /Preparation evidence artifact changed, expired or disappeared before publication/,
);
const preparationRecheckOffset = publishExistingDraftJob.indexOf(
  "Preparation run changed or is no longer successful before publication",
);
const releasePublicationOffset = publishExistingDraftJob.indexOf(
  "gh release edit $env:RELEASE_TAG --draft=false --latest",
);
assert.ok(
  preparationRecheckOffset > 0 &&
    releasePublicationOffset > preparationRecheckOffset,
  "prepare-run provenance must be revalidated immediately before publication",
);
assert.match(publishExistingDraftJob, /\$now\.AddDays\(-7\)/);
assert.match(publishExistingDraftJob, /foreach \(\$mode in @\('default', 'custom'\)\)/);
assert.match(
  publishExistingDraftJob,
  /\$scriptHashes\['default'\] -cne \$scriptHashes\['custom'\]/,
);
assert.match(
  publishExistingDraftJob,
  /T2 default and custom jobs must test identical official installer script bytes/,
);
assert.match(
  publishExistingDraftJob,
  /\$cliVersions\['default'\] -cne \$cliVersions\['custom'\]/,
);
assert.match(
  publishExistingDraftJob,
  /T2 default and custom jobs must install the identical Codex CLI version/,
);
assert.match(
  publishExistingDraftJob,
  /codex-cli-t2-\$mode-\$env:T2_RUN_ID-\$\(\$run\.run_attempt\)/,
);
assert.match(
  publishExistingDraftJob,
  /\$evidence\.repository_harness\.result -cne 'success'/,
);
assert.match(publishExistingDraftJob, /Verify human T3 report and independent review/);
assert.match(publishExistingDraftJob, /release:t3-approved/);
assert.match(
  publishExistingDraftJob,
  /\$issue\.user\.login, \$comment\.user\.login/,
);
assert.match(
  publishExistingDraftJob,
  /\[Text\.Encoding\]::UTF8\.GetBytes\(\$text\)/,
);
assert.match(
  publishExistingDraftJob,
  /\$reportBodySha256 = Get-Utf8Sha256 \(\[string\]\$issue\.body\)/,
);
assert.match(
  publishExistingDraftJob,
  /'T3_REPORT_BODY_SHA256' = \$reportBodySha256/,
);
assert.match(
  publishExistingDraftJob,
  /VERIFIED_T3_REPORT_BODY_SHA256=\$reportBodySha256/,
);
assert.match(
  publishExistingDraftJob,
  /VERIFIED_T3_REVIEW_BODY_SHA256=\$reviewBodySha256/,
);
assert.match(
  publishExistingDraftJob,
  /\$currentBodySha256 -cne \$env:VERIFIED_T3_REPORT_BODY_SHA256/,
);
assert.match(
  publishExistingDraftJob,
  /T3 report body changed after independent review verification/,
);
assert.match(
  publishExistingDraftJob,
  /\$currentReviewBodySha256 -cne \$env:VERIFIED_T3_REVIEW_BODY_SHA256/,
);
assert.match(
  publishExistingDraftJob,
  /T3 review comment changed after independent review verification/,
);
assert.match(publishExistingDraftJob, /T3 report approval state changed before publication/);
assert.match(publishExistingDraftJob, /T3 report approval label changed before publication/);
assert.match(publishExistingDraftJob, /T3 independent-review identity changed before publication/);
assert.match(publishExistingDraftJob, /'T3_DETAIL_REPORT' = 'EMBEDDED'/);
assert.match(publishExistingDraftJob, /\[string\]\$issue\.body\.Length -lt 2500/);
assert.match(publishExistingDraftJob, /Embedded T3 detail report must contain exactly one section/);
assert.match(publishExistingDraftJob, /foreach \(\$checkpoint in 1\.\.11/);
assert.match(publishExistingDraftJob, /exactly one PASS row for \$checkpoint/);
for (const marker of [
  "T3_RESULT",
  "T3_DETAIL_REPORT",
  "HUMAN_OAUTH",
  "FIRST_USAGE",
  "APP_RESTART",
  "WINDOWS_REBOOT",
  "LEGACY_NPM_CONFLICT",
  "UNINSTALL_PRESERVATION",
  "REDACTION_REVIEW",
  "NO_CREDENTIALS_IN_CI",
  "RELEASE_EVIDENCE_SHA256",
  "T3_REVIEW",
  "T3_REPORT_BODY_SHA256",
]) {
  assert.match(publishExistingDraftJob, new RegExp(`'${marker}'`));
}
assert.match(codexReleaseGate, /T3_REPORT_BODY_SHA256: <current-issue-body-utf8-64-hex-sha256>/);
assert.match(codexReleaseGate, /전문을 gate Issue 본문에 직접 포함/);
assert.match(codexReleaseGate, /skeletal Issue는 실패/);
assert.doesNotMatch(installSmokeTemplate, /signed_publisher/);
assert.match(installSmokeTemplate, /verified_publisher/);
assert.match(
  codexReleaseGate,
  /review 뒤 Issue 제목이 아닌 \*\*본문\*\*을 한 글자라도 수정하면 기존 승인은 무효/,
);
assert.match(
  remoteWindowsTest,
  /review comment 뒤 Issue 본문이 바뀌면 기존 승인은 무효/,
);
assert.strictEqual(
  (releaseWorkflow.match(/gh release edit \$env:RELEASE_TAG --draft=false --latest/g) || [])
    .length,
  1,
);
assert.doesNotMatch(prepareDraftJob, /--draft=false --latest/);
assert.match(publishExistingDraftJob, /gh release download \$env:RELEASE_TAG --dir \$draftDir/);
assert.match(
  publishExistingDraftJob,
  /git ls-remote --exit-code origin "refs\/tags\/\$env:RELEASE_TAG"/,
);
assert.match(
  publishExistingDraftJob,
  /Published remote tag does not resolve to the verified release commit/,
);
assert.match(publishExistingDraftJob, /foreach \(\$name in \$expected\)/);
assert.match(
  publishExistingDraftJob,
  /Published asset bytes differ from the verified draft: \$name/,
);
assert.match(publishExistingDraftJob, /Published exact-byte evidence verification failed/);
assert.match(publishExistingDraftJob, /Published updater manifest verification failed/);
assert.match(publishExistingDraftJob, /Published updater signature verification failed/);
assert.match(releaseWorkflow, /"Codex-Claude-Usage-Setup\.exe",/);
assert.match(releaseWorkflow, /releases\/latest\/download\/\$assetName/);
assert.match(releaseWorkflow, /Latest release is missing direct installer asset/);
assert.match(releaseWorkflow, /Published direct installer was not ready after retries/);
assert.match(
  readme,
  /href="https:\/\/github\.com\/Kyuhan1230\/ai-usage-monitor\/releases\/latest\/download\/Codex-Claude-Usage-Setup\.exe"><strong>Download for Windows<\/strong><\/a>/,
);
assert.match(releaseWorkflow, /Authenticode/);
assert.match(releaseWorkflow, /v1\.1\.1/);
assert.match(releaseWorkflow, /--notes \$releaseNotice[\s\S]*--generate-notes/);
assert.match(releaseWorkflow, /Invoke-RestMethod/);
assert.match(releaseWorkflow, /\$candidate\.version -eq \$env:EXPECTED_RELEASE_VERSION/);
assert.match(releaseWorkflow, /Published manifest signature is empty/);
assert.doesNotMatch(releaseWorkflow, /\$response\.Content \| ConvertFrom-Json/);
assert.match(releaseWorkflow, /group: release-publication/);
assert.match(releaseWorkflow, /environment: production-release/);
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
const silentNsisSmokeMarker = "\n      - name: Smoke-test silent NSIS install";
const silentNsisSmokeOffset = ciWorkflow.indexOf(silentNsisSmokeMarker);
assert.ok(silentNsisSmokeOffset > 0, "silent NSIS smoke step is missing");
const silentNsisSmokeEnd = ciWorkflow.indexOf(
  "\n      - name:",
  silentNsisSmokeOffset + silentNsisSmokeMarker.length,
);
assert.ok(silentNsisSmokeEnd > silentNsisSmokeOffset, "silent NSIS smoke step is not bounded");
const silentNsisSmokeStep = ciWorkflow.slice(silentNsisSmokeOffset, silentNsisSmokeEnd);

assert.match(silentNsisSmokeStep, /timeout-minutes: 3/);
assert.match(silentNsisSmokeStep, /function Invoke-BoundedProcess/);
assert.match(
  silentNsisSmokeStep,
  /\$process\.WaitForExit\(\$TimeoutSeconds \* 1000\)/,
);
assert.match(silentNsisSmokeStep, /taskkill\.exe/);
assert.match(silentNsisSmokeStep, /& \$taskkill \/PID \$process\.Id \/T \/F/);
assert.doesNotMatch(silentNsisSmokeStep, /Start-Process[\s\S]{0,160}\s-Wait\b/);
assert.match(
  silentNsisSmokeStep,
  /-ArgumentList @\('\/S', "\/D=\$installRoot"\)/,
);
assert.match(
  silentNsisSmokeStep,
  /Join-Path \$installRoot 'codex-claude-usage\.exe'/,
);
assert.doesNotMatch(
  silentNsisSmokeStep,
  /Join-Path \$installRoot 'Codex Claude Usage\.exe'/,
);
assert.match(
  silentNsisSmokeStep,
  /Resolve-Path -LiteralPath 'src-tauri\/target\/release\/codex-claude-usage\.exe'/,
);
assert.match(
  silentNsisSmokeStep,
  /Installed application bytes differ from the freshly built application/,
);
assert.match(silentNsisSmokeStep, /Join-Path \$installRoot 'uninstall\.exe'/);
assert.match(silentNsisSmokeStep, /if \(\(Get-Item -LiteralPath \$artifact\)\.Length -le 0\)/);
assert.match(
  silentNsisSmokeStep,
  /Join-Path \$env:LOCALAPPDATA 'Programs\\OpenAI\\Codex\\bin\\codex\.exe'/,
);
assert.match(silentNsisSmokeStep, /Join-Path \$env:APPDATA 'npm\\codex\.ps1'/);
assert.match(silentNsisSmokeStep, /\$env:CODEX_INSTALL_DIR/);
assert.match(
  silentNsisSmokeStep,
  /\[System\.EnvironmentVariableTarget\]::User/,
);
assert.match(
  silentNsisSmokeStep,
  /\[System\.EnvironmentVariableTarget\]::Machine/,
);
assert.match(
  silentNsisSmokeStep,
  /try \{[\s\S]*\} finally \{[\s\S]*-ArgumentList @\('\/S'\)/,
);
assert.strictEqual(
  (silentNsisSmokeStep.match(/Assert-CodexStateUnchanged/g) || []).length,
  3,
);
assert.match(silentNsisSmokeStep, /-Phase 'install'/);
assert.match(silentNsisSmokeStep, /-Phase 'uninstall'/);
assert.match(
  silentNsisSmokeStep,
  /Silent NSIS uninstall did not remove the disposable install target/,
);

assert.strictEqual(packageJson.packageManager, "npm@10.9.0");
assert.deepStrictEqual(packageJson.engines, {
  node: "22.12.0",
  npm: "10.9.0",
});
assert.strictEqual(nodeVersion, "22.12.0");
assert.match(rustToolchain, /channel = "1\.97\.1"/);
assert.match(rustToolchain, /components = \["clippy", "rustfmt"\]/);
assert.match(rustToolchain, /targets = \["x86_64-pc-windows-msvc"\]/);
assert.match(verifyToolchain, /path\.dirname\(process\.execPath\)/);
assert.match(verifyToolchain, /node_modules[\s\S]*npm[\s\S]*npm-cli\.js/);
assert.match(
  checkDevEnvironment,
  /\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5\}/,
);
assert.doesNotMatch(
  checkDevEnvironment,
  /\{F1E7E4B4-28F6-4C9A-A826-D10A5B1F73E9\}/,
);
assert.strictEqual(
  packageJson.scripts["test:codex-live-install"],
  "cargo run --locked --quiet --manifest-path src-tauri/Cargo.toml --example codex_live_install",
);

for (const [workflowName, workflow] of [
  ["ci", ciWorkflow],
  ["release", releaseWorkflow],
  ["updater-e2e", e2eWorkflow],
  ["codex-installer-smoke", codexInstallerSmokeWorkflow],
]) {
  const actionReferences = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map(
    (match) => match[1],
  );
  assert.ok(actionReferences.length > 0, `${workflowName} has no action references`);
  for (const actionReference of actionReferences) {
    assert.match(
      actionReference,
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/,
      `${workflowName} action must use a full commit SHA: ${actionReference}`,
    );
  }
}

assert.match(
  codexInstallerSmokeWorkflow,
  /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/,
);
assert.match(
  codexInstallerSmokeWorkflow,
  /actions\/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38/,
);
assert.match(
  codexInstallerSmokeWorkflow,
  /dtolnay\/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4/,
);
assert.match(
  codexInstallerSmokeWorkflow,
  /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/,
);
assert.match(codexInstallerSmokeWorkflow, /toolchain: 1\.97\.1/);
assert.match(codexInstallerSmokeWorkflow, /node-version: 22\.12\.0/);
assert.match(codexInstallerSmokeWorkflow, /- default\s+- custom/);
assert.match(
  codexInstallerSmokeWorkflow,
  /https:\/\/chatgpt\.com\/codex\/install\.ps1/,
);
assert.match(codexInstallerSmokeWorkflow, /\$process\.WaitForExit\(600000\)/);
assert.match(
  codexInstallerSmokeWorkflow,
  /\^\(\?:codex-cli\|codex\)\\s\+v\?\(\?<version>\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+/,
);
assert.match(codexInstallerSmokeWorkflow, /\$version = \$Matches\.version/);
assert.match(
  codexInstallerSmokeWorkflow,
  /\$env:AI_USAGE_MONITOR_T2_CODEX_PATH = \$env:CODEX_EXPECTED_CLI/,
);
assert.match(
  codexInstallerSmokeWorkflow,
  /\$env:AI_USAGE_MONITOR_T2_CODEX_HOME = \$env:CODEX_HOME/,
);
assert.match(
  codexInstallerSmokeWorkflow,
  /\$env:AI_USAGE_MONITOR_T2_EXPECTED_SOURCE = \$env:CODEX_EXPECTED_SOURCE/,
);
assert.match(
  codexInstallerSmokeWorkflow,
  /\$env:AI_USAGE_MONITOR_T2_EVIDENCE_PATH = \$env:CODEX_HARNESS_EVIDENCE/,
);
assert.match(codexInstallerSmokeWorkflow, /npm run verify:toolchain/);
assert.match(codexInstallerSmokeWorkflow, /npm run test:codex-live-install/);
for (const field of [
  "schema_version",
  "selected_expected_candidate",
  "selected_source",
  "selected_version",
  "provenance",
  "auth_state",
  "safe_error_code",
]) {
  assert.match(codexInstallerSmokeWorkflow, new RegExp(`'${field}'`));
}
assert.match(
  codexInstallerSmokeWorkflow,
  /if \(\$null -ne \$harnessEvidence\.safe_error_code\)/,
);
assert.match(
  codexInstallerSmokeWorkflow,
  /safe_error_code = if \(\[string\]::IsNullOrWhiteSpace\(\$env:CODEX_HARNESS_SAFE_ERROR_CODE\)\)[\s\S]*?\$null/,
);
assert.match(
  codexInstallerSmokeWorkflow,
  /\$allowedProvenance = @\('verified_publisher', 'tracked_official_install', 'unverified'\)/,
);
assert.match(codexInstallerSmokeWorkflow, /Enforce complete T2 result/);
assert.match(
  codexInstallerSmokeWorkflow,
  /repository_harness = '\$\{\{ steps\.repository_harness\.outcome \}\}'/,
);
assert.doesNotMatch(codexInstallerSmokeWorkflow, /secrets\./);

assert.match(
  betaReleaseChecklist,
  /T2 workflow passed for both `default` and `custom` install modes on this exact release commit/,
);
assert.match(
  betaReleaseChecklist,
  /same official installer-script SHA-256 and the same installed Codex CLI version/,
);
assert.match(
  betaReleaseChecklist,
  /prepare job verifies these controls before updater signing secrets are used/,
);
assert.match(
  betaReleaseChecklist,
  /revalidated the T3 issue state and approval label, tester\/reviewer identities and associations/,
);
assert.match(
  betaReleaseChecklist,
  /re-downloaded and rehashed all five release assets/,
);
assert.match(
  betaReleaseChecklist,
  /confirmed `enabled=true` through GitHub's official immutable-releases endpoint/,
);
assert.match(codexReleaseGate, /GET \/repos\/\{owner\}\/\{repo\}\/immutable-releases/);
assert.match(codexReleaseGate, /현재 원격 저장소는 이 설정이 꺼져 있으므로 활성화 전까지 Release는 No-Go/);
assert.match(
  betaReleaseChecklist,
  /T3 Windows 11 desktop test for this exact commit, installer SHA-256, and `release-evidence\.json` SHA-256/,
);
assert.match(
  betaReleaseChecklist,
  /obtained an independent reviewer approval carrying the same digests/,
);
assert.match(betaReleaseChecklist, /A green T2 run never substitutes for T3/);
assert.match(betaReleaseChecklist, /Keep the release as a draft and mark it \*\*No-Go\*\*/);
assert.match(
  betaReleaseChecklist,
  /Do not place ChatGPT credentials, OAuth tokens, cookies, MFA material, or `auth\.json` in GitHub Actions secrets or artifacts/,
);

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

const releaseEvidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "release-evidence-"));
try {
  const version = projectVersion();
  const tag = `v${version}`;
  const commit = "a".repeat(40);
  const versionedInstaller = path.join(
    releaseEvidenceRoot,
    `Codex-Claude-Usage-Setup-${version}.exe`,
  );
  const directInstaller = path.join(releaseEvidenceRoot, "Codex-Claude-Usage-Setup.exe");
  const signature = `${versionedInstaller}.sig`;
  const manifest = path.join(releaseEvidenceRoot, "latest.json");
  const evidencePath = path.join(releaseEvidenceRoot, EVIDENCE_FILE);
  const installerBytes = Buffer.from("immutable-release-installer-fixture");
  const signatureBytes = Buffer.from("immutable-release-signature-fixture\n");

  fs.writeFileSync(versionedInstaller, installerBytes);
  fs.writeFileSync(directInstaller, installerBytes);
  fs.writeFileSync(signature, signatureBytes);
  fs.writeFileSync(manifest, '{"version":"fixture"}\n', "utf8");

  const created = createEvidence(releaseEvidenceRoot, tag, version, commit, "12345");
  assert.strictEqual(created.release_commit, commit);
  assert.strictEqual(created.assets.length, 4);

  const sha256 = (file) =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const installerDigest = sha256(versionedInstaller);
  const evidenceDigest = sha256(evidencePath);
  const originalEvidence = fs.readFileSync(evidencePath);
  const verified = verifyEvidence(
    releaseEvidenceRoot,
    tag,
    version,
    commit,
    installerDigest,
    evidenceDigest,
  );
  assert.strictEqual(verified.installerSha256, installerDigest);
  assert.strictEqual(verified.evidenceSha256, evidenceDigest);

  const invalidPreparationEvidence = JSON.parse(originalEvidence.toString("utf8"));
  invalidPreparationEvidence.preparation_run_id = "0";
  fs.writeFileSync(
    evidencePath,
    `${JSON.stringify(invalidPreparationEvidence, null, 2)}\n`,
    "utf8",
  );
  const invalidPreparationEvidenceDigest = sha256(evidencePath);
  assert.throws(
    () =>
      verifyEvidence(
        releaseEvidenceRoot,
        tag,
        version,
        commit,
        installerDigest,
        invalidPreparationEvidenceDigest,
      ),
    /Evidence preparation run ID is invalid/,
  );
  fs.writeFileSync(evidencePath, originalEvidence);

  assert.throws(
    () =>
      verifyEvidence(
        releaseEvidenceRoot,
        tag,
        version,
        commit,
        "0".repeat(64),
        evidenceDigest,
      ),
    /Versioned installer SHA-256 does not match/,
  );

  fs.appendFileSync(signature, "tampered");
  assert.throws(
    () =>
      verifyEvidence(
        releaseEvidenceRoot,
        tag,
        version,
        commit,
        installerDigest,
        evidenceDigest,
      ),
    /Draft asset does not match release evidence/,
  );
  fs.writeFileSync(signature, signatureBytes);

  fs.appendFileSync(evidencePath, "tampered");
  assert.throws(
    () =>
      verifyEvidence(
        releaseEvidenceRoot,
        tag,
        version,
        commit,
        installerDigest,
        evidenceDigest,
      ),
    /release-evidence\.json SHA-256 does not match/,
  );
  fs.writeFileSync(evidencePath, originalEvidence);

  fs.unlinkSync(evidencePath);
  fs.writeFileSync(directInstaller, Buffer.from("different-installer-alias"));
  assert.throws(
    () => createEvidence(releaseEvidenceRoot, tag, version, commit, "12345"),
    /direct installer alias is not byte-for-byte identical/,
  );
} finally {
  fs.rmSync(releaseEvidenceRoot, { recursive: true, force: true });
}

process.stdout.write(
  "PASS updater manifest와 immutable release evidence 변조 거부 계약을 검증했습니다.\n",
);
