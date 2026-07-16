"use strict";

const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const packageJson = require(path.join(ROOT, "package.json"));
const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
const expectedTag = `v${packageJson.version}`;

if (!tag) {
  process.stderr.write("Release tag is required. Pass v<package-version> as the first argument.\n");
  process.exit(1);
}

if (tag !== expectedTag) {
  process.stderr.write(`Release tag ${tag} does not match package version ${packageJson.version}. Expected ${expectedTag}.\n`);
  process.exit(1);
}

process.stdout.write(`Release tag ${tag} matches package version ${packageJson.version}.\n`);
