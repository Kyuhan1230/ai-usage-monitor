"""Aggregate Claude Code JSONL token usage for the unified dashboard."""

from __future__ import annotations

import html
import json
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from dashboard_common import FileCache, render_usage_table

KST = ZoneInfo("Asia/Seoul")
SYNTHETIC_MODEL = "<synthetic>"


TOKEN_KEYS = (
    "input_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
)

CLAUDE_TOOLTIPS = {
    "Input": "Claude 모델에 전달된 입력 토큰입니다.",
    "Cached Input": "프롬프트 캐시에서 재사용된 입력 토큰입니다.",
    "Cache Write": "새로 프롬프트 캐시에 기록된 입력 토큰입니다.",
    "Output": "Claude 모델이 응답으로 생성한 출력 토큰입니다.",
    "Total": "Input, Cached Input, Cache Write, Output을 더한 토큰 합계입니다.",
    "Events": "중복 제거 후 집계된 assistant usage 메시지 수입니다.",
}

CLAUDE_TODAY_MODEL_COLUMNS = [
    ("model", "Model", None),
    ("input_tokens", "Input", CLAUDE_TOOLTIPS["Input"]),
    ("cache_read_input_tokens", "Cached Input", CLAUDE_TOOLTIPS["Cached Input"]),
    ("cache_creation_input_tokens", "Cache Write", CLAUDE_TOOLTIPS["Cache Write"]),
    ("output_tokens", "Output", CLAUDE_TOOLTIPS["Output"]),
    ("total_tokens", "Total", CLAUDE_TOOLTIPS["Total"]),
    ("events", "Events", CLAUDE_TOOLTIPS["Events"]),
]

CLAUDE_DAILY_COLUMNS = [
    ("date", "Date", None),
    ("models", "Models", None),
    ("input_tokens", "Input", CLAUDE_TOOLTIPS["Input"]),
    ("cache_read_input_tokens", "Cached Input", CLAUDE_TOOLTIPS["Cached Input"]),
    ("cache_creation_input_tokens", "Cache Write", CLAUDE_TOOLTIPS["Cache Write"]),
    ("output_tokens", "Output", CLAUDE_TOOLTIPS["Output"]),
    ("total_tokens", "Total", CLAUDE_TOOLTIPS["Total"]),
    ("events", "Events", CLAUDE_TOOLTIPS["Events"]),
]


@dataclass
class UsageTotals:
    """Claude token usage totals.

    Args:
        input_tokens: Input token count.
        cache_read_input_tokens: Cached input token count.
        cache_creation_input_tokens: Cache write token count.
        output_tokens: Output token count.
        total_tokens: Sum of all Claude token fields.
        events: Deduplicated assistant usage message count.
        files: Source files included in the total.
    """

    input_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    events: int = 0
    files: set[Path] = field(default_factory=set)

    def add(self, usage: dict[str, Any], source_file: Path) -> None:
        """Add one deduplicated usage object.

        Args:
            usage: Claude message usage object.
            source_file: Source JSONL file path.

        Returns:
            None.
        """

        subtotal = 0
        for key in TOKEN_KEYS:
            value = to_int(usage.get(key))
            setattr(self, key, getattr(self, key) + value)
            subtotal += value
        self.total_tokens += subtotal
        self.events += 1
        self.files.add(source_file)


def to_int(value: Any) -> int:
    """Convert a JSON value to a safe integer token count."""

    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.isdecimal():
        return int(value)
    return 0


def default_sessions_dir() -> Path:
    """Return the default Claude Code project transcript directory."""

    return Path.home() / ".claude" / "projects"


def iter_jsonl_files(sessions_dir: Path) -> list[Path]:
    """Return all Claude JSONL transcript files, including subagents folders."""

    if not sessions_dir.exists():
        return []
    return sorted(path for path in sessions_dir.rglob("*.jsonl") if path.is_file())


