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
import claude_usage_report
from dashboard_common import FileCache


SCHEMA_VERSION = 1
DEFAULT_REFRESH_SECONDS = 3
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8767
DEFAULT_STATUS_PATH = Path.home() / ".codex-usage-wrapper" / "status.json"
DEFAULT_CLAUDE_STATUS_PATH = Path.home() / ".codex-usage-wrapper" / "claude-status.json"
DEFAULT_HISTORY_DIR = Path.home() / ".codex-usage-wrapper" / "history"
DEFAULT_POLL_INTERVAL_MS = 3 * 60 * 1000
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

CLAUDE_RING_LABELS = (
    ("five_hour", "Current session"),
    ("seven_day", "Current week"),
)

DASHBOARD_STYLE = """
    main {
      max-width: 1680px;
      margin: 0 auto;
      padding: 28px 20px 40px;
    }
    h1 {
      margin: 0 0 18px;
      font-family: var(--mono);
      font-size: 20px;
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
    .dashboard-top {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    .dashboard-top h1 {
      margin-bottom: 0;
    }
    .dashboard-note {
      color: var(--muted);
      font-size: 12px;
      font-family: var(--mono);
      white-space: nowrap;
    }
    .top-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .theme-toggle {
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--surface);
      color: var(--text);
      cursor: pointer;
      font: 12px var(--mono);
      min-width: 92px;
      padding: 6px 10px;
    }
    .theme-toggle:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .tool-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }
    .tool-panel {
      min-width: 0;
      background: linear-gradient(180deg, rgba(255, 255, 255, .025), rgba(255, 255, 255, 0));
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 18px;
    }
    .panel-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      min-height: 54px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 12px;
      margin-bottom: 14px;
    }
    .panel-head h2 {
      margin: 0 0 6px;
      color: var(--text);
      font-size: 16px;
      text-transform: none;
      letter-spacing: 0;
    }
    .panel-badge {
      flex: none;
      border: 1px solid var(--border);
      border-radius: 999px;
      color: var(--muted);
      background: var(--surface);
      padding: 4px 8px;
      font-size: 11px;
      font-family: var(--mono);
    }
    .tool-panel .meta,
    .report-meta {
      margin: 0;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .report-meta {
      margin-bottom: 12px;
    }
    .tool-panel > .meta {
      display: none;
    }
    .tool-panel h2:not(.panel-title) {
      margin-top: 24px;
    }
    .tool-panel .stats {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }
    .tool-panel .stat {
      padding: 14px;
    }
    .tool-panel .stat .value {
      font-size: 20px;
    }
    .rings {
      display: flex;
      flex-wrap: wrap;
      gap: 18px;
      margin: 0 0 22px;
    }
    .ring-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      width: 140px;
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
    .ring-detail {
      display: grid;
      grid-template-rows: 16px 16px;
      gap: 2px;
      width: 100%;
      min-height: 34px;
      text-align: center;
    }
    .ring-used,
    .ring-reset {
      font-size: 12px;
      color: var(--muted);
      font-family: var(--mono);
      line-height: 1.35;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .ring-used:empty::before,
    .ring-reset:empty::before {
      content: " ";
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
    @media (max-width: 1180px) {
      .tool-grid {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 640px) {
      main {
        padding: 20px 12px 32px;
      }
      .dashboard-top {
        align-items: flex-start;
        flex-direction: column;
      }
      .dashboard-note {
        white-space: normal;
      }
      .top-actions {
        width: 100%;
        justify-content: space-between;
      }
      .tool-panel {
        padding: 14px;
      }
      .panel-head {
        min-height: 0;
      }
      .tool-panel .stats {
        grid-template-columns: 1fr;
      }
    }
"""


def display_used(limit: dict[str, Any] | None) -> str | None:
    """사용률 표시 문자열을 만든다.

    Args:
        limit: 제한 정보 딕셔너리.

    Returns:
        사용률 문구 또는 None.
    """

    if not limit:
        return None
    used_percent = limit.get("used_percent")
    if isinstance(used_percent, int):
        return f"사용 {used_percent}%"
    remaining_percent = limit.get("remaining_percent")
    if isinstance(remaining_percent, int):
        return f"사용 {max(0, min(100, 100 - remaining_percent))}%"
    return None


