# Channel-specific promotion copy

These are drafts, not text to paste everywhere unchanged. Before posting, re-check each community's current self-promotion rules and replace placeholders with the current release and demo URLs.

## 1. GeekNews

제목:

> Codex와 Claude Code 한도가 작업 중 끝나서, 고갈 시각을 예측하는 Windows 앱을 만들었습니다

본문:

> Codex CLI와 Claude Code를 번갈아 쓰다 보면 남은 비율은 보여도 “이 속도면 reset 전에 막히는가?”는 바로 답하기 어려웠습니다. 그래서 두 도구의 한도와 로컬 토큰 기록을 연결해 고갈 시각, 평소 대비 급증, 필요한 감속 비율을 계산하는 Windows 트레이 앱을 만들었습니다.
>
> 수집기를 상주시켜 두지 않았습니다. 사용자가 새로고침하거나 opt-in 활동 감지가 발생할 때만 CLI를 한 번 실행하고, prompt와 response 본문은 분석 결과에 저장하지 않습니다. 자체 telemetry와 local HTTP server도 없습니다.
>
> 경량성은 좋은 숫자만 고르지 않고 함께 공개했습니다. cold tray idle은 11.43MB이고 WebView process가 없지만, UI를 열면 WebView2를 포함해 약 427MB까지 올라갑니다. 그래서 창을 닫으면 WebView 자체를 파기하도록 만들었습니다.
>
> 현재 가장 큰 제약은 Authenticode 미서명입니다. SignPath Foundation 첫 신청은 아직 외부 신뢰 신호가 부족하다는 이유로 승인되지 않아 SmartScreen 경고가 나올 수 있습니다. GitHub Release의 SHA-256, source build 방법과 local data 경계를 공개하고 제한 beta로 설치 마찰부터 확인하고 있습니다.
>
> Windows에서 실제 Codex CLI 또는 Claude Code를 쓰는 분의 피드백이 필요합니다. 특히 설치를 중단하게 만든 지점, 첫 refresh 성공 여부, 고갈 예측 문구가 이해되는지를 알고 싶습니다.

## 2. Reddit — Claude Code angle

Title:

> I wanted quota forecasting, not another Claude token dashboard

Body:

> I use Claude Code on Windows and the number I actually need is not accumulated tokens—it is whether the current quota will survive until reset.
>
> I built a local tray app that estimates an exhaustion window from observed burn rate, compares it with reset time, flags unusual spikes against the recent baseline, and suggests a slowdown or model change. It can show Codex CLI beside Claude Code, but Claude alone is enough to use it.
>
> It has no developer-operated telemetry or local web server. It does not copy prompts or response text into analytics. Collection is one-shot on refresh or an opt-in activity trigger rather than an always-running CLI.
>
> Honest limitation: the current Windows installer is not Authenticode-signed, so SmartScreen may show Unknown publisher. The release page includes the exact SHA-256 and source-build path.
>
> I would value feedback from actual Windows Claude Code users on first-run setup and whether the forecast changes a real decision.
>
> Demo: `<demo URL>`<br>
> Source and release: `<repository URL>`

## 3. Reddit — Codex angle

Title:

> I built a Windows tray app to predict whether Codex will hit its limit before reset

Body:

> Codex shows the current limit, but during a long coding session I still wanted a decision: at this burn rate, will I run out before reset?
>
> This app makes a local history of quota observations, estimates an exhaustion range and confidence, detects unusual acceleration, and suggests how much to slow down. Claude Code can be shown in the same window, but it is optional.
>
> For Codex it calls the installed CLI app server's `account/rateLimits/read` once per refresh and exits. There is no always-on collection process and no prompt or response telemetry.
>
> The installer is currently unsigned with Authenticode, and that limitation is stated before download. SHA-256 and build-from-source instructions are available on the release page.
>
> Demo: `<demo URL>`<br>
> Source and release: `<repository URL>`

## 4. Developer-tools / Tauri angle

Title:

> The idle and open-UI memory cost of my Tauri tray app—including the ugly number

Body:

> I moved a Windows usage monitor to Tauri and measured more than the installer size.
>
> - Release executable: 4.41 MB
> - Cold tray idle: 11.43 MB, one process, no WebView
> - After closing the UI: 25.28 MB, no WebView
> - Compact UI open: about 427 MB including seven system WebView2 processes
>
> The last number changed the architecture: startup no longer creates a window, and closing the UI destroys the WebView rather than hiding it. Codex and Claude collection also runs only as a short one-shot request.
>
> The product use case is quota-exhaustion forecasting for Codex CLI and Claude Code, but I am posting because the lifecycle and measurement trade-off may be useful to other Tauri tray-app developers.
>
> Architecture and measurements: `<repository section URL>`

## 5. Show HN

Title:

> Show HN: A Windows tray app that predicts Codex and Claude Code quota exhaustion

Body:

