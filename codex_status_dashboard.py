"""Codex CLI /status 캡처 결과와 토큰 사용량 리포트를 하나의 로컬 대시보드로 표시한다."""

from __future__ import annotations

import argparse
import html
import http.server
import json
import os
import re
import subprocess
import sys
import threading
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import codex_usage_report as usage_report


SCHEMA_VERSION = 1
DEFAULT_REFRESH_SECONDS = 3
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8767
DEFAULT_STATUS_PATH = Path.home() / ".codex-usage-wrapper" / "status.json"
DEFAULT_HISTORY_DIR = Path.home() / ".codex-usage-wrapper" / "history"
DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000
DEFAULT_CODEX_COMMAND = "codex.exe" if sys.platform == "win32" else "codex"
DEFAULT_NODE_COMMAND = "node"
POLLER_SCRIPT_PATH = Path(__file__).resolve().parent / "codex-status-poller.js"
KST = ZoneInfo("Asia/Seoul")

LIMIT_ALIASES = {
    "five_hour": ("5-hour", "5 hour", "five-hour", "five hour", "5h"),
    "weekly": ("weekly", "week"),
    "monthly": ("monthly", "month"),
}


@dataclass(frozen=True)
class UsageLimit:
    """Codex 플랜 제한 하나의 파싱 결과를 담는다.

    Args:
        type: 제한 종류. 예: `five_hour`, `weekly`, `monthly`.
        remaining_percent: 잔여율. 파싱하지 못하면 None.
        reset_text: reset 안내 문구. 파싱하지 못하면 None.
    """

    type: str
    remaining_percent: int | None
    reset_text: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """JSON 저장용 딕셔너리로 변환한다.

        Returns:
            제한 정보를 담은 딕셔너리.
        """

        return {
            "type": self.type,
            "remaining_percent": self.remaining_percent,
            "reset_text": self.reset_text,
        }


def now_kst() -> datetime:
    """현재 KST 시각을 반환한다.

    Returns:
        Asia/Seoul 타임존이 붙은 현재 시각.
    """

    return datetime.now(tz=KST)


def default_status_path() -> Path:
    """기본 status.json 경로를 반환한다.

    Returns:
        사용자 홈 아래 `.codex-usage-wrapper/status.json` 경로.
    """

    return DEFAULT_STATUS_PATH


def normalize_limit_name(text: str) -> str | None:
    """텍스트에서 제한 종류를 식별한다.

    Args:
        text: `/status` 출력의 한 줄 또는 주변 텍스트.

    Returns:
        제한 종류 문자열. 찾지 못하면 None.
    """

    lowered = text.lower()
    for limit_type, aliases in LIMIT_ALIASES.items():
        if any(alias in lowered for alias in aliases):
            return limit_type
    return None


def extract_remaining_percent(text: str) -> int | None:
    """텍스트에서 잔여율 퍼센트를 추출한다.

    Args:
        text: `/status` 출력 일부.

    Returns:
        0부터 100 사이의 퍼센트 값. 찾지 못하면 None.
    """

    # remaining 주변의 퍼센트를 우선 사용해 consumed 값과 혼동을 줄인다.
    remaining_match = re.search(
        r"remaining[^0-9]{0,30}(\d{1,3})\s*%|(\d{1,3})\s*%[^A-Za-z0-9]{0,30}remaining",
        text,
        flags=re.IGNORECASE,
    )
    if remaining_match:
        raw_value = remaining_match.group(1) or remaining_match.group(2)
        return clamp_percent(raw_value)

    percent_match = re.search(r"(\d{1,3})\s*%", text)
    if percent_match:
        return clamp_percent(percent_match.group(1))
    return None


def clamp_percent(value: str) -> int | None:
    """퍼센트 문자열을 0부터 100 사이 정수로 제한한다.

    Args:
        value: 숫자 문자열.

    Returns:
        범위 안으로 보정한 정수. 숫자가 아니면 None.
    """

    if not value.isdecimal():
        return None
    return max(0, min(100, int(value)))