def render_limit_ring(label: str, limit: dict[str, Any] | None, show_used: bool = False) -> str:
    """플랜 잔여율 하나를 도넛형 링 카드로 렌더링한다.

    Args:
        label: 화면에 표시할 제한 이름(예: `5-hour`).
        limit: 제한 정보 딕셔너리. 값이 없으면 미확인 상태로 그린다.
        show_used: 하단 보조 문구에 사용률을 함께 표시할지 여부.

    Returns:
        `<div class="ring-card">` HTML 조각.
    """

    percent = limit.get("remaining_percent") if limit else None
    if isinstance(percent, int):
        if percent <= 10:
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

    used_text = display_used(limit) if show_used else ""
    if used_text is None:
        used_text = ""
    reset_text = display_reset(limit)
    if reset_text == "N/A":
        reset_text = ""
    return f"""
    <div class="ring-card">
      <div class="ring ring-{tone}" style="--pct:{pct_for_style}">
        <span class="ring-value">{html.escape(value_text)}</span>
      </div>
      <div class="ring-label">{html.escape(label)}</div>
      <div class="ring-detail">
        <div class="ring-used" title="{html.escape(used_text)}">{html.escape(used_text)}</div>
        <div class="ring-reset" title="{html.escape(reset_text)}">{html.escape(reset_text)}</div>
      </div>
    </div>
"""


