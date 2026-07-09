# Codex, Claude Usage Dashboard

Codex 사용량을 로컬에서 확인하기 위한 도구 모음이다.

- `src/python/codex_status_dashboard.py`: 플랜 잔여율(`/status` 캡처 결과)과 토큰 사용량 리포트를 하나로 합친 메인 대시보드.
- `src/python/codex_dashboard_fastapi.py`: 개발 중 파일 수정이 바로 반영되도록 FastAPI와 uvicorn reload로 대시보드를 띄우는 진입점.
- `src/python/codex_usage_report.py`: `~/.codex/sessions` JSONL을 스캔해서 날짜별, 모델별 토큰 사용량을 집계한다. 대시보드에서도 재사용하고, 독립적으로 정적 HTML을 뽑을 때도 쓴다.
- `src/node/codex-status-poller.js`: 대시보드가 자동으로 띄우는 헤드리스 백그라운드 프로세스. 숨겨진 Codex CLI 세션 하나를 잡아두고 주기적으로 `/status`를 캡처한다.
- `src/node/codex-wrapper.js` / `scripts/codex-wrapper.ps1`: 실제로 코딩할 때 쓰는 터미널을 감싸서, 그 세션의 실제 출력에서 `/status`를 캡처하는 보조 수단(선택 사항).

인증 토큰, 브라우저 쿠키, 비공개 Usage API는 사용하지 않는다. 잔여율은 로그인된 Codex CLI를 그대로 구동해서 `/status` 명령을 실행한 화면 출력을 읽는 방식으로만 얻는다.

## 1. 대시보드 실행

별도 PowerShell에서 대시보드를 실행한다.

```powershell
cd "D:\1. 프로젝트\스터디\CodexUsage"
npm run dashboard
```

브라우저에서 연다.

```text
http://127.0.0.1:8767
```

같은 사내망의 다른 PC에서는 이 PC의 LAN IP로 접속한다.

```text
http://10.24.0.145:8767
```

이 명령 하나로 다음이 자동으로 일어난다.

- 플랜 잔여율(5-hour/weekly/monthly)이 잔여량에 따라 초록/주황/빨강으로 바뀌는 링으로, 토큰 사용량 리포트(날짜별·모델별)가 그 아래 한 페이지에 표시된다.
- 서버가 시작하면서 백그라운드에 숨겨진 Codex CLI 세션을 하나 띄우고(`src/node/codex-status-poller.js`), 기본 3분마다 `/status`를 캡처해서 `status.json`을 갱신한다. 사용자가 이 프로세스를 직접 신경 쓸 필요는 없다.
- 대시보드 하단에는 마지막 성공 캡처 시각과 poller heartbeat가 함께 표시된다. heartbeat가 계속 바뀌면 poller는 살아 있고, 성공 캡처 시각만 오래됐으면 `/status` 파싱이나 Codex CLI 상태를 확인하면 된다.
- 토큰 사용량 쪽은 파일별로 (수정시각, 크기)를 캐싱해서, 실제로 바뀐 세션 파일만 다시 파싱한다. 코딩 중에는 그날 활성 세션 파일 하나만 계속 바뀌므로, 세션 폴더가 수백~수천 개 파일로 커져도 매 새로고침마다 전부 다시 읽지 않는다. 서버를 막 띄운 직후의 최초 집계만 세션 폴더 크기에 비례해 다소 걸릴 수 있고(예: 1GB 안팎이면 20초 내외), 이마저도 서버가 첫 요청을 받기 전 백그라운드에서 미리 데워둔다.

대시보드는 페이지 전체를 새로고침하지 않는다. 기본 3초마다 잔여율·토큰 사용량 영역만 백그라운드에서 다시 받아와 조용히 갈아 끼운다(`/fragment` 엔드포인트를 fetch로 폴링).

개발 중에는 reload 모드로 실행한다. Python 파일을 고치면 uvicorn이 서버를 자동으로 다시 띄우므로 매번 직접 껐다 켤 필요가 없다.

```powershell
npm run dashboard:dev
```

기존 순수 Python HTTP 서버로 확인해야 할 때는 아래 명령을 쓴다.

