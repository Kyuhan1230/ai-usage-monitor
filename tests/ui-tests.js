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
assert.strictEqual(packageJson.version, "1.0.5");
assert.strictEqual(tauriConfig.version, packageJson.version);
assert.strictEqual(tauriConfig.build.frontendDist, "../src/ui");
assert.deepStrictEqual(tauriConfig.app.windows, [], "백그라운드 시작 시 WebView를 만들면 안 됩니다.");
assert.strictEqual(tauriConfig.bundle.windows.webviewInstallMode.type, "skip");
assert.strictEqual(tauriConfig.bundle.windows.nsis.installerHooks, "./windows/hooks.nsh");
assert(!JSON.stringify(packageJson).match(/electron|python|fastapi|node-pty/i));
assert(!cargoToml.match(/reqwest|ureq|hyper|tauri-plugin-(?:http|updater)/i));

const nsisHooks = fs.readFileSync(path.join(root, "src-tauri", "windows", "hooks.nsh"), "utf8");
assert(nsisHooks.includes("IfSilent cli_offer_done"), "무인 설치에서는 CLI 설치 질문을 건너뛰어야 합니다.");
assert.strictEqual((nsisHooks.match(/MB_YESNO\|MB_DEFBUTTON2/g) || []).length, 2, "두 CLI 모두 기본값이 아니요인 명시적 동의를 받아야 합니다.");
assert(nsisHooks.includes("https://chatgpt.com/codex/install.ps1"), "OpenAI 공식 Windows 설치 스크립트만 사용해야 합니다.");
assert(nsisHooks.includes("https://claude.ai/install.ps1"), "Anthropic 공식 Windows 설치 스크립트만 사용해야 합니다.");
assert(nsisHooks.includes("$LOCALAPPDATA\\Programs\\OpenAI\\Codex\\bin\\codex.exe"));
assert(nsisHooks.includes("$APPDATA\\npm\\codex.cmd"));
assert(nsisHooks.includes("$PROFILE\\.local\\bin\\claude.exe"));
assert(nsisHooks.includes("$LOCALAPPDATA\\Microsoft\\WinGet\\Links\\claude.exe"));
assert(nsisHooks.includes("$APPDATA\\npm\\claude.cmd"));
assert(!/\bcodex(?:\.exe)?\s+login\b/i.test(nsisHooks), "설치 프로그램이 계정 로그인을 자동 실행하면 안 됩니다.");
assert(!/\bclaude(?:\.exe)?\s+auth\s+login\b/i.test(nsisHooks), "설치 프로그램이 Claude 로그인을 자동 실행하면 안 됩니다.");
assert(nsisHooks.indexOf("Push $0") < nsisHooks.indexOf("Pop $0"), "NSIS 훅은 본문이 쓰는 레지스터 값을 복원해야 합니다.");

