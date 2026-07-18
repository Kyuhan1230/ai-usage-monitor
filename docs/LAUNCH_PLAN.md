# v1.0 공개 전략

## 냉정한 진단

“Codex와 Claude 사용량을 보여준다”만으로는 관심을 받기 어렵다. 이미 `ccusage`는 훨씬 많은 CLI와 출력 형식을 지원하고, Claude 전용 대시보드와 네이티브 트레이 앱도 많다. 이 프로젝트가 기억될 이유는 기능 수가 아니라 다음 한 문장이어야 한다.

> 리셋 전에 한도가 바닥날지 예측하고, 지금 얼마나 줄이거나 어떤 모델로 바꿀지 알려주는 로컬 Windows 앱.

## 첫 사용자

- Windows에서 Codex CLI와 Claude Code를 모두 쓰는 사람
- 현재 잔여율보다 “오늘 작업을 끝낼 수 있는가”가 중요한 사람
- 토큰·세션 원문을 외부 대시보드에 보내고 싶지 않은 사람
- 터미널 표보다 트레이 알림과 작은 창을 원하는 사람

다음 사용자는 당장 잡지 않는다.

- 많은 AI CLI를 한꺼번에 집계하려는 사용자: `ccusage`가 더 적합하다.
- macOS 네이티브 메뉴바 경험이 최우선인 사용자: Swift 기반 도구가 더 가볍다.
- 구독 청구액과 정확히 일치하는 회계 도구가 필요한 사용자: 이 앱의 비용은 API 정가 등가 참고치다.

## 30초 데모 순서

1. Compact에서 Codex/Claude 잔여율과 리셋 시각을 보여준다.
2. **지금 다시 계산**을 누른다. CLI가 요청 중에만 나타났다가 종료되는 것을 보여준다.
3. Usage Insights에서 “리셋 전 고갈”, 소진 속도, 전일 대비와 한 줄 행동 추천을 보여준다.
4. `X`로 창을 닫고 작업 관리자에서 1개 프로세스·WebView 0개로 돌아가는 모습을 보여준다.
5. “텔레메트리 0, 열린 포트 0, 설치 파일 1.47MB”를 마지막 프레임에 둔다.

## 공개 전에 저장소에서 할 일

- GitHub topics: `codex`, `claude-code`, `usage-monitor`, `tauri`, `windows`, `local-first`.
- 저장소 Social preview에는 Usage Insights와 “Will you run out before reset?” 문구가 함께 보이는 1280×640 이미지를 사용한다.
- v1.0 Release 본문 첫 화면에 설치 파일 크기, 미서명 여부, 개인정보 경계와 30초 GIF를 둔다.
- README의 첫 스크린샷은 기능 목록보다 예측·추천이 한 화면에 보이는 Usage Insights로 유지한다.
- SignPath 승인 전에는 SmartScreen 경고를 숨기지 말고 설치 단계에 명시한다.

## 공개 글의 핵심 서사

기능 나열보다 이 리팩터링 이야기가 더 강하다.

> 95.4MB Electron 설치 파일을 1.47MB Tauri 설치 파일로 줄였다. 그런데 창을 열어 보니 WebView2까지 합친 메모리는 여전히 427MB였다. 그래서 숫자를 숨기는 대신 UI를 닫으면 WebView를 파기하고, 로그인 시작은 11.43MB 트레이 프로세스만 남도록 다시 설계했다. CLI도 새로고침 때만 한 번 실행한다.

이 서사는 “또 하나의 사용량 대시보드”보다 기술적 신뢰와 차별점을 동시에 만든다.

### 짧은 공개 문안

> I built a local Windows tray app for Codex + Claude that answers one question: will my limit run out before it resets? It forecasts exhaustion, flags spikes, estimates list-price cost, and suggests an action. No telemetry, no local server, no polling CLI. The installer is 1.47MB; idle tray is 11–25MB because WebView2 is loaded only while a window is open. MIT.

## 배포 순서

1. `v1.0.0` 태그로 GitHub Actions가 테스트와 NSIS 패키징을 완료하게 한다.
2. Draft Release의 파일명·크기·SHA-256·서명 상태를 확인한다.
3. 30초 데모 GIF와 정확한 제한 사항을 Release에 추가한다.
4. GitHub Release를 먼저 공개해 모든 외부 글이 한 다운로드 URL을 가리키게 한다.
5. Show HN, 관련 Reddit 커뮤니티, 개발자 SNS에는 같은 글을 복사하지 말고 각 커뮤니티 규칙과 관심사에 맞춰 데모·기술 이야기·프라이버시 중 하나를 앞세운다.
6. 첫 주에는 새 기능보다 설치 실패, CLI 버전 호환성과 SmartScreen 이탈을 우선 수정한다.

## 성공 기준

앱에 텔레메트리를 추가하지 않는다. 다음 공개 지표만 본다.

- GitHub Release 고유 다운로드 수
- README 방문 대비 Release 클릭
- 설치/첫 새로고침 실패 Issue 수와 해결 시간
- “고갈 예측 또는 추천이 실제 행동을 바꿨다”는 사용자의 자발적 피드백
- 첫 30일 재방문 기여자와 외부 PR 수

별이 아니라 **다운로드 후 첫 새로고침 성공률**이 먼저다. 자체 텔레메트리가 없으므로 Release 다운로드와 opt-in Issue/Discussion을 근거로 개선한다.

## 비교 기준

- [ccusage](https://github.com/ryoppippi/ccusage): 지원 도구 폭, CLI 자동화와 JSON 출력의 기준.
- [Claude Usage Dashboard](https://github.com/phuryn/claude-usage): Claude 로컬 히스토리와 브라우저 시각화의 기준.
- [Usage Monitor for Claude](https://github.com/jens-duttke/usage-monitor-for-claude): Windows 네이티브 트레이의 즉시성과 작은 실행 파일의 기준.
- [Claude Usage Tracker](https://github.com/hamed-elfayome/Claude-Usage-Tracker): macOS 네이티브 완성도와 다국어 배포의 기준.

이 프로젝트는 이들을 “이긴다”고 주장하지 않는다. **두 공급자의 한도와 로컬 토큰을 예측·비교·추천으로 연결하는 Windows 의사결정 화면**이라는 좁은 자리를 차지한다.