```powershell
npm run dashboard:legacy
```

플랜 잔여율 자동 캡처를 끄고 싶으면:

```powershell
python src/python/codex_status_dashboard.py --serve --no-auto-status-poll
```

캡처 주기, Codex 실행 파일, 세션 폴더 등은 옵션으로 바꿀 수 있다.

```powershell
python src/python/codex_status_dashboard.py --serve `
  --poll-interval-ms 180000 `
  --codex-command codex.exe `
  --sessions-dir "C:\Users\me\.codex\sessions"
```

## 2. 컴퓨터 켤 때 자동으로 띄우기

로그인할 때마다 대시보드가 알아서 백그라운드로 뜨게 하려면, Windows 시작프로그램 폴더에 바로가기를 등록한다.

```powershell
$WshShell = New-Object -ComObject WScript.Shell
$startupFolder = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder "CodexUsageDashboard.lnk"

$shortcut = $WshShell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "D:\1. 프로젝트\스터디\CodexUsage\scripts\codex_status_dashboard_start.ps1"'
$shortcut.WorkingDirectory = "D:\1. 프로젝트\스터디\CodexUsage"
$shortcut.WindowStyle = 7
$shortcut.Save()
```

`scripts/codex_status_dashboard_start.ps1`이 `npm install`(필요할 때만) 후 대시보드를 창 없이 백그라운드로 띄우고, 출력을 `~\.codex-usage-wrapper\dashboard.log` / `dashboard-error.log`에 남긴다.

스크립트는 `http://127.0.0.1:8767/status.json`이 이미 응답하면 새 대시보드를 중복 실행하지 않고 종료한다. 서버는 `0.0.0.0:8767`에 바인딩해서 같은 사내망의 다른 PC에서도 열 수 있다.

껐다 켜지 않고 바로 등록한 상태를 확인하려면 시작프로그램 폴더를 직접 연다.

```powershell
explorer shell:startup
```

자동 실행을 끄려면 그 폴더에서 `CodexUsageDashboard.lnk`만 지우면 된다.

이 방식은 Docker가 아니라 Windows 네이티브 방식이다. 대시보드가 실제로 하는 일(로그인된 `codex.exe`를 그대로 구동해서 `/status`를 읽는 것)은 Linux 컨테이너 안에서는 실행할 수 없는 Windows 프로세스라서, Docker로 묶는 방식은 이 프로젝트의 핵심 기능과 맞지 않는다.

상시 실행 안정성을 더 높이고 싶으면 시작프로그램 바로가기보다 작업 스케줄러를 권장한다. 시작프로그램은 로그인 시 1회 실행만 보장하고, 작업 스케줄러는 실패 시 재시작 정책을 줄 수 있다. 작업 스케줄러 등록은 Windows 정책에 따라 관리자 권한 PowerShell이 필요할 수 있다.

작업 스케줄러 등록 예시:

```powershell
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "D:\1. 프로젝트\스터디\CodexUsage\scripts\codex_status_dashboard_start.ps1"'

$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName "CodexUsageDashboard" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Start local Codex, Claude Usage Dashboard"
```

이미 시작프로그램 바로가기를 쓰고 있다면 둘 중 하나만 남긴다. 둘 다 등록해도 스크립트가 중복 실행을 막지만, 운영 경로는 하나가 낫다.

## 3. (선택) 실제 코딩 세션에서 더 빠르게 캡처하기 — 래퍼

백그라운드 poller는 기본 3분 주기라서 즉각성이 떨어질 수 있다. 실제로 코딩하는 세션 자체에서 캡처하고 싶다면 아래 래퍼로 Codex를 실행한다.

```powershell
cd "D:\1. 프로젝트\스터디\CodexUsage"
.\scripts/codex-wrapper.ps1
```

PowerShell이 아니라 파일을 더블클릭해서 실행하고 싶으면 아래 파일을 사용한다.

```text
scripts/codex-wrapper.cmd
```

더블클릭했을 때 창이 바로 닫히면 PowerShell이나 Windows Terminal에서 아래처럼 실행한다.

```powershell
.\scripts/codex-wrapper.cmd
```