const trackedSource = [
  ...fs.readdirSync(path.join(root, "src-tauri", "src")).map((name) => path.join(root, "src-tauri", "src", name)),
  ...fs.readdirSync(ui).map((name) => path.join(ui, name)),
].filter((filePath) => fs.statSync(filePath).isFile()).map((filePath) => fs.readFileSync(filePath, "utf8")).join("\n");
assert(!/0\.0\.0\.0|127\.0\.0\.1|localhost:\d+|http\.createServer|\.listen\s*\(/i.test(trackedSource));
assert(!/setInterval\([^,]+,\s*60000\)/.test(trackedSource));
assert.deepStrictEqual(
  [...new Set(trackedSource.match(/https?:\/\/[^"\s]+/g) || [])].sort(),
  [
    "https://chatgpt.com/codex/install.ps1",
    "https://claude.ai/install.ps1",
    "https://code.claude.com/docs/en/setup",
    "https://learn.chatgpt.com/docs/codex/cli",
    "https://openai.com/api/pricing/",
    "https://platform.claude.com/docs/en/about-claude/pricing",
  ],
  "런타임 소스에는 표시용 공식 가격 출처 외의 URL이 없어야 합니다.",
);
const rustEntry = fs.readFileSync(path.join(root, "src-tauri", "src", "lib.rs"), "utf8");
const setupBlock = rustEntry.slice(rustEntry.indexOf(".setup("), rustEntry.indexOf(".on_window_event("));
assert(!setupBlock.includes("refresh_all"), "앱 시작 시 CLI 수집을 자동 실행하면 안 됩니다.");
assert(setupBlock.includes('--background'), "로그인 시작은 WebView 없는 트레이 모드를 사용해야 합니다.");
assert(rustEntry.includes('" --background"'), "로그인 시작 명령에 백그라운드 플래그가 필요합니다.");
assert(rustEntry.includes("api.prevent_exit()"), "마지막 창을 닫아도 트레이 프로세스는 유지되어야 합니다.");
assert(
  rustEntry.includes("async fn show_window"),
  "Windows에서 보조 WebView 창을 동기 command handler 안에서 만들면 안 됩니다.",
);
assert(
  rustEntry.includes("spawn_blocking(move || show_window_by_label"),
  "보조 WebView 창 생성은 WebView 이벤트 스레드 밖에서 실행해야 합니다.",
);
assert(
  rustEntry.includes("show_window_on_worker(app.clone(), label.to_string())"),
  "트레이 메뉴의 보조 창 생성도 이벤트 handler 밖에서 실행해야 합니다.",
);
assert(rustEntry.includes('"claude auth login"'), "Claude 로그인 버튼은 실제 로그인 하위 명령을 실행해야 합니다.");
assert(trackedSource.includes('&["login", "status"]'), "Setup은 Codex 로그인 상태를 직접 확인해야 합니다.");
assert(trackedSource.includes('&["auth", "status"]'), "Setup은 Claude 로그인 상태를 직접 확인해야 합니다.");
assert(rustEntry.includes("first_window = if onboarding_complete()"), "첫 실행은 Setup 온보딩을 열어야 합니다.");
assert(rustEntry.includes('"compact"') && rustEntry.includes('"setup"'), "온보딩 완료 여부에 따른 첫 창이 필요합니다.");
assert(rustEntry.includes("complete_onboarding"), "사용자가 첫 설정 완료 또는 나중에를 선택할 수 있어야 합니다.");
assert(trackedSource.includes("desktop_bundle_only"), "보호된 Codex 데스크톱 번들을 독립 CLI로 오인하면 안 됩니다.");
assert(trackedSource.includes("current_path_values"), "실행 중 설치된 CLI를 감지하려면 최신 사용자 PATH를 다시 읽어야 합니다.");
assert(trackedSource.includes("Programs/OpenAI/Codex/bin/codex.exe"), "Codex 공식 설치 경로를 PATH와 별도로 확인해야 합니다.");
assert(trackedSource.includes(".local/bin/claude.exe"), "Claude 공식 설치 경로를 PATH와 별도로 확인해야 합니다.");
assert(!fs.existsSync(path.join(root, "src", "electron")));
assert(!fs.existsSync(path.join(root, "src", "node")));

const setupHtml = fs.readFileSync(path.join(ui, "setup.html"), "utf8");
const setupScript = fs.readFileSync(path.join(ui, "setup.js"), "utf8");
const insightsHtml = fs.readFileSync(path.join(ui, "insights.html"), "utf8");
const insightsScript = fs.readFileSync(path.join(ui, "insights.js"), "utf8");
assert(
  insightsHtml.indexOf('id="decision"') < insightsHtml.indexOf('class="analysis-details"'),
  "핵심 고갈 판정은 상세 분석보다 먼저 보여야 합니다.",
);
assert(insightsHtml.includes("실제 구독 청구액 아님"), "API 정가 환산은 실제 청구액과 구분해야 합니다.");
assert(insightsScript.includes("function renderDecision"), "Insights는 최우선 판정과 행동을 별도로 렌더링해야 합니다.");
assert(insightsScript.includes("function formatForecastRange"), "예상 고갈은 단일 시각보다 범위를 우선 표시해야 합니다.");
assert(insightsScript.includes("rateVariabilityPercent"), "예측 신뢰도에는 속도 변동 근거가 필요합니다.");
const compactHtml = fs.readFileSync(path.join(ui, "compact.html"), "utf8");
const compactScript = fs.readFileSync(path.join(ui, "compact.js"), "utf8");
assert(compactHtml.includes('id="decision"'), "첫 Compact 창에서 고갈 판정을 바로 보여줘야 합니다.");
assert(compactScript.includes("function renderDecision"), "Compact 창은 분석 결과의 최우선 판정을 렌더링해야 합니다.");
assert(compactScript.includes("el.decision.addEventListener"), "Compact 판정에서 상세 근거로 이동할 수 있어야 합니다.");
for (const id of ["setup-later", "setup-complete", "refresh", "collect"]) {
  assert(setupHtml.includes(`id="${id}"`), `Setup 온보딩 컨트롤 누락: ${id}`);
}
assert(setupScript.trimEnd().endsWith("refresh(false);"), "Setup 첫 진입은 사용량 수집 없이 설치·인증 상태만 확인해야 합니다.");
assert(setupScript.includes('codexAuth.state === "authenticated"'), "설정 완료는 Codex 직접 인증 상태를 사용해야 합니다.");
assert(setupScript.includes('claudeAuth.state === "authenticated"'), "설정 완료는 Claude 직접 인증 상태를 사용해야 합니다.");
assert(setupScript.includes("function hasAuthenticatedProvider"), "한 공급자만 인증해도 온보딩을 완료할 수 있어야 합니다.");
assert(setupScript.includes('|| setup.claudeAuth.state === "authenticated"'), "Codex와 Claude 인증은 선택 조건이어야 합니다.");
assert(rustEntry.includes("let codex_ready = codex_cli_state() == CliState::Ready"), "설치된 공급자만 수집해야 합니다.");
assert(rustEntry.includes("let claude_ready = claude_cli_state() == CliState::Ready"), "설치된 공급자만 수집해야 합니다.");
assert(setupHtml.includes('id="activity-monitoring"'), "활동 기반 자동 확인은 사용자가 켜고 끌 수 있어야 합니다.");
assert(setupScript.includes("setActivityMonitoring"), "자동 확인 설정은 백엔드에 명시적으로 저장해야 합니다.");
assert(rustEntry.includes("AUTO_REFRESH_COOLDOWN_MS"), "활동 기반 수집에는 최소 실행 간격이 필요합니다.");
assert(rustEntry.includes("AUTO_REFRESH_COOLDOWN_MS: i64 = 5 * 60 * 1000"), "활동 중 CLI 수집 간격은 최소 5분이어야 합니다.");
assert(rustEntry.includes("if !activity_monitoring_enabled()"), "자동 확인을 끄면 활동 파일을 반복 스캔하지 않아야 합니다.");
assert(rustEntry.includes("start_activity_monitor(app.handle().clone())"), "트레이 런타임에서 활동 감시를 시작해야 합니다.");

process.stdout.write(`PASS ${scripts.length}개 UI 스크립트와 Tauri 로컬 전용 구성을 검증했습니다.\n`);
