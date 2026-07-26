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

for (const name of ["compact", "insights", "details", "setup", "update"]) {
  const html = fs.readFileSync(path.join(ui, `${name}.html`), "utf8");
  assert(html.includes('<script src="bridge.js"></script>'));
  assert(html.indexOf('src="bridge.js"') < html.indexOf(`src="${name}.js"`));
}

const packageJson = require("../package.json");
const tauriConfig = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const tauriCiConfig = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.ci.conf.json"), "utf8"));
const cargoToml = fs.readFileSync(path.join(root, "src-tauri", "Cargo.toml"), "utf8");
const capabilities = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "capabilities", "default.json"), "utf8"));
assert.strictEqual(packageJson.version, "1.2.4");
assert.strictEqual(packageJson.productName, "Codex Claude Usage");
assert.strictEqual(tauriConfig.version, packageJson.version);
assert.strictEqual(tauriConfig.productName, "Codex Claude Usage");
assert.strictEqual(tauriConfig.build.frontendDist, "../src/ui");
assert.deepStrictEqual(tauriConfig.app.windows, [], "백그라운드 시작 시 WebView를 만들면 안 됩니다.");
assert.strictEqual(tauriConfig.bundle.windows.webviewInstallMode.type, "skip");
assert.strictEqual(tauriConfig.bundle.windows.nsis.installerHooks, "./windows/hooks.nsh");
assert(!JSON.stringify(packageJson).match(/electron|python|fastapi|node-pty/i));
assert(!cargoToml.match(/reqwest|ureq|hyper|tauri-plugin-http/i));
assert.strictEqual((cargoToml.match(/tauri-plugin-updater/g) || []).length, 1);
assert.match(cargoToml, /ProductName = "Codex Claude Usage"/);
assert.strictEqual(tauriConfig.bundle.createUpdaterArtifacts, true);
assert.strictEqual(tauriCiConfig.bundle.createUpdaterArtifacts, false, "일반 CI는 공식 서명키 없이 updater artifact를 만들면 안 됩니다.");
assert.deepStrictEqual(
  tauriConfig.plugins.updater.endpoints,
  ["https://github.com/Kyuhan1230/ai-usage-monitor/releases/latest/download/latest.json"],
);
assert.strictEqual(tauriConfig.plugins.updater.windows.installMode, "passive");
assert(!JSON.stringify(tauriConfig.plugins.updater).match(/dangerousInsecureTransportProtocol|allowDowngrades/i));
assert(capabilities.windows.includes("update"), "업데이트 창이 기본 capability 범위에 있어야 합니다.");
assert(capabilities.permissions.includes("core:window:allow-start-resize-dragging"), "프레임 없는 Compact 창의 크기 조절 권한이 필요합니다.");
assert(!capabilities.permissions.some((permission) => permission.startsWith("updater:")), "프런트엔드에 updater plugin 권한을 직접 열면 안 됩니다.");

