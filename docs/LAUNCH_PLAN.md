# 공개 및 초기 사용자 확보 계획

## 제품 포지셔닝

대상은 막연한 AI API 비용 관리자가 아니라 **Windows에서 Codex CLI 또는 Claude Code를 많이 쓰는 사용자**다.

> Codex와 Claude Code 한도가 언제 바닥날지 예측해주는 로컬 Windows 트레이 앱.

핵심 가치는 누적 토큰 표가 아니라 의사결정이다.

- 구독 한도 고갈 시각 예측
- reset 전 소진 여부와 예측 신뢰도
- 평소 대비 한도·토큰 급증 감지
- 감속, 반복 작업 점검, 모델 변경 추천
- 자체 텔레메트리와 수집 서버가 없는 로컬 처리

초기 홍보에서는 Python, LangChain, PyPI, 일반 API 비용 관리 메시지를 사용하지 않는다. 제품과 맞지 않는 방문자를 늘리는 것보다 실제 Windows CLI 사용자의 설치와 피드백이 중요하다.

## 30일 목표

| 목표 | 정의 | 증거 |
| --- | --- | --- |
| 확인된 설치 사용자 30명 | 설치 성공을 Issue, Discussion, 설문 또는 직접 베타 대화로 확인 | 피드백 링크와 날짜를 개인정보 없이 기록 |
| GitHub star 50개 | 저장소 공개 수치 | GitHub |
| 구체적인 피드백 10건 | 설치, 예측, 추천 또는 이탈 이유를 설명한 응답 | Beta feedback Issue/Discussion |
| 외부 기여 또는 Issue 3건 | 유지관리자 외부 사용자가 만든 유효한 Issue, PR 또는 문서 기여 | GitHub |
| 설치 마찰 파악 | SmartScreen 중단, 설치 실패, CLI 탐지 실패, 첫 refresh 실패를 구분 | Beta feedback 선택 항목 |

`확인된 설치 사용자`는 release download 수와 같지 않다. 텔레메트리가 없으므로 다운로드를 설치 성공으로 간주하지 않는다.

## 측정 원칙

앱에 익명 텔레메트리를 추가하지 않는다.

- GitHub Traffic: unique visitors, clones, referring sites
- GitHub Release: installer download count
- GitHub: star, fork, Issue, Discussion, PR
- 각 게시 플랫폼이 제공하는 공개 또는 작성자용 클릭·조회 통계
- 사용자가 자발적으로 제출한 beta feedback

GitHub Traffic은 UTM parameter별 클릭을 제공하지 않으므로 UTM만 붙였다고 채널별 전환이 측정되는 것은 아니다. 별도 추적 서버를 두지 않는 동안에는 게시 시각, GitHub referring sites, 플랫폼 자체 통계, 피드백의 선택적 유입 경로를 함께 사용한다. 향후 랜딩 페이지를 운영한다면 다음 규칙으로 UTM을 통일한다.

```text
utm_source=<geeknews|reddit|hackernews|linkedin|producthunt|blog>
utm_medium=<community|social|launch|article>
utm_campaign=windows-beta
utm_content=<post-angle>
```

주간 기록 표:

| 날짜 | 채널/게시물 | 조회·클릭 | GitHub 방문 | Release 다운로드 | 확인 설치 | 피드백 | 주요 이탈 이유 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |

## 서명 상태와 공개 순서

2026-07-23 SignPath Foundation 신청은 외부 신뢰와 인지도 신호 부족으로 승인되지 않았다. 따라서 “서명될 때까지 모든 홍보 보류”는 사용하지 않는다. 인지도가 있어야 무료 서명을 받을 수 있는데 홍보를 서명 뒤로 미루면 순환이 생긴다.

서명 전:

- Windows 전용 초기 beta로 표현
- unsigned Authenticode와 SmartScreen 경고를 다운로드 전에 표시
- GitHub Release SHA-256, Tauri updater signature, 소스 빌드 경로 제공
- 설치 실패와 신뢰 이탈을 수집할 수 있는 소규모 공개
- GeekNews, 직접 관련 커뮤니티, 지인 beta 중심

서명 후:

- publisher와 Authenticode 검증 결과 표시
- Show HN, Product Hunt 등 더 넓은 공개
- unsigned beta에서 확인된 설치 마찰이 해결됐는지 재검증

코드 서명이 늦어져도 Show HN을 영구 보류하지 않는다. 영어 README, 데모, 실제 사용자 후기, 안정화 릴리스가 준비되고 unsigned 상태를 충분히 고지할 수 있다면 게시 시점을 다시 판단한다.

모든 릴리스는 [unsigned beta release checklist](BETA_RELEASE_CHECKLIST.md)를 따른다.

## 전환 준비

### GitHub About

Description:

> A local Windows tray app that predicts when your Codex CLI and Claude Code usage limits will run out.

Topics:

```text
claude-code
codex-cli
codex
openai
anthropic
usage-monitor
quota-monitor
developer-tools
windows
windows-app
tauri
rust
system-tray
```

### README 첫 화면

1. 한 줄 문제 정의
2. 12–18초 demo GIF
3. Windows download
4. Forecast, detect, act
5. local-only 개인정보 경계
6. unsigned SmartScreen 안내
7. 상세 설명

