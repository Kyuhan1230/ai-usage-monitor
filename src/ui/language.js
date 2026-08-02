"use strict";

// 모든 WebView에서 같은 언어를 사용한다. 화면이 동적으로 만든 문구도 observer가 즉시 번역한다.
(function initializeLanguage() {
  const STORAGE_KEY = "ai-usage-monitor-language";
  const VALID_LANGUAGES = new Set(["ko", "en"]);
  const originalText = new WeakMap();
  const originalAttributes = new WeakMap();

  const EN = {
    "사용량 요약": "Usage overview",
    "확인 중": "Checking",
    "5시간": "5 hours",
    "세션": "Session",
    "주간": "Weekly",
    "월간": "Monthly",
    "속도 계산 전": "Rate pending",
    "서버가 값을 읽는 중": "Reading values",
    "hook 상태 확인 중": "Checking hook",
    "마지막 갱신 확인 중": "Checking last update",
    "최근 사용 속도를 계산하는 중입니다.": "Calculating your recent usage rate.",
    "연결된 도구가 없습니다.": "No tools are connected.",
    "Setup에서 Codex 또는 Claude Code에 로그인한 뒤 사용량을 확인하세요.": "Sign in to Codex or Claude Code in Setup to view usage.",
    "항상 위": "Always on top",
    "투명도": "Opacity",
    "새로고침": "Refresh",
    "분석": "Insights",
    "상세": "Details",
    "최소화": "Minimize",
    "트레이로 숨기기": "Hide to tray",
    "창을 항상 위에 표시": "Keep window always on top",
    "창 투명도": "Window opacity",
    "창 크기 조절": "Resize window",
    "드래그하여 창 크기 조절": "Drag to resize window",
    "모델·날짜별 토큰": "Tokens by model and date",
    "로컬 집계를 불러오는 중": "Loading local totals",
    "지금 다시 계산": "Recalculate now",
    "제공자 필터": "Provider filter",
    "날짜": "Date",
    "도구": "Tool",
    "모델": "Model",
    "비용 환산": "Estimated cost",
    "표시할 로컬 토큰 기록이 없습니다.": "No local token records to display.",
    "원본 프롬프트와 응답은 표시하거나 복사하지 않습니다. 비용은 구독 청구액이 아닌 공식 API 표준 정가 등가 추정입니다.": "Original prompts and responses are never displayed or copied. Costs are API list-price estimates, not subscription charges.",
    "리셋보다 먼저 한도가 바닥날까?": "Will the limit run out before reset?",
    "로컬 기록을 분석하는 중": "Analyzing local records",
    "분석할 기록이 아직 없습니다. 컴팩트 창에서 새로고침한 뒤 다시 확인하세요.": "There is not enough history to analyze yet. Refresh in the compact window and try again.",
    "우선 확인할 한도": "Priority limit",
    "가장 먼저 소진될 한도를 찾고 있습니다": "Finding the limit most likely to run out first",
    "최근 사용 속도와 다음 리셋 시각을 비교하고 있습니다.": "Comparing recent usage with the next reset.",
    "최우선 한도를 찾는 중": "Finding the priority limit",
    "리셋 생존 분석": "Reset survival analysis",
    "예상 소진과 리셋": "Expected depletion and reset",
    "계산 중": "Calculating",
    "빠른 경우와 느린 경우를 다음 리셋 시점과 비교합니다.": "Comparing the fast and slow estimates with the next reset.",
    "시간당 사용 속도": "Hourly usage rate",
    "현재 속도를 리셋까지 유지 가능한 수준과 비교합니다.": "Comparing the current rate with the sustainable rate until reset.",
    "지금 할 일": "Next action",
    "새로고침해 최신 상태를 확인하세요.": "Refresh to check the latest status.",
    "최근 소진 속도와 고갈 예상": "Recent depletion rate and forecast",
    "최근 평균 사용 속도가 이어진다고 가정합니다": "Assumes the recent average rate continues",
    "상세 분석": "Detailed analysis",
    "비교, 이상 급증, API 정가 환산과 모든 제안": "Comparisons, spikes, API estimates, and all suggestions",
    "펼쳐보기": "Expand",
    "알림 수": "Alerts",
    "정상 범위": "Normal",
    "API 정가 환산": "API list-price estimate",
    "실제 구독 청구액 아님": "Not an actual subscription charge",
    "전일 대비": "Day over day",
    "전주 대비": "Week over week",
    "아직 비교 전": "Not enough data",
    "임계치·이상 급증": "Thresholds and unusual spikes",
    "API 정가 환산·모델 시뮬레이션": "API estimate and model simulation",
    "모든 제안": "All suggestions",
    "실제 구독 청구액이나 현금 절약액이 아닙니다. 로컬 토큰을 API 표준 정가로 환산한 참고치이며, 가격을 모르는 모델은 합계에서 제외합니다.": "These are reference estimates based on API list prices, not subscription charges or cash savings. Models without known prices are excluded.",
    "사용할 도구를 연결하세요": "Connect the tools you use",
    "Codex CLI와 Claude Code 중 사용하는 도구 하나만 연결해도 시작할 수 있습니다.": "Connect either Codex CLI or Claude Code to get started.",
    "도구 연결": "Tool connections",
    "Claude Code 연결": "Connect Claude Code",
    "Claude Code로 시작": "Start with Claude Code",
    "앱에 Claude 표시": "Show Claude in the app",
    "앱에 Codex 표시": "Show Codex in the app",
    "Codex CLI 연결": "Connect Codex CLI",
    "앱 설정": "App settings",
    "화면 테마": "Theme",
    "모든 앱 화면에 적용되며 다음 실행에도 유지됩니다.": "Applies to every app window and is saved for next time.",
    "다크": "Dark",
    "라이트": "Light",
    "표시 언어": "Language",
    "모든 앱 화면의 언어를 선택합니다.": "Choose the language used across all app windows.",
    "로컬 토큰 상세": "Local token details",
    "상세 열기": "Open details",
    "활동 중 자동 확인": "Check automatically while active",
    "자동 확인": "Automatic checks",
    "앱 업데이트": "App updates",
    "업데이트 확인 기록을 불러오는 중입니다.": "Loading update history.",
    "업데이트 확인": "Check for updates",
    "Windows 시작 시 실행": "Run at Windows startup",
    "자동 실행": "Launch automatically",
    "나중에": "Later",
    "사용량 화면 열기": "Open usage",
    "상태 다시 확인": "Check status again",
    "연결된 도구 사용량 확인": "Check connected tool usage",
    "새 버전이 있습니다": "A new version is available",
    "업데이트하면 앱을 잠시 다시 시작합니다. 사용 기록은 그대로 유지됩니다.": "The app will restart briefly. Your usage history will be preserved.",
    "릴리스 내용 보기": "View release notes",
    "업데이트 준비 중": "Preparing update",
    "업데이트": "Update",
    "전체": "All",
    "예측 불가": "Unavailable",
    "계산 전": "Pending",
    "높음": "High",
    "보통": "Medium",
    "낮음": "Low",
    "위험": "Risk",
    "주의": "Warning",
    "유지 가능": "Sustainable",
    "판정 보류": "Decision pending",
    "판단 유보": "Inconclusive",
    "기록 없음": "No history",
    "리셋 정보 없음": "No reset data",
    "소진 속도 계산 전": "Depletion rate pending",
    "리셋 전 소진 가능성 큼": "Likely to run out before reset",
    "리셋까지 유지 가능": "Likely to last until reset",
    "속도 계산 전": "Rate pending",
    "감속 불필요": "No reduction needed",
    "표시할 한도 없음": "No limit to display",
    "확인 필요": "Needs attention",
    "위험 알림 없음": "No risk alerts",
    "소진": "Depleted",
    "한도 소진": "Limit depleted",
    "갱신 중": "Updating",
    "최신": "Current",
    "재시도": "Retry",
    "지연": "Delayed",
    "오래됨": "Stale",
    "사용량 미수집": "Usage not collected",
    "사용량 방금 확인": "Usage checked just now",
    "확인 기록 없음": "No check history",
    "현재 버전 확인 불가": "Unable to determine current version",
    "다시 확인": "Check again",
    "최신 버전입니다": "Up to date",
    "Codex 데스크톱 앱만 있습니다. 사용량 확인에는 독립 실행 Codex CLI가 필요합니다.": "Only the Codex desktop app was found. Usage checks require the standalone Codex CLI.",
    "설치됨 · 로그인이 필요합니다.": "Installed · sign-in required.",
    "설치됨 · 로그인 상태를 확인하지 못했습니다. 상태를 다시 확인하세요.": "Installed · unable to verify sign-in. Check status again.",
    "로그인 완료": "Signed in",
    "Codex 설치": "Install Codex",
    "독립 CLI 설치": "Install standalone CLI",
    "공식 CLI 다시 설치": "Reinstall official CLI",
    "standalone 설치": "Install standalone CLI",
    "Codex 업데이트": "Update Codex",
    "Claude 설치": "Install Claude",
    "Codex 로그인": "Sign in to Codex",
    "Device code 로그인": "Device code sign-in",
    "다른 CLI 파일 선택": "Choose another CLI file",
    "설치 진행 중": "Installation in progress",
    "설치 취소": "Cancel installation",
    "로그인 진행 중": "Sign-in in progress",
    "로그인 취소": "Cancel sign-in",
    "작업 취소": "Cancel operation",
    "Claude 로그인": "Sign in to Claude",
    "독립 실행 Codex CLI를 찾지 못했습니다.": "The standalone Codex CLI was not found.",
    "Codex 데스크톱 앱과 별도로 독립 실행 CLI가 필요합니다.": "A standalone CLI is required in addition to the Codex desktop app.",
    "발견한 Codex 후보를 안전하게 실행할 수 없습니다.": "The discovered Codex candidate cannot be run safely.",
    "Codex 후보의 버전을 확인하지 못했습니다.": "The Codex candidate version could not be verified.",
    "설치된 Codex CLI가 필요한 명령을 지원하지 않습니다.": "The installed Codex CLI does not support the required commands.",
    "사용 가능한 Codex CLI가 여러 개라 자동으로 선택하지 않았습니다.": "Multiple Codex CLIs are available, so none was selected automatically.",
    "예전 npm 설치에 필요한 Node.js를 찾지 못했습니다.": "Node.js required by the legacy npm installation was not found.",
    "예전 npm 설치와 현재 Node.js가 호환되지 않습니다.": "The legacy npm installation is incompatible with the current Node.js runtime.",
    "Codex 후보의 게시자 확인에 실패해 실행을 차단했습니다.": "Publisher verification failed, so this Codex candidate was blocked.",
    "Windows의 최신 CLI 경로를 확인하지 못했습니다.": "The latest Windows CLI paths could not be checked.",
    "사용자 지정 Codex 설치 경로가 올바르지 않습니다.": "The custom Codex installation location is invalid.",
    "Codex 설치 프로세스를 시작하지 못했습니다.": "The Codex installation process could not be started.",
    "Codex 설치 프로세스가 정상적으로 끝나지 않았습니다.": "The Codex installation process did not exit successfully.",
    "설치 뒤에도 실행 가능한 Codex CLI를 확인하지 못했습니다.": "No runnable Codex CLI was found after installation.",
    "Codex 설치를 취소했습니다.": "Codex installation was cancelled.",
    "Codex 로그인 프로세스를 시작하지 못했습니다.": "The Codex sign-in process could not be started.",
    "Codex 로그인을 취소했습니다.": "Codex sign-in was cancelled.",
    "로그인 프로세스는 끝났지만 인증 완료를 확인하지 못했습니다.": "The sign-in process exited, but authentication could not be confirmed.",
    "Codex 로그인 상태 확인 시간이 초과됐습니다.": "Checking Codex sign-in status timed out.",
    "Codex 로그인 상태를 안전하게 판정하지 못했습니다.": "Codex sign-in status could not be determined safely.",
    "이 Codex CLI에서는 사용량 확인 명령을 사용할 수 없습니다.": "This Codex CLI does not provide the usage command.",
    "Codex 사용량을 확인하지 못했습니다.": "Codex usage could not be checked.",
    "Codex 사용량 확인 시간이 초과됐습니다.": "Checking Codex usage timed out.",
    "이미 Codex 작업이 진행 중입니다.": "A Codex operation is already in progress.",
    "Codex 설정 상태를 확인하지 못했습니다.": "Codex setup status could not be checked.",
    "현재 PATH": "Current PATH",
    "사용자 PATH": "User PATH",
    "시스템 PATH": "System PATH",
    "기본 standalone 경로": "Default standalone location",
    "npm 전역 launcher": "Global npm launcher",
    ".local launcher": ".local launcher",
    "사용자 local bin": "User local bin",
    "사용자 지정 설치 경로": "Custom installation location",
    "직접 선택한 CLI": "Manually selected CLI",
    "직접 선택한 Codex CLI": "Manually selected Codex CLI",
    "게시자 확인": "Publisher verified",
    "이 앱에서 시작한 공식 설치": "Official installation started by this app",
    "공급자 출처 미확인": "Publisher provenance unverified",
    "게시자 확인 실패": "Publisher verification failed",
    "Codex CLI 후보를 확인하는 중입니다.": "Checking Codex CLI candidates.",
    "독립 실행 Codex CLI가 없습니다.": "The standalone Codex CLI is not installed.",
    "Codex로 보이는 파일을 실행하거나 버전을 확인할 수 없습니다.": "A Codex-like file was found, but it could not be run or version-checked.",
    "예전 npm Codex 설치가 있지만 필요한 Node.js가 없습니다.": "A legacy npm Codex installation exists, but its required Node.js runtime is missing.",
    "예전 npm Codex 설치와 현재 Node.js가 호환되지 않습니다.": "The legacy npm Codex installation is incompatible with the current Node.js runtime.",
    "설치된 Codex CLI가 로그인 또는 사용량 확인에 필요한 명령을 지원하지 않습니다.": "The installed Codex CLI does not support the required sign-in or usage commands.",
    "사용 가능한 Codex CLI가 여러 개입니다. 사용할 CLI를 아래에서 직접 선택하세요.": "Multiple Codex CLIs are available. Select the one to use below.",
    "Codex CLI 상태를 안전하게 판정하지 못했습니다.": "Codex CLI status could not be determined safely.",
    "Codex CLI 확인 완료": "Codex CLI ready",
    "로그인 확인 완료": "Sign-in confirmed",
    "로그인 상태 확인 중": "Checking sign-in status",
    "로그인이 필요합니다": "Sign-in required",
    "Codex 로그인 상태를 확인하지 못했습니다.": "Codex sign-in status could not be checked.",
    "Codex 설치가 오래 걸리고 있습니다. PowerShell 진행 상황을 확인하거나 취소할 수 있습니다.": "Codex installation is taking longer than expected. Check PowerShell progress or cancel the operation.",
    "Codex 공식 설치 프로그램을 실행하고 있습니다.": "Running the official Codex installer.",
    "Codex 설치 작업의 실행·취소 결과와 설치된 CLI를 검증하는 중입니다.": "Checking the Codex installation or cancellation result and validating the installed CLI.",
    "로그인이 오래 걸리고 있습니다. 브라우저 인증을 완료하거나 작업을 취소할 수 있습니다.": "Sign-in is taking longer than expected. Complete browser authentication or cancel the operation.",
    "Codex가 연 브라우저에서 로그인을 완료하세요. 계정과 MFA는 사용자가 직접 입력합니다.": "Complete sign-in in the browser opened by Codex. You enter the account and MFA details yourself.",
    "로그인 작업의 실행·취소 결과와 같은 Codex CLI의 인증 상태를 확인하는 중입니다.": "Checking the sign-in or cancellation result and authentication state of the same Codex CLI.",
    "로그인 명령이 끝났습니다. Codex 인증 상태를 다시 확인하는 중입니다.": "The sign-in command exited. Checking Codex authentication again.",
    "Codex 설치를 완료하지 못했습니다.": "Codex installation could not be completed.",
    "Codex 설치 프로세스는 비정상 종료했지만, 앱이 실행 가능한 Codex CLI를 별도로 확인했습니다.": "The Codex installer process exited abnormally, but the app separately verified a runnable Codex CLI.",
    "이전 설치 작업의 추적이 끊겼습니다. 현재 CLI 상태를 다시 확인하세요.": "Tracking for the previous installation was lost. Check the current CLI status again.",
    "이전 로그인 작업의 추적이 끊겼습니다. 현재 로그인 상태를 다시 확인하세요.": "Tracking for the previous sign-in was lost. Check the current sign-in status again.",
    "앱은 선택된 Codex CLI에서 로그인 명령까지만 시작합니다. 브라우저의 계정 입력, MFA와 승인은 사용자가 직접 완료합니다.": "The app only starts the sign-in command using the selected Codex CLI. You complete account entry, MFA, and approval in the browser.",
    "사용할 Codex CLI를 선택하세요. 전체 경로는 앱에 표시되지 않습니다.": "Select the Codex CLI to use. Full paths are not displayed in the app.",
    "Codex CLI 후보 목록": "Codex CLI candidate list",
    "Codex CLI 작업": "Codex CLI actions",
    "사용할 Claude Code에 로그인하세요.": "Sign in to the Claude Code installation you want to use.",
    "Codex CLI에 로그인하거나 Claude Code를 사용할 도구로 선택하세요.": "Sign in to Codex CLI or select Claude Code as the tool to use.",
    "10분 동안 자동 확인했습니다. 작업은 종료하지 않았습니다. PowerShell을 확인하거나 상태를 다시 확인하세요.": "Automatic checks stopped after 10 minutes. The operation was not terminated. Check PowerShell or refresh the status.",
    "Codex 작업 상태를 자동으로 확인하지 못했습니다. 상태를 다시 확인하세요.": "The Codex operation could not be checked automatically. Refresh the status.",
    "Codex 설치를 시작하지 않았습니다.": "Codex installation was not started.",
    "Codex 설치를 시작했습니다. 이 앱이 종료 결과와 설치된 CLI를 다시 확인합니다.": "Codex installation was started. The app will check the exit result and installed CLI.",
    "Device code 로그인을 시작했습니다. 터미널의 안내에 따라 사용자가 직접 인증하세요.": "Device code sign-in was started. Follow the terminal instructions to authenticate yourself.",
    "Codex 로그인을 시작했습니다. 브라우저의 계정 입력, MFA와 승인은 사용자가 직접 완료하세요.": "Codex sign-in was started. Complete account entry, MFA, and approval yourself in the browser.",
    "Codex 설치 프로세스를 시작하지 못했습니다. 상태를 다시 확인하세요.": "The Codex installation process could not be started. Refresh the status.",
    "Codex 로그인 프로세스를 시작하지 못했습니다. 상태를 다시 확인하세요.": "The Codex sign-in process could not be started. Refresh the status.",
    "선택한 Codex CLI를 다시 검증하는 중입니다.": "Revalidating the selected Codex CLI.",
    "Codex CLI 후보를 선택했습니다. 같은 CLI의 로그인 상태를 다시 확인했습니다.": "The Codex CLI candidate was selected and its sign-in status was checked again.",
    "Codex CLI 후보를 선택하지 못했습니다. 상태를 다시 확인하세요.": "The Codex CLI candidate could not be selected. Refresh the status.",
    "선택한 Codex CLI 파일을 앱 안에서 다시 검증하는 중입니다.": "Validating the selected Codex CLI file inside the app.",
    "파일 선택 창을 닫고 현재 Codex 상태를 확인했습니다. 선택한 파일이 있으면 같은 경로로 검증했습니다.": "Closed the file picker and checked the current Codex status. If you selected a file, it was validated using that same path.",
    "선택한 파일을 Codex CLI로 검증하지 못했습니다. 상태를 다시 확인하세요.": "The selected file could not be validated as Codex CLI. Refresh the status.",
    "Codex 설치 취소를 요청하는 중입니다.": "Requesting cancellation of the Codex installation.",
    "Codex 로그인 취소를 요청하는 중입니다.": "Requesting cancellation of Codex sign-in.",
    "Codex 설치 취소를 요청했습니다.": "Codex installation cancellation was requested.",
    "Codex 로그인 취소를 요청했습니다.": "Codex sign-in cancellation was requested.",
    "Codex 작업을 취소하지 못했습니다. PowerShell과 현재 상태를 확인하세요.": "The Codex operation could not be cancelled. Check PowerShell and the current status.",
    [`OpenAI Codex CLI 공식 설치 프로그램을 실행할까요?

출처: https://chatgpt.com/codex/install.ps1
인터넷에서 CLI를 내려받고 사용자 PATH를 변경할 수 있습니다.
CLI는 이 앱에 포함되지 않으며 일반 사용자는 Node.js, npm 또는 Rust를 설치할 필요가 없습니다.
실행 중에는 이 화면에서 취소를 요청할 수 있으며, 종료 확인 단계에 들어가면 취소할 수 없습니다.`]: `Run the official OpenAI Codex CLI installer?

Source: https://chatgpt.com/codex/install.ps1
The installer downloads the CLI from the internet and may update your user PATH.
The CLI is not bundled with this app, and regular users do not need to install Node.js, npm, or Rust.
You can request cancellation from this screen while it is running; cancellation is unavailable after final verification begins.`,
    "CLI 설치를 취소했습니다.": "CLI installation was cancelled.",
    "정상: 별도 서버 없이 로컬 세션 파일에서 모델·날짜별 토큰을 표시합니다.": "Ready: model and daily token totals come from local session files without a separate server.",
    "켜짐: 앱만 시작하며 사용량 CLI는 상주시켜 두지 않습니다.": "On: starts only the app; usage CLIs do not stay running.",
    "꺼짐: 사용자가 직접 실행할 때만 앱이 시작됩니다.": "Off: the app starts only when you open it.",
    "켜짐: 로컬 세션 활동이 있을 때만, 최소 5분 간격으로 사용량을 확인합니다.": "On: checks usage at least five minutes apart when local session activity is detected.",
    "꺼짐: 새로고침 버튼을 눌렀을 때만 사용량을 확인합니다.": "Off: checks usage only when you press Refresh.",
    "첫 설정을 마치고 사용량 화면을 엽니다.": "Finish setup and open the usage screen.",
    "다시 표시": "Show again",
    "이 앱에서 숨기기": "Hide in this app",
    "Claude Code 연결 영역을 열었습니다.": "Opened the Claude Code connection section.",
    "Claude Code를 사용할 도구로 선택했습니다.": "Selected Claude Code as a tool.",
    "Codex CLI를 사용할 도구로 선택했습니다.": "Selected Codex CLI as a tool.",
    "연결된 도구의 사용량을 한 번씩 확인하는 중입니다.": "Checking usage for each connected tool.",
    "설치 및 로그인 상태를 확인하는 중입니다.": "Checking installation and sign-in status.",
    "사용량 확인을 마쳤습니다.": "Usage check completed.",
    "설치 및 로그인 상태를 확인했습니다.": "Installation and sign-in status checked.",
    "새 버전을 확인하는 중입니다.": "Checking for a new version.",
    "현재 최신 버전을 사용하고 있습니다.": "You are using the latest version.",
    "업데이트 안내 창을 열었습니다.": "Opened the update window.",
    "다른 업데이트 확인이 진행 중입니다. 잠시 후 다시 시도하세요.": "Another update check is in progress. Try again shortly.",
    "서명된 업데이트 준비 중": "Preparing signed update",
    "서명 확인 완료 · 설치 준비 중": "Signature verified · preparing installation",
    "설치 완료 · 앱 다시 시작 중": "Installation complete · restarting app",
    "업데이트 다운로드 중": "Downloading update",
    "업데이트 중": "Updating",
    "다시 시도": "Try again",
    "업데이트 중단됨": "Update stopped",
    "최신 사용량을 다시 수집해야 합니다": "Collect the latest usage again",
    "오래된 예상값은 현재 상태처럼 표시하지 않습니다.": "Stale forecasts are not shown as the current state.",
    "리셋 시각을 확인할 수 없습니다": "Reset time is unavailable",
    "공급자가 리셋 시각을 제공한 뒤 생존 여부를 계산합니다.": "Survival is calculated after the provider supplies a reset time.",
    "잔여량이 실제로 줄어들면 고갈 시점을 계산합니다": "A depletion forecast appears after remaining usage decreases",
    "수집 횟수보다 잔여량이 변한 기록이 필요합니다.": "A change in remaining usage is required, not just more samples.",
    "최신 속도를 다시 계산해야 합니다": "Recalculate the latest rate",
    "오래된 데이터에는 감속 목표를 제시하지 않습니다.": "No reduction target is shown for stale data.",
    "잔여량 변화가 확인되면 필요한 속도를 계산합니다": "The required rate appears after remaining usage changes",
    "아직 사용량이 줄어든 기록이 없어 감속 목표를 계산할 수 없습니다.": "A reduction target cannot be calculated until usage decreases.",
    "현재 속도라면 다음 리셋까지 한도를 유지할 가능성이 큽니다.": "At the current rate, the limit is likely to last until the next reset.",
    "한도 기록이 없습니다": "No limit history",
    "임계치 초과나 이상 급증이 감지되지 않았습니다.": "No threshold breach or unusual spike was detected.",
    "오늘 토큰 기록 없음": "No token records today",
    "최신 사용량을 확인한 뒤 다시 판단하겠습니다": "Refresh usage before making a decision",
    "현재 속도면 리셋 전에 소진될 가능성이 큽니다": "At this rate, usage is likely to run out before reset",
    "잔여량 변화가 확인되면 고갈 시점을 계산할 수 있습니다": "A depletion forecast will appear after remaining usage changes",
    "현재 사용 흐름이면 다음 리셋까지 한도를 유지할 가능성이 큽니다": "The current usage trend is likely to last until the next reset",
    "가장 먼저 확인할 한도": "First limit to check",
    "마지막 수집 후 10분이 지났습니다. 이전 값 대신 최신 사용량으로 다시 계산하세요.": "More than 10 minutes have passed since collection. Recalculate using current usage.",
    "최근 평균 사용 속도를 기준으로 한 결과입니다. 작업량이 크게 달라지면 다시 계산하세요.": "This result uses the recent average rate. Recalculate if your workload changes significantly.",
    "수집 횟수가 아니라 실제 잔여량 변화가 있어야 소진 속도를 계산할 수 있습니다.": "The depletion rate requires an actual change in remaining usage, not just more samples.",
    "지금 다시 계산해 최신 사용량을 확인하세요.": "Recalculate now to check current usage.",
    "고갈 시점의 오차가 큽니다. 큰 작업을 나누고 사용량을 줄이세요.": "The depletion estimate has a wide margin. Split large tasks and reduce usage.",
    "잔여량이 줄어든 뒤 다시 계산하거나 활동 기반 자동 확인을 켜세요.": "Recalculate after remaining usage decreases, or enable activity-based checks.",
    "현재 속도를 유지해도 됩니다. 작업량이 달라지면 다시 확인하세요.": "You can maintain the current rate. Check again if your workload changes."
  };

  const RULES = [
    [/^현재 PATH #(\d+)$/, "Current PATH #$1"],
    [/^사용자 PATH #(\d+)$/, "User PATH #$1"],
    [/^시스템 PATH #(\d+)$/, "System PATH #$1"],
    [/^Codex CLI 후보 (\d+)$/, "Codex CLI candidate $1"],
    [/^사용 가능한 Codex CLI (\d+)개가 충돌합니다\. 사용할 CLI를 아래에서 직접 선택하세요\.$/, "$1 Codex CLI candidates conflict. Select the CLI to use below."],
    [/^추가 Codex 후보 (\d+)개는 우선순위가 낮아 선택하지 않았습니다\. 호환 가능한 다른 설치이거나 예전 npm 설치일 수 있으므로 원치 않으면 업데이트하거나 제거하세요\.$/, "$1 additional Codex CLI candidate(s) were not selected because they have lower priority. They may be another compatible installation or a legacy npm installation; update or remove them if unwanted."],
    [/^(\d+)% 남음$/, "$1% remaining"],
    [/^시간당 ([\d.]+)%p$/, "$1%p/hour"],
    [/^(\d+)분 전 갱신$/, "Updated $1m ago"],
    [/^(\d+)시간 전 갱신$/, "Updated $1h ago"],
    [/^(\d+)시간 (\d+)분 전 갱신$/, "Updated $1h $2m ago"],
    [/^방금 갱신$/, "Updated just now"],
    [/^수집 (.+)$/, "Captured $1"],
    [/^리셋 (.+)$/, "Resets $1"],
    [/^허용 ([\d.]+)%p\/시간$/, "Allowed $1%p/hour"],
    [/^현재 ([\d.]+)%p\/시간$/, "Current $1%p/hour"],
    [/^현재가 허용 속도의 ([\d.]+)배$/, "$1× the allowed rate"],
    [/^약 (\d+)% 감속 필요$/, "Reduce by about $1%"],
    [/^(\d+)% 감속 필요$/, "$1% reduction needed"],
    [/^앞으로 사용량을 약 (\d+)% 줄이세요\.$/, "Reduce usage by about $1% from now on."],
    [/^현재 속도면 리셋보다 (.+) 먼저 소진$/, "At this rate, usage runs out $1 before reset"],
    [/^(.+) · (.+) · (.+) 수집$/, "$1 · $2 · captured $3"],
    [/^(.+) 한도가 소진됐습니다$/, "$1 is depleted"],
    [/^(.+) 한도가 거의 소진됐습니다$/, "$1 is nearly depleted"],
    [/^(.+) 한도를 확인하세요$/, "Check the $1 limit"],
    [/^(.+) 사용 흐름 확인 전$/, "$1 usage trend pending"],
    [/^(.+) 최신 사용량 확인 필요$/, "$1 usage needs refreshing"],
    [/^(.+) 리셋 전 소진 가능성$/, "$1 may run out before reset"],
    [/^(.+) 소진 속도 계산 전$/, "$1 depletion rate pending"],
    [/^(.+) 현재 속도 유지 가능$/, "$1 current rate is sustainable"],
    [/^(.+) (.+) 한도 소진$/, "$1 $2 limit depleted"],
    [/^(.+) (.+) 한도 위험 · (\d+)% 남음$/, "$1 $2 limit at risk · $3% remaining"],
    [/^(.+) (.+) 한도 주의 · (\d+)% 남음$/, "$1 $2 limit warning · $3% remaining"],
    [/^(.+) 한도 위험 · (\d+)% 남음$/, "$1 limit at risk · $2% remaining"],
    [/^(.+) 한도 주의 · (\d+)% 남음$/, "$1 limit warning · $2% remaining"],
    [/^(.+)의 최근 사용 속도를 계산 중입니다\.$/, "Calculating $1's recent usage rate."],
    [/^(.+) 사용량을 새로고침하세요\.$/, "Refresh $1 usage."],
    [/^리셋 전까지 (.+)의 새 작업을 멈추세요\.$/, "Pause new $1 work until reset."],
    [/^(.+)의 큰 작업을 줄여 (.+) 한도를 아끼세요\.$/, "Reduce large $1 tasks to preserve the $2 limit."],
    [/^(.+)의 큰 작업을 나누고 사용량을 줄이세요\.$/, "Split large $1 tasks and reduce usage."],
    [/^(.+) (.+) 사용량을 약 (\d+)% 줄이세요\.$/, "Reduce $1 $2 usage by about $3%."],
    [/^(.+)의 중요한 작업을 우선해 (.+) 한도를 아끼세요\.$/, "Prioritize important $1 tasks to preserve the $2 limit."],
    [/^(.+) 잔여량 변화 후 소진 여부를 다시 계산합니다\.$/, "Recalculate $1 depletion after remaining usage changes."],
    [/^(.+)는 현재 속도를 유지해도 됩니다\.$/, "$1 can maintain the current rate."],
    [/^(.+) 토큰 사용 급증\. 반복 작업을 점검하세요\.$/, "$1 token usage spiked. Check repetitive tasks."],
    [/^(.+)의 단순 작업에는 저비용 모델을 고려하세요\.$/, "Consider a lower-cost model for simple $1 tasks."],
    [/^사용량 (\d+)분 전 확인$/, "Usage checked $1m ago"],
    [/^사용량 (\d+)시간 전 확인$/, "Usage checked $1h ago"],
    [/^사용량 (\d+)시간 (\d+)분 전 확인$/, "Usage checked $1h $2m ago"],
    [/^(\d+)개 날짜·모델 행 · (.+) tokens · 최대 500행$/, "$1 date/model rows · $2 tokens · up to 500 rows"],
    [/^v(.+) 사용 중$/, "Running v$1"],
    [/^(.+)가 설치되어 있지 않습니다\.$/, "$1 is not installed."],
    [/^설치됨 · 로그인 완료 · (.+)$/, "Installed · signed in · $1"],
    [/^(.+) 설치 창을 열었습니다\.(.+)$/, "Opened the $1 installer.$2"],
    [/^(.+)를 이 앱에서 숨겼습니다\. CLI 로그인은 그대로입니다\.$/, "$1 is hidden in this app. CLI sign-in is unchanged."],
    [/^(.+)를 다시 표시합니다\.$/, "Showing $1 again."],
    [/^실행 실패: (.+)$/, "Failed to run: $1"],
    [/^상태 확인 실패: (.+)$/, "Status check failed: $1"],
    [/^표시 설정 변경 실패: (.+)$/, "Failed to change visibility: $1"],
    [/^업데이트 확인 실패: (.+) 네트워크를 확인한 뒤 다시 시도하세요\.$/, "Update check failed: $1 Check your network and try again."],
    [/^(\d+)시간 관찰$/, "$1h observed"],
    [/^잔여량 감소 (\d+)회$/, "$1 depletion events"],
    [/^평균 속도 오차 약 ±(\d+)%$/, "Average-rate uncertainty about ±$1%"],
    [/^(\d+)일$/, "$1d"],
    [/^(\d+)시간$/, "$1h"],
    [/^(\d+)분$/, "$1m"]
  ];

  function normalizeLanguage(value) {
    return VALID_LANGUAGES.has(value) ? value : "ko";
  }

  function readLanguage() {
    try {
      return normalizeLanguage(window.localStorage.getItem(STORAGE_KEY));
    } catch (_error) {
      return "ko";
    }
  }

  function locale() {
    return readLanguage() === "en" ? "en-US" : "ko-KR";
  }

  function translateUnit(value) {
    return EN[value] || RULES.reduce((result, [pattern, replacement]) => (
      result === value && pattern.test(value) ? value.replace(pattern, replacement) : result
    ), value);
  }

  function translateText(value) {
    const trimmed = value.trim();
    if (!trimmed) return value;
    let translated = translateUnit(trimmed);
    if (translated === trimmed && trimmed.includes(" · ")) {
      translated = trimmed.split(" · ").map(translateUnit).join(" · ");
    }
    return value.replace(trimmed, translated);
  }

  function translateNode(node, language) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!originalText.has(node)) originalText.set(node, node.nodeValue);
      node.nodeValue = language === "en" ? translateText(originalText.get(node)) : originalText.get(node);
      return;
    }
    if (!(node instanceof Element)) return;
    const saved = originalAttributes.get(node) || {};
    for (const name of ["title", "aria-label", "placeholder"]) {
      if (node.hasAttribute(name) && !(name in saved)) saved[name] = node.getAttribute(name);
      if (name in saved) {
        const nextValue = language === "en" ? translateText(saved[name]) : saved[name];
        if (node.getAttribute(name) !== nextValue) node.setAttribute(name, nextValue);
      }
    }
    originalAttributes.set(node, saved);
    for (const child of node.childNodes) translateNode(child, language);
  }

  function applyLanguage(value) {
    const language = normalizeLanguage(value);
    document.documentElement.lang = language;
    if (document.body) translateNode(document.body, language);
    return language;
  }

  function setLanguage(value) {
    const language = applyLanguage(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, language);
    } catch (_error) {
      // 저장소를 사용할 수 없어도 현재 창에는 선택한 언어를 적용한다.
    }
    window.dispatchEvent(new CustomEvent("usage-language-change", { detail: { language } }));
    window.setTimeout(() => window.location.reload(), 0);
    return language;
  }

  const observer = new MutationObserver((mutations) => {
    const language = readLanguage();
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) translateNode(node, language);
      if (mutation.type === "attributes") translateNode(mutation.target, language);
    }
  });

  document.addEventListener("DOMContentLoaded", () => {
    applyLanguage(readLanguage());
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["title", "aria-label", "placeholder"]
    });
  });
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) window.location.reload();
  });

  window.usageLanguage = { applyLanguage, readLanguage, setLanguage, translateText, locale, STORAGE_KEY };
}());
