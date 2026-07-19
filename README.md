<p align="center">
  <img src="assets/codex-claude-usage.png" width="112" alt="Codex Claude Usage icon">
</p>

<h1 align="center">Codex Claude Usage</h1>

<p align="center">
  <strong>리셋보다 먼저 AI 코딩 한도가 바닥날까?</strong><br>
  Codex CLI와 Claude Code의 소진 시각·비용·다음 행동을 로컬에서 계산하는 Windows 앱입니다.
</p>

<p align="center">
  <a href="https://github.com/Kyuhan1230/ai-usage-monitor/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Kyuhan1230/ai-usage-monitor/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/Kyuhan1230/ai-usage-monitor/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/Kyuhan1230/ai-usage-monitor?display_name=tag&sort=semver"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/Kyuhan1230/ai-usage-monitor"></a>
  <img alt="Windows 10+" src="https://img.shields.io/badge/Windows-10%2B-0078D4?logo=windows">
</p>

<p align="center">
  <a href="https://github.com/Kyuhan1230/ai-usage-monitor/releases/latest"><strong>Windows용 다운로드</strong></a>
  · <a href="#screenshots">Screenshots</a>
  · <a href="#quick-start">Quick start</a>
  · <a href="#development">Development</a>
</p>

---

단순히 “몇 % 남았나”를 다시 그리지 않습니다. 한도 히스토리와 로컬 토큰 합계를 이용해 **언제 고갈되는지, 평소보다 얼마나 빨리 쓰는지, 지금 무엇을 바꿔야 하는지** 보여줍니다. Tauri/Rust 단일 앱으로 동작하며 Chromium 런타임, Python, localhost 웹 서버와 상시 CLI 폴러를 설치본에 포함하지 않습니다.

> [!IMPORTANT]
> 이 프로젝트는 OpenAI 또는 Anthropic의 공식 제품이 아닙니다. OpenAI, Codex, Anthropic, Claude의 이름과 표장은 각 권리자의 자산입니다.

## Screenshots

### Usage insights

<p align="center">
  <img src="docs/images/app-insights.png" alt="소진 예측, 임계치, 비교, 이상 급증, 비용과 추천을 보여주는 Usage Insights" width="100%">
</p>

### Local token details

<p align="center">
  <img src="docs/images/app-details.png" alt="앱 내부에서 보여주는 날짜별 모델별 로컬 토큰 상세" width="100%">
</p>

<table>
  <tr>
    <th width="40%">Compact monitor</th>
    <th width="60%">Setup &amp; health checks</th>
  </tr>
  <tr>
    <td align="center"><img src="docs/images/app-compact.png" alt="Codex Claude Usage compact monitor"></td>
    <td align="center"><img src="docs/images/app-setup.png" alt="Codex Claude Usage setup screen"></td>
  </tr>
  <tr>
    <td>남은 한도, 리셋 시각과 연결 상태를 작은 창에서 확인합니다.</td>
    <td>CLI 로그인, Claude hook, 로컬 상세 화면과 자동 실행 상태를 점검합니다.</td>
  </tr>
</table>

> [!NOTE]
> 스크린샷은 실제 renderer를 대표 샘플 데이터로 렌더링한 것입니다. 개인 세션이나 로컬 사용량을 읽지 않습니다.

## 무엇이 다른가

많은 오픈소스 사용량 도구가 누적 토큰이나 현재 잔여율을 보여주는 데서 끝납니다. 이 앱의 초점은 **의사결정**입니다.

| 질문 | 답변 |
| --- | --- |
| 리셋 전에 바닥나는가? | 관측 소진 속도와 예상 고갈 시각, 예측 신뢰도 |
| 갑자기 왜 빨리 줄었는가? | 평소 중앙값 기반 한도·토큰 이상 급증 감지 |
| 어제보다 많이 썼는가? | 전일 및 이전 7일 대비 |
| 모델을 바꾸면 얼마나 아끼는가? | 동일 토큰 가정의 저비용 모델 절약 가능성 |
| 그래서 지금 뭘 해야 하는가? | 필요한 감속 비율, 반복 작업 점검, 모델 변경 추천 |
| 내 데이터는 어디로 가는가? | 로컬 파일과 앱 내부 화면만 사용, 텔레메트리·수집 서버 없음 |

대표 오픈소스와는 경쟁 축이 다릅니다.

