#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const ui = path.join(root, "src", "ui");
const scripts = fs.readdirSync(ui).filter((name) => name.endsWith(".js"));

for (const name of scripts) {
  execFileSync(process.execPath, ["--check", path.join(ui, name)], { stdio: "pipe" });
}
assert(scripts.includes("bridge.js"));

for (const name of ["compact", "insights", "details", "setup"]) {
  const html = fs.readFileSync(path.join(ui, `${name}.html`), "utf8");
  assert(html.includes('<script src="bridge.js"></script>'));
  assert(html.indexOf('src="bridge.js"') < html.indexOf(`src="${name}.js"`));
}

const packageJson = require("../package.json");
const tauriConfig = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const cargoToml = fs.readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8");
assert.strictEqual(packageJson.version, "1.0.0");
assert.strictEqual(tauriConfig.version, packageJson.version);
assert.strictEqual(tauriConfig.build.frontendDist, "../src/ui");
assert.deepStrictEqual(tauriConfig.app.windows, [], "백그라운드 시작 시 WebView를 만들면 안 됩니다.");
assert.strictEqual(tauriConfig.bundle.windows.webviewInstallMode.type, "skip");
assert(!JSON.stringify(packageJson).match(/electron|python|fastapi|node-pty/i));
assert(!cargoToml.match(/reqwest|ureq|hyper|tauri-plugin-(?:http|updater)/i));

const trackedSource = [
  ...fs.readdirSync(path.join(root, "src-tauri", "src")).map((name) => path.join(root, "src-tauri", "src", name)),
  ...fs.readdirSync(ui).map((name) => path.join(ui, name)),
].filter((filePath) => fs.statSync(filePath).isFile()).map((filePath) => fs.readFileSync(filePath, "utf8")).join("\n");
assert(!/0\.0\.0\.0|127\.0\.0\.1|localhost:\d+|http\.createServer|\.listen\s*\(/i.test(trackedSource));
assert(!/setInterval\([^,]+,\s*60000\)/.test(trackedSource));
assert.deepStrictEqual(
  [...new Set(trackedSource.match(/https?:\/\/[^"\s]+/g) || [])].sort(),
  ["https://openai.com/api/pricing/", "https://platform.claude.com/docs/en/about-claude/pricing"],
  "런타임 소스에는 표시용 공식 가격 출처 외의 URL이 없어야 합니다.",
);
const rustEntry = fs.readFileSync(path.join(root, "src-tauri", "src", "lib.rs"), "utf8");
const setupBlock = rustEntry.slice(rustEntry.indexOf(".setup("), rustEntry.indexOf(".on_window_event("));
assert(!setupBlock.includes("refresh_all"), "앱 시작 시 CLI 수집을 자동 실행하면 안 됩니다.");
assert(setupBlock.includes('--background'), "로그인 시작은 WebView 없는 트레이 모드를 사용해야 합니다.");
assert(rustEntry.includes('" --background"'), "로그인 시작 명령에 백그라운드 플래그가 필요합니다.");
assert(rustEntry.includes("api.prevent_exit()"), "마지막 창을 닫아도 트레이 프로세스는 유지되어야 합니다.");
assert(!fs.existsSync(path.join(root, "src", "electron")));
assert(!fs.existsSync(path.join(root, "src", "node")));

process.stdout.write(`PASS ${scripts.length}개 UI 스크립트와 Tauri 로컬 전용 구성을 검증했습니다.\n`);