처음 실행할 때 `node_modules`가 없으면 `npm install`을 한 번 실행한다.

Codex 안에서 한 줄 맨 앞에 아래 명령을 입력하면 래퍼가 가로챈다.

```text
:usage
```

래퍼는 이 입력을 Codex로 보내지 않고 내부적으로 `/status`를 입력한 뒤 출력값을 캡처해서 `status.json`에 저장한다. 대시보드는 다음 refresh 때 값을 표시한다.

래퍼는 기본적으로 다음 자동 갱신도 수행한다.

- 세션 시작 후 약 2.5초 뒤 1회 `/status` 캡처
- 사용자 입력과 캡처가 없을 때 3분 idle 주기 캡처
- 응답 출력이 조용해진 뒤 자동 캡처 시도

자동 캡처는 사용자 입력이 감지되었거나, Codex 출력이 아직 조용해지지 않았거나, 승인/확인 프롬프트로 보이는 출력이 최근에 감지되면 건너뛴다. `/status` 출력이 계속 흘러서 quiet 구간이 오지 않으면(예: 스피너 애니메이션) 최대 15초 뒤 강제로 캡처를 마무리한다.

응답 후 자동 캡처를 끄려면:

```powershell
.\scripts/codex-wrapper.ps1 --no-after-output-capture
```

자동 시작 캡처를 끄려면:

```powershell
.\scripts/codex-wrapper.ps1 --no-start-capture
```

idle 캡처를 끄려면:

```powershell
.\scripts/codex-wrapper.ps1 --no-idle-capture
```

Codex 인자를 넘기려면 `--` 뒤에 쓴다.

```powershell
.\scripts/codex-wrapper.ps1 -- --model gpt-5.5
```

## 4. 수동 캡처 fallback

래퍼도 백그라운드 poller도 쓰고 싶지 않다면 `/status` 출력 복사 방식으로 `status.json`을 만들 수 있다.

1. Codex CLI에서 `/status`를 실행한다.
2. 출력 내용을 복사한다.
3. 별도 PowerShell에서 실행한다.

```powershell
cd "D:\1. 프로젝트\스터디\CodexUsage"
Get-Clipboard | python src/python/codex_status_dashboard.py --raw-stdin
```

## 5. 토큰 사용량만 필요할 때

대시보드 없이 리포트만 뽑고 싶을 때 쓴다.

정적 HTML 생성:

```powershell
python src/python/codex_usage_report.py
```

실시간 재스캔 서버:

```powershell
python src/python/codex_usage_report.py --serve
```

브라우저에서 연다.

```text
http://127.0.0.1:8765
```

## 6. 저장 파일

최신 상태:

```text
~\.codex-usage-wrapper\status.json
```

히스토리:

```text
~\.codex-usage-wrapper\history\YYYY-MM-DD.jsonl
```

백그라운드 poller의 PID(대시보드 서버가 자동 관리, 직접 건드릴 필요 없음):

```text
~\.codex-usage-wrapper\poller.pid
```

시작프로그램으로 띄웠을 때의 서버 로그(문제 생겼을 때 여기부터 확인):

```text
~\.codex-usage-wrapper\dashboard.log
~\.codex-usage-wrapper\dashboard-error.log
```

## 7. 보안 원칙

- OpenAI 인증 토큰을 읽지 않는다.
- 브라우저 쿠키를 읽지 않는다.
- 비공개 Usage API를 호출하지 않는다.
- 외부 서버로 사용량 데이터를 보내지 않는다.
- 대시보드는 로컬 파일과 로컬 HTTP 서버만 사용한다.
- 백그라운드 poller도 로그인된 Codex CLI를 그대로 구동해서 화면에 보이는 `/status` 출력을 읽을 뿐, 인증 파일이나 세션 토큰을 직접 열어보지 않는다.

## 7-1. Claude Code 사용량 섹션

통합 대시보드에는 Codex 섹션 아래에 Claude 사용량 섹션도 표시된다.

