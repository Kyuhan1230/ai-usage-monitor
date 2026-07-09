# Codex Claude Usage

Codex CLI와 Claude Code 사용량을 한 화면에서 보는 로컬 Windows 대시보드다.

이 프로젝트는 사용량을 보려고 인증 토큰, 브라우저 쿠키, 비공개 Usage API를 건드리지 않는다. 이미 로그인된 CLI가 로컬에 남기는 출력과 로그만 읽고, 결과를 로컬 대시보드와 Windows 트레이 앱으로 보여준다.

## 기능 요약

- Codex 5-hour, weekly 잔여율 표시
- Claude current session, current week 잔여율 표시
- Codex와 Claude 토큰 사용량을 날짜별, 모델별로 집계
- Windows 트레이 상주 앱
- 항상 위에 떠 있는 compact window
- 전체 HTML 대시보드
- Windows 로그인 시 자동 실행
- 다른 PC 배포용 Windows 설치 파일 생성
- Claude `/usage` 백그라운드 수집 및 선택형 statusLine hook 설치
- 로컬 파일 기반 캐싱으로 큰 세션 폴더에서도 빠른 갱신

## 화면 구성

Windows 앱은 세 가지 화면을 제공한다.

- Compact window: Codex와 Claude 잔여율만 작게 표시하는 항상 위 창
- Full dashboard: 잔여율, 날짜별 사용량, 모델별 사용량을 모두 보여주는 대시보드
- Setup window: Codex CLI, Claude Code, Claude hook, uvicorn, 자동 실행 상태를 점검하는 설정 화면

대시보드는 기본적으로 `127.0.0.1:8767`에서 실행된다.

```text
http://127.0.0.1:8767
```

## 설치 파일로 사용하기

빌드가 끝난 설치 파일은 아래 경로에 생성된다.

```text
dist\Codex Claude Usage Setup 0.1.0.exe
```

친구나 다른 PC에 배포할 때는 이 설치 파일을 전달하면 된다.

단, 설치 파일이 모든 외부 런타임을 포함하는 것은 아니다. 대상 PC에는 아래 프로그램이 필요하다.

- Codex CLI
- Claude Code
- Python
- Python 환경에서 실행 가능한 `fastapi`, `uvicorn`

설치 후 앱을 처음 실행하면 Setup 창에서 필요한 항목을 확인할 수 있다.

## 첫 실행 체크리스트

설치 후 Setup 창에서 아래 상태를 확인한다.

```text
Codex CLI               정상 또는 필요
Claude Code             정상 또는 필요
Claude statusLine hook  정상 또는 필요
Dashboard runtime       정상 또는 필요
Windows 시작 시 실행     정상 또는 주의
```

상태 문구는 다음처럼 표시된다.

```text
정상: 방금 갱신
정상: 3분 전 갱신
주의: 오래된 값입니다. 4시간 전 갱신.
필요: statusLine hook이 현재 앱을 가리키지 않습니다.
```

Setup에서 할 수 있는 일:

- `codex login` 실행
- `claude auth` 실행
- Claude statusLine hook 설치
- 전체 대시보드 열기
- status 파일 최신성 확인

## 실행

저장소를 직접 받아서 실행할 때는 Node 의존성을 설치한 뒤 경량 앱을 띄운다.

```powershell
npm install
npm run app
```

이 명령은 Electron을 쓰지 않는 Windows 내장 WinForms 앱을 실행한다. 앱이 켜지면 작은 compact window와 백그라운드 수집기만 시작하고, FastAPI 대시보드 서버는 전체 대시보드를 열 때만 시작한다.

기존 Electron 앱을 비교용으로 실행해야 하면 아래 명령을 사용한다.

```powershell
npm run app:electron
```

기본 경량 앱의 평상시 프로세스 구성은 다음과 같다.

```text
parents: powershell.exe
collectors: node.exe 2개
server: 대시보드 열기 전에는 없음
electron: 없음
```

## 경량 앱 검증

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -STA -File scripts\native-usage-tray.ps1 -SelfTest
```

실행 중 프로세스를 확인하려면 다음을 사용한다.

```powershell
Get-CimInstance Win32_Process |
  Where-Object {
    $_.CommandLine -like '*native-usage-tray.ps1*' -or
    $_.CommandLine -like '*codex-status-poller.js*' -or
    $_.CommandLine -like '*claude-usage-poller.js*' -or
    $_.CommandLine -like '*uvicorn*'
  } |
  Select-Object ProcessId,ParentProcessId,Name,CommandLine