const nsisHooks = fs.readFileSync(path.join(root, "src-tauri", "windows", "hooks.nsh"), "utf8");
assert(nsisHooks.includes("IfSilent cli_offer_done"), "무인 설치에서는 CLI 설치 질문을 건너뛰어야 합니다.");
assert.strictEqual((nsisHooks.match(/MB_YESNO\|MB_DEFBUTTON2/g) || []).length, 1, "기본 설치는 Codex CLI만 선택적으로 제안해야 합니다.");
assert(nsisHooks.includes("https://chatgpt.com/codex/install.ps1"), "OpenAI 공식 Windows 설치 스크립트만 사용해야 합니다.");
assert(!nsisHooks.includes("https://claude.ai/install.ps1"), "Claude 설치는 Setup에서 사용자가 명시적으로 선택해야 합니다.");
assert(nsisHooks.includes("$LOCALAPPDATA\\Programs\\OpenAI\\Codex\\bin\\codex.exe"));
assert(nsisHooks.includes("$APPDATA\\npm\\codex.cmd"));
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
const setupCss = fs.readFileSync(path.join(ui, "setup.css"), "utf8");
const insightsHtml = fs.readFileSync(path.join(ui, "insights.html"), "utf8");
const insightsScript = fs.readFileSync(path.join(ui, "insights.js"), "utf8");
const insightsCss = fs.readFileSync(path.join(ui, "insights.css"), "utf8");
const detailsCss = fs.readFileSync(path.join(ui, "details.css"), "utf8");
const updateCss = fs.readFileSync(path.join(ui, "update.css"), "utf8");
const bridgeScript = fs.readFileSync(path.join(ui, "bridge.js"), "utf8");
assert(setupHtml.includes("<title>Codex Claude Usage Setup</title>") && setupHtml.includes("<h1>Codex Claude Usage</h1>"), "Setup은 현재 제품명을 유지해야 합니다.");
assert(
  insightsHtml.indexOf('id="decision"') < insightsHtml.indexOf('class="analysis-details"'),
  "핵심 고갈 판정은 상세 분석보다 먼저 보여야 합니다.",
);
assert(insightsHtml.includes("실제 구독 청구액 아님"), "API 정가 환산은 실제 청구액과 구분해야 합니다.");
assert(insightsScript.includes("function renderDecision"), "Insights는 최우선 판정과 행동을 별도로 렌더링해야 합니다.");
assert(insightsScript.includes("function formatForecastRange"), "예상 고갈은 단일 시각보다 범위를 우선 표시해야 합니다.");
assert(insightsScript.includes("forecastSpreadPercent"), "예측 근거에는 평균 속도의 오차 범위가 필요합니다.");
assert(insightsScript.includes("depletionEventCount"), "원시 표본 수와 실제 잔여량 감소 횟수를 구분해야 합니다.");
assert(insightsScript.includes('limit.forecastStatus === "safe"'), "예측 불가 상태를 안전으로 표시하면 안 됩니다.");
assert(insightsHtml.includes('id="survival-timeline"'), "리셋 생존 타임라인 영역이 필요합니다.");
assert(insightsHtml.includes('id="slowdown-bullet"'), "필요 감속률 불릿 차트 영역이 필요합니다.");
assert(insightsScript.includes("function renderSurvivalTimeline"), "예상 고갈 범위와 리셋을 같은 축에서 비교해야 합니다.");
assert(insightsScript.includes("function renderSlowdownBullet"), "현재 속도와 허용 속도를 구조화된 값으로 비교해야 합니다.");
assert(insightsScript.includes("관찰 기간이 짧아 정확한 감속률은 아직 제시하지 않습니다"), "짧은 관찰 결과를 정확한 처방처럼 표시하면 안 됩니다.");
assert(insightsScript.includes("수집 횟수보다 잔여량이 변한 기록이 필요합니다"), "표본 수가 충분한 사용자에게 막연히 기록을 더 모으라고 안내하면 안 됩니다.");
const compactHtml = fs.readFileSync(path.join(ui, "compact.html"), "utf8");
const compactCss = fs.readFileSync(path.join(ui, "compact.css"), "utf8");
const compactScript = fs.readFileSync(path.join(ui, "compact.js"), "utf8");
const detailsHtml = fs.readFileSync(path.join(ui, "details.html"), "utf8");
const detailsScript = fs.readFileSync(path.join(ui, "details.js"), "utf8");
const { activeProviders, detailProviders, visibleRecommendations } = require(path.join(ui, "provider-view.js"));
assert(compactHtml.includes('id="decision"'), "첫 Compact 창에서 고갈 판정을 바로 보여줘야 합니다.");
assert(compactHtml.includes("<title>Usage Compact</title>"), "Compact는 현재 제품명을 유지해야 합니다.");
assert(insightsHtml.includes("<title>Usage Insights</title>"), "Insights는 현재 제품명을 유지해야 합니다.");
assert(detailsHtml.includes("<title>Token Details</title>"), "Token Details는 현재 제품명을 유지해야 합니다.");
assert(compactScript.includes("function renderDecision"), "Compact 창은 분석 결과의 최우선 판정을 렌더링해야 합니다.");
assert(compactScript.includes("소진 속도 계산 전"), "Compact 창은 속도를 계산하지 못한 상태를 명시해야 합니다.");
assert(compactScript.includes("최신 사용량 확인 필요"), "Compact 창은 오래된 데이터로 안전 판정을 내리면 안 됩니다.");
assert(insightsScript.includes("최신 사용량을 확인한 뒤 다시 판단하겠습니다"), "Insights는 오래된 데이터의 판정을 보류해야 합니다.");
assert(compactScript.includes("el.decision.addEventListener"), "Compact 판정에서 상세 근거로 이동할 수 있어야 합니다.");
assert(compactHtml.includes('id="no-provider"'), "연결된 공급자가 없을 때 Compact의 중립 상태가 필요합니다.");
assert(compactScript.includes("activeProviders(snapshot)"), "Compact는 현재 인증된 공급자만 표시해야 합니다.");
assert(insightsScript.includes("activeProviders(snapshot)"), "Insights는 현재 인증된 공급자만 판정해야 합니다.");
assert(detailsScript.includes("detailProviders(snapshot)"), "Token Details는 현재 연결과 과거 이력을 함께 고려해야 합니다.");
assert(detailsHtml.includes('class="toolbar"') && detailsHtml.includes("hidden"), "공급자 필터는 선택 가능한 공급자 수에 따라 숨길 수 있어야 합니다.");
const activeOnlyCodex = {
  providers: {
    codex: { authState: "authenticated" },
    claude: { authState: "unauthenticated" },
  },
  codex: { connected: true },
  claude: { connected: true },
  analytics: {
    usage: {
      rows: [{ provider: "claude", totalTokens: 10 }],
    },
  },
};
assert.deepStrictEqual(activeProviders(activeOnlyCodex), ["codex"]);
assert.deepStrictEqual(detailProviders(activeOnlyCodex), ["codex", "claude"], "과거 Claude 토큰 행은 상세 화면에서 보존해야 합니다.");
assert.deepStrictEqual(
  activeProviders({
    providers: { codex: { authState: "unknown" }, claude: { authState: "unavailable" } },
    codex: { connected: true },
    claude: { connected: true },
  }),
  ["codex"],
  "인증 확인 전에는 성공적으로 수집한 기존 공급자만 안전하게 표시합니다.",
);
assert(compactScript.includes("visibleRecommendations(analytics, providers)"), "Compact 우선 문구는 인증된 공급자로 걸러야 합니다.");
assert(insightsScript.includes("visibleRecommendations(analytics, providers)"), "Insights 권장 문구는 인증된 공급자로 걸러야 합니다.");
assert(!/analytics\.recommendations\[0\]/.test(compactScript + insightsScript), "거르지 않은 권장 문구를 그대로 대표 문구로 쓰면 안 됩니다.");
const mixedRecommendations = {
  recommendations: [
    { priority: "critical", provider: "codex", reason: "critical_limit", action: "Codex 5시간 한도가 4% 남았습니다." },
    { priority: "warning", provider: "claude", reason: "token_spike", action: "Claude 오늘 토큰 사용량이 최근 중앙값의 3.4배입니다." },
    { priority: "info", provider: "codex", reason: "model_savings", action: "Codex의 단순 작업을 gpt-5.6-luna로 보내면 절약할 수 있습니다." },
  ],
};
const claudeOnlyVisible = visibleRecommendations(mixedRecommendations, ["claude"]);
assert.deepStrictEqual(
  claudeOnlyVisible.map((item) => item.provider),
  ["claude"],
  "Claude만 인증한 사용자에게 Codex 잔여 이력 문구를 보여주면 안 됩니다.",
);
assert(
  !claudeOnlyVisible.some((item) => /gpt-/.test(item.action)),
  "표시된 문구에 다른 공급자의 모델명이 나타나면 안 됩니다.",
);
assert.deepStrictEqual(
  visibleRecommendations({ recommendations: [{ priority: "ok", provider: null, action: "현재 속도라면 유지 가능합니다." }] }, ["claude"]).length,
  1,
  "공급자가 없는 healthy 문구는 항상 통과해야 합니다.",
);
assert.deepStrictEqual(visibleRecommendations(null, ["codex"]), [], "분석 결과가 없으면 빈 목록이어야 합니다.");
assert(insightsScript.includes("if (visible.length)"), "걸러낸 뒤 남는 문구가 없으면 빈 목록을 남기지 않아야 합니다.");
assert(compactScript.includes("el.meters.dataset.providerCount"), "Compact 그리드 열 수는 표시 대상 공급자 수에서 파생해야 합니다.");
assert(/\.meters\[data-provider-count="1"\]\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s.test(compactCss), "공급자가 하나면 카드가 가로 폭을 모두 써야 합니다.");
assert(insightsScript.includes("singleProvider && singleProvider.comparison"), "단일 공급자 화면의 비교값에 미표시 공급자가 섞이면 안 됩니다.");
assert(!compactHtml.includes('class="dial"'), "의미가 모호한 대표 원형 게이지를 사용하면 안 됩니다.");
for (const id of ["codex-five-hour-bar", "codex-weekly-bar", "claude-five-hour-bar", "claude-seven-day-bar"]) {
  assert(compactHtml.includes(`id="${id}"`), `Compact 한도 막대 누락: ${id}`);
}
for (const id of ["codex-five-hour-rate", "codex-weekly-rate", "claude-five-hour-rate", "claude-seven-day-rate"]) {
  assert(compactHtml.includes(`id="${id}"`), `Compact 소진 속도 누락: ${id}`);
}
assert(compactScript.includes("function renderLimitRate"), "Compact 창은 한도별 시간당 소진 속도를 렌더링해야 합니다.");
assert(compactScript.includes("시간당 ${rate}%p"), "Compact 소진 속도는 시간 단위를 명시해야 합니다.");
assert(/body\s*\{[^}]*overflow-x:\s*hidden/s.test(compactCss), "Compact 창은 가로 스크롤을 만들면 안 됩니다.");
assert(/body\s*\{[^}]*overflow-y:\s*auto/s.test(compactCss), "작은 Compact 창은 전체 세로 스크롤로 기능에 접근할 수 있어야 합니다.");
assert(/\.meters\s*\{[^}]*overflow:\s*visible/s.test(compactCss), "확대 시 공급자 한도 카드가 잘리면 안 됩니다.");
assert(compactCss.includes("--compact-font-body: 13px"), "Compact 기본 본문 글꼴 토큰이 필요합니다.");
assert(compactCss.includes("--compact-font-title: 18px"), "Compact 기본 제목 글꼴 토큰이 필요합니다.");
assert(compactCss.includes("--compact-font-meta: 12px"), "Compact 기본 보조 글꼴 토큰이 필요합니다.");
assert(compactCss.includes("@media (max-width: 679px) and (max-height: 560px)"), "세로 카드의 중간 높이 밀도 단계가 필요합니다.");
assert(compactCss.includes("@media (max-height: 520px)"), "Compact 기본 높이를 포함하는 밀도 단계가 필요합니다.");
assert(compactCss.includes("--compact-font-body: 12px"), "낮은 Compact 창은 본문 글꼴을 단계적으로 줄여야 합니다.");
assert(compactCss.includes("--compact-font-title: 16px"), "낮은 Compact 창은 제목 글꼴을 단계적으로 줄여야 합니다.");
assert(compactCss.includes("--compact-font-meta: 11px"), "Compact 보조 글꼴은 11px 아래로 줄이면 안 됩니다.");
assert(compactCss.includes("--compact-control-height: 28px"), "낮은 Compact 창에서도 조작 높이는 28px 이상이어야 합니다.");
assert(/\.decision-strip strong\s*\{[^}]*overflow:\s*hidden/s.test(compactCss), "결정 안내에 중첩 스크롤이 생기면 안 됩니다.");
assert(!/\bzoom\s*:|transform\s*:\s*scale/i.test(compactCss), "Compact 화면 전체를 강제로 축소하면 안 됩니다.");
assert(compactHtml.includes('id="resize-grip"'), "프레임 없는 Compact 창에 크기 조절 손잡이가 필요합니다.");
assert(bridgeScript.includes('startResizeDragging("SouthEast")'), "Compact 크기 조절은 Tauri 창 API를 사용해야 합니다.");
assert(compactCss.includes("@media (max-width: 340px)"), "Compact 창에 최소 폭 레이아웃이 필요합니다.");
for (const [name, stylesheet] of [
  ["Insights", insightsCss],
  ["Details", detailsCss],
  ["Setup", setupCss],
  ["Update", updateCss],
]) {
  assert(stylesheet.includes("@media (max-width:"), `${name} 화면에 좁은 폭 레이아웃이 필요합니다.`);
}
assert(rustEntry.includes("primary_work_area"), "창 시작 크기는 모니터 작업 영역을 반영해야 합니다.");
assert(rustEntry.includes("monitor.work_area().size"), "작업 표시줄을 제외한 작업 영역을 사용해야 합니다.");
assert(rustEntry.includes(".resizable(true)"), "모든 보조 창은 사용자가 크기를 조절할 수 있어야 합니다.");
for (const id of ["setup-later", "setup-complete", "refresh", "collect"]) {
  assert(setupHtml.includes(`id="${id}"`), `Setup 온보딩 컨트롤 누락: ${id}`);
}
assert(setupScript.includes("refresh(false);"), "Setup 첫 진입은 사용량 수집 없이 설치·인증 상태만 확인해야 합니다.");
assert(setupScript.trimEnd().endsWith("loadUpdateState();"), "Setup 첫 진입은 마지막 업데이트 확인 상태도 불러와야 합니다.");
assert(setupHtml.includes('src="setup-view.js"'), "Setup은 상태 전이를 순수 계산 모듈로 분리해야 합니다.");
assert(setupHtml.includes('id="claude-section"') && setupHtml.includes('id="hook-card"'), "Claude 카드와 hook 카드는 별도 섹션으로 제어해야 합니다.");
assert(setupHtml.includes('id="claude-add"') && setupHtml.includes('id="claude-only"') && setupHtml.includes('id="codex-add"'), "Codex·Claude 전용 경로 CTA가 필요합니다.");
assert(setupScript.includes("deriveSetupView"), "Setup 렌더링은 상태 전이표를 사용해야 합니다.");
assert(setupScript.includes("latestView.canComplete"), "완료 처리는 현재 Setup 경로의 인증 조건을 사용해야 합니다.");
assert(!setupScript.includes("hasAuthenticatedProvider"), "어느 한 공급자 인증만으로 Codex 경로를 완료하면 안 됩니다.");
assert(setupScript.includes("claudeSectionExpanded: true"), "Claude CTA는 CLI 실행 없이 화면 섹션만 열어야 합니다.");
assert(setupScript.includes("providerSelectionStatus"), "경로 전환은 보조기술에 상태를 알려야 합니다.");
const { deriveSetupView } = require(path.join(ui, "setup-view.js"));
function setupFixture(codexState, claudeState) {
  return {
    setup: {
      codexAuth: { state: codexState },
      claudeAuth: { state: claudeState },
    },
  };
}
const codexFirst = deriveSetupView(setupFixture("unauthenticated", "unauthenticated"));
assert.strictEqual(codexFirst.setupMode, "codex");
assert.strictEqual(codexFirst.claudeSectionExpanded, false, "Claude 설치 여부만으로 기본 섹션을 열면 안 됩니다.");
assert.strictEqual(codexFirst.canComplete, false);
const codexOnly = deriveSetupView(setupFixture("authenticated", "unauthenticated"));
assert.deepStrictEqual(
  [codexOnly.setupMode, codexOnly.claudeSectionExpanded, codexOnly.canComplete, codexOnly.completionLabel],
  ["codex", false, true, "Codex 시작하기"],
);
const claudeOnly = deriveSetupView(setupFixture("unauthenticated", "authenticated"));
assert.deepStrictEqual(
  [claudeOnly.setupMode, claudeOnly.claudeSectionExpanded, claudeOnly.canComplete, claudeOnly.completionLabel],
  ["claudeOnly", true, true, "Claude 시작하기"],
);
const both = deriveSetupView(setupFixture("authenticated", "authenticated"));
assert.deepStrictEqual(
  [both.setupMode, both.claudeSectionExpanded, both.canComplete, both.connectedProviders],
  ["codex", true, true, "both"],
);
const claudeAddedToCodex = deriveSetupView(
  setupFixture("unauthenticated", "authenticated"),
  { setupMode: "codex", claudeSectionExpanded: true },
);
assert.strictEqual(claudeAddedToCodex.canComplete, false, "Codex 경로에서는 Claude 인증만으로 완료할 수 없습니다.");
assert.strictEqual(claudeAddedToCodex.showClaudeOnlyAction, true, "Claude 인증 뒤에도 사용자가 명시적으로 전용 경로로 전환할 수 있어야 합니다.");
const selectedClaudeOnly = deriveSetupView(
  setupFixture("unauthenticated", "authenticated"),
  { setupMode: "claudeOnly", claudeSectionExpanded: true },
);
assert.strictEqual(selectedClaudeOnly.canComplete, true);
assert(rustEntry.includes("let codex_ready = codex_cli_state() == CliState::Ready"), "설치된 공급자만 수집해야 합니다.");
assert(rustEntry.includes("let claude_ready = claude_cli_state() == CliState::Ready"), "설치된 공급자만 수집해야 합니다.");
assert(setupHtml.includes('id="activity-monitoring"'), "활동 기반 자동 확인은 사용자가 켜고 끌 수 있어야 합니다.");
assert(setupScript.includes("setActivityMonitoring"), "자동 확인 설정은 백엔드에 명시적으로 저장해야 합니다.");
assert(rustEntry.includes("AUTO_REFRESH_COOLDOWN_MS"), "활동 기반 수집에는 최소 실행 간격이 필요합니다.");
assert(rustEntry.includes("AUTO_REFRESH_COOLDOWN_MS: i64 = 5 * 60 * 1000"), "활동 중 CLI 수집 간격은 최소 5분이어야 합니다.");
assert(rustEntry.includes("if !activity_monitoring_enabled()"), "자동 확인을 끄면 활동 파일을 반복 스캔하지 않아야 합니다.");
assert(rustEntry.includes("start_activity_monitor(app.handle().clone())"), "트레이 런타임에서 활동 감시를 시작해야 합니다.");
assert(rustEntry.includes("start_update_monitor(app.handle().clone())"), "앱 시작 후 지속형 업데이트 monitor를 시작해야 합니다.");
assert(trackedSource.includes("AUTO_CHECK_DELAY_SECONDS: u64 = 15"), "자동 업데이트 확인은 시작 뒤 15초를 기다려야 합니다.");
assert(rustEntry.includes("automatic_check_wait(&app)"), "업데이트 monitor는 다음 확인 시각을 다시 계산해야 합니다.");
assert(rustEntry.includes("UPDATE_MONITOR_BUSY_SLEEP: Duration = Duration::from_secs(60)"), "동시 확인 중에는 1분 뒤 다시 판단해야 합니다.");
assert(rustEntry.includes("UPDATE_MONITOR_ERROR_SLEEP"), "상태 저장 실패도 tight loop를 만들지 않아야 합니다.");
assert(rustEntry.includes("tauri_plugin_updater::Builder::new().build()"), "공식 Rust updater plugin을 등록해야 합니다.");
assert(rustEntry.includes('"check_update"') && rustEntry.includes("update::tray_menu_text(app.handle())"), "트레이에 지속되는 업데이트 상태와 수동 진입점이 필요합니다.");
assert(rustEntry.includes("item.set_text(update::tray_menu_text(app))"), "확인 결과가 트레이 문구에 반영돼야 합니다.");
assert(rustEntry.includes("result.should_notify") && rustEntry.includes("트레이 메뉴에서 확인하세요"), "자동 발견은 창 대신 Windows 알림으로 안내해야 합니다.");
assert(rustEntry.includes("installation_in_progress(window.app_handle())"), "설치 중 업데이트 창을 닫을 수 없어야 합니다.");
assert(rustEntry.includes("fn notification_payload"), "Windows 알림 조건과 본문은 단위 테스트 가능한 계약이어야 합니다.");
assert(rustEntry.includes("tauri_plugin_single_instance::init"), "앱 중복 실행은 기존 인스턴스를 재사용해야 합니다.");
assert(rustEntry.indexOf("tauri_plugin_single_instance::init") < rustEntry.indexOf("tauri_plugin_notification::init"), "single-instance 플러그인은 가장 먼저 등록해야 합니다.");
assert(rustEntry.includes("오늘 토큰 {multiplier:.1}배 급증"), "토큰 이상 급증도 Windows 알림에 포함해야 합니다.");
assert(rustEntry.includes('Some("low")'), "저신뢰 예측만으로 Windows 고갈 알림을 보내면 안 됩니다.");
for (const field of ["sourceCapturedAt", "currentRatePercentPerHour", "safeRatePercentPerHour", "requiredReductionPercent", "depletionEventCount", "forecastSpreadPercent"]) {
  assert(trackedSource.includes(field), `시각화용 구조화 데이터 계약 누락: ${field}`);
}