def extract_reset_text(text: str) -> str | None:
    """텍스트에서 reset 관련 문구를 추출한다.

    Args:
        text: `/status` 출력 일부.

    Returns:
        reset 문구. 찾지 못하면 None.
    """

    reset_match = re.search(
        r"(resets?\s+(?:in\s+)?[^,\n\r)]+|reset\s+(?:in\s+)?[^,\n\r)]+)",
        text,
        re.IGNORECASE,
    )
    if reset_match:
        return reset_match.group(1).strip()
    return None


def parse_status_text(raw_status_text: str) -> dict[str, Any]:
    """Codex CLI `/status` raw 출력에서 사용량 상태를 파싱한다.

    Args:
        raw_status_text: Codex CLI가 출력한 `/status` 원문.

    Returns:
        status.json으로 저장할 스키마 딕셔너리.
    """

    captured_at = now_kst().isoformat(timespec="seconds")
    limits_by_type: dict[str, UsageLimit] = {}
    lines = [line.strip() for line in raw_status_text.splitlines() if line.strip()]

    for index, line in enumerate(lines):
        limit_type = normalize_limit_name(line)
        if limit_type is None:
            continue
        if limit_type in limits_by_type:
            continue

        # reset 문구가 다음 줄에 분리되는 경우를 위해 주변 한 줄까지 같이 본다.
        context = line
        if index + 1 < len(lines):
            context = f"{context} {lines[index + 1]}"

        percent = extract_remaining_percent(context)
        reset_text = extract_reset_text(context)
        limits_by_type[limit_type] = UsageLimit(limit_type, percent, reset_text)

    parse_status = (
        "ok"
        if any(limit.remaining_percent is not None for limit in limits_by_type.values())
        else "failed"
    )
    return {
        "schema_version": SCHEMA_VERSION,
        "captured_at": captured_at,
        "source": "codex_cli_status",
        "parse_status": parse_status,
        "limits": [limit.to_dict() for limit in limits_by_type.values()],
        "raw_status_text": raw_status_text,
    }