```

앱만 켠 상태에서는 `uvicorn`과 `8767` 포트가 없어야 한다.

## 일반 대시보드만 실행하기

Electron 앱 없이 브라우저 대시보드만 실행할 수 있다.

```powershell
npm run dashboard
```

브라우저에서 연다.

```text
http://127.0.0.1:8767
```

개발 중 Python 파일 변경을 자동 반영하려면 reload 모드를 사용한다.

```powershell
npm run dashboard:dev
```

기존 순수 Python HTTP 서버를 확인해야 할 때는 legacy 명령을 사용한다.

```powershell
npm run dashboard:legacy
```

## 데이터가 갱신되는 방식

Codex 잔여율:

- 앱이 백그라운드에서 Codex CLI를 실행한다.
- `/status` 출력을 캡처한다.
- `~\.codex-usage-wrapper\status.json`에 저장한다.
- 기본적으로 3분마다 다시 캡처한다.
- 이 수집기는 FastAPI 대시보드 서버와 별도로 실행된다.

Claude 잔여율:

- 앱이 백그라운드에서 `claude /usage`를 실행한다.
- `Current session`, `Current week (all models)` 출력을 파싱한다.
- `~\.codex-usage-wrapper\claude-status.json`에 저장한다.
- 기본적으로 3분마다 다시 캡처한다.
- Claude statusLine hook은 선택 사항이다.

토큰 사용량:

- Codex는 `~\.codex\sessions` JSONL을 읽는다.
- Claude는 `~\.claude\projects\**\*.jsonl`을 읽는다.
- 파일별 `(mtime, size)` 캐시를 사용해 바뀐 파일만 다시 파싱한다.
- 전체 대시보드를 열어둔 동안 대시보드가 이 집계를 갱신한다.

## 저장 위치

최신 Codex 상태:

```text
~\.codex-usage-wrapper\status.json
```

최신 Claude 상태:

```text
~\.codex-usage-wrapper\claude-status.json
```

Codex status 캡처 히스토리:

```text
~\.codex-usage-wrapper\history\YYYY-MM-DD.jsonl
```

대시보드 로그:

```text
~\.codex-usage-wrapper\dashboard.log
~\.codex-usage-wrapper\dashboard-error.log
```

## 보안 원칙

이 프로젝트는 다음을 하지 않는다.

- OpenAI 인증 토큰 읽기
- Anthropic 인증 토큰 읽기
- 브라우저 쿠키 읽기
- 비공개 Usage API 호출
- 외부 서버로 사용량 데이터 전송
- 원본 민감 로그를 외부 서비스에 업로드

사용하는 입력은 로컬 CLI 출력, 로컬 status JSON, 로컬 세션 JSONL뿐이다.

## 프로젝트 구조

```text
src/electron/
  main.js                 Windows 앱 메인 프로세스
  preload.js              안전한 IPC 브릿지
  renderer/compact.*      항상 위 compact window
  renderer/setup.*        초기 설정 및 상태 점검 UI

src/node/
  codex-status-poller.js  Codex /status 백그라운드 캡처
  codex-wrapper.js        선택형 Codex 터미널 래퍼
  claude-status-hook.js   Claude statusLine hook 파서
  claude-usage-poller.js  Claude /usage 백그라운드 캡처
  status-capture.js       status JSON 저장/파싱 공용 로직

src/python/
  codex_dashboard_fastapi.py  FastAPI 대시보드 진입점
  codex_status_dashboard.py   통합 대시보드 렌더링
  codex_usage_report.py       Codex JSONL 사용량 집계
  claude_usage_report.py      Claude JSONL 사용량 집계
  dashboard_common.py         HTML 렌더링 공용 유틸

scripts/
  codex-wrapper.ps1
  codex-wrapper.cmd
  codex_status_dashboard_start.ps1
```

## 선택: Codex 래퍼 사용

백그라운드 poller보다 더 빠르게 현재 Codex 세션의 status를 캡처하고 싶으면 래퍼를 사용할 수 있다.

```powershell
.\scripts\codex-wrapper.ps1
```

Codex 안에서 아래 명령을 입력하면 래퍼가 가로채서 `/status`를 캡처한다.

```text
:usage
```

Codex 인자를 넘기려면 `--` 뒤에 쓴다.

```powershell
.\scripts\codex-wrapper.ps1 -- --model gpt-5.5
```

## 수동 캡처

자동 캡처가 깨졌을 때는 `/status` 출력을 복사해서 수동으로 저장할 수 있다.

```powershell
Get-Clipboard | python src/python/codex_status_dashboard.py --raw-stdin
```

## 문제 해결

Claude 값이 오래됨으로 표시된다:

- Setup에서 Claude statusLine hook이 정상인지 확인한다.
- 필요하면 `hook 설치`를 누른다.
- Claude Code 창을 활성화하거나 새 세션을 시작해 statusLine이 다시 그려지게 한다.
- `~\.codex-usage-wrapper\claude-status.json`의 수정 시각을 확인한다.

Codex 값이 오래됨으로 표시된다:

- Codex CLI 로그인이 되어 있는지 확인한다.
- Setup에서 Codex CLI 상태를 확인한다.
- Full dashboard를 열어 poller heartbeat가 움직이는지 확인한다.
- 필요하면 `npm run dashboard` 또는 앱을 재시작한다.

Dashboard runtime이 필요으로 표시된다:

- Python이 설치되어 있는지 확인한다.
- `uvicorn`과 `fastapi`가 실행 가능한 환경인지 확인한다.

```powershell
python -m pip install fastapi uvicorn
```

설치 앱에 수정이 반영되지 않는다:

- `npm run app`은 개발 모드다.
- 설치 앱은 `npm run dist`로 다시 빌드해야 바뀐다.
- 빌드 후 `dist\Codex Claude Usage Setup 0.1.0.exe`를 다시 실행한다.

## 검증

전체 테스트:

```powershell
npm test
```

검증 범위:

- JavaScript 문법 검사
- Python 문법 검사
- Codex `/status` 파싱
- Codex poller 동작
- Claude statusLine hook 파싱
- Codex/Claude JSONL 사용량 집계
- 통합 대시보드 렌더링
- Electron main/preload/renderer 문법 검사

## 현재 제약

- 설치 파일은 Electron 앱과 프로젝트 파일을 포함하지만 Python 런타임, Codex CLI, Claude Code를 설치하지 않는다.
- Claude 잔여율은 `claude /usage` 출력에 의존한다.
- Codex 잔여율은 실제 Codex CLI `/status` 화면 출력 포맷에 의존한다.
- 기본 아이콘은 아직 Electron 기본 아이콘이다.
- 완전 독립 실행형 앱으로 만들려면 Python 서버를 번들링하거나 Node/Electron 쪽으로 서버를 옮겨야 한다.
