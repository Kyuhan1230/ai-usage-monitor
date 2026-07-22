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
assert.strictEqual(packageJson.version, "1.2.1");
assert.strictEqual(tauriConfig.version, packageJson.version);
assert.strictEqual(tauriConfig.build.frontendDist, "../src/ui");
assert.deepStrictEqual(tauriConfig.app.windows, [], "백그라운드 시작 시 WebView를 만들면 안 됩니다.");
assert.strictEqual(tauriConfig.bundle.windows.webviewInstallMode.type, "skip");
assert.strictEqual(tauriConfig.bundle.windows.nsis.installerHooks, "./windows/hooks.nsh");
assert(!JSON.stringify(packageJson).match(/electron|python|fastapi|node-pty/i));
assert(!cargoToml.match(/reqwest|ureq|hyper|tauri-plugin-http/i));
assert.strictEqual((cargoToml.match(/tauri-plugin-updater/g) || []).length, 1);
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
const setupCss = fs.readFileSync(path.join(ui, "setup.css"), "utf8");
const insightsHtml = fs.readFileSync(path.join(ui, "insights.html"), "utf8");
const insightsScript = fs.readFileSync(path.join(ui, "insights.js"), "utf8");
const insightsCss = fs.readFileSync(path.join(ui, "insights.css"), "utf8");
const detailsCss = fs.readFileSync(path.join(ui, "details.css"), "utf8");
const updateCss = fs.readFileSync(path.join(ui, "update.css"), "utf8");
const bridgeScript = fs.readFileSync(path.join(ui, "bridge.js"), "utf8");
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
assert(compactHtml.includes('id="decision"'), "첫 Compact 창에서 고갈 판정을 바로 보여줘야 합니다.");
assert(compactScript.includes("function renderDecision"), "Compact 창은 분석 결과의 최우선 판정을 렌더링해야 합니다.");
assert(compactScript.includes("소진 속도 계산 전"), "Compact 창은 속도를 계산하지 못한 상태를 명시해야 합니다.");
assert(compactScript.includes("최신 사용량 확인 필요"), "Compact 창은 오래된 데이터로 안전 판정을 내리면 안 됩니다.");
assert(insightsScript.includes("최신 사용량을 확인한 뒤 다시 판단하겠습니다"), "Insights는 오래된 데이터의 판정을 보류해야 합니다.");
assert(compactScript.includes("el.decision.addEventListener"), "Compact 판정에서 상세 근거로 이동할 수 있어야 합니다.");
assert(!compactHtml.includes('class="dial"'), "의미가 모호한 대표 원형 게이지를 사용하면 안 됩니다.");
for (const id of ["codex-five-hour-bar", "codex-weekly-bar", "claude-five-hour-bar", "claude-seven-day-bar"]) {
  assert(compactHtml.includes(`id="${id}"`), `Compact 한도 막대 누락: ${id}`);
}
for (const id of ["codex-five-hour-rate", "codex-weekly-rate", "claude-five-hour-rate", "claude-seven-day-rate"]) {
  assert(compactHtml.includes(`id="${id}"`), `Compact 소진 속도 누락: ${id}`);
}
assert(compactScript.includes("function renderLimitRate"), "Compact 창은 한도별 시간당 소진 속도를 렌더링해야 합니다.");
assert(compactScript.includes("시간당 ${rate}%p"), "Compact 소진 속도는 시간 단위를 명시해야 합니다.");
assert(/body\s*\{[^}]*overflow:\s*auto/s.test(compactCss), "확대된 Compact 내용은 세로로 스크롤할 수 있어야 합니다.");
assert(/\.meters\s*\{[^}]*overflow:\s*visible/s.test(compactCss), "확대 시 공급자 한도 카드가 잘리면 안 됩니다.");
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
assert(rustEntry.includes("start_automatic_update_check(app.handle().clone())"), "앱 시작 후 자동 업데이트 확인을 예약해야 합니다.");
assert(rustEntry.includes("AUTO_CHECK_DELAY_SECONDS"), "자동 업데이트 확인에는 시작 지연이 필요합니다.");
assert(rustEntry.includes("tauri_plugin_updater::Builder::new().build()"), "공식 Rust updater plugin을 등록해야 합니다.");
assert(rustEntry.includes('MenuItem::with_id(app, "check_update", "업데이트 확인"'), "트레이에 수동 업데이트 확인이 필요합니다.");
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
assert(setupScript.includes("window.usageApp.checkForUpdate(true)"), "Setup의 수동 확인은 cooldown과 snooze를 우회해야 합니다.");

process.stdout.write(`PASS ${scripts.length}개 UI 스크립트와 Tauri 로컬 전용 구성을 검증했습니다.\n`);