def load_json_lines(path: Path) -> list[dict[str, Any]]:
    """Read parseable JSON objects from a JSONL file."""

    records: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as file:
            for line in file:
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(record, dict):
                    records.append(record)
    except (OSError, UnicodeDecodeError):
        return []
    return records


def date_from_record(record: dict[str, Any]) -> str:
    """Extract a KST date string from a Claude record timestamp."""

    timestamp = record.get("timestamp")
    if not isinstance(timestamp, str) or not timestamp:
        return "unknown"
    normalized = timestamp.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is not None:
            parsed = parsed.astimezone(KST)
        return parsed.date().isoformat()
    except ValueError:
        return timestamp[:10] if len(timestamp) >= 10 else "unknown"


def message_of(record: dict[str, Any]) -> dict[str, Any]:
    """Return the nested Claude message dictionary when present."""

    message = record.get("message")
    return message if isinstance(message, dict) else {}


def compute_file_usage(path: Path) -> dict[tuple[str, str], UsageTotals]:
    """Compute per-date and per-model Claude usage for one JSONL file.

    Claude repeats the same usage object across multiple JSONL lines for one
    assistant message id, so summing lines directly overcounts by about 2.2x-2.7x.
    This keeps only the last usage object seen for each message id before summing.
    """

    deduped: dict[str, tuple[str, str, dict[str, Any]]] = {}
    current_model = "unknown"

    for record in load_json_lines(path):
        if record.get("type") != "assistant":
            continue

        message = message_of(record)
        model = message.get("model")
        if isinstance(model, str) and model:
            current_model = model

        usage = message.get("usage")
        if not isinstance(usage, dict):
            continue

        message_id = message.get("id")
        if not isinstance(message_id, str) or not message_id:
            message_id = f"__missing_id__:{len(deduped)}"

        deduped[message_id] = (date_from_record(record), current_model, usage)

    result: dict[tuple[str, str], UsageTotals] = defaultdict(UsageTotals)
    for date, model, usage in deduped.values():
        result[(date, model)].add(usage, path)
    return dict(result)


def merge_into(target: UsageTotals, source: UsageTotals) -> None:
    """Merge one total into another."""

    for key in TOKEN_KEYS:
        setattr(target, key, getattr(target, key) + getattr(source, key))
    target.total_tokens += source.total_tokens
    target.events += source.events
    target.files.update(source.files)


def aggregate_usage(sessions_dir: Path, file_cache: FileCache | None = None) -> dict[tuple[str, str], UsageTotals]:
    """Aggregate Claude usage across all JSONL files under sessions_dir."""

    aggregate: dict[tuple[str, str], UsageTotals] = defaultdict(UsageTotals)
    for path in iter_jsonl_files(sessions_dir):
        if file_cache is None:
            try:
                file_usage = compute_file_usage(path)
            except Exception:
                file_usage = {}
        else:
            stat_result = path.stat()
            signature = (stat_result.st_mtime, stat_result.st_size)
            cached = file_cache.get(path)
            if cached is not None and cached[0] == signature:
                file_usage = cached[1]
            else:
                try:
                    file_usage = compute_file_usage(path)
                except Exception:
                    file_usage = {}
                file_cache[path] = (signature, file_usage)

        for key, totals in file_usage.items():
            merge_into(aggregate[key], totals)
    return dict(aggregate)


def format_number(value: int) -> str:
    """Format an integer with thousands separators."""

    return f"{value:,}"


def format_models(models: set[str]) -> str:
    """Render model names with a tooltip when there are many."""

    ordered = sorted(model for model in models if model)
    if not ordered:
        return "unknown"
    visible_models = ordered[:3]
    suffix = f" +{len(ordered) - len(visible_models)}" if len(ordered) > len(visible_models) else ""
    visible = ", ".join(visible_models) + suffix
    full = ", ".join(ordered)
    escaped_full = html.escape(full)
    return f'<span data-tip="{escaped_full}" title="{escaped_full}">{html.escape(visible)}</span>'


def today_kst() -> str:
    """Return today's date in KST."""

    return datetime.now(KST).date().isoformat()


