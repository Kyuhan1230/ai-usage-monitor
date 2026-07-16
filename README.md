# Codex Claude Usage

Codex CLI와 Claude Code 사용량을 한 화면에서 확인하는 로컬 Electron 기반 Windows 트레이 앱이다.

이 앱은 이미 로그인된 CLI의 공개 출력과 로컬 세션 로그만 읽는다. OpenAI 또는 Anthropic 인증 토큰, 브라우저 쿠키, 비공개 Usage API는 읽거나 호출하지 않는다. 수집한 데이터는 사용자 PC 안의 `~\.codex-usage-wrapper` 폴더에만 저장된다.

## 주요 기능

- Codex 5-hour, weekly 잔여율 표시
- Claude current session, current week 잔여율 표시
- Codex와 Claude 토큰 사용량을 날짜별, 모델별로 집계
- Windows 트레이 상주 앱
- 창을 닫아도 백그라운드에서 계속 최신화
- 전체 대시보드는 필요할 때만 FastAPI 서버로 실행
- Dashboard 버튼은 서버 준비 상태를 확인한 뒤 브라우저를 실행
- Setup 화면에서 Codex, Claude, hook, 자동 실행 상태 점검
- Windows 로그인 시 자동 실행 등록
- 설치용 `Setup.exe` 생성
- GitHub Releases 기반 새 버전 확인, 다운로드, 재시작 설치 안내
- 로컬 파일 캐시를 사용해 큰 세션 폴더에서도 빠른 갱신

## 화면

앱은 세 가지 화면을 제공한다.

- Compact window: Codex와 Claude 잔여율을 작게 보여주는 기본 창
- Setup window: CLI 로그인, hook, dashboard runtime, 자동 실행 상태를 점검하는 설정 창
- Full dashboard: 날짜별, 모델별 토큰 사용량과 상세 통계를 보여주는 웹 대시보드

Full dashboard는 기본적으로 아래 주소에서 열린다.

```text
http://127.0.0.1:8767
```

Dashboard 버튼을 누르면 앱은 먼저 `http://127.0.0.1:8767/status.json` 응답을 확인한다. 서버가 아직 준비되지 않았으면 짧게 대기한 뒤 브라우저를 열고, 준비 실패 시 경고 메시지를 표시한다.

## 빠른 설치

릴리스 산출물로 설치하려면 아래 파일을 실행한다.

```text
dist\Codex Claude Usage-Setup-<version>.exe
```

설치 후 시작 메뉴 또는 바탕화면에서 `Codex Claude Usage`를 실행한다. 앱을 닫아도 트레이에 남아 백그라운드 수집을 계속한다. 완전히 종료하려면 트레이 메뉴에서 종료를 선택한다.

## 필요 조건

GitHub Release 설치본을 사용하는 대상 PC에는 아래 프로그램만 필요하다. 대시보드용 Python과 Node.js는 앱에 포함된다.

- Windows 10 이상
- Codex CLI
- Claude Code

소스 실행 및 빌드 환경에는 다음 항목이 추가로 필요하다.

- Node.js 22.12 이상
- Python 3.13
- Python 패키지 `fastapi`, `uvicorn`, `tzdata`

Python 패키지는 다음 명령으로 설치한다. Windows의 `Asia/Seoul` 시간대 지원에 필요한 `tzdata`도 함께 설치된다.

```powershell
python -m pip install -r requirements.txt
```

Codex와 Claude는 각 CLI에서 먼저 로그인해야 한다.

```powershell
codex login
claude auth
```

Claude Code 버전에 따라 `claude auth` 대신 `claude login`을 사용하는 환경도 있다. Setup 화면의 버튼은 현재 설치된 CLI 동작을 확인하기 위한 보조 기능이다.

## 개발 실행

저장소를 직접 받아 실행하려면 Node 의존성을 설치한다.

```powershell
npm install
```

기본 Electron 앱을 실행한다.

```powershell
npm run app
```

명시적으로 Electron 앱을 실행하려면 같은 앱을 다음 명령으로 실행할 수 있다.

```powershell
npm run app:electron
```

기존 PowerShell WinForms tray 앱은 legacy fallback으로 남아 있다.

```powershell
npm run app:legacy-tray
```

브라우저 대시보드만 실행하려면 다음 명령을 사용한다.

```powershell
npm run dashboard
```

개발 중 Python 파일 변경을 자동 반영하려면 reload 모드를 사용한다.

```powershell
npm run dashboard:dev
```

## 빌드와 배포

설치 파일을 만들려면 다음 명령을 실행한다.

```powershell
npm run dist
```

빌드 명령은 Python.org의 공식 CPython 3.13 embeddable 배포본을 내려받아 SHA-256을 검증하고, 대시보드 의존성을 설치본에 포함한다. 이 때문에 최초 빌드는 네트워크 연결이 필요하다.

