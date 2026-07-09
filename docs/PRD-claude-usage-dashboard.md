# PRD: 통합 AI CLI 사용량 대시보드 (Claude Code 섹션 추가)

## Problem Statement

Codex CLI와 Claude Code를 매일 같이 쓰는데, 사용량을 한눈에 볼 수 있는 대시보드는 Codex 것밖에 없다. Claude Code로 오늘 얼마나 토큰을 썼는지, 어떤 모델에서 얼마나 썼는지 확인하려면 터미널 스크롤을 눈으로 훑거나 `~/.claude` 밑의 원본 JSON 파일을 직접 뒤져야 한다. 이미 Codex 쪽에서 확보한 "항상 켜져 있고, 손 안 대도 알아서 최신 상태를 보여주는" 가시성을 Claude Code에도 똑같이 갖고 싶고, 가능하면 지금 보고 있는 바로 그 화면에서 같이 보고 싶다.

## Solution

기존 CodexUsage 대시보드(`codex_status_dashboard.py --serve`, 8767번 포트)를 하나의 "통합 AI CLI 사용량 대시보드"로 확장해서, 같은 페이지에서 Codex 섹션과 Claude 섹션을 나란히 보여준다. 다크 테마, 스크롤+sticky 헤더 테이블, 툴팁, `/fragment` 비동기 갱신, 파일별 캐싱, Windows 로그온 자동 실행 등 이미 만들어둔 대시보드 인프라를 그대로 재사용한다.

Claude 섹션의 토큰 사용량은 처음부터 동작한다 — Claude Code가 로컬에 남기는 세션 트랜스크립트(`~/.claude/projects/**/*.jsonl`)를 Codex와 동일한 파일별 캐싱 구조로 스캔·집계한다.

**Phase 0 스파이크 완료(go 결정)**: Claude Code 바이너리(`claude.exe`)를 직접 조사한 결과, 잔여율 패널을 Codex와 전혀 다른 — 그리고 훨씬 안전한 — 방식으로 만들 수 있다는 게 확인됐다. Claude Code에는 공식 `statusLine` 훅 기능이 있고, `~/.claude/settings.json`에 `{"statusLine": {"type": "command", "command": "..."}}`를 등록해두면 Claude Code가 상태줄을 다시 그릴 때마다 그 명령어를 실행하면서 `rate_limits.five_hour.used_percentage`, `rate_limits.seven_day.used_percentage`가 들어있는 JSON을 **표준입력으로** 넘겨준다(바이너리에 내장된 공식 예시 스크립트로 확인). 즉 Codex처럼 헤드리스 세션을 띄우고 화면 텍스트를 정규식으로 긁어낼 필요 없이, 구조화된 JSON을 그냥 받아서 저장하면 된다. 이 머신에는 Claude Code 전용 `rate_limits`에 5-hour/7-day 두 개만 있고(모델별 device-auth 관련 항목 제외) monthly에 해당하는 필드는 없다 — Claude 섹션의 링은 Codex의 3개(5-hour/weekly/monthly)가 아니라 2개(5-hour/7-day)가 된다.

## User Stories