def today_totals(aggregate: dict[tuple[str, str], UsageTotals], today: str) -> UsageTotals:
    """Merge all totals for one date."""

    total = UsageTotals()
    for (date, _model), totals in aggregate.items():
        if date == today:
            merge_into(total, totals)
    return total


def sum_totals(aggregate: dict[tuple[str, str], UsageTotals]) -> UsageTotals:
    """Merge all aggregate totals."""

    total = UsageTotals()
    for totals in aggregate.values():
        merge_into(total, totals)
    return total


def render_today_model_table(aggregate: dict[tuple[str, str], UsageTotals], today: str) -> str:
    """Render today's usage grouped by model."""

    rows: list[dict[str, str]] = []
    items = [(model, totals) for (date, model), totals in aggregate.items() if date == today and model != SYNTHETIC_MODEL]
    for model, totals in sorted(items, key=lambda item: item[1].total_tokens, reverse=True):
        rows.append(row_for_totals({"model": html.escape(model)}, totals))

    if not rows:
        rows.append(
            {
                "model": "오늘 집계된 모델 사용량이 없습니다.",
                "input_tokens": "",
                "cache_read_input_tokens": "",
                "cache_creation_input_tokens": "",
                "output_tokens": "",
                "total_tokens": "",
                "events": "",
            }
        )
    return render_usage_table(rows, CLAUDE_TODAY_MODEL_COLUMNS)


def render_daily_table(aggregate: dict[tuple[str, str], UsageTotals]) -> str:
    """Render daily Claude usage summary."""

    by_date: dict[str, UsageTotals] = defaultdict(UsageTotals)
    models_by_date: dict[str, set[str]] = defaultdict(set)
    for (date, model), totals in aggregate.items():
        merge_into(by_date[date], totals)
        if model != SYNTHETIC_MODEL:
            models_by_date[date].add(model)

    rows: list[dict[str, str]] = []
    for date, totals in sorted(by_date.items(), reverse=True):
        rows.append(row_for_totals({"date": html.escape(date), "models": format_models(models_by_date[date])}, totals))
    return render_usage_table(rows, CLAUDE_DAILY_COLUMNS)


def row_for_totals(prefix: dict[str, str], totals: UsageTotals) -> dict[str, str]:
    """Create a table row dictionary from totals."""

    return {
        **prefix,
        "input_tokens": format_number(totals.input_tokens),
        "cache_read_input_tokens": format_number(totals.cache_read_input_tokens),
        "cache_creation_input_tokens": format_number(totals.cache_creation_input_tokens),
        "output_tokens": format_number(totals.output_tokens),
        "total_tokens": format_number(totals.total_tokens),
        "events": format_number(totals.events),
    }


def render_report_body(aggregate: dict[tuple[str, str], UsageTotals], sessions_dir: Path) -> str:
    """Render the Claude usage report body."""

    today_date = today_kst()
    today = today_totals(aggregate, today_date)
    empty_note = "" if aggregate else '<p class="empty">집계할 usage/token 이벤트가 없습니다.</p>'

    return f"""
    <p class="report-meta">스캔 대상: {html.escape(str(sessions_dir))}</p>
    <section class="stats">
      <div class="stat"><div class="label">오늘 Total Tokens</div><div class="value">{format_number(today.total_tokens)}</div></div>
      <div class="stat"><div class="label">오늘 Input Tokens</div><div class="value">{format_number(today.input_tokens)}</div></div>
      <div class="stat"><div class="label">오늘 Cache Write Tokens</div><div class="value">{format_number(today.cache_creation_input_tokens)}</div></div>
      <div class="stat"><div class="label">오늘 Output Tokens</div><div class="value">{format_number(today.output_tokens)}</div></div>
    </section>
    {empty_note}
    <h2>오늘 사용량 기준일: {html.escape(today_date)} 00:00 KST</h2>
    <h2>오늘 모델별 사용량</h2>
    {render_today_model_table(aggregate, today_date)}
    <h2>날짜별 요약</h2>
    {render_daily_table(aggregate)}
"""
