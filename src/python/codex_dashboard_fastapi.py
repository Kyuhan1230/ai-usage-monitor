"""FastAPI 개발 서버로 Codex 사용량 대시보드를 제공한다."""

from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse

import codex_status_dashboard as status_dashboard
import codex_usage_report as usage_report
import claude_usage_report
from dashboard_common import FileCache


def env_bool(name: str, default: bool) -> bool:
    """환경변수 문자열을 bool 값으로 해석한다.

    Args:
        name: 읽을 환경변수 이름.
        default: 환경변수가 없을 때 사용할 기본값.

    Returns:
        해석된 bool 값.
    """

    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    return raw_value.strip().lower() not in {"0", "false", "no", "off"}


def env_int(name: str, default: int) -> int:
    """환경변수 문자열을 정수로 해석한다.

    Args:
        name: 읽을 환경변수 이름.
        default: 환경변수가 없거나 정수가 아닐 때 사용할 기본값.

    Returns:
        해석된 정수.
    """

    raw_value = os.getenv(name)
    if raw_value is None:
        return default
    try:
        return int(raw_value)
    except ValueError:
        return default


def env_path(name: str, default: Path) -> Path:
    """환경변수 문자열을 Path로 해석한다.

    Args:
        name: 읽을 환경변수 이름.
        default: 환경변수가 없을 때 사용할 기본 경로.

    Returns:
        확장된 Path 값.
    """

    raw_value = os.getenv(name)
    if raw_value is None:
        return default.expanduser()
    return Path(raw_value).expanduser()


STATUS_PATH = env_path("CODEX_USAGE_STATUS_PATH", status_dashboard.DEFAULT_STATUS_PATH)
CLAUDE_STATUS_PATH = env_path("CODEX_USAGE_CLAUDE_STATUS_PATH", status_dashboard.DEFAULT_CLAUDE_STATUS_PATH)
HISTORY_DIR = env_path("CODEX_USAGE_HISTORY_DIR", status_dashboard.DEFAULT_HISTORY_DIR)
SESSIONS_DIR = env_path("CODEX_USAGE_SESSIONS_DIR", usage_report.default_sessions_dir())
CLAUDE_SESSIONS_DIR = env_path("CODEX_USAGE_CLAUDE_SESSIONS_DIR", claude_usage_report.default_sessions_dir())
REFRESH_SECONDS = env_int("CODEX_USAGE_REFRESH_SECONDS", status_dashboard.DEFAULT_REFRESH_SECONDS)
AUTO_STATUS_POLL = env_bool("CODEX_USAGE_AUTO_STATUS_POLL", True)
POLL_INTERVAL_MS = env_int("CODEX_USAGE_POLL_INTERVAL_MS", status_dashboard.DEFAULT_POLL_INTERVAL_MS)
CODEX_COMMAND = os.getenv("CODEX_USAGE_CODEX_COMMAND", status_dashboard.DEFAULT_CODEX_COMMAND)
NODE_COMMAND = os.getenv("CODEX_USAGE_NODE_COMMAND", status_dashboard.DEFAULT_NODE_COMMAND)

app = FastAPI(title="Codex, Claude Usage Dashboard")
usage_file_cache: FileCache = {}
claude_usage_file_cache: FileCache = {}
poller_process = None


def current_usage_aggregate() -> dict[tuple[str, str], usage_report.UsageTotals]:
    """현재 세션 로그 기준 토큰 사용량을 집계한다.

    Returns:
        `(date, model)` 키를 가진 사용량 집계 딕셔너리.
    """

    return usage_report.aggregate_usage(SESSIONS_DIR, usage_file_cache)


def current_claude_usage_aggregate() -> dict[tuple[str, str], claude_usage_report.UsageTotals]:
    """현재 Claude 프로젝트 로그 기준 토큰 사용량을 집계한다.

    Returns:
        `(date, model)` 키를 가진 Claude 사용량 집계 딕셔너리.
    """

    return claude_usage_report.aggregate_usage(CLAUDE_SESSIONS_DIR, claude_usage_file_cache)


@app.on_event("startup")
def startup() -> None:
    """FastAPI 서버 시작 시 백그라운드 status poller를 실행한다."""

    global poller_process
    if AUTO_STATUS_POLL:
        poller_process = status_dashboard.start_status_poller(
            STATUS_PATH,
            HISTORY_DIR,
            POLL_INTERVAL_MS,
            CODEX_COMMAND,
            NODE_COMMAND,
        )
    threading.Thread(target=current_usage_aggregate, daemon=True).start()
    threading.Thread(target=current_claude_usage_aggregate, daemon=True).start()


@app.on_event("shutdown")
def shutdown() -> None:
    """FastAPI 서버 종료 시 이 프로세스가 띄운 poller를 종료한다."""

    status_dashboard.stop_status_poller(poller_process, STATUS_PATH)


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    """전체 대시보드 HTML을 반환한다.

    Returns:
        HTML 문서 문자열.
    """

    return status_dashboard.render_dashboard_page(
        status_dashboard.read_status(STATUS_PATH),
        STATUS_PATH,
        REFRESH_SECONDS,
        {},
        SESSIONS_DIR,
        status_dashboard.read_status(CLAUDE_STATUS_PATH),
        CLAUDE_STATUS_PATH,
        {},
        CLAUDE_SESSIONS_DIR,
        AUTO_STATUS_POLL,
        True,
    )


@app.get("/index.html", response_class=HTMLResponse)
def index_html() -> str:
    """전체 대시보드 HTML을 반환한다.

    Returns:
        HTML 문서 문자열.
    """

    return index()


@app.get("/fragment", response_class=HTMLResponse)
def fragment() -> str:
    """대시보드 갱신용 HTML 조각을 반환한다.

    Returns:
        HTML 조각 문자열.
    """

    return status_dashboard.render_dashboard_content(
        status_dashboard.read_status(STATUS_PATH),
        STATUS_PATH,
        current_usage_aggregate(),
        SESSIONS_DIR,
        status_dashboard.read_status(CLAUDE_STATUS_PATH),
        CLAUDE_STATUS_PATH,
        current_claude_usage_aggregate(),
        CLAUDE_SESSIONS_DIR,
        AUTO_STATUS_POLL,
    )


@app.get("/status.json")
def status_json() -> JSONResponse:
    """현재 status.json 내용을 반환한다.

    Returns:
        JSON 응답.
    """

    status: dict[str, Any] = status_dashboard.read_status(STATUS_PATH) or {}
    return JSONResponse(status, headers={"Cache-Control": "no-store"})