> I built Codex Claude Usage because a remaining percentage did not answer the question I had during long coding sessions: will this quota survive until reset?
>
> The app keeps local quota observations, estimates an exhaustion window and confidence, detects spikes relative to the user's recent baseline, and recommends a slowdown or model change. Either Codex CLI or Claude Code is enough; using both puts them in one compact view.
>
> It is local-first: no developer-operated telemetry, no local HTTP server, and no prompt/response body copied into analytics. CLI collection is one-shot on manual refresh or an opt-in activity trigger.
>
> I also measured the uncomfortable parts. The release executable is 4.41 MB and cold tray idle is 11.43 MB with no WebView process. Opening the UI is much heavier—about 427 MB including WebView2—so the app destroys the WebView whenever the window closes.
>
> Current limitation: the Windows installer is not Authenticode-signed, so SmartScreen may show Unknown publisher. The release page exposes the SHA-256, Tauri update-signature distinction, privacy boundary, and source-build path.
>
> Demo: `<demo URL>`<br>
> GitHub: `<repository URL>`

## 6. LinkedIn

> Codex CLI와 Claude Code를 사용하면서 “남은 비율”보다 “지금 속도면 reset 전에 한도가 끝나는가?”가 더 중요한 순간이 많았습니다.
>
> 이 개인적인 불편을 해결하기 위해 근무 외 개인 오픈소스 프로젝트로 Windows 트레이 앱을 만들었습니다. 로컬 기록으로 고갈 시각과 급증을 계산하고, 필요한 감속이나 모델 변경을 제안합니다.
>
> 구현에서는 Rust/Tauri, 상시 CLI process가 없는 one-shot 수집, WebView lifecycle, prompt·response 비수집을 중요하게 다뤘습니다. 좋은 수치만 고르지 않기 위해 cold tray 11.43MB와 UI open 약 427MB를 모두 공개했습니다.
>
> 회사의 지원이나 업무 산출물이 아닌 개인 프로젝트이며, 자체 telemetry 없이 GitHub에서 소스와 privacy boundary를 공개합니다. 현재는 Windows Codex/Claude 실사용자의 설치와 forecasting feedback을 받고 있습니다.
>
> `<repository URL>`

## 7. Development article outline

제목:

> Codex와 Claude Code 한도 고갈 시각을 예측하는 Windows 앱을 만든 과정

구성:

1. 남은 비율이 답하지 못한 질문
2. API 비용 관리가 아니라 구독 한도 의사결정인 이유
3. 인증 파일 직접 접근을 피하고 CLI 경계를 사용한 이유
4. 상시 polling 대신 one-shot collection과 activity detection
5. 고갈 범위, confidence와 reset 비교 방식
6. recent median 기반 spike detection
7. WebView를 평소 제거하게 된 실제 memory 측정
8. prompt·response body를 복사하지 않는 local data 설계
9. SmartScreen, SignPath 거절과 unsigned beta를 숨기지 않는 이유
10. 정확도 한계, 현재 부족한 점과 필요한 beta feedback

대체 제목:

> Tauri로 상시 CLI 프로세스 없는 AI 사용량 모니터를 만든 이유

## 8. Awesome list submission

PR title:

> Add Codex Claude Usage to Usage & Observability

PR body:

> Adds Codex Claude Usage, an MIT-licensed local Windows tray app for Codex CLI and Claude Code quota-exhaustion forecasting, spike detection, and action recommendations.
>
> Checklist:
>
> - The target list has no unmet minimum-star requirement.
> - The entry fits the existing Usage & Observability or Windows developer-tools category.
> - The repository has a current release, English README, license, screenshots, and installation disclosure.
> - The description follows this list's required format and alphabetical ordering.

Candidate entry:

> [Codex Claude Usage](https://github.com/Kyuhan1230/ai-usage-monitor) — Local Windows tray app that forecasts Codex CLI and Claude Code quota exhaustion, detects usage spikes, and recommends next actions.

Do not submit until the target repository's current `CONTRIBUTING.md` and category rules have been checked.

## 9. Product Hunt preparation

Tagline:

> Know whether your AI coding limit will run out before reset

Short description:

> A local Windows tray app that forecasts Codex CLI and Claude Code quota exhaustion, detects unusual usage spikes, and recommends what to change next.

Readiness gate:

- Authenticode signed, or an explicit launch decision accepting unsigned-install friction
- English README and stable download page
- Social preview, 15-second GIF, and 45-second video
- Three permissioned user testimonials
- One or two stabilization releases after beta
- Maker available to answer questions on launch day
- No request for upvotes

## 10. 45-second video script

| Time | Voiceover / caption | Visual |
| --- | --- | --- |
| 0–5s | “A coding session should not end because a quota surprised you.” | Work interrupted, then Compact appears |
| 5–15s | “See Codex CLI and Claude Code limits together.” | Compact provider cards and reset times |
| 15–25s | “Forecast whether each limit runs out before reset—with a confidence range.” | Usage Insights exhaustion card |
| 25–35s | “Detect unusual spikes and get a concrete slowdown or model suggestion.” | Spike and recommendation panels |
| 35–42s | “No developer telemetry. No local server. Your usage history stays on this PC.” | Local-only boundary caption |
| 42–45s | “Windows beta on GitHub.” | Icon, repository, unsigned-beta disclosure |
