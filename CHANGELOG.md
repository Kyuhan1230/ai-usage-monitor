# Changelog

이 프로젝트의 주요 변경 사항을 버전별로 기록합니다.

## 1.0.0 - 2026-07-18

### Changed

- Electron/Node 백엔드를 Tauri 2와 Rust로 교체했습니다.
- Codex app-server 원샷, Claude `/usage` 원샷과 statusLine hook, JSONL 증분 집계, 예측·비용·추천 계산을 Rust로 이식했습니다.
- 네 화면은 프레임워크 없는 HTML/CSS/JS를 유지하고 Tauri command bridge만 사용합니다.
- Windows 자동 실행은 HKCU 사용자 레지스트리로 옮겼습니다. 로그인 시작은 트레이만 띄우고, Compact·상세·인사이트·Setup은 필요할 때만 WebView 창을 만듭니다.
- 창의 `X`는 WebView를 파기하고 25MB 안팎의 단일 트레이 프로세스로 돌아가며, 명시적 트레이 Quit만 앱을 종료합니다.
- 모든 CLI 수집을 사용자 새로고침 동작으로 제한했습니다. 앱 시작과 트레이 대기 중에는 Codex/Claude CLI를 실행하지 않습니다.

### Removed

- Electron, electron-updater, electron-builder와 모든 Node.js 런타임 의존성을 제거했습니다.
- 앱 내부 자동 업데이트 네트워크 확인을 제거했습니다. 새 버전 설치는 사용자가 GitHub Release에서 직접 시작합니다.

### Performance

- CI에서 NSIS 설치 파일 20MB 상한을 강제합니다.
- 실측 애플리케이션 EXE는 4.41MB, NSIS 설치 파일은 1.47MB입니다.
- 콜드 백그라운드 트레이는 11.43MB·단일 프로세스·WebView 0개였고, UI를 닫은 뒤에는 25.28MB·CPU 측정값 0%로 돌아왔습니다.
- UI 표시 중 시스템 WebView2를 포함한 working set은 427.05MB였으며, README에 이 비용을 함께 공개합니다.

### Fixed

- GPT-5.6 비용 추정에 공식 캐시 쓰기 1.25배 규칙을 적용하고 절약 비교 모델을 GPT-5.6 Luna로 갱신했습니다.

## 0.4.0 - 2026-07-18

### Changed

- 날짜별·모델별 토큰 상세를 Electron 내부 화면으로 통합했습니다.
- Setup과 README를 단일 앱, 무서버 실행 경로에 맞게 정리했습니다.
- 현재 단발 수집·로컬 분석 경로만 검증하도록 테스트를 간결하게 재구성했습니다.

### Removed

- Python, FastAPI, Uvicorn과 번들 CPython 런타임을 제거했습니다.
- localhost 대시보드와 모든 HTTP listening port를 제거했습니다.
- node-pty, legacy PowerShell tray/wrapper, Codex·Claude 지속 폴러를 제거했습니다.

## 0.3.0 - 2026-07-18

### Added

- 한도 히스토리에서 소진 속도, 예상 고갈 시각, reset 전 고갈 여부와 신뢰도를 계산합니다.
- 잔여 25%/10% 임계치와 이상 급증을 감지하고 Windows 로컬 알림을 표시합니다.
- 오늘과 전일, 최근 7일과 이전 7일의 토큰 사용량을 비교합니다.
- 공식 API 표준 정가를 기준으로 오늘 비용 등가 추정과 저비용 모델 전환 절약 가능성을 계산합니다.
- 모든 결과와 규칙 기반 실행 추천을 모은 Usage Insights 창을 추가했습니다.
- Codex와 Claude 세션 JSONL을 파일 시그니처 캐시로 증분 집계하는 Node 수집기를 추가했습니다.

### Privacy

- Claude statusLine 및 `/usage` 원문을 상태·히스토리에 저장하지 않고 필요한 한도 숫자만 보존합니다.
- 분석 결과는 로컬 `~/.codex-usage-wrapper`에만 기록하며 원본 프롬프트와 응답 본문을 복사하지 않습니다.

## 0.2.0 - 2026-07-18

### Changed

- 앱 시작과 수동 새로고침 때만 Codex 공식 app-server의 계정 사용량 메서드를 호출하도록 바꿨습니다.
- Claude의 1분 주기 `/usage` 폴러를 제거하고, statusLine 이벤트 수집을 기본 경로로 삼았습니다.
- 동시에 여러 새로고침이 들어오면 하나의 원샷 수집으로 합치고, 제공자별 오류를 Setup 화면에 표시합니다.

### Removed

- Electron 앱이 Codex와 Claude 수집용 자식 프로세스를 상시 실행하고 재시작하던 경로를 제거했습니다.
- 기본 실행 경로의 PID 파일, 프로세스 감시, 1분 폴링 타이머를 제거했습니다.

## 0.1.4 - 2026-07-18

### Security

- Electron, FastAPI 개발 명령, legacy Python 서버, PowerShell 시작 스크립트의 대시보드 바인딩을 `127.0.0.1`로 통일했습니다.
- 외부 네트워크 인터페이스 바인딩이 다시 추가되지 않도록 회귀 테스트를 추가했습니다.