1. Codex CLI와 Claude Code를 같이 쓰는 개발자로서, 같은 대시보드에서 오늘의 Claude 토큰 사용량을 보고 싶다. 그래야 두 군데를 따로 확인하지 않아도 된다.
2. 개발자로서, Claude 토큰 사용량을 날짜별·모델별로 나눠 보고 싶다. 그래야 어떤 날/모델이 사용량을 많이 차지하는지 알 수 있다.
3. 개발자로서, 대화 한 턴(thinking→text→tool_use처럼 여러 줄로 쪼개져 기록되는 경우 포함)의 토큰 사용량이 정확히 한 번만 집계되면 좋겠다. 실수로 같은 사용량을 여러 번 더해서 실제보다 부풀려진 숫자를 보고 싶지 않다.
4. 개발자로서, Claude 섹션에서 캐시로 읽은(재사용된) 입력 토큰을 새 입력 토큰과 구분해서 보고 싶다. 그래야 프롬프트 캐싱으로 얼마나 이득을 보는지 알 수 있다.
5. 개발자로서, 캐시를 새로 만드는 데 쓰인 토큰(cache write)도 별도로 보고 싶다. 그래야 새 컨텍스트를 캐싱하는 데 드는 비용도 놓치지 않는다.
6. 개발자로서, 서브에이전트(보조 에이전트) 세션에서 쓴 토큰도 메인 세션과 합쳐서 보고 싶다. 서브에이전트도 실제로 과금되는 비용이라, 그걸 빼면 "오늘 얼마나 썼는지"가 실제보다 적게 보인다.
7. 개발자로서, Claude 사용량 테이블의 컬럼에 마우스를 올리면 각 토큰 종류가 뭔지 설명이 뜨면 좋겠다(Codex 테이블과 동일하게). 그래야 매번 추측하지 않아도 된다.
8. 개발자로서, Claude 사용량 테이블도 행이 많아지면 스크롤되고 헤더는 고정되면 좋겠다(Codex 테이블과 동일하게). 그래야 페이지가 한없이 길어지지 않는다.
9. 개발자로서, Claude 사용량 숫자가 전체 새로고침 없이 몇 초마다 알아서 갱신되면 좋겠다(`/fragment` 비동기 방식 재사용). 그래야 대시보드가 살아있다는 느낌이 든다.
10. 개발자로서, 실제로 바뀐 Claude 세션 파일만 다시 파싱되면 좋겠다. 그래야 Claude Code를 쓰는 도중에 대시보드를 열어도 몇 초씩 버벅이지 않는다(Codex에서 이미 고친 파일별 캐싱과 동일).
11. 개발자로서, 서버를 막 띄운 직후 첫 페이지 로딩이 전체 재집계 때문에 막히지 않으면 좋겠다(Codex에 이미 있는 백그라운드 pre-warm과 동일).
12. 개발자로서, "오늘" 통계 카드가 전체 누적이 아니라 정말 오늘 하루치만 보여주면 좋겠다(Codex에서 이미 고친 것과 동일).
13. 개발자로서, 잔여율을 얻으려고 실제 코딩 세션과 별개로 숨겨진 Claude 세션을 또 하나 띄우고 싶지 않다(Codex의 headless poller처럼). Claude Code가 공식으로 제공하는 `statusLine` 훅으로 구조화된 데이터를 받고 싶다.
14. 개발자로서, 잔여율 데이터가 화면 텍스트를 정규식으로 긁어서 만든 값이 아니라 Claude Code가 직접 주는 JSON 숫자였으면 좋겠다. 그래야 화면 문구가 바뀌어도 잘 안 깨진다.
15. 개발자로서, 잔여율을 Codex와 똑같은 색깔 링 UI(5-hour, 7-day 두 개)로 보여주면 좋겠다. 그래야 두 섹션이 일관돼 보인다.
16. 개발자로서, `statusLine` 훅이 아직 한 번도 안 불렸거나(설정 직후) JSON에 `rate_limits`가 없는 경우에도 대시보드가 깨지지 않고 "N/A"로 표시되면 좋겠다.
17. 개발자로서, Claude 쪽 데이터 소스가 일시적으로 없거나 에러 나도(예: 이 컴퓨터에 Claude Code가 아예 없는 경우) Codex 섹션은 정상 동작하면 좋겠다. 한쪽이 죽어서 전체가 죽는 건 싫다.
18. 개발자로서, Claude 데이터를 읽는 코드가 `.credentials.json`이나 다른 인증/토큰 파일은 절대 열지 않으면 좋겠다(Codex 쪽에 이미 있는 보안 원칙과 동일).
19. 개발자로서, 이미 다른 목적으로 `statusLine`을 설정해뒀다면(예: 이미 발견된 `caveman-statusline.ps1` 같은 것) 이 기능이 그걸 조용히 덮어쓰지 않고, 기존 설정을 감지해서 체이닝하거나 최소한 명시적으로 경고해주면 좋겠다.
20. 개발자로서, 기존 Windows 로그온 자동 실행 바로가기 하나로 통합 대시보드(두 섹션 다) 전체가 뜨면 좋겠다. Claude용으로 바로가기를 또 등록하고 싶지 않다.
21. 개발자로서, Codex(약 940개 파일·1GB)와 Claude(약 283개 파일·146MB) 세션 이력을 같이 로드해도 페이지 로딩·갱신 속도가 계속 빠르면 좋겠다. Claude를 추가했다고 Codex 쪽 성능이 다시 나빠지는 건 싫다.
22. 개발자로서, 기존 `tests/run-tests.js` 관례를 따르는 자동화 테스트가 Claude 집계 로직과 통합 페이지 출력을 커버하면 좋겠다. 그래야 Claude 쪽 회귀도 Codex처럼 잡힌다.
23. 개발자로서, README가 통합 대시보드와 실행 방법을 설명해주면 좋겠다. 나중에 소스코드를 다시 뒤져가며 알아내고 싶지 않다.
24. 개발자로서, Claude 사용량 필드가 화면의 어느 컬럼과 대응되는지가 문서로 명확히 남아있으면 좋겠다. 나중에 Claude Code 로그 스키마가 바뀌었을 때 감으로 때려맞추지 않아도 되게.