def render_dashboard_content(
    status: dict[str, Any] | None,
    status_path: Path,
    usage_aggregate: dict[tuple[str, str], usage_report.UsageTotals],
    sessions_dir: Path,
    claude_status: dict[str, Any] | None,
    claude_status_path: Path,
    claude_usage_aggregate: dict[tuple[str, str], claude_usage_report.UsageTotals],
    claude_sessions_dir: Path,
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

    rings = "".join(render_limit_ring(label, limits.get(key), True) for key, label in RING_LABELS)
    try:
        claude_limits = limit_map(claude_status)
        claude_rings = "".join(render_limit_ring(label, claude_limits.get(key), True) for key, label in CLAUDE_RING_LABELS)
        claude_body = claude_usage_report.render_report_body(claude_usage_aggregate, claude_sessions_dir)
    except Exception:
        claude_rings = "".join(render_limit_ring(label, None) for _key, label in CLAUDE_RING_LABELS)
        claude_body = '<p class="empty">집계할 usage/token 이벤트가 없습니다.</p>'

    claude_status_hint = (
        ""
        if claude_status
        else f"""
      <section class="hint">
        <div class="label">Claude statusLine hook이 아직 실행되지 않았습니다</div>
        <p>토큰 사용량은 JSONL에서 집계하지만 Current session/week 잔여율은 <code>{html.escape(str(claude_status_path))}</code> 파일이 생긴 뒤 표시됩니다.</p>
      </section>
"""
    )
    poll_dot_class = "poll-dot" if auto_status_poll else "poll-dot off"
    poll_text = "자동 폴링 켜짐" if auto_status_poll else "자동 폴링 꺼짐"

    return f"""
    {setup_hint}
    <section class="tool-grid" aria-label="Codex와 Claude 사용량">
      <article class="tool-panel tool-panel-codex">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Codex 사용량</h2>
            <p class="meta">status: {html.escape(str(status_path))}</p>
          </div>
          <span class="panel-badge">Codex</span>
        </div>
        <section class="rings">
          {rings}
        </section>
        {usage_report.render_report_body(usage_aggregate, sessions_dir)}
      </article>
      <article class="tool-panel tool-panel-claude">
        <div class="panel-head">
          <div>
            <h2 class="panel-title">Claude 사용량</h2>
            <p class="meta">status: {html.escape(str(claude_status_path))}</p>
          </div>
          <span class="panel-badge">Claude</span>
        </div>
        {claude_status_hint}
        <section class="rings">
          {claude_rings}
        </section>
        {claude_body}
      </article>
    </section>
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
    claude_status: dict[str, Any] | None,
    claude_status_path: Path,
    claude_usage_aggregate: dict[tuple[str, str], claude_usage_report.UsageTotals],
    claude_sessions_dir: Path,
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

    content = render_dashboard_content(
        status,
        status_path,
        usage_aggregate,
        sessions_dir,
        claude_status,
        claude_status_path,
        claude_usage_aggregate,
        claude_sessions_dir,
        auto_status_poll,
    )
    refresh_script = usage_report.render_live_refresh_script("dashboard-content", "/fragment", refresh_seconds)
    theme_script = render_theme_script()

    return f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex, Claude Usage Dashboard</title>
  <script>
    (function () {{
      var theme = localStorage.getItem("codexUsageTheme") || "dark";
      document.documentElement.dataset.theme = theme;
    }})();
  </script>
  <style>
{usage_report.BASE_STYLE}
{DASHBOARD_STYLE}
{usage_report.REPORT_STYLE}  </style>
</head>
<body>
  <main>
    <div class="dashboard-top">
      <h1>Codex, Claude Usage Dashboard</h1>
      <div class="top-actions">
        <div class="dashboard-note">잔여율 기준 · 10% 위험 · 50% 주의</div>
        <button class="theme-toggle" id="theme-toggle" type="button" aria-label="테마 전환">Dark</button>
      </div>
    </div>
    <div id="dashboard-content">{content}</div>
  </main>
  {usage_report.render_tooltip_script()}
  {theme_script}
  {refresh_script}
</body>
</html>
"""


def render_theme_script() -> str:
    """다크/라이트 테마 토글 스크립트를 렌더링한다.

    Returns:
        `<script>` 태그 문자열.
    """

    return """
  <script>
    (function () {
      var button = document.getElementById("theme-toggle");
      if (!button) {
        return;
      }
      function currentTheme() {
        return document.documentElement.dataset.theme === "light" ? "light" : "dark";
      }
      function syncButton() {
        var theme = currentTheme();
        button.textContent = theme === "light" ? "Light" : "Dark";
        button.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
      }
      button.addEventListener("click", function () {
        var nextTheme = currentTheme() === "light" ? "dark" : "light";
        document.documentElement.dataset.theme = nextTheme;
        localStorage.setItem("codexUsageTheme", nextTheme);
        syncButton();
      });
      syncButton();
    })();
  </script>
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
    claude_sessions_dir: Path,
    claude_status_path: Path,
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
    usage_file_cache: FileCache = {}
    claude_usage_file_cache: FileCache = {}

    def current_usage_aggregate() -> dict[tuple[str, str], usage_report.UsageTotals]:
        return usage_report.aggregate_usage(sessions_dir, usage_file_cache)

    def current_claude_usage_aggregate() -> dict[tuple[str, str], claude_usage_report.UsageTotals]:
        return claude_usage_report.aggregate_usage(claude_sessions_dir, claude_usage_file_cache)

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
                claude_status = read_status(claude_status_path)
                body = render_dashboard_content(
                    status,
                    status_path,
                    current_usage_aggregate(),
                    sessions_dir,
                    claude_status,
                    claude_status_path,
                    current_claude_usage_aggregate(),
                    claude_sessions_dir,
                    auto_status_poll,
                ).encode("utf-8")
                usage_report.send_body(self, body, "text/html; charset=utf-8")
                return

            if self.path not in ("/", "/index.html"):
                self.send_error(404)
                return

            status = read_status(status_path)
            claude_status = read_status(claude_status_path)
            body = render_dashboard_page(
                status,
                status_path,
                refresh_seconds,
                current_usage_aggregate(),
                sessions_dir,
                claude_status,
                claude_status_path,
                current_claude_usage_aggregate(),
                claude_sessions_dir,
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
            print(f"scanning Claude sessions {claude_sessions_dir}")
            print("press Ctrl+C to stop")
            # 세션 폴더가 크면 최초 집계가 수십 초 걸릴 수 있어, 첫 방문자가 그 대기를
            # 그대로 겪지 않도록 서버가 요청을 받기 전에 백그라운드에서 미리 데워둔다.
            threading.Thread(target=current_usage_aggregate, daemon=True).start()
            threading.Thread(target=current_claude_usage_aggregate, daemon=True).start()
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
        "--claude-sessions-dir",
        type=Path,
        default=claude_usage_report.default_sessions_dir(),
        help="Claude Code project JSONL directory for the token usage section. Default: ~/.claude/projects",
    )
    parser.add_argument(
        "--claude-status-path",
        type=Path,
        default=DEFAULT_CLAUDE_STATUS_PATH,
        help="Claude statusLine status JSON path. Default: ~/.codex-usage-wrapper/claude-status.json",
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
            args.claude_sessions_dir.expanduser(),
            args.claude_status_path.expanduser(),
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