const updateHtml = fs.readFileSync(path.join(ui, "update.html"), "utf8");
const updateScript = fs.readFileSync(path.join(ui, "update.js"), "utf8");
for (const text of ["새 버전이 있습니다", "현재", "새 버전", "업데이트", "나중에", "릴리스 내용 보기"]) {
  assert(updateHtml.includes(text), `업데이트 안내 문구 누락: ${text}`);
}
assert(updateHtml.includes('id="download-progress"'), "다운로드 진행률 영역이 필요합니다.");
assert(updateScript.includes("function renderProgress"), "업데이트 진행률을 렌더링해야 합니다.");
assert(updateScript.includes('installButton.textContent = "다시 시도"'), "설치 실패 후 다시 시도할 수 있어야 합니다.");
assert(updateScript.includes("현재 앱과 사용 기록은 그대로 유지됩니다"), "실패 시 기존 앱과 기록 보존을 안내해야 합니다.");
assert(updateScript.includes('installButton.addEventListener("click", installAvailableUpdate)'), "업데이트 설치는 사용자 클릭으로만 시작해야 합니다.");
assert(updateScript.trimEnd().endsWith("loadUpdate();"), "업데이트 창 로드는 상태 조회만 수행해야 합니다.");
assert(!updateScript.includes("innerHTML"), "원격 릴리스 노트는 HTML로 삽입하면 안 됩니다.");
assert(bridgeScript.includes("new window.__TAURI__.core.Channel()"), "Rust 다운로드 진행률 채널을 연결해야 합니다.");
assert(setupHtml.includes('id="check-update"'), "Setup에 수동 업데이트 확인 버튼이 필요합니다.");
assert(setupScript.includes("window.usageApp.getUpdateState()"), "Setup은 마지막 업데이트 확인 상태를 불러와야 합니다.");
for (const field of ["availableVersion", "lastSuccessfulCheckAt", "lastCheckError"]) {
  assert(setupScript.includes(field), `Setup 업데이트 진단 필드 누락: ${field}`);
}
assert(setupScript.includes("업데이트 열기"), "Setup은 이미 발견한 업데이트의 진입점을 유지해야 합니다.");
assert(setupScript.includes("window.usageApp.checkForUpdate(true)"), "Setup의 수동 확인은 cooldown과 snooze를 우회해야 합니다.");

process.stdout.write(`PASS ${scripts.length}개 UI 스크립트와 Tauri 로컬 전용 구성을 검증했습니다.\n`);