## Implementation Decisions

- **아키텍처**: 별개 프로젝트/포트가 아니라 기존 `codex_status_dashboard.py`를 통합 진입점으로 유지하고 확장한다(사용자 확인 완료).
- **신규 모듈 `claude_usage_report.py`**: `codex_usage_report.py`와 동일한 공개 인터페이스로 구조를 맞춘다 — `default_sessions_dir()`(→ `~/.claude/projects`), `iter_jsonl_files`, `compute_file_usage(path)`, `aggregate_usage(sessions_dir, file_cache)`, `today_totals`, `sum_totals`, `render_report_body(aggregate, sessions_dir)`.
- **공용 코드 분리**: `BASE_STYLE`, `REPORT_STYLE`, `render_live_refresh_script`, `send_body`, `FileCache` 타입을 `codex_usage_report.py`에서 꺼내 새 공용 모듈(예: `dashboard_common.py`)로 옮기고, `codex_usage_report.py`와 `claude_usage_report.py` 둘 다 거기서 import한다. 어느 한쪽이 다른 쪽의 공용 코드를 소유하는 비대칭 의존을 피한다.
- **테이블 렌더링 일반화**: Codex 전용으로 굳어 있는 8컬럼 `render_rows`를 `render_usage_table(rows, columns)` 형태로 일반화한다. `columns`는 `(field_name, header_label, tooltip_text)` 목록이라, Codex 섹션은 Reasoning Output을 유지하고 Claude 섹션은 Cache Write를 추가하면서 Reasoning Output은 뺄 수 있다. 테이블 마크업·스크롤·정렬·툴팁 CSS는 그대로 공유한다.
- **Claude 필드 매핑** (User Story 24 대응, 명시적으로 문서화. 실데이터 조사로 검증 완료):
  - Claude `input_tokens` → 화면 "Input"
  - Claude `cache_read_input_tokens` → 화면 "Cached Input" (Codex `cached_input_tokens`와 같은 의미 슬롯)
  - Claude `cache_creation_input_tokens` → 신규 컬럼 "Cache Write" (Codex에 대응 항목 없음. Codex의 "Reasoning Output" 슬롯을 재활용하지 않는다 — 성격이 다른 비용이라서.)
  - Claude `output_tokens` → 화면 "Output"
  - "Total"은 Claude 쪽에서 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`로 직접 계산한다(실데이터 조사 결과 이벤트에 미리 계산된 총합 필드가 없음을 확인함 — API가 total을 직접 주는 필드가 나중에 발견되면 그쪽을 우선한다).
  - 모델은 각 assistant 턴 레코드의 `message.model`에서 가져온다. **실데이터 검증 결과 75개 세션 파일·12,048개 assistant+usage 레코드 전부(100%)에 `message.model`이 채워져 있었다** — Codex처럼 별도 `turn_context` 레코드에서 모델을 이어받아야 하는 구조가 아니다. 다만 `<synthetic>`이라는 특수 모델 문자열이 25건 관측됐는데(null/누락이 아니라 실제 값), 이건 필터링하지 않고 다른 모델명과 동일하게 표/집계에 그대로 노출한다. `codex_usage_report.py`의 "파일 내 최근 모델 이어받기" 방어 패턴은 model 필드가 비어있는 예외적 레코드에 대한 안전망으로만 유지한다(실데이터에서는 발동할 일이 없었음).
  - 날짜는 각 레코드의 `timestamp` 필드에서 뽑는다(실데이터 확인 결과 ISO8601 UTC라 Codex의 다단계 폴백보다 단순함). Codex 섹션의 `today_utc()`와 동일한 UTC 기준을 그대로 맞춘다.
  - `message.usage` 객체가 있는 레코드(assistant 턴)만 집계 대상. `user` 턴, 툴/첨부 이벤트는 건너뛴다.
  - **⚠️ 중복 집계 방지(필수, User Story 3 대응)**: Claude Code는 한 논리적 턴(thinking → text → tool_use 등 콘텐츠 블록 단위)을 JSONL에서 여러 줄로 나눠 기록하는데, 같은 턴에 속한 줄들은 **동일한 `message.id`에 완전히 동일한 `usage` 객체를 반복해서** 들고 있다. 실데이터로 검증한 결과, 이 특성을 무시하고 usage가 있는 줄을 전부 그냥 더하면 실제 사용량보다 **2.2~2.7배** 부풀려진다(4개 세션 파일 샘플, output 토큰 기준 2.17x~2.73x 과다 집계 확인). 따라서 `compute_file_usage`는 파일을 순회하면서 **`message.id`별로 마지막에 관측된 `usage` 객체 하나만 유지**한 뒤(먼저 dedup), 그 dedup된 집합에 대해서만 날짜·모델별로 합산해야 한다. 단순히 "usage 있는 줄마다 더하기"는 명백한 버그이며 이 항목이 이번 PRD에서 가장 위험도가 높은 구현 포인트다.
  - 서브에이전트 세션 파일(`projects/<프로젝트>/subagents/*.jsonl`)도 메인 세션 파일과 동일한 구조(`type: assistant` + `message.usage`)이고 동일한 message-id 중복 문제가 있으므로, 같은 dedup 로직을 그대로 적용한다.
- **스캔 범위**: `claude_usage_report.iter_jsonl_files(sessions_dir)`는 `~/.claude/projects/**/*.jsonl`을 재귀적으로 전부 스캔한다 — 메인 세션 파일뿐 아니라 `subagents/` 서브폴더도 포함한다(사용자 확인 완료: 서브에이전트 비용도 실제 과금이라 빼면 숫자가 실제보다 작게 나옴). `memory/`처럼 `.jsonl`이 아닌 파일은 글롭 패턴 자체에서 자연히 제외된다.
- **측정된 규모**: 이 머신 기준 `~/.claude/projects/`는 총 283개 `.jsonl` 파일, 약 145.7MB(메인 세션 75개·136.7MB + 서브에이전트 208개·8.9MB) — Codex의 942개 파일·998MB보다 훨씬 작다. 첫 콜드 스캔이 Codex의 19초 같은 문제를 일으킬 가능성은 낮지만, 그렇다고 파일별 캐싱을 생략할 이유는 아니다(로그는 계속 쌓이고, "그날 활성 파일만 바뀌는" 접근 패턴 자체는 Codex와 동일하므로 캐싱 없이는 결국 같은 문제가 재발한다).
- **파일별 캐싱 그대로 재사용**: Codex용으로 만든 `FileCache`(mtime+size 키) 패턴을 Claude `aggregate_usage`에도 그대로 쓴다. Claude도 "그날 활성 파일 하나만 계속 바뀌고 나머지는 그대로"인 동일한 접근 패턴이라 이 최적화가 똑같이 필요하다.
- **백그라운드 pre-warm 그대로 재사용**: 서버 기동 시 `threading.Thread(target=current_usage_aggregate, daemon=True).start()` 패턴을 Claude 집계용으로 하나 더 띄운다.
- **통합 페이지 레이아웃**: `render_dashboard_content`에 `<h2>Claude 사용량</h2>` + Claude용 `render_report_body` 블록을 Codex 토큰 섹션 아래에 추가한다. `/fragment` 응답에도 두 섹션을 모두 포함해서, 비동기 갱신 한 번에 둘 다 같이 바뀌게 한다.
- **데이터 없음/에러 격리**: `~/.claude/projects`가 없으면(이 컴퓨터에 Claude Code가 없는 경우) Claude 섹션은 기존 `.empty` 스타일("집계할 usage/token 이벤트가 없습니다")을 재사용한 빈 상태로 표시하고 예외를 던지지 않는다. Claude 집계 실패가 Codex 섹션 렌더링을 막지 않도록, 공용 헬퍼 안쪽이 아니라 섹션 조합 레벨에서 try/except로 격리한다.
- **보안 원칙 동일 적용**: `claude_usage_report.py`는 `projects/` 아래 `.jsonl` 파일만 연다. `.credentials.json`, `.claude.json`, `projects/` 바깥 파일은 절대 열지 않는다(README에 이미 있는 Codex 쪽 "인증 토큰/비공개 API 미사용" 원칙과 동일).
- **Phase 0 스파이크 — 완료, go**: `claude.exe` 바이너리를 직접 조사해서 확인함(추측 아님). 근거:
  - `claude --help`의 Commands 목록에는 잔여율 관련 서브커맨드가 없다(agents/auth/auto-mode/doctor/gateway/install/mcp/plugin/project/setup-token/ultrareview/update뿐). 즉 CLI 플래그로 바로 뽑아낼 방법은 없다.
  - 대신 바이너리에 `statusLine` 기능의 공식 예시 스크립트가 그대로 내장돼 있다: `~/.claude/settings.json`에 `{"statusLine": {"type": "command", "command": "<쉘 명령>"}}`를 등록하면, Claude Code가 상태줄을 다시 그릴 때마다 그 명령을 실행하면서 **표준입력으로** JSON을 넘겨준다. 내장 예시가 그대로 이 JSON을 쓰는 법을 보여준다: `jq -r '.rate_limits.five_hour.used_percentage'`, `jq -r '.rate_limits.seven_day.used_percentage'`.
  - 이 머신의 `rate_limits` 스키마를 바이너리에서 전수 조사한 결과 `five_hour`, `seven_day` 두 항목만 있다(`device_authorization`/`device_verify`는 인증 관련이라 무관). monthly에 해당하는 필드는 없음 — Codex의 3개 링(5-hour/weekly/monthly)과 다르게 Claude 섹션은 **2개 링(5-hour/7-day)**만 만든다.
  - 이 방식은 Codex의 headless-poller 방식보다 근본적으로 더 안전하다: 별도 세션을 안 띄우고, PTY도 안 쓰고, 화면 텍스트를 정규식으로 파싱하지도 않는다. Claude Code가 이미 구조화한 JSON을 그냥 받아 쓰기만 하면 된다.
- **Phase 2 구현(더 이상 조건부 아님, 설계 확정)**: `claude-status-hook.<js|py>`라는 작은 statusLine 커맨드 스크립트를 새로 만든다. 하는 일은 두 가지뿐이다 — (1) stdin으로 들어온 JSON을 파싱해서 `rate_limits.five_hour.used_percentage` / `rate_limits.seven_day.used_percentage`(및 있으면 reset 관련 필드)를 Codex의 `status.json`과 같은 스키마(`schema_version`, `captured_at`, `limits: [{type, remaining_percent, reset_text}]`)로 변환해 저장(`writeStatus`/`status-capture.js` 재사용, `capture_method: "claude_statusline_hook"`), (2) 상태줄에 실제로 표시할 한 줄 텍스트를 stdout으로 인쇄(사용자가 평소 보던 상태줄이 갑자기 비거나 깨지면 안 되므로). Codex처럼 별도 백그라운드 프로세스나 PID 파일 관리, 재시도/백오프 로직이 통째로 필요 없다 — Claude Code 자신이 이미 주기적으로(상태줄 리렌더링마다) 이 스크립트를 실행해준다.
- **기존 `statusLine` 설정과의 충돌 방지**: 이건 가상의 우려가 아니다 — 이 계정에는 이미 `caveman` 플러그인이 `~/.claude/hooks/caveman-statusline.sh`와 `install.ps1`/`uninstall.ps1`을 통해 `statusLine`을 관리하는 코드가 깔려 있다(현재 `~/.claude/settings.json`에는 `statusLine` 키가 비어있는 걸로 봐서 지금은 비활성 상태지만, 사용자가 caveman 모드를 켜면 그 시점에 등록될 수 있는 구조다). 즉 `statusLine`은 여러 도구가 경쟁할 수 있는 공유 자원이다. 설치 스크립트는 기존 `statusLine.command`가 있으면 무조건 덮어쓰지 않고, 새 훅이 원래 명령을 그대로 호출한 뒤 그 출력에 잔여율 텍스트를 이어붙여 반환하도록 체이닝한다. 체이닝이 여의치 않으면(예: 원래 명령 포맷을 예측할 수 없음) 기존 설정을 건드리지 않고 사용자에게 수동 설정 방법만 안내한다.
- **자동 실행 추가 등록 없음**: 기존 `codex_status_dashboard_start.ps1` + Windows 시작프로그램 바로가기가 계속 통합 서버 하나만 실행한다. `statusLine` 훅은 대시보드 서버와 무관하게 Claude Code 자신이 호출하므로, 이 스크립트 쪽에도 손댈 게 없다.
- **CLI 옵션 추가**: `codex_status_dashboard.py --serve`에 `--claude-sessions-dir`(기본값 `~/.claude/projects`)와 `--claude-status-path`(statusLine 훅이 쓰는 파일 경로, 기본값 `~/.codex-usage-wrapper/claude-status.json`)를 기존 `--sessions-dir`/`--status-path`와 나란히 추가한다.

## Testing Decisions

- 좋은 테스트는 내부 호출 순서가 아니라 외부에서 관찰 가능한 결과(HTML 출력, 저장된 JSON, HTTP 응답)를 검증한다 — 이 프로젝트의 `tests/run-tests.js`가 이미 그렇게 하고 있다(예: `testDuplicateLimitsKeepFirstGeneralLimit`은 파싱된 JSON 결과를 검증하지 내부 함수 호출을 검증하지 않는다).
- `claude_usage_report.compute_file_usage` / `aggregate_usage`: 손으로 만든 작은 fixture `.jsonl`로 검증한다. 커버할 케이스:
  - **가장 중요**: 같은 `message.id`를 가진 여러 줄(thinking/text/tool_use, 동일한 usage 반복)이 있는 fixture를 만들어서, 결과가 "줄 개수만큼 곱해진 값"이 아니라 "고유 message.id 개수만큼만" 집계됐는지 정확한 숫자로 assert한다. 이 테스트가 없으면 실데이터로 확인한 2.2~2.7배 과다 집계 버그가 그대로 재발해도 아무 테스트도 안 잡는다.
  - 정상 assistant 턴 레코드, `usage`가 없는 레코드
  - `cache_creation_input_tokens`만 있고 `cache_read_input_tokens`는 없는 레코드
  - 모델이 중간에 바뀌는 파일, `<synthetic>` 같은 특수 모델 문자열이 필터링되지 않고 그대로 나오는지
  - `subagents/` 서브폴더 파일도 메인 세션 파일과 합산되는지
- 통합 대시보드 HTML: 기존 `testMergedDashboardShowsUsageAndStatus`를 확장하거나 옆에 새 테스트를 추가해서, Claude 세션 fixture 디렉터리를 넣고 렌더링된 페이지에 Claude 섹션의 통계/테이블 내용이 들어있는지 확인한다(Codex 섹션 검증 방식과 동일).
- Claude 데이터 없음 내성: `--claude-sessions-dir`를 존재하지 않는 경로로 줬을 때도 대시보드가 200을 반환하고 Codex 섹션은 정상, Claude 섹션은 빈 상태 문구가 뜨는지 확인하는 테스트. 위 "데이터 없음/에러 격리" 결정이 실제로 지켜지는지 증명한다.
- `claude-status-hook`(statusLine 커맨드 스크립트): PTY도 없고 백그라운드 프로세스도 아니라서 Codex의 `testHeadlessStatusPoller` 같은 pty/mock-CLI 기반 테스트가 필요 없다. 대신 표준입력에 손으로 만든 `rate_limits` JSON을 흘려보내고(`echo '{"rate_limits":{"five_hour":{"used_percentage":29},"seven_day":{"used_percentage":66}}}' | node claude-status-hook.js`), 저장된 상태 파일의 `remaining_percent`가 `100 - used_percentage`로 정확히 뒤집혔는지, stdout에 상태줄용 텍스트가 그래도 나오는지 확인한다. `rate_limits` 필드가 아예 없는 입력(빈 객체, 깨진 JSON)에도 죽지 않고 이전 값을 유지하거나 "N/A" 상태로 남는지도 확인한다.
- 기존 `statusLine` 체이닝 로직: 기존 명령이 있는 fixture 설정으로 설치 스크립트를 돌려서, 원래 명령의 출력이 사라지지 않고 체이닝된 출력에 포함되는지 확인한다.
- 테스트 범위 제외: 링 UI의 픽셀 단위 검증(이미 있는 Codex 링 컴포넌트를 재사용할 뿐 새 UI 컴포넌트가 아니므로 추가 검증 불필요), Claude Code 자체가 `statusLine` 명령을 실제로 얼마나 자주/정확히 호출하는지에 대한 검증(이건 Claude Code 내부 동작이라 이 프로젝트의 테스트 범위 밖).

## Out of Scope

- `~/.claude/stats-cache.json` 사용(직접 JSONL 스캔 방식으로 확정됨) — 나중에 "그냥 캐시 파일 읽으면 되지 않냐"는 제안이 다시 나올 걸 대비해 명시적으로 제외.
- Claude 사용량의 USD 비용 표시(`stats-cache.json`에는 `costUSD`가 있지만, 직접 스캔 방식에서는 가격 계산을 하지 않는다. 비용 추정은 별도 PRD로 분리).
- Claude 섹션을 넣는 데 필요한 것 이상으로 Codex 대시보드 자체를 다시 디자인하는 것(Codex 링/테이블 자체는 그대로).
- 여러 컴퓨터/여러 사용자 집계(이 도구는 계속 로컬 단일 사용자·단일 머신·localhost 전용으로 남는다).
- `claude-status-hook` 자체는 stdin JSON을 읽어 파일로 저장하는 게 전부라 플랫폼 종속적이지 않지만, 이 프로젝트 전체(대시보드 서버 자동 실행, Codex 쪽 node-pty 캡처)가 이미 Windows 전용으로 범위가 잡혀 있으므로 macOS/Linux에서의 설치·검증은 이번 범위에 포함하지 않는다.
- 이 기능이 배포되기 전의 Claude 사용 이력 백필/가져오기 — Codex와 동일하게, 읽는 시점에 디스크에 있는 `.jsonl` 파일만 반영한다.

## Further Notes

- 이 PRD의 핵심 구현 결정(특히 message.id 중복 집계 버그, 모델 필드 신뢰도, 서브에이전트 파일 구조, 실측 디렉터리 크기)은 추측이 아니라 이 머신의 실제 `~/.claude/projects/` 데이터를 직접 조사해서 검증한 결과다. 구현 시작 전 설계 검토 단계에서 잡아낸 것이라, 코드를 짜고 나서 뒤늦게 발견했다면 조용히 2배 넘게 부풀려진 숫자가 배포됐을 것이다.
- 이 저장소는 git이 초기화돼 있지 않고 원격 저장소도 없어서 연결된 이슈 트래커가 없다. 그래서 이 PRD는 외부 트래커에 발행하는 대신 저장소 안에 마크다운 파일로 저장했다. 나중에 트래커가 생기면 이 파일을 그대로 첫 티켓으로 옮기면 된다.
- Phase 0 스파이크는 이 문서 안에서 완료·기록됐다(위 Solution, Implementation Decisions 참고) — 별도 후속 문서가 필요 없다. `statusLine` 기반 설계는 애초에 예상했던 "PTY로 화면 긁기"보다 훨씬 단순하고 견고해서, Phase 2가 더 이상 "조건부 스트레치 목표"가 아니라 Phase 1(토큰 집계)과 비슷한 확정 작업이 됐다.
- `dashboard_common.py` 분리 작업은 엄밀히는 이미 배포된 Codex 코드의 리팩터링이지 새 Claude 기능이 아니다. 이 PRD가 Claude에 관한 것이긴 하지만 Codex 경로도 건드리는 작업이라는 점을 구현 리뷰 때 짚고 넘어가야 한다.
- `claude.exe`는 246MB짜리 컴파일된 바이너리라 문자열 grep으로 조사한 내용(슬래시 커맨드 목록, `rate_limits` 스키마, statusLine 예시 스크립트)은 번들된 소스 문자열을 읽은 것이지 공식 문서가 아니다. 다음 Claude Code 업데이트에서 JSON 스키마나 필드명이 바뀔 수 있으니, `claude-status-hook`은 필드가 없거나 이름이 바뀐 경우에도 조용히 "N/A"로 떨어지도록 방어적으로 짜야 한다(이미 Implementation/Testing Decisions에 반영됨).
- **미검증 잔여 리스크 1건**: `message.id` dedup은 지금 설계상 "파일 하나 안에서만" 이뤄진다. Codex 쪽에서도 이미 알려진 문제인데(README에는 안 적었지만 리뷰 중 언급됨), 세션을 나중에 재개(resume)하거나 압축(compact)하면 같은 대화가 여러 세션 파일에 걸쳐 나타날 가능성이 있다 — 그런 경우 파일 간 중복까지는 이번 dedup으로 못 잡는다. 실데이터에서 이 패턴을 직접 확인하지는 못했고, Codex 쪽에서도 별도로 조사하지 않은 채 감수한 리스크라 이번에도 같은 수준으로 감수하고 넘어간다. 나중에 숫자가 이상하게 크다는 신고가 오면 제일 먼저 의심해볼 지점으로 남겨둔다.
