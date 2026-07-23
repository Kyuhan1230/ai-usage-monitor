# 개인정보 처리방침

최종 수정일: 2026-07-23

Codex Claude Usage는 사용자의 PC에서 동작하는 로컬 사용량 모니터다. 자체 분석 서버, 광고, 원격 텔레메트리를 운영하지 않으며 OpenAI 또는 Anthropic 인증 토큰과 브라우저 쿠키를 수집하지 않는다.

## 로컬에서 읽고 저장하는 정보

앱은 다음 로컬 정보만 처리한다.

- 사용자가 새로고침을 누를 때 이미 설치되고 로그인된 Codex CLI app-server가 반환한 계정 한도 숫자
- Claude Code가 statusLine 이벤트로 전달한 사용량 및 사용자의 새로고침 때 한 번 실행한 `/usage` 출력
- 사용량 집계를 위한 `~\.codex\sessions` 및 `~\.claude\projects`의 로컬 세션 JSONL
- 앱 설정, 최신 상태와 집계 캐시
- 마지막 업데이트 성공·자동 시도 시각, 자동 실패 횟수와 짧은 오류, 발견한 버전, 마지막 안내 버전과 미루기 만료 시각
- 한도 히스토리에서 계산한 소진 예측, 임계치, 비교 결과와 모델별 토큰 합계에 가격표를 적용한 비용 참고치

앱이 만든 데이터는 기본적으로 `~\.codex-usage-wrapper`에 저장된다. 사용자는 앱을 제거한 뒤 이 폴더를 직접 삭제해 로컬 데이터를 지울 수 있다.

statusLine 입력과 `/usage` 출력 원문은 분석 히스토리에 저장하지 않는다. 분석 파일에는 제공자, 모델명, 날짜별 토큰 합계, 한도 비율과 계산 결과만 기록하며 프롬프트와 응답 본문을 복사하지 않는다.

Codex app-server에는 `account/rateLimits/read`만 요청한다. UI와 분석에 쓰지 않는 `account/usage/read` 응답은 요청하거나 저장하지 않는다.

## 네트워크 통신

- 앱은 프로세스 시작 15초 뒤 새 버전을 확인할 수 있고, 실행 중에도 다음 확인 시각이 되면 다시 확인한다. 성공 뒤에는 24시간, 연속 실패 뒤에는 15분·1시간·6시간 간격으로 제한해 요청한다. 요청 대상은 `https://github.com/Kyuhan1230/ai-usage-monitor/releases/latest/download/latest.json`이다. Setup과 트레이의 **업데이트 확인**을 누른 수동 요청은 이 대기 시간을 무시한다.
- 업데이트 manifest 요청 시 GitHub에는 IP 주소, 요청 시각과 updater User-Agent 같은 일반 접속 정보가 전달될 수 있다. 고정 endpoint 요청에 앱 버전, Windows target, 사용량, 세션 내용, 인증 정보와 `~\.codex-usage-wrapper`의 로컬 파일을 추가해 전송하지 않는다.
- 새 버전이 있어도 사용자가 **업데이트**를 누르기 전에는 설치 파일을 다운로드하지 않는다. 사용자가 동의하면 같은 GitHub Release의 Tauri 서명된 설치 파일을 내려받아 서명을 검증하고 설치한다. 자동 확인은 업데이트 창을 띄우지 않고 버전당 한 번 Windows 알림을 표시하며, 알림을 닫거나 업데이트 창에서 **나중에**를 선택해도 트레이의 업데이트 진입점은 유지한다.
- NSIS 설치 프로그램은 WebView2 부트스트래퍼를 자동 다운로드하지 않는다. 앱은 Windows에 이미 설치된 WebView2 Runtime만 사용한다.
- 대화형 NSIS 설치에서 Codex CLI와 Claude Code 설치 여부를 각각 확인한다. 없는 도구는 기본 선택이 **아니요**인 동의 대화상자를 표시하며, 동의한 경우에만 `https://chatgpt.com/codex/install.ps1` 또는 `https://claude.ai/install.ps1`을 실행한다. 거절하거나 설치가 실패해도 모니터 설치는 계속되며, 무인 설치(`/S`)에서는 모든 질문과 네트워크 요청을 건너뛴다.
- Setup의 CLI 설치 버튼도 사용자의 확인을 받은 뒤 해당 공급자의 공식 설치 프로그램을 새 PowerShell 창에서 실행한다.
- Setup을 열면 `codex login status`와 `claude auth status`를 한 번씩 실행해 인증 성공 여부를 확인한다. 계정 이메일·조직명이 포함될 수 있는 stdout/stderr는 저장하거나 UI로 전달하지 않고 즉시 버린다.
- 설치 프로그램과 앱은 로그인을 자동 실행하지 않는다. 로그인은 사용자가 Setup의 공급자별 로그인 버튼을 누른 경우에만 시작되며 인증 정보는 각 CLI가 관리한다.
- Codex와 Claude 사용량을 새로 확인할 때 각 CLI가 해당 공급자의 서비스와 통신할 수 있다. 이 통신과 인증 정보는 Codex CLI 및 Claude Code가 관리한다.
- 앱은 사용량 수집을 위해 CLI 자식 프로세스를 상주시켜 두거나 1분 주기로 호출하지 않는다. 사용자가 새로고침을 누를 때만 원샷 호출한다.
- Claude statusLine 이벤트는 Claude Code가 statusLine을 갱신할 때 로컬 훅 프로세스로 전달되고 즉시 종료되며, 별도 네트워크 수집기를 만들지 않는다.
- 앱 화면은 로컬 파일을 직접 읽으며 HTTP 서버나 listening port를 열지 않는다.
- 앱은 사용량 또는 세션 내용을 개발자나 별도의 분석 서비스로 전송하지 않는다.

GitHub, OpenAI 및 Anthropic 서비스에는 각 공급자의 개인정보 처리방침이 적용된다.

## 시스템 변경

- Windows 로그인 시 자동 실행은 Setup 화면에서 사용자가 선택한 경우에만 등록한다. 이 모드는 WebView 창과 사용량 CLI를 시작하지 않고 트레이 프로세스만 실행한다.
- 첫 일반 실행에서 Setup을 열었는지 기록하기 위해 `~\.codex-usage-wrapper\onboarding.json`에 완료 여부, 건너뜀 여부와 완료 시각만 저장한다. 계정 상태나 계정 식별자는 기록하지 않는다.
- 업데이트 확인 시각, 실패 횟수·짧은 오류, 발견·안내 버전과 미루기 상태는 `~\.codex-usage-wrapper\update-state.json`에 저장한다. 다운로드 경로, 서명 개인키와 사용자 데이터는 이 파일에 저장하지 않는다.
- Claude statusLine hook은 사용자가 설치 버튼을 누른 경우에만 설정한다. 다른 명령이 있으면 그대로 보존하며, 사용자가 교체를 확인하면 원본 설정을 먼저 백업한다.
- 앱은 Windows의 앱 제거 기능으로 제거할 수 있다.

## 문의

개인정보 또는 보안 관련 문의는 저장소의 GitHub Issues를 이용한다: <https://github.com/Kyuhan1230/ai-usage-monitor/issues>