생성되는 주요 산출물은 다음과 같다.

```text
dist\Codex Claude Usage-Setup-<version>.exe
dist\Codex Claude Usage-Setup-<version>.exe.blockmap
dist\latest.yml
```

친구나 팀원에게 전달할 때는 보통 Electron NSIS 설치본 하나를 주면 된다. legacy native 산출물은 `npm run dist:legacy-native`로 별도 생성한다.

Setup은 현재 사용자 영역에 설치한다.

```text
%LOCALAPPDATA%\Programs\Codex Claude Usage
```

설치본은 시작 메뉴, 바탕화면 바로가기, 제거 항목, 트레이 아이콘에 같은 앱 아이콘을 사용한다.

소스 파일만 수정한 경우 이미 설치된 앱에는 자동 반영되지 않는다. 설치본에 반영하려면 `npm run dist`로 Setup을 다시 만들고 재설치하거나, 개발 중에는 `npm run app`으로 Electron 앱을 직접 실행한다.

### GitHub Actions CI/CD

`main` 브랜치 push와 pull request에서는 `.github/workflows/ci.yml`이 다음 작업을 수행한다.

- Node.js 22.12와 Python 3.13 준비
- JavaScript, Python 의존성 설치
- 전체 테스트 실행
- 해시를 검증한 Python embeddable 런타임 준비
- Windows NSIS 설치본 빌드
- 설치본과 자동 업데이트 메타데이터를 Actions artifact로 14일간 보관

정식 배포는 `package.json` 버전과 같은 `v<version>` 태그를 push하면 시작된다. 예를 들어 patch 버전을 올려 배포하려면 다음과 같이 실행한다.

```powershell
npm version patch
git push origin main --follow-tags
```

`.github/workflows/release.yml`은 태그와 앱 버전이 일치하는지 확인하고, 테스트와 Windows 빌드를 통과한 뒤 GitHub Releases에 아래 파일을 공개한다.

- Windows 설치 파일 `.exe`
- 차등 업데이트 파일 `.blockmap`
- 업데이트 메타데이터 `latest.yml`

별도 Personal Access Token은 필요하지 않다. 워크플로는 저장소가 제공하는 `GITHUB_TOKEN`과 `contents: write` 권한을 사용한다.

### 설치된 앱의 자동 업데이트

GitHub Release에서 설치한 앱은 다음 시점에 새 공개 릴리스를 확인한다.

- 앱 시작 15초 후
- 앱 실행 중 6시간마다
- 트레이 메뉴의 `Check for updates...` 선택 시

새 버전이 있으면 먼저 다운로드 여부를 묻고, 다운로드가 끝나면 즉시 재시작해 설치할지 묻는다. `종료할 때 설치`를 선택하면 앱을 다음에 종료할 때 설치된다. 개발 모드인 `npm run app`에서는 자동 업데이트가 동작하지 않는다.

처음 한 번은 GitHub Releases에서 설치 파일을 직접 내려받아 설치해야 한다. 그 설치본부터 이후 공개 릴리스 업데이트 안내를 받을 수 있다. 현재 Windows 코드 서명 인증서를 설정하지 않았으므로 다른 PC에서는 첫 설치 때 Windows SmartScreen의 게시자 경고가 표시될 수 있다.

## 데이터 수집 방식

Codex 잔여율:

- 앱이 백그라운드에서 Codex CLI를 실행한다.
- `/status` 출력을 캡처하고 파싱한다.
- `~\.codex-usage-wrapper\status.json`에 저장한다.
- 기본적으로 1분마다 갱신한다.

Claude 잔여율:

- 앱이 백그라운드에서 `claude /usage`를 실행한다.
- `Current session`, `Current week (all models)` 출력을 파싱한다.
- `~\.codex-usage-wrapper\claude-status.json`에 저장한다.
- Claude statusLine hook은 선택 사항이다.

토큰 사용량:

- Codex는 `~\.codex\sessions` JSONL 파일을 읽는다.
- Claude는 `~\.claude\projects` 아래의 모든 JSONL 파일을 재귀적으로 읽는다.
- 파일별 `(mtime, size)` 캐시를 사용해 변경된 파일만 다시 파싱한다.
- 전체 대시보드를 열어둔 동안 상세 집계가 갱신된다.

캡처 주기는 환경변수로 조절할 수 있다.

```powershell
$env:CODEX_USAGE_POLL_INTERVAL_MS = "180000"
$env:CODEX_USAGE_CODEX_POLL_INTERVAL_MS = "60000"
$env:CODEX_USAGE_CLAUDE_POLL_INTERVAL_MS = "180000"
```

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