영어를 기본으로 하고 기존 한국어 상세 문서는 `docs/README.ko.md`에 유지한다.

### Social preview

크기: 1280×640.

주 문구:

> Will your AI coding limit run out before reset?

하단:

> Codex CLI + Claude Code · Local Windows tray app

Compact UI와 고갈 예측 문구를 크게 보이고 전체 화면을 축소해 넣지 않는다.

### Demo

15초 GIF:

1. Compact에서 Codex·Claude 잔여 한도
2. reset 전 고갈 예상 강조
3. Usage Insights의 이상 급증
4. 감속 또는 모델 변경 추천
5. 창을 닫아 tray 유지

45초 영상:

| 구간 | 내용 |
| --- | --- |
| 0–5초 | 작업 중 한도가 갑자기 끝나는 문제 |
| 5–15초 | 두 CLI 사용량을 한 화면에 표시 |
| 15–25초 | 고갈 시각과 reset 전 소진 여부 |
| 25–35초 | 급증 감지와 행동 추천 |
| 35–45초 | Windows, local-only, 공식 GitHub 다운로드 |

## 채널 우선순위

### Tier 1

1. 실제 Codex/Claude Windows 사용자 10명에게 제한 beta 요청
2. GeekNews: 제품 광고보다 개발기와 솔직한 제약
3. Claude Code, Codex, AI coding 관련 커뮤니티: 커뮤니티별 문제를 바꿔서 게시
4. 최소 star 조건이 없고 usage/observability 범주가 있는 Awesome list

관련 없는 `r/Python`, 일반 LangChain 커뮤니티, `r/LocalLLaMA`는 우선 대상이 아니다.

### Tier 2

5. 영문 개발기
6. LinkedIn 개인 프로젝트 게시
7. Show HN: 제품 가치가 제목, 실제 메모리 수치는 본문

### Tier 3

8. Product Hunt: 영어 자료, 영상, 사용자 후기 3개, 안정화 릴리스 1–2회 뒤

경쟁 프로젝트의 Issue나 Discussion에는 실제 Windows GUI, quota forecast, Codex+Claude 통합 요구 또는 허용된 showcase 문맥이 있을 때만 공유한다. `ccusage 대체품`이 아니라 상세 CLI 집계와 Windows quota decision surface의 보완 관계로 설명한다.

현재 규칙과 실제 Awesome list 자격 조건은 [채널 조사 기록](CHANNEL_RESEARCH.md)에서 관리한다.

## 3주 실행

### 1주차 — 전환과 신뢰

- [x] 영어 README 기본화와 한국어 문서 분리
- [x] GitHub Description과 Topics
- [ ] Social Preview 업로드
- [x] 15초 GIF 제작
- [x] 45초 walkthrough MP4 제작
- [x] SHA-256, SmartScreen, SignPath 결과 문서화
- [x] GitHub Discussions 활성화
- [x] Beta feedback Issue form
- [x] `good first issue`, `feedback wanted` 라벨과 초기 Issue

### 2주차 — 초기 사용자

- [ ] 실제 Windows CLI 사용자 10명에게 개별 beta 요청
- [ ] GeekNews 개발기 게시
- [x] LinkedIn 개인 프로젝트 게시
- [ ] 커뮤니티 규칙을 확인한 Discord/오픈채팅 공유
- [ ] 설치 실패, CLI 탐지, 첫 refresh 문제를 기능 추가보다 먼저 수정
- [ ] 사용자 표현을 README와 onboarding 문구에 반영

### 3주차 — 해외 확장

- [ ] 직접 관련 Reddit 커뮤니티 2–3곳에 서로 다른 글 게시
- [x] 조건이 맞는 Awesome list에 선별 PR
- [ ] 영문 개발기 게시
- [ ] 서명·후기·안정성 상태를 재평가하고 Show HN 게시 여부 결정
- [ ] Product Hunt 준비도만 점검하고 조건 미달이면 보류

## 재사용할 원본 소재

| 원본 | 재사용 |
| --- | --- |
| 15초 GIF | README, Reddit, LinkedIn, Product Hunt |
| 메모리 측정 | Show HN, Tauri 커뮤니티, 개발기 |
| 고갈 예측 | Claude·Codex 커뮤니티 |
| local-only 구조 | privacy 관심 개발자 |
| 경쟁 도구 비교 | 블로그, README, 관련 Discussion |
| unsigned beta와 서명 과정 | 후속 개발기와 SignPath 재신청 근거 |

같은 글을 복사하지 않는다. 각 커뮤니티가 관심을 가질 문제, 측정, 구현 또는 개인정보 경계를 먼저 둔다.

## 핵심 메시지

한국어:

> Codex와 Claude Code 한도가 언제 바닥날지 예측해주는 Windows 앱입니다. 단순히 남은 비율만 보여주는 것이 아니라, 현재 소진 속도라면 reset 전에 막히는지, 평소보다 사용량이 급증했는지, 지금 얼마나 사용 속도를 줄여야 하는지를 로컬에서 계산합니다.

English:

> Know whether your Codex or Claude Code limit will run out before it resets. A local Windows tray app that forecasts quota exhaustion, detects unusual usage spikes, and recommends what to change next.