def write_status(status: dict[str, Any], status_path: Path, history_dir: Path | None = None) -> None:
    """status.json과 선택적 history JSONL을 저장한다.

    Args:
        status: 저장할 상태 딕셔너리.
        status_path: 최신 상태를 저장할 JSON 파일 경로.
        history_dir: 히스토리 JSONL 저장 디렉터리. None이면 저장하지 않는다.

    Returns:
        None.
    """

    status_path.parent.mkdir(parents=True, exist_ok=True)
    status_path.write_text(
        json.dumps(status, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    if history_dir is None:
        return

    history_dir.mkdir(parents=True, exist_ok=True)
    captured_at = str(status.get("captured_at", now_kst().date().isoformat()))
    history_path = history_dir / f"{captured_at[:10]}.jsonl"
    with history_path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(status, ensure_ascii=False) + "\n")


def read_status(status_path: Path) -> dict[str, Any] | None:
    """status.json을 읽는다.

    Args:
        status_path: 읽을 JSON 파일 경로.

    Returns:
        파싱한 상태 딕셔너리. 파일이 없거나 깨졌으면 None.
    """

    if not status_path.exists():
        return None
    try:
        data = json.loads(status_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def limit_map(status: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    """status 딕셔너리의 limits 배열을 type 기준 맵으로 바꾼다.

    Args:
        status: status.json에서 읽은 상태 딕셔너리.

    Returns:
        제한 종류를 키로 하는 딕셔너리.
    """

    if status is None:
        return {}
    limits = status.get("limits")
    if not isinstance(limits, list):
        return {}
    result: dict[str, dict[str, Any]] = {}
    for limit in limits:
        if not isinstance(limit, dict):
            continue
        limit_type = limit.get("type")
        if isinstance(limit_type, str):
            result[limit_type] = limit
    return result


def display_reset(limit: dict[str, Any] | None) -> str:
    """reset 표시 문자열을 만든다.

    Args:
        limit: 제한 정보 딕셔너리.

    Returns:
        reset 문구 또는 `N/A`.
    """

    if not limit:
        return "N/A"
    reset_text = limit.get("reset_text")
    if isinstance(reset_text, str) and reset_text:
        return reset_text
    return "N/A"


RING_LABELS = (
    ("five_hour", "5-hour"),
    ("weekly", "Weekly"),
    ("monthly", "Monthly"),
)

DASHBOARD_STYLE = """
    main {
      max-width: 1100px;
      margin: 0 auto;
      padding: 32px 20px 44px;
    }
    h1 {
      margin: 0 0 4px;
      font-size: 22px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    h1::before {
      content: "";
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 10px 1px var(--accent);
      flex: none;
    }
    h2 {
      margin: 32px 0 12px;
      font-size: 15px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: .06em;
    }
    .rings {
      display: flex;
      flex-wrap: wrap;
      gap: 28px;
      margin: 20px 0 28px;
    }
    .ring-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      width: 128px;
    }
    .ring {
      --track: var(--surface-2);
      --ring-color: #3a4150;
      width: 108px;
      height: 108px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      position: relative;
      background: conic-gradient(var(--ring-color) calc(var(--pct) * 1%), var(--track) 0);
    }
    .ring::before {
      content: "";
      position: absolute;
      inset: 10px;
      border-radius: 50%;
      background: var(--surface);
    }
    .ring-value {
      position: relative;
      font-family: var(--mono);
      font-size: 21px;
      font-weight: 600;
    }
    .ring-ok { --ring-color: var(--ok); }
    .ring-warn { --ring-color: var(--warn); }
    .ring-critical { --ring-color: var(--critical); }
    .ring-label {
      font-size: 13px;
      font-weight: 600;
      letter-spacing: .02em;
    }
    .ring-reset {
      font-size: 12px;
      color: var(--muted);
      font-family: var(--mono);
      text-align: center;
    }
    .hint {
      margin-bottom: 24px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }
    .hint .label {
      color: var(--muted);
      font-size: 13px;
    }
    .hint p {
      margin: 10px 0 0;
      color: var(--muted);
      line-height: 1.5;
    }
    .hint pre {
      overflow: auto;
      padding: 10px 14px;
      background: var(--surface-2);
      border-radius: 6px;
      font-size: 13px;
    }
    footer.status-footer {
      margin-top: 36px;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
    }
    .poll-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--ok);
      flex: none;
    }
    .poll-dot.off {
      background: #454c5a;
    }
"""


def render_limit_ring(label: str, limit: dict[str, Any] | None) -> str:
    """플랜 잔여율 하나를 도넛형 링 카드로 렌더링한다.

    Args:
        label: 화면에 표시할 제한 이름(예: `5-hour`).
        limit: 제한 정보 딕셔너리. 값이 없으면 미확인 상태로 그린다.

    Returns:
        `<div class="ring-card">` HTML 조각.
    """

    percent = limit.get("remaining_percent") if limit else None
    if isinstance(percent, int):
        if percent <= 20:
            tone = "critical"
        elif percent <= 50:
            tone = "warn"
        else:
            tone = "ok"
        value_text = f"{percent}%"
        pct_for_style = percent
    else:
        tone = ""
        value_text = "–"
        pct_for_style = 0

    reset_text = display_reset(limit)
    return f"""
    <div class="ring-card">
      <div class="ring ring-{tone}" style="--pct:{pct_for_style}">
        <span class="ring-value">{html.escape(value_text)}</span>
      </div>
      <div class="ring-label">{html.escape(label)}</div>
      <div class="ring-reset">{html.escape(reset_text)}</div>
    </div>
"""


def render_dashboard_content(
    status: dict[str, Any] | None,
    status_path: Path,
    usage_aggregate: dict[tuple[str, str], usage_report.UsageTotals],
    sessions_dir: Path,
    auto_status_poll: bool,
) -> str:
    """플랜 잔여율 링 + 토큰 사용량 리포트, 대시보드의 갱신 대상 영역만 렌더링한다.

    전체 페이지 최초 렌더링과 `/fragment` 비동기 갱신 양쪽에서 재사용한다.

    Args:
        status: status.json에서 읽은 상태 딕셔너리.
        status_path: 읽은 status.json 경로.
        usage_aggregate: 토큰 사용량 `(date, model)` 집계 딕셔너리.
        sessions_dir: 토큰 사용량을 집계한 세션 디렉터리.
        auto_status_poll: 백그라운드 status poller 자동 실행 여부.

    Returns:
        HTML 조각 문자열.
    """

    limits = limit_map(status)
    captured_at = status.get("captured_at") if status else None
    last_updated = captured_at if isinstance(captured_at, str) else "아직 없음"
    poller = status.get("poller") if status else None
    poller_state = poller.get("state") if isinstance(poller, dict) else None
    poller_heartbeat = poller.get("heartbeat_at") if isinstance(poller, dict) else None
    poller_detail = poller.get("detail") if isinstance(poller, dict) else None
    poller_parts = []
    if isinstance(poller_state, str) and poller_state:
        poller_parts.append(poller_state)
    if isinstance(poller_heartbeat, str) and poller_heartbeat:
        poller_parts.append(poller_heartbeat)
    if isinstance(poller_detail, str) and poller_detail:
        poller_parts.append(poller_detail)
    poller_status_text = " · ".join(poller_parts) if poller_parts else "heartbeat 없음"

    setup_hint = (
        ""
        if status or auto_status_poll
        else f"""
    <section class="hint">
      <div class="label">status.json이 아직 없습니다</div>
      <p>Codex CLI에서 <code>/status</code>를 실행한 뒤 출력 내용을 복사하고, 별도 PowerShell에서 아래 명령을 실행하세요.</p>
      <pre>Get-Clipboard | python codex_status_dashboard.py --raw-stdin</pre>
      <p>저장 경로: <code>{html.escape(str(status_path))}</code></p>
    </section>
"""
    )

    rings = "".join(render_limit_ring(label, limits.get(key)) for key, label in RING_LABELS)

    poll_dot_class = "poll-dot" if auto_status_poll else "poll-dot off"
    poll_text = "자동 폴링 켜짐" if auto_status_poll else "자동 폴링 꺼짐"

    return f"""
    {setup_hint}
    <section class="rings">
      {rings}
    </section>
    <h2>토큰 사용량</h2>
    {usage_report.render_report_body(usage_aggregate, sessions_dir)}
    <footer class="status-footer">
      <span class="{poll_dot_class}"></span>
      <span>마지막 성공 캡처: {html.escape(last_updated)} · {poll_text}</span>
      <span>Poller: {html.escape(poller_status_text)}</span>
    </footer>
"""


def render_dashboard_page(
    status: dict[str, Any] | None,
    status_path: Path,
    refresh_seconds: int,
    usage_aggregate: dict[tuple[str, str], usage_report.UsageTotals],
    sessions_dir: Path,
    auto_status_poll: bool,
) -> str:
    """플랜 잔여율과 토큰 사용량 리포트를 하나로 합친 전체 대시보드 페이지를 렌더링한다.

    Args:
        status: status.json에서 읽은 상태 딕셔너리.
        status_path: 읽은 status.json 경로.
        refresh_seconds: 백그라운드 비동기 갱신 주기(초).
        usage_aggregate: 토큰 사용량 `(date, model)` 집계 딕셔너리.
        sessions_dir: 토큰 사용량을 집계한 세션 디렉터리.
        auto_status_poll: 백그라운드 status poller 자동 실행 여부.

    Returns:
        HTML 문서 문자열.
    """

    content = render_dashboard_content(status, status_path, usage_aggregate, sessions_dir, auto_status_poll)
    refresh_script = usage_report.render_live_refresh_script("dashboard-content", "/fragment", refresh_seconds)

    return f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Usage Dashboard</title>
  <style>
{usage_report.BASE_STYLE}
{DASHBOARD_STYLE}
{usage_report.REPORT_STYLE}  </style>
</head>
<body>
  <main>
    <h1>Codex Usage Dashboard</h1>
    <div id="dashboard-content">{content}</div>
  </main>
  {usage_report.render_tooltip_script()}
  {refresh_script}
</body>
</html>
"""


def is_pid_running(pid: int) -> bool:
    """주어진 PID의 프로세스가 살아 있는지 확인한다.

    Args:
        pid: 확인할 프로세스 ID.

    Returns:
        살아 있으면 True.
    """

    if sys.platform == "win32":
        try:
            result = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}"],
                capture_output=True,
                text=True,
                check=False,
            )
        except OSError:
            return False
        return str(pid) in result.stdout

    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def parse_status_datetime(value: Any) -> datetime | None:
    """status.json 안의 ISO 시각 문자열을 datetime으로 변환한다.

    Args:
        value: `captured_at` 또는 poller `heartbeat_at` 값.

    Returns:
        파싱된 datetime. 문자열이 아니거나 파싱할 수 없으면 None.
    """

    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=KST)
    return parsed


def is_poller_status_fresh(status_path: Path, poll_interval_ms: int) -> bool:
    """status.json 기준으로 poller heartbeat가 최근인지 확인한다.

    Args:
        status_path: poller가 갱신하는 status.json 경로.
        poll_interval_ms: 정상 poll 주기(ms).

    Returns:
        heartbeat 또는 마지막 캡처가 허용 시간 안이면 True.
    """

    status = read_status(status_path)
    if not status:
        return False

    poller = status.get("poller")
    heartbeat_at = poller.get("heartbeat_at") if isinstance(poller, dict) else None
    timestamp = parse_status_datetime(heartbeat_at) or parse_status_datetime(status.get("captured_at"))
    if timestamp is None:
        return False

    max_age_seconds = max((poll_interval_ms / 1000) * 2 + 60, 10 * 60)
    return (now_kst() - timestamp.astimezone(KST)).total_seconds() <= max_age_seconds


def start_status_poller(
    status_path: Path,
    history_dir: Path,
    poll_interval_ms: int,
    codex_command: str,
    node_command: str,
) -> subprocess.Popen | None:
    """플랜 잔여율을 자동으로 캡처하는 헤드리스 poller를 백그라운드로 띄운다.

    이미 같은 status.json을 갱신 중인 poller가 살아 있으면 새로 띄우지 않는다.

    Args:
        status_path: poller가 갱신할 status.json 경로.
        history_dir: poller가 기록할 history JSONL 디렉터리.
        poll_interval_ms: /status 캡처 주기(ms).
        codex_command: 실행할 Codex CLI 실행 파일.
        node_command: poller를 실행할 node 실행 파일.

    Returns:
        새로 띄운 poller의 Popen 객체. 이미 떠 있거나 실행에 실패하면 None.
    """

    if not POLLER_SCRIPT_PATH.exists():
        print(f"[dashboard] status poller script not found: {POLLER_SCRIPT_PATH}")
        return None

    pid_path = status_path.parent / "poller.pid"
    existing_pid = read_poller_pid(pid_path)
    if existing_pid is not None and is_pid_running(existing_pid):
        if is_poller_status_fresh(status_path, poll_interval_ms):
            print(f"[dashboard] status poller already running (pid {existing_pid}), skipping auto-start")
            return None
        print(f"[dashboard] status poller pid {existing_pid} is running but heartbeat is stale; starting a new poller")

    try:
        process = subprocess.Popen(
            [
                node_command,
                str(POLLER_SCRIPT_PATH),
                "--status-path",
                str(status_path),
                "--history-dir",
                str(history_dir),
                "--poll-interval-ms",
                str(poll_interval_ms),
                "--codex-command",
                codex_command,
            ],
            cwd=str(POLLER_SCRIPT_PATH.parent),
        )
    except OSError as error:
        print(f"[dashboard] failed to start status poller: {error}")
        return None

    pid_path.parent.mkdir(parents=True, exist_ok=True)
    pid_path.write_text(str(process.pid), encoding="utf-8")
    print(f"[dashboard] started background status poller (pid {process.pid})")
    return process


def read_poller_pid(pid_path: Path) -> int | None:
    """poller.pid 파일에서 PID를 읽는다.

    Args:
        pid_path: poller.pid 파일 경로.

    Returns:
        저장된 PID. 없거나 읽을 수 없으면 None.
    """

    if not pid_path.exists():
        return None
    try:
        return int(pid_path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None


def stop_status_poller(process: subprocess.Popen | None, status_path: Path) -> None:
    """이 서버가 띄운 poller를 종료한다.

    Args:
        process: `start_status_poller`가 반환한 Popen 객체. None이면 아무 것도 하지 않는다.
        status_path: poller.pid 파일 위치를 찾기 위한 status.json 경로.

    Returns:
        None.
    """

    if process is None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()

    pid_path = status_path.parent / "poller.pid"
    if read_poller_pid(pid_path) == process.pid:
        pid_path.unlink(missing_ok=True)


def run_dashboard_server(
    status_path: Path,
    host: str,
    port: int,
    refresh_seconds: int,
    sessions_dir: Path,
    history_dir: Path,
    auto_status_poll: bool,
    poll_interval_ms: int,
    codex_command: str,
    node_command: str,
) -> None:
    """status.json과 세션 토큰 사용량을 함께 보여주는 로컬 대시보드 서버를 실행한다.

    Args:
        status_path: 주기적으로 읽을 status.json 경로.
        host: 바인딩할 호스트.
        port: 바인딩할 포트.
        refresh_seconds: 브라우저 자동 새로고침 주기.
        sessions_dir: 토큰 사용량을 집계할 Codex 세션 디렉터리.
        history_dir: status poller가 캡처 기록을 남길 history JSONL 디렉터리.
        auto_status_poll: 백그라운드 status poller 자동 실행 여부.
        poll_interval_ms: status poller의 /status 캡처 주기(ms).
        codex_command: status poller가 실행할 Codex CLI 실행 파일.
        node_command: status poller를 실행할 node 실행 파일.

    Returns:
        None.
    """

    # 파일별 (mtime, 크기)가 이전과 같으면 다시 파싱하지 않는다. 실사용 중에는
    # 그날 활성 세션 파일 하나만 계속 바뀌므로, 요청마다 수백 개 파일을 전부
    # 다시 읽는 대신 바뀐 파일만 다시 읽는다.
    usage_file_cache: usage_report.FileCache = {}

    def current_usage_aggregate() -> dict[tuple[str, str], usage_report.UsageTotals]:
        return usage_report.aggregate_usage(sessions_dir, usage_file_cache)

    class DashboardHandler(http.server.BaseHTTPRequestHandler):
        """status.json + 토큰 사용량 기반 대시보드 요청 핸들러."""

        def do_GET(self) -> None:
            """대시보드 HTML, 조각 HTML(/fragment), 원본 status JSON 중 하나를 응답한다."""

            if self.path == "/status.json":
                status = read_status(status_path) or {}
                body = json.dumps(status, ensure_ascii=False, indent=2).encode("utf-8")
                usage_report.send_body(self, body, "application/json; charset=utf-8")
                return

            if self.path == "/fragment":
                status = read_status(status_path)
                body = render_dashboard_content(
                    status,
                    status_path,
                    current_usage_aggregate(),
                    sessions_dir,
                    auto_status_poll,
                ).encode("utf-8")
                usage_report.send_body(self, body, "text/html; charset=utf-8")
                return

            if self.path not in ("/", "/index.html"):
                self.send_error(404)
                return

            status = read_status(status_path)
            body = render_dashboard_page(
                status,
                status_path,
                refresh_seconds,
                current_usage_aggregate(),
                sessions_dir,
                auto_status_poll,
            ).encode("utf-8")
            usage_report.send_body(self, body, "text/html; charset=utf-8")

        def log_message(self, format: str, *args: Any) -> None:
            """대시보드 요청 로그를 한 줄로 출력한다.

            /fragment, /status.json은 열어둔 탭마다 몇 초 간격으로 반복 호출되므로,
            로그온 시 자동 실행되어 며칠씩 떠 있을 로그 파일이 그 노이즈로만
            채워지지 않도록 건너뛴다.
            """

            if self.path in ("/fragment", "/status.json"):
                return
            print(f"{self.address_string()} - {format % args}")

    poller_process = (
        start_status_poller(status_path, history_dir, poll_interval_ms, codex_command, node_command)
        if auto_status_poll
        else None
    )

    try:
        # 페이지가 열려 있는 동안 연결 하나가 keep-alive로 유지되면서, 백그라운드
        # /fragment 폴링용 새 연결을 못 받는 문제가 있어 단일 스레드 서버 대신 사용한다.
        with http.server.ThreadingHTTPServer((host, port), DashboardHandler) as server:
            print(f"serving status dashboard at http://{host}:{port}")
            print(f"reading {status_path}")
            print(f"scanning {sessions_dir}")
            print("press Ctrl+C to stop")
            # 세션 폴더가 크면 최초 집계가 수십 초 걸릴 수 있어, 첫 방문자가 그 대기를
            # 그대로 겪지 않도록 서버가 요청을 받기 전에 백그라운드에서 미리 데워둔다.
            threading.Thread(target=current_usage_aggregate, daemon=True).start()
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                print("\nstopping dashboard server")
    finally:
        stop_status_poller(poller_process, status_path)


def read_raw_status(args: argparse.Namespace) -> str:
    """CLI 인자에 따라 `/status` raw 텍스트를 읽는다.

    Args:
        args: argparse 네임스페이스.

    Returns:
        raw status 텍스트.
    """

    if args.raw_stdin:
        return sys.stdin.read()
    if args.raw_file is not None:
        return args.raw_file.expanduser().read_text(encoding="utf-8")
    if args.raw_text is not None:
        return args.raw_text
    raise ValueError("--raw-stdin, --raw-file 또는 --raw-text가 필요합니다.")


def parse_args() -> argparse.Namespace:
    """CLI 인자를 파싱한다.

    Returns:
        argparse 네임스페이스.
    """

    parser = argparse.ArgumentParser(
        description="Render a local dashboard from Codex CLI /status capture JSON."
    )
    parser.add_argument(
        "--status-path",
        type=Path,
        default=default_status_path(),
        help="status.json path. Default: ~/.codex-usage-wrapper/status.json",
    )
    parser.add_argument(
        "--serve",
        action="store_true",
        help="Start the local dashboard server.",
    )
    parser.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help="Host for --serve. Default: 127.0.0.1",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help="Port for --serve. Default: 8767",
    )
    parser.add_argument(
        "--refresh-seconds",
        type=int,
        default=DEFAULT_REFRESH_SECONDS,
        help="Browser refresh interval. Default: 3",
    )
    parser.add_argument(
        "--raw-file",
        type=Path,
        help="Parse raw /status text from a UTF-8 text file and write status.json.",
    )
    parser.add_argument(
        "--raw-text",
        help="Parse raw /status text from this argument and write status.json.",
    )
    parser.add_argument(
        "--raw-stdin",
        action="store_true",
        help="Parse raw /status text from standard input and write status.json.",
    )
    parser.add_argument(
        "--history-dir",
        type=Path,
        default=DEFAULT_HISTORY_DIR,
        help="History JSONL directory. Default: ~/.codex-usage-wrapper/history",
    )
    parser.add_argument(
        "--sessions-dir",
        type=Path,
        default=usage_report.default_sessions_dir(),
        help="Codex session JSONL directory for the token usage section. Default: ~/.codex/sessions",
    )
    parser.add_argument(
        "--no-auto-status-poll",
        action="store_true",
        help="Don't spawn a background headless Codex session to auto-capture plan limits for --serve.",
    )
    parser.add_argument(
        "--poll-interval-ms",
        type=int,
        default=DEFAULT_POLL_INTERVAL_MS,
        help=f"Background status poller capture interval. Default: {DEFAULT_POLL_INTERVAL_MS}",
    )
    parser.add_argument(
        "--codex-command",
        default=DEFAULT_CODEX_COMMAND,
        help=f"Codex CLI executable for the background status poller. Default: {DEFAULT_CODEX_COMMAND}",
    )
    parser.add_argument(
        "--node-command",
        default=DEFAULT_NODE_COMMAND,
        help="Node executable used to run the background status poller. Default: node",
    )
    return parser.parse_args()


def main() -> None:
    """CLI 진입점."""

    args = parse_args()
    status_path = args.status_path.expanduser()

    if args.raw_stdin or args.raw_file is not None or args.raw_text is not None:
        raw_status = read_raw_status(args)
        status = parse_status_text(raw_status)
        write_status(status, status_path, args.history_dir.expanduser())
        print(f"wrote {status_path} ({status['parse_status']})")
        return

    if args.serve:
        run_dashboard_server(
            status_path,
            args.host,
            args.port,
            args.refresh_seconds,
            args.sessions_dir.expanduser(),
            args.history_dir.expanduser(),
            not args.no_auto_status_poll,
            args.poll_interval_ms,
            args.codex_command,
            args.node_command,
        )
        return

    status = read_status(status_path)
    if status is None:
        print(f"status file not found or invalid: {status_path}")
        return
    print(json.dumps(status, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