사용하는 입력은 로컬 CLI 출력, 로컬 status JSON, 로컬 세션 JSONL이다. GitHub issue나 로그 공유 시에는 `~\.codex-usage-wrapper`와 세션 JSONL 원본을 그대로 첨부하지 않는 것을 권장한다.

## 프로젝트 구조

```text
assets/
  codex-claude-usage.ico     Windows 앱, tray, shortcut 아이콘
  codex-claude-usage.png     아이콘 원본 PNG

scripts/
  native-usage-tray.ps1      legacy WinForms tray 앱
  build-native-exe.ps1       legacy native launcher exe 생성
  build-native-installer.ps1 legacy native setup 생성
  codex-wrapper.ps1          선택형 Codex wrapper
  codex-wrapper.cmd          선택형 Codex wrapper

src/node/
  codex-status-poller.js     Codex /status 백그라운드 캡처
  claude-usage-poller.js     Claude /usage 백그라운드 캡처
  claude-status-hook.js      Claude statusLine hook 파서
  codex-wrapper.js           Codex terminal wrapper
  status-capture.js          status JSON 저장과 공용 파서

src/python/
  codex_dashboard_fastapi.py FastAPI 대시보드 진입점
  codex_status_dashboard.py  통합 대시보드 렌더링
  codex_usage_report.py      Codex JSONL 사용량 집계
  claude_usage_report.py     Claude JSONL 사용량 집계
  dashboard_common.py        HTML 렌더링 공용 유틸

src/electron/
  main.js                    주력 Electron 앱
  preload.js                 Electron IPC bridge
  renderer/                  Electron renderer UI

tests/
  run-tests.js               통합 테스트 러너
  mock-codex*.js             Codex CLI mock
```

## 선택: Codex wrapper

백그라운드 poller보다 더 빠르게 현재 Codex 세션의 `/status`를 캡처하고 싶으면 wrapper를 사용할 수 있다.

```powershell
.\scripts\codex-wrapper.ps1
```

Codex 안에서 아래 명령을 입력하면 wrapper가 `/status`를 캡처한다.

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

Claude 값이 오래됨으로 표시될 때:

- Setup에서 Claude CLI 상태와 statusLine hook 상태를 확인한다.
- 필요하면 hook 설치를 다시 누른다.
- Claude Code 창을 활성화하거나 새 세션을 시작해 statusLine이 다시 그려지게 한다.
- `~\.codex-usage-wrapper\claude-status.json` 수정 시각을 확인한다.

Codex 값이 오래됨으로 표시될 때:

- Codex CLI 로그인이 되어 있는지 확인한다.
- Setup에서 Codex CLI 상태를 확인한다.
- Full dashboard를 열어 poller heartbeat가 움직이는지 확인한다.
- 필요하면 앱을 재시작한다.

Dashboard runtime이 필요로 표시될 때:

- 설치본이라면 앱을 최신 GitHub Release 버전으로 다시 설치한다.
- 개발 모드라면 Python 3.13과 `fastapi`, `uvicorn`이 현재 환경에서 실행 가능한지 확인한다.

Dashboard 버튼을 눌렀는데 앱만 흐려지거나 비활성화된 것처럼 보일 때:

- Setup 창 안에서 눌렀다면 최신 설치본인지 확인한다. 오래된 설치본은 모달 Setup 창이 닫히지 않아 부모 창이 비활성화된 것처럼 보일 수 있다.
- 브라우저에서 `http://127.0.0.1:8767`을 직접 열어 대시보드 서버가 정상 응답하는지 확인한다.
- 설치본을 사용 중이면 최신 Setup으로 다시 설치한다.
- 개발 중이면 Electron 앱을 완전히 종료한 뒤 `npm run app`으로 다시 실행한다.

작업표시줄 또는 바로가기 아이콘이 예전 아이콘으로 보일 때:

- 설치본을 최신 Setup으로 다시 설치한다.
- 기존에 작업표시줄에 고정한 낡은 바로가기가 있으면 제거 후 다시 고정한다.
- Windows 아이콘 캐시 때문에 잠시 늦게 갱신될 수 있다.

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
- Claude `/usage` 파싱
- Claude statusLine hook 파싱
- Codex와 Claude JSONL 사용량 집계
- 통합 대시보드 렌더링
- Electron main, preload, renderer 문법 검사

## 현재 제약

- Codex 잔여율은 Codex CLI `/status` 화면 출력 포맷에 의존한다.
- Claude 잔여율은 `claude /usage` 출력 포맷에 의존한다.
- Codex와 Claude의 정확한 요금제 이름은 안정적으로 자동 판별하지 않는다.
- 설치본은 Electron의 Node.js와 대시보드용 Python 런타임을 포함하지만 Codex CLI와 Claude Code는 포함하지 않는다.
- 각 CLI가 없거나 로그인되지 않은 PC에서는 해당 서비스의 사용량을 수집할 수 없다.
