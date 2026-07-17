# Changelog

이 프로젝트의 주요 변경 사항을 버전별로 기록합니다.

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
