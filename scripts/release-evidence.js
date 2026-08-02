#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const EVIDENCE_FILE = "release-evidence.json";
const SCHEMA_VERSION = 1;

function fail(message) {
  throw new Error(message);
}

function normalizeCommit(value) {
  const commit = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    fail("Release commit must be a full 40-character Git SHA.");
  }
  return commit;
}

function normalizeSha256(value, label = "SHA-256") {
  const digest = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    fail(`${label} must contain exactly 64 hexadecimal characters.`);
  }
  return digest;
}

function normalizeVersion(value) {
  const version = String(value || "").trim();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail("Release version must be a SemVer-compatible value.");
  }
  return version;
}

function validateIdentity(tag, version, commit, runId) {
  const normalizedVersion = normalizeVersion(version);
  if (String(tag || "").trim() !== `v${normalizedVersion}`) {
    fail("Release tag must exactly match v<release-version>.");
  }
  const normalizedRunId = String(runId || "").trim();
  if (!/^[1-9][0-9]*$/.test(normalizedRunId)) {
    fail("Preparation run ID must be a positive integer.");
  }
  return {
    tag: String(tag).trim(),
    version: normalizedVersion,
    commit: normalizeCommit(commit),
    runId: normalizedRunId,
  };
}

function expectedAssetNames(version, includeEvidence) {
  const names = [
    `Codex-Claude-Usage-Setup-${version}.exe`,
    "Codex-Claude-Usage-Setup.exe",
    `Codex-Claude-Usage-Setup-${version}.exe.sig`,
    "latest.json",
  ];
  if (includeEvidence) names.push(EVIDENCE_FILE);
  return names.sort();
}

function assertExactFiles(directory, expectedNames) {
  const actualNames = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    fail(`Release asset set is not exact. Expected ${expectedNames.join(", ")}.`);
  }
}

function describeFile(filePath) {
  const bytes = fs.statSync(filePath).size;
  if (bytes <= 0) fail(`Release asset is empty: ${path.basename(filePath)}`);
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  return { bytes, sha256 };
}

function collectAssets(directory, version) {
  return expectedAssetNames(version, false).map((name) => {
    const description = describeFile(path.join(directory, name));
    return { name, ...description };
  });
}

function assertInstallerAlias(assets, version) {
  const versioned = assets.find((asset) => asset.name === `Codex-Claude-Usage-Setup-${version}.exe`);
  const alias = assets.find((asset) => asset.name === "Codex-Claude-Usage-Setup.exe");
  if (!versioned || !alias || versioned.bytes !== alias.bytes || versioned.sha256 !== alias.sha256) {
    fail("The direct installer alias is not byte-for-byte identical to the versioned installer.");
  }
  return versioned.sha256;
}

function createEvidence(directory, tag, version, commit, runId) {
  const identity = validateIdentity(tag, version, commit, runId);
  const absoluteDirectory = path.resolve(directory);
  assertExactFiles(absoluteDirectory, expectedAssetNames(identity.version, false));
  const assets = collectAssets(absoluteDirectory, identity.version);
  assertInstallerAlias(assets, identity.version);

  const evidence = {
    schema_version: SCHEMA_VERSION,
    release_tag: identity.tag,
    release_version: identity.version,
    release_commit: identity.commit,
    preparation_run_id: identity.runId,
    assets,
  };
  fs.writeFileSync(
    path.join(absoluteDirectory, EVIDENCE_FILE),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
  return evidence;
}

function verifyEvidence(
  directory,
  tag,
  version,
  commit,
  expectedInstallerDigest,
  expectedEvidenceDigest,
) {
  const absoluteDirectory = path.resolve(directory);
  const expectedCommit = normalizeCommit(commit);
  const expectedInstallerSha256 = normalizeSha256(
    expectedInstallerDigest,
    "Expected installer SHA-256",
  );
  const expectedEvidenceSha256 = normalizeSha256(
    expectedEvidenceDigest,
    "Expected release evidence SHA-256",
  );
  const normalizedVersion = normalizeVersion(version);
  if (String(tag || "").trim() !== `v${normalizedVersion}`) {
    fail("Release tag must exactly match v<release-version>.");
  }

  assertExactFiles(absoluteDirectory, expectedAssetNames(normalizedVersion, true));
  const evidencePath = path.join(absoluteDirectory, EVIDENCE_FILE);
  const evidenceDescription = describeFile(evidencePath);
  if (evidenceDescription.sha256 !== expectedEvidenceSha256) {
    fail("release-evidence.json SHA-256 does not match the publication input.");
  }
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  if (evidence.schema_version !== SCHEMA_VERSION) fail("Unsupported release evidence schema.");
  if (evidence.release_tag !== String(tag).trim()) fail("Evidence release tag does not match.");
  if (evidence.release_version !== normalizedVersion) fail("Evidence release version does not match.");
  if (normalizeCommit(evidence.release_commit) !== expectedCommit) {
    fail("Evidence release commit does not match.");
  }
  if (!/^[1-9][0-9]*$/.test(String(evidence.preparation_run_id || ""))) {
    fail("Evidence preparation run ID is invalid.");
  }
  if (!Array.isArray(evidence.assets)) fail("Evidence assets must be an array.");

  const expectedNames = expectedAssetNames(normalizedVersion, false);
  const evidenceNames = evidence.assets.map((asset) => asset && asset.name).sort();
  if (JSON.stringify(evidenceNames) !== JSON.stringify(expectedNames)) {
    fail("Evidence asset inventory is incomplete or contains unexpected entries.");
  }

  const actualAssets = collectAssets(absoluteDirectory, normalizedVersion);
  for (const actual of actualAssets) {
    const recorded = evidence.assets.find((asset) => asset.name === actual.name);
    if (
      !recorded ||
      recorded.bytes !== actual.bytes ||
      normalizeSha256(recorded.sha256, `Recorded ${actual.name} SHA-256`) !== actual.sha256
    ) {
      fail(`Draft asset does not match release evidence: ${actual.name}`);
    }
  }
  const installerSha256 = assertInstallerAlias(actualAssets, normalizedVersion);
  if (installerSha256 !== expectedInstallerSha256) {
    fail("Versioned installer SHA-256 does not match the publication input.");
  }
  return { evidence, installerSha256, evidenceSha256: evidenceDescription.sha256 };
}

function main(argv) {
  const [command, directory, tag, version, commit, finalValue, evidenceDigest] = argv;
  if (command === "create") {
    const evidence = createEvidence(directory, tag, version, commit, finalValue);
    const installerSha256 = assertInstallerAlias(evidence.assets, evidence.release_version);
    process.stdout.write(
      `Created ${EVIDENCE_FILE} for ${evidence.release_tag} (${evidence.release_commit}); installer SHA-256 ${installerSha256}.\n`,
    );
    return;
  }
  if (command === "verify") {
    const result = verifyEvidence(
      directory,
      tag,
      version,
      commit,
      finalValue,
      evidenceDigest,
    );
    process.stdout.write(
      `Verified immutable draft evidence for ${result.evidence.release_tag}; installer SHA-256 ${result.installerSha256}; evidence SHA-256 ${result.evidenceSha256}.\n`,
    );
    return;
  }
  process.stderr.write(
    "Usage:\n" +
      "  release-evidence.js create <asset-dir> <tag> <version> <commit> <preparation-run-id>\n" +
      "  release-evidence.js verify <asset-dir> <tag> <version> <commit> <installer-sha256> <evidence-sha256>\n",
  );
  process.exitCode = 1;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  EVIDENCE_FILE,
  createEvidence,
  verifyEvidence,
};