- 토큰 사용량은 `~\.claude\projects\**\*.jsonl` 파일을 스캔해서 날짜별, 모델별로 집계한다.
- `subagents` 하위 폴더의 JSONL도 포함한다.
- Claude JSONL은 같은 `message.id`를 가진 여러 assistant 라인이 동일한 usage를 반복 기록하므로, 대시보드는 `message.id`별 마지막 usage만 집계한다.
- 표시 열은 Input, Cached Input, Cache Write, Output, Total, Events다.
- Claude Current session/week 잔여율은 Claude Code의 `statusLine` hook이 저장한 `~\.codex-usage-wrapper\claude-status.json`을 읽는다. 사용률은 링 하단 보조 문구로 함께 표시한다.

Claude statusLine hook 수동 등록:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"D:\\1. 프로젝트\\스터디\\CodexUsage\\src/node/claude-status-hook.js\""
  }
}
```

위 내용을 `~\.claude\settings.json`에 직접 추가한다. 대시보드 서버는 이 파일을 자동으로 수정하지 않는다.

이미 `statusLine.command`가 있다면 바로 덮어쓰지 않는다. 이 머신에서는 caveman 플러그인이 statusLine을 관리할 수 있으므로 실제 충돌 가능성이 있다. 기존 statusLine을 유지하려면 그대로 둔다. 둘 다 쓰려면 기존 명령을 `CLAUDE_STATUSLINE_ORIGINAL_COMMAND` 환경 변수에 넣고 hook 명령을 호출하도록 수동으로 체인한다.

예시:

```powershell
$env:CLAUDE_STATUSLINE_ORIGINAL_COMMAND = "기존 statusLine 명령"
node "D:\1. 프로젝트\스터디\CodexUsage\src\node\claude-status-hook.js"
```

hook은 Claude Code가 stdin으로 넘기는 JSON에서 `rate_limits.five_hour.used_percentage`와 `rate_limits.seven_day.used_percentage`를 읽고, 사용률과 잔여율을 함께 `claude-status.json`에 저장한다. 대시보드 링 중앙은 잔여율을 표시하고, 사용률은 보조 문구로 표시한다. `remaining_percentage` 계열 필드만 있으면 사용률을 역산하고, `resets_at` 같은 epoch 값은 KST 시각으로 표시한다. JSON이 없거나 깨져도 종료 코드 0으로 끝나며 status 파일에는 failed 상태를 남긴다.

## 8. 현재 제약

Windows TUI 래핑은 `node-pty` 기반이다. 대부분의 Windows Terminal 환경에서 동작하도록 만들었지만, 승인 프롬프트나 특수한 멀티라인 입력 중 자동 `/status` 주입은 완전히 증명하기 어렵다.

백그라운드 poller는 실제 코딩 세션과는 별개의 Codex CLI 프로세스이므로, 로그인 상태에서 두 개의 세션이 동시에 떠 있는 상태가 된다. Codex 최초 실행 시 온보딩 화면 등 특수한 프롬프트가 뜨면 자동 캡처가 지연되거나 건너뛸 수 있다.

가장 안전하고 즉각적인 갱신 방식은 여전히 래퍼를 쓰면서 `:usage`를 직접 입력하는 방식이다. 대시보드만 켜두는 방식은 최대 poll 주기(기본 3분)만큼 지연될 수 있다.

서버를 새로 띄운 직후 첫 요청은 세션 폴더 전체를 처음 훑느라 세션 폴더 크기에 따라 몇 초~몇십 초 걸릴 수 있다(파일별 캐시가 아직 없으므로). 이후 요청은 바뀐 파일만 다시 읽어서 훨씬 빠르다.

## 9. 검증

전체 검증:

```powershell
npm test
```

검증 내용:

- JavaScript / Python 문법 검사
- `/status` raw 텍스트 파싱
- mock Codex CLI에서 `:usage` 가로채기
- mock Codex CLI에서 세션 시작 자동 캡처
- mock Codex CLI에서 idle 자동 캡처
- 헤드리스 poller의 시작·주기 캡처
- poller가 존재하지 않는 Codex 실행 파일에도 죽지 않고 재시도하는지
- mock `/status` 출력 캡처 후 `status.json` 생성
- 합쳐진 대시보드가 잔여율과 토큰 사용량을 함께 표시하는지