| 프로젝트 유형 | 가장 잘하는 것 | Codex Claude Usage의 선택 |
| --- | --- | --- |
| [ccusage](https://github.com/ryoppippi/ccusage) | 많은 AI CLI의 토큰·비용을 CLI/JSON으로 집계 | 지원 대상을 Codex·Claude로 좁히고 한도 고갈 예측과 행동 추천을 Windows UI로 제공 |
| [Claude Usage Dashboard](https://github.com/phuryn/claude-usage) | Claude 세션·프로젝트 히스토리와 브라우저 차트 | Python·localhost 서버 없이 앱 내부에서 두 공급자를 함께 표시 |
| [Usage Monitor for Claude](https://github.com/jens-duttke/usage-monitor-for-claude) 등 네이티브 트레이 | 매우 가벼운 실시간 Claude 한도 표시 | 인증 파일을 직접 읽는 대신 기존 CLI의 원샷/statusLine 경로를 사용하고 예측·비교·비용까지 연결 |

따라서 **많은 도구 지원이나 터미널 자동화가 우선이면 ccusage가 더 적합**합니다. 이 앱은 “오늘 이 속도로 쓰면 리셋 전에 막히는가, 그렇다면 지금 무엇을 바꿀까”가 필요한 Windows 사용자에게 맞습니다.

### 측정된 경량성

2026-07-18 Windows 릴리스 빌드의 참고 측정값입니다. 시스템과 WebView2 버전에 따라 달라질 수 있으며, 창을 연 상태의 비용도 함께 공개합니다.

| 상태 | 결과 |
| --- | --- |
| 애플리케이션 EXE | 4.41MB |
| NSIS 설치 파일 | 1.47MB |
| 로그인 시작/콜드 트레이 대기 | 11.43MB, 앱 프로세스 1개, WebView 0개 |
| UI를 닫은 뒤 트레이 대기 | 25.28MB, 앱 프로세스 1개, CPU 측정값 0%, WebView 0개 |
| Compact UI 표시 중 | 427.05MB, 앱+시스템 WebView2 7개 프로세스 |
| 모든 대기 상태 | Codex/Claude CLI 0개, listening port 0개 |

UI가 열린 동안에는 WebView2 메모리 비용이 큽니다. 그래서 로그인 시작은 창을 만들지 않고, 트레이 클릭 때만 WebView를 로드하며, `X`를 누르면 창과 WebView 프로세스를 파기합니다.

## Features

| 영역 | 제공 기능 |
| --- | --- |
| 한도 모니터링 | Codex 5-hour/weekly, Claude current session/current week 잔여율 |
| 고갈 예측 | 소진 속도, 예상 고갈 시각, reset 전 고갈 여부와 표본 기반 신뢰도 |
| 로컬 알림 | 잔여 25% 주의·10% 위험, 이상 급증, reset 전 고갈 예측 |
| 비교·비용 | 오늘/전일, 최근 7일/이전 7일 비교와 API 정가 기준 비용 등가 추정 |
| 실행 가능한 추천 | 감속 비율, 반복 작업 점검, 저비용 모델 전환 가능성을 규칙 기반으로 제안 |
| 상세 집계 | 날짜별·모델별 input, cached input, cache write, output, reasoning token |
| 가벼운 수집 | 수동 새로고침 또는 opt-in 활동 감지 시 CLI를 짧게 원샷 실행; 앱 대기 중 자식 프로세스 없음 |
| 로컬 전용 화면 | 별도 Python·HTTP 서버·열린 포트 없이 앱 내부에서 모든 결과 표시 |
| 데스크톱 앱 | Windows 트레이, always-on-top, 투명도, 로그인 시 자동 실행 |
| 명시적 업데이트 | 앱이 자동 네트워크 확인을 하지 않으며 사용자가 GitHub Release에서 직접 설치 |

## Quick start

1. [Latest Release](https://github.com/Kyuhan1230/ai-usage-monitor/releases/latest)에서 `Codex-Claude-Usage-Setup-<version>.exe`를 설치합니다.
2. Codex CLI 또는 Claude Code가 없으면 설치 프로그램이 각 공식 설치 프로그램을 실행할지 개별적으로 묻습니다. 동의한 도구만 내려받으며, 거절하거나 설치가 실패해도 모니터 설치는 계속됩니다.
3. 앱을 처음 실행하면 Setup이 자동으로 열려 두 CLI의 설치·로그인 상태를 직접 확인합니다. Codex 또는 Claude 중 사용하는 도구 하나만 연결해도 시작할 수 있으며, 필요한 도구에만 **설치** 또는 **로그인** 버튼이 표시됩니다.

```powershell
codex login
claude auth login
```

4. 사용할 도구의 로그인을 마친 뒤 **상태 다시 확인 → 설정 완료**를 누릅니다. 나머지 도구와 Claude statusLine 이벤트 연결은 선택 사항입니다.
5. **사용량 확인**을 누르면 원샷으로 최신 상태를 읽습니다. Setup에서 **활동 중 자동 확인**을 켜면 로컬 세션 파일이 바뀐 경우에만 최소 15분 간격으로 원샷 수집합니다. `X`는 창과 WebView를 닫고 트레이만 남기며, 완전히 종료하려면 트레이 메뉴의 **Quit**을 선택합니다.

설치본에 Codex CLI나 Claude Code를 포함하지 않아 설치 파일 크기를 키우지 않으며, 별도 Node.js나 Python도 필요하지 않습니다. 대화형 설치 또는 Setup에서 사용자가 특정 CLI 설치에 동의한 경우에만 해당 공급자의 공식 설치 스크립트로 네트워크 요청을 보냅니다. 앱과 설치 프로그램은 WebView2를 자동 다운로드하지 않으므로, WebView2가 제거된 Windows 환경에서는 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)을 사용자가 먼저 설치해야 합니다.

> [!WARNING]
> SignPath Foundation 코드 서명은 심사 대기 중입니다. 승인 전 설치 파일에서는 Windows SmartScreen의 `알 수 없는 게시자` 안내가 표시될 수 있습니다.

## How it works

```mermaid
flowchart LR
    A["Manual refresh"] --> B["Codex app-server one-shot"]
    A --> C["Claude /usage one-shot fallback"]
    J["Optional local session activity"] --> K["15-minute cooldown"]
    K --> B
    K --> C
    D["Claude statusLine event"] --> E["Local status JSON"]
    B --> E
    C --> E
    F["Local session JSONL"] --> G["Incremental token aggregation"]
    E --> H["Forecast, alerts, recommendations"]
    G --> H
    H --> I["Embedded app windows"]
```

- Codex는 사용자가 새로고침할 때 공식 app-server의 `account/rateLimits/read`만 호출한 뒤 즉시 프로세스를 종료합니다. 사용하지 않는 account usage 응답은 요청하거나 저장하지 않습니다.
- Claude는 statusLine 이벤트를 기본 경로로 사용합니다. 수동 새로고침의 `/usage`는 초기값을 위한 단발 대체 경로입니다.
- 자동 확인을 켜면 Rust 트레이 프로세스가 1분마다 로컬 세션 파일의 변경 시각만 확인합니다. 활동이 감지돼도 CLI는 최소 15분 간격으로 한 번 실행하며, 자동 확인을 끄면 파일 확인도 수행하지 않습니다.
- 상시 CLI 폴링, PID 감시, 수집 프로세스 자동 재시작, localhost 서버가 없습니다.
- Rust 수집기가 `~/.codex/sessions`와 `~/.claude/projects`에서 토큰 숫자만 증분 집계합니다. 프롬프트와 응답 본문은 분석 결과에 복사하지 않습니다.

### Local data

| 데이터 | 기본 위치 |
| --- | --- |
| Codex 최신 상태 | `~/.codex-usage-wrapper/status.json` |
| Claude 최신 상태 | `~/.codex-usage-wrapper/claude-status.json` |
| 변경 시점 히스토리 | `~/.codex-usage-wrapper/history/YYYY-MM-DD.jsonl` |
| 분석 결과 | `~/.codex-usage-wrapper/analytics.json` |
| 토큰 집계 캐시 | `~/.codex-usage-wrapper/token-usage-cache.json` |
| 활동 기반 자동 확인 설정 | `~/.codex-usage-wrapper/monitoring.json` |

## Privacy & security

- 자체 서버, 광고, 원격 텔레메트리가 없습니다.
- 인증 토큰, 브라우저 쿠키, 프롬프트와 응답 본문을 수집하지 않습니다.
- 사용량·분석 결과는 `~/.codex-usage-wrapper`에만 저장됩니다.
- 앱 자체의 텔레메트리·업데이트·분석 네트워크 요청은 없습니다. 수동 새로고침과 사용자가 켠 활동 기반 자동 확인의 원샷 CLI 통신·인증은 각 CLI가 관리합니다.
- NSIS 설치 프로그램도 WebView2를 자동 다운로드하지 않고 Windows에 이미 설치된 런타임만 사용합니다.
- 로컬 HTTP 서버나 listening port를 열지 않습니다.

자세한 내용은 [Privacy policy](docs/PRIVACY.md), [Security policy](SECURITY.md), [Code signing policy](docs/CODE_SIGNING_POLICY.md)를 확인하세요.

## Development

### Requirements

- Windows 10 이상
- Node.js 22.12 이상
- Rust stable MSVC toolchain
- Microsoft C++ Build Tools와 WebView2
- Codex CLI 및 Claude Code(실데이터 확인 시)

### Run, test, build

```powershell
git clone https://github.com/Kyuhan1230/ai-usage-monitor.git
cd ai-usage-monitor
npm ci
npm test
npm run app
npm run dist
```

Tauri NSIS 설치 파일은 `src-tauri/target/release/bundle/nsis/`에 만들어집니다. CI와 Release는 20MB를 넘는 설치 파일을 실패 처리합니다.

### Project layout

```text
.github/workflows/        CI와 Release workflow
assets/                   Windows 앱 아이콘
docs/images/              재현 가능한 UI 스크린샷
scripts/                  릴리스 태그 검증 도구
src/ui/                   프레임워크 없는 내장 HTML/CSS/JS 화면
src-tauri/                Rust 수집·분석·트레이·패키징 백엔드
tests/                    UI 계약과 로컬 전용 경계 테스트
```

## Troubleshooting

<details>
<summary><strong>Codex 또는 Claude 값이 오래됨으로 표시됩니다.</strong></summary>

1. Setup에서 해당 CLI와 로그인 상태를 확인합니다.
2. **지금 다시 계산**을 눌러 원샷 결과를 확인합니다.
3. Claude는 statusLine hook 설치 상태를 확인합니다.
4. 계속되면 `~/.codex-usage-wrapper/status.json`과 `claude-status.json`의 수정 시각을 확인합니다.

</details>

<details>
<summary><strong>Codex 데스크톱 앱은 설치했는데 CLI 설치 안내가 표시됩니다.</strong></summary>

Microsoft Store의 Codex 데스크톱 앱에 포함된 실행 파일은 패키지 보호 대상이라 다른 앱에서 CLI처럼 실행할 수 없습니다. Setup의 **Codex 설치**에서 독립 실행 Codex CLI를 설치한 뒤 **상태 다시 확인**을 누르세요. 앱은 최신 사용자 PATH를 다시 읽으므로 실행 중 설치된 CLI도 감지하며, 보호된 데스크톱 번들을 실행 가능한 CLI로 오인하지 않습니다.

</details>

<details>
<summary><strong>토큰 상세가 비어 있습니다.</strong></summary>

Codex 또는 Claude Code로 작업한 뒤 다시 계산합니다. 앱은 `~/.codex/sessions`와 `~/.claude/projects`의 로컬 JSONL이 존재할 때만 모델·날짜별 합계를 만들 수 있습니다.

</details>

## Current limitations

- Codex 수집은 설치된 CLI의 app-server 계정 메서드 지원 여부에 의존합니다.
- Claude 단발 대체 경로는 `/usage` 출력 형식에 의존합니다.
- 비용은 실제 구독 청구액이 아니라 [OpenAI](https://openai.com/api/pricing/)와 [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing)의 2026-07-18 API 표준 정가로 환산한 참고치입니다. GPT-5.6 캐시 쓰기는 공식 1.25배 규칙을 적용하며, 가격을 알 수 없는 모델은 제외합니다.
- 요금제 이름과 실제 구독 크레딧은 자동 판별하지 않습니다.
- 현재 공개 설치 파일은 SignPath Foundation 승인 전까지 Authenticode 미서명 상태입니다.

## Contributing

[기여 가이드](CONTRIBUTING.md) · [버그 신고](https://github.com/Kyuhan1230/ai-usage-monitor/issues/new?template=bug_report.yml) · [기능 제안](https://github.com/Kyuhan1230/ai-usage-monitor/issues/new?template=feature_request.yml)

제품 포지셔닝과 v1 공개 체크리스트는 [Launch plan](docs/LAUNCH_PLAN.md)에 기록했습니다.

## License

[MIT License](LICENSE) · Copyright © 2026 kyuhan1230

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/). Application submitted; approval is pending.
