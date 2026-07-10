"""Codex session JSONL 사용량을 날짜별, 모델별 HTML 리포트로 집계한다."""

from __future__ import annotations

import argparse
import html
import http.server
import json
import os
import re
import threading
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from dashboard_common import BASE_STYLE, REPORT_STYLE, FileCache, render_live_refresh_script, render_usage_table, send_body

KST = ZoneInfo("Asia/Seoul")
DEFAULT_FILE_CACHE_PATH = Path.home() / ".codex-usage-wrapper" / "codex-file-cache.json"
CACHE_SCHEMA_VERSION = 1


TOKEN_KEYS = (
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
)

FILENAME_DATE_RE = re.compile(r"rollout-(\d{4}-\d{2}-\d{2})T")

METRIC_TOOLTIPS = {
    "Input": "모델에 전달된 입력 토큰입니다. 캐시로 재사용된 입력도 포함됩니다.",
    "Cached Input": "입력 토큰 중 프롬프트 캐시로 재사용되어 더 저렴하게 처리된 토큰입니다.",
    "Output": "모델이 실제 응답으로 생성한 토큰입니다.",
    "Reasoning Output": "응답을 만들기 위해 모델 내부 추론에 사용한 토큰입니다.",
    "Total": "Codex가 해당 usage 이벤트에 대해 보고한 전체 토큰 합계입니다.",
    "Events": "집계에 포함된 usage 이벤트 수입니다. 보통 응답 또는 처리 단위별로 기록됩니다.",
}

CODEX_TODAY_MODEL_COLUMNS = [
    ("model", "Model", None),
    ("input_tokens", "Input", METRIC_TOOLTIPS["Input"]),
    ("cached_input_tokens", "Cached Input", METRIC_TOOLTIPS["Cached Input"]),
    ("output_tokens", "Output", METRIC_TOOLTIPS["Output"]),
    ("reasoning_output_tokens", "Reasoning Output", METRIC_TOOLTIPS["Reasoning Output"]),
    ("total_tokens", "Total", METRIC_TOOLTIPS["Total"]),
    ("events", "Events", METRIC_TOOLTIPS["Events"]),
]

CODEX_DAILY_COLUMNS = [
    ("date", "Date", None),
    ("models", "Models", None),
    ("input_tokens", "Input", METRIC_TOOLTIPS["Input"]),
    ("cached_input_tokens", "Cached Input", METRIC_TOOLTIPS["Cached Input"]),
    ("output_tokens", "Output", METRIC_TOOLTIPS["Output"]),
    ("reasoning_output_tokens", "Reasoning Output", METRIC_TOOLTIPS["Reasoning Output"]),
    ("total_tokens", "Total", METRIC_TOOLTIPS["Total"]),
    ("events", "Events", METRIC_TOOLTIPS["Events"]),
]


@dataclass
class UsageTotals:
    """토큰 사용량 집계값을 담는다.

    Args:
        input_tokens: 입력 토큰 수.
        cached_input_tokens: 캐시된 입력 토큰 수.
        output_tokens: 출력 토큰 수.
        reasoning_output_tokens: 추론 출력 토큰 수.
        total_tokens: 전체 토큰 수.
        events: 집계에 포함된 usage 이벤트 수.
        files: 집계에 포함된 파일 경로 집합.
    """

    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    reasoning_output_tokens: int = 0
    total_tokens: int = 0
    events: int = 0
    files: set[Path] = field(default_factory=set)

    def add(self, usage: dict[str, Any], source_file: Path) -> None:
        """usage 딕셔너리의 토큰 값을 현재 집계에 더한다.

        Args:
            usage: JSONL 이벤트에서 추출한 usage/token 딕셔너리.
            source_file: usage 이벤트가 들어 있던 원본 파일 경로.

        Returns:
            None.
        """

        for key in TOKEN_KEYS:
            setattr(self, key, getattr(self, key) + to_int(usage.get(key)))
        self.events += 1
        self.files.add(source_file)


def usage_totals_to_dict(totals: UsageTotals) -> dict[str, Any]:
    """파일 캐시에 저장할 수 있는 dict로 집계값을 변환한다.

    Args:
        totals: 직렬화할 집계값.

    Returns:
        JSON으로 저장 가능한 집계 dict.
    """

    return {
        "input_tokens": totals.input_tokens,
        "cached_input_tokens": totals.cached_input_tokens,
        "output_tokens": totals.output_tokens,
        "reasoning_output_tokens": totals.reasoning_output_tokens,
        "total_tokens": totals.total_tokens,
        "events": totals.events,
    }


def usage_totals_from_dict(data: dict[str, Any], source_file: Path) -> UsageTotals:
    """파일 캐시에서 읽은 dict를 UsageTotals로 복원한다.

    Args:
        data: 캐시에 저장된 집계 dict.
        source_file: 집계가 나온 원본 파일 경로.

    Returns:
        복원된 집계값.
    """

    return UsageTotals(
        input_tokens=to_int(data.get("input_tokens")),
        cached_input_tokens=to_int(data.get("cached_input_tokens")),
        output_tokens=to_int(data.get("output_tokens")),
        reasoning_output_tokens=to_int(data.get("reasoning_output_tokens")),
        total_tokens=to_int(data.get("total_tokens")),
        events=to_int(data.get("events")),
        files={source_file},
    )


def load_file_cache(cache_path: Path) -> FileCache:
    """디스크에 저장된 파일별 집계 캐시를 읽는다.

    Args:
        cache_path: 캐시 JSON 파일 경로.

    Returns:
        파일 경로별 시그니처와 집계 결과 캐시.
    """

    if not cache_path.exists():
        return {}
    try:
        raw_cache = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}

    if not isinstance(raw_cache, dict) or raw_cache.get("schema_version") != CACHE_SCHEMA_VERSION:
        return {}

    files = raw_cache.get("files")
    if not isinstance(files, dict):
        return {}

    cache: FileCache = {}
    for path_text, entry in files.items():
        if not isinstance(path_text, str) or not isinstance(entry, dict):
            continue
        signature = entry.get("signature")
        rows = entry.get("rows")
        if (
            not isinstance(signature, list)
            or len(signature) != 2
            or not isinstance(rows, list)
        ):
            continue

        source_file = Path(path_text)
        file_usage: dict[tuple[str, str], UsageTotals] = {}
        for row in rows:
            if not isinstance(row, dict):
                continue
            date = row.get("date")
            model = row.get("model")
            totals = row.get("totals")
            if not isinstance(date, str) or not isinstance(model, str) or not isinstance(totals, dict):
                continue
            file_usage[(date, model)] = usage_totals_from_dict(totals, source_file)

        cache[source_file] = ((float(signature[0]), int(signature[1])), file_usage)
    return cache


def save_file_cache(cache_path: Path, file_cache: FileCache, seen_paths: set[Path]) -> None:
    """파일별 집계 캐시를 디스크에 저장한다.

    Args:
        cache_path: 캐시 JSON 파일 경로.
        file_cache: 현재 메모리 캐시.
        seen_paths: 이번 스캔에서 실제로 발견한 파일 경로 집합.

    Returns:
        None.
    """

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    files: dict[str, Any] = {}
    for path in sorted(seen_paths, key=lambda item: str(item)):
        cached = file_cache.get(path)
        if cached is None:
            continue
        signature, file_usage = cached
        rows = []
        for (date, model), totals in sorted(file_usage.items()):
            rows.append(
                {
                    "date": date,
                    "model": model,
                    "totals": usage_totals_to_dict(totals),
                }
            )
        files[str(path)] = {
            "signature": [signature[0], signature[1]],
            "rows": rows,
        }

    tmp_path = cache_path.with_suffix(f"{cache_path.suffix}.tmp")
    tmp_path.write_text(
        json.dumps({"schema_version": CACHE_SCHEMA_VERSION, "files": files}, ensure_ascii=False),
        encoding="utf-8",
    )
    os.replace(tmp_path, cache_path)


def to_int(value: Any) -> int:
    """정수로 해석 가능한 토큰 값을 안전하게 변환한다.

    Args:
        value: JSON에서 읽은 임의의 값.

    Returns:
        정수로 변환된 값. 변환할 수 없으면 0.
    """

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
    """기본 Codex 세션 디렉터리를 반환한다.

    Returns:
        사용자 홈 아래의 `.codex/sessions` 경로.
    """

    return Path.home() / ".codex" / "sessions"


def iter_jsonl_files(sessions_dir: Path) -> list[Path]:
    """세션 디렉터리 아래 JSONL 파일 목록을 정렬해서 반환한다.

    Args:
        sessions_dir: 스캔할 Codex 세션 디렉터리.

    Returns:
        이름순으로 정렬된 JSONL 파일 경로 목록.
    """

    if not sessions_dir.exists():
        return []
    return sorted(path for path in sessions_dir.rglob("*.jsonl") if path.is_file())


def load_json_lines(path: Path) -> list[dict[str, Any]]:
    """JSONL 파일을 읽고 파싱 가능한 객체만 반환한다.

    Args:
        path: 읽을 JSONL 파일 경로.

    Returns:
        각 줄에서 파싱한 JSON 객체 목록.
    """

    records: list[dict[str, Any]] = []
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
    return records


def payload_of(record: dict[str, Any]) -> dict[str, Any]:
    """이벤트의 payload 딕셔너리를 반환한다.

    Args:
        record: JSONL 한 줄에서 파싱한 이벤트 객체.

    Returns:
        payload가 딕셔너리이면 해당 값, 아니면 빈 딕셔너리.
    """

    payload = record.get("payload")
    return payload if isinstance(payload, dict) else {}


def get_nested_dict(data: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    """중첩 딕셔너리에서 지정 경로의 딕셔너리 값을 꺼낸다.

    Args:
        data: 탐색할 딕셔너리.
        keys: 순서대로 접근할 키 목록.

    Returns:
        경로 끝 값이 딕셔너리이면 해당 값, 아니면 빈 딕셔너리.
    """

    current: Any = data
    for key in keys:
        if not isinstance(current, dict):
            return {}
        current = current.get(key)
    return current if isinstance(current, dict) else {}


def model_from_record(record: dict[str, Any]) -> str | None:
    """이벤트 하나에서 모델명 힌트를 추출한다.

    Args:
        record: JSONL 한 줄에서 파싱한 이벤트 객체.

    Returns:
        이벤트에 담긴 모델명. 없으면 None.
    """

    payload = payload_of(record)
    model = payload.get("model")
    if isinstance(model, str) and model:
        return model

    settings = get_nested_dict(payload, ("collaboration_mode", "settings"))
    settings_model = settings.get("model")
    if isinstance(settings_model, str) and settings_model:
        return settings_model

    return None


def date_from_record(record: dict[str, Any], source_file: Path) -> str:
    """이벤트 날짜를 `YYYY-MM-DD` 형식으로 구한다.

    Args:
        record: JSONL 한 줄에서 파싱한 이벤트 객체.
        source_file: 날짜 fallback에 사용할 파일 경로.

    Returns:
        날짜 문자열. 이벤트와 파일명에서 찾지 못하면 `unknown`.
    """

    payload = payload_of(record)
    timestamp = record.get("timestamp") or payload.get("timestamp")
    if isinstance(timestamp, str) and timestamp:
        normalized = timestamp.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
            if parsed.tzinfo is not None:
                parsed = parsed.astimezone(KST)
            return parsed.date().isoformat()
        except ValueError:
            if len(timestamp) >= 10:
                return timestamp[:10]

    filename_match = FILENAME_DATE_RE.search(source_file.name)
    if filename_match:
        return filename_match.group(1)

    # 디렉터리 구조가 yyyy/mm/dd이면 파일명에 날짜가 없어도 복구한다.
    parts = source_file.parts
    if len(parts) >= 4 and all(part.isdecimal() for part in parts[-4:-1]):
        year, month, day = parts[-4:-1]
        return f"{year}-{month.zfill(2)}-{day.zfill(2)}"

    return "unknown"


def usage_from_record(record: dict[str, Any]) -> dict[str, Any] | None:
    """이벤트에서 합산할 usage 딕셔너리를 추출한다.

    Args:
        record: JSONL 한 줄에서 파싱한 이벤트 객체.

    Returns:
        `last_token_usage` 딕셔너리 또는 None.
    """

    info = get_nested_dict(payload_of(record), ("info",))
    usage = info.get("last_token_usage")
    if isinstance(usage, dict):
        return usage
    return None


def fallback_total_usage(records: list[dict[str, Any]]) -> dict[str, Any] | None:
    """증분 usage가 없는 파일에서 마지막 누적 usage를 찾는다.

    Args:
        records: 한 JSONL 파일에서 읽은 이벤트 목록.

    Returns:
        마지막 `total_token_usage` 딕셔너리 또는 None.
    """

    last_total: dict[str, Any] | None = None
    for record in records:
        info = get_nested_dict(payload_of(record), ("info",))
        usage = info.get("total_token_usage")
        if isinstance(usage, dict):
            last_total = usage
    return last_total


def merge_into(target: UsageTotals, source: UsageTotals) -> None:
    """source의 값을 target에 더한다(파일 집합은 합집합).

    Args:
        target: 값을 누적할 대상.
        source: 더할 값.

    Returns:
        None.
    """

    for key in TOKEN_KEYS:
        setattr(target, key, getattr(target, key) + getattr(source, key))
    target.events += source.events
    target.files.update(source.files)


def compute_file_usage(path: Path) -> dict[tuple[str, str], UsageTotals]:
    """세션 파일 하나를 파싱해서 (date, model)별 usage 기여분을 계산한다.

    Args:
        path: 파싱할 JSONL 파일 경로.

    Returns:
        이 파일에서만 나온 `(date, model)` 키의 usage 딕셔너리.
    """

    records = load_json_lines(path)
    result: dict[tuple[str, str], UsageTotals] = defaultdict(UsageTotals)
    if not records:
        return dict(result)

    # 세션 도중 모델이 바뀔 수 있으므로(예: /model 전환), 파일 전체가 아니라
    # 각 이벤트 시점까지 관측된 가장 최근 모델을 사용한다.
    current_model = "unknown"
    matched_events = 0
    for record in records:
        model_hint = model_from_record(record)
        if model_hint is not None:
            current_model = model_hint

        usage = usage_from_record(record)
        if usage is None:
            continue
        date = date_from_record(record, path)
        result[(date, current_model)].add(usage, path)
        matched_events += 1

    # 오래된 스키마처럼 증분값이 없으면 파일별 마지막 누적값만 더한다.
    if matched_events == 0:
        usage = fallback_total_usage(records)
        if usage is not None:
            date = date_from_record(records[-1], path)
            result[(date, current_model)].add(usage, path)

    return dict(result)


def aggregate_usage(
    sessions_dir: Path,
    file_cache: FileCache | None = None,
    disk_cache_path: Path | None = None,
) -> dict[tuple[str, str], UsageTotals]:
    """세션 JSONL 파일을 날짜별, 모델별로 집계한다.

    `file_cache`를 넘기면 파일별 (mtime, 크기)가 이전과 같은 파일은 다시 파싱하지 않고
    캐시된 결과를 재사용한다. 실사용 중에는 그날 활성 세션 파일 하나만 계속 갱신되고
    나머지 수백 개는 그대로이므로, 매번 전체를 다시 읽지 않아도 되게 하기 위함이다.

    Args:
        sessions_dir: 스캔할 Codex 세션 디렉터리.
        file_cache: 파일 경로별 (시그니처, 파싱 결과) 캐시. None이면 매번 전부 다시 파싱한다.

    Returns:
        `(date, model)` 키를 가진 usage 집계 딕셔너리.
    """

    uses_disk_cache = disk_cache_path is not None
    cache_changed = False
    if disk_cache_path is not None:
        if file_cache is None:
            file_cache = load_file_cache(disk_cache_path.expanduser())
        elif not file_cache:
            file_cache.update(load_file_cache(disk_cache_path.expanduser()))

    aggregate: dict[tuple[str, str], UsageTotals] = defaultdict(UsageTotals)
    seen_paths: set[Path] = set()
    for path in iter_jsonl_files(sessions_dir):
        seen_paths.add(path)
        if file_cache is None:
            file_usage = compute_file_usage(path)
        else:
            stat_result = path.stat()
            signature = (stat_result.st_mtime, stat_result.st_size)
            cached = file_cache.get(path)
            if cached is not None and cached[0] == signature:
                file_usage = cached[1]
            else:
                file_usage = compute_file_usage(path)
                file_cache[path] = (signature, file_usage)
                cache_changed = True

        for key, totals in file_usage.items():
            merge_into(aggregate[key], totals)

    if uses_disk_cache and file_cache is not None and (cache_changed or seen_paths):
        try:
            save_file_cache(disk_cache_path.expanduser(), file_cache, seen_paths)
        except OSError:
            pass

    return dict(aggregate)


def format_number(value: int) -> str:
    """정수를 HTML 표시에 적합한 천 단위 문자열로 바꾼다.

    Args:
        value: 표시할 정수.

    Returns:
        쉼표가 포함된 숫자 문자열.
    """

    return f"{value:,}"


def format_models(models: set[str]) -> str:
    """모델 목록을 표 안에 넣기 좋은 짧은 문자열로 렌더링한다.

    Args:
        models: 집계에 포함된 모델명 집합.

    Returns:
        HTML 문자열. 모델이 많으면 일부만 보이고 전체 목록은 tooltip으로 제공한다.
    """

    ordered = sorted(model for model in models if model)
    if not ordered:
        return "unknown"

    visible_models = ordered[:3]
    suffix = f" +{len(ordered) - len(visible_models)}" if len(ordered) > len(visible_models) else ""
    visible = ", ".join(visible_models) + suffix
    full = ", ".join(ordered)
    escaped_full = html.escape(full)
    return f'<span data-tip="{escaped_full}" title="{escaped_full}">{html.escape(visible)}</span>'


def render_rows(aggregate: dict[tuple[str, str], UsageTotals]) -> str:
    """집계 결과를 HTML 테이블 행으로 렌더링한다.

    Args:
        aggregate: `(date, model)` 키를 가진 usage 집계 딕셔너리.

    Returns:
        HTML `tr` 문자열.
    """

    rows: list[dict[str, str]] = []
    for (date, model), totals in sorted(aggregate.items(), key=lambda item: item[0], reverse=True):
        rows.append(
            {
                "date": html.escape(date),
                "model": html.escape(model),
                "input_tokens": format_number(totals.input_tokens),
                "cached_input_tokens": format_number(totals.cached_input_tokens),
                "output_tokens": format_number(totals.output_tokens),
                "reasoning_output_tokens": format_number(totals.reasoning_output_tokens),
                "total_tokens": format_number(totals.total_tokens),
                "events": format_number(totals.events),
                "files": format_number(len(totals.files)),
            }
        )
    return render_usage_table(rows, CODEX_DAILY_COLUMNS + [("files", "Files", None)])


def render_daily_rows(aggregate: dict[tuple[str, str], UsageTotals]) -> str:
    """모델을 합친 날짜별 사용량 행을 렌더링한다.

    Args:
        aggregate: `(date, model)` 키를 가진 usage 집계 딕셔너리.

    Returns:
        HTML `tr` 문자열.
    """

    by_date: dict[str, UsageTotals] = defaultdict(UsageTotals)
    models_by_date: dict[str, set[str]] = defaultdict(set)
    for (date, model), totals in aggregate.items():
        merge_into(by_date[date], totals)
        models_by_date[date].add(model)

    rows: list[dict[str, str]] = []
    for date, totals in sorted(by_date.items(), reverse=True):
        rows.append(
            {
                "date": html.escape(date),
                "models": format_models(models_by_date[date]),
                "input_tokens": format_number(totals.input_tokens),
                "cached_input_tokens": format_number(totals.cached_input_tokens),
                "output_tokens": format_number(totals.output_tokens),
                "reasoning_output_tokens": format_number(totals.reasoning_output_tokens),
                "total_tokens": format_number(totals.total_tokens),
                "events": format_number(totals.events),
            }
        )
    return render_usage_table(rows, CODEX_DAILY_COLUMNS)


def render_today_model_rows(aggregate: dict[tuple[str, str], UsageTotals], today: str) -> str:
    """오늘 날짜에 해당하는 모델별 사용량 행을 렌더링한다.

    Args:
        aggregate: `(date, model)` 키를 가진 usage 집계 딕셔너리.
        today: 표시할 기준 날짜 문자열(`YYYY-MM-DD`).

    Returns:
        HTML `tr` 문자열.
    """

    rows: list[dict[str, str]] = []
    items = [
        (model, totals)
        for (date, model), totals in aggregate.items()
        if date == today
    ]
    for model, totals in sorted(items, key=lambda item: item[1].total_tokens, reverse=True):
        rows.append(
            {
                "model": html.escape(model),
                "input_tokens": format_number(totals.input_tokens),
                "cached_input_tokens": format_number(totals.cached_input_tokens),
                "output_tokens": format_number(totals.output_tokens),
                "reasoning_output_tokens": format_number(totals.reasoning_output_tokens),
                "total_tokens": format_number(totals.total_tokens),
                "events": format_number(totals.events),
            }
        )

    if rows:
        return render_usage_table(rows, CODEX_TODAY_MODEL_COLUMNS)
    return render_usage_table(
        [
            {
                "model": "오늘 집계된 모델 사용량이 없습니다.",
                "input_tokens": "",
                "cached_input_tokens": "",
                "output_tokens": "",
                "reasoning_output_tokens": "",
                "total_tokens": "",
                "events": "",
            }
        ],
        CODEX_TODAY_MODEL_COLUMNS,
    )


def today_kst() -> str:
    """오늘 날짜를 KST 00시 기준의 `YYYY-MM-DD` 문자열로 반환한다.

    Returns:
        KST 기준 오늘 날짜 문자열.
    """

    return datetime.now(KST).date().isoformat()


def today_totals(aggregate: dict[tuple[str, str], UsageTotals], today: str) -> UsageTotals:
    """오늘 날짜에 해당하는 (date, model) 집계만 하나로 더한다.

    Args:
        aggregate: `(date, model)` 키를 가진 usage 집계 딕셔너리.
        today: 합칠 기준 날짜 문자열(`YYYY-MM-DD`).

    Returns:
        오늘 하루치 총합 `UsageTotals`.
    """

    total = UsageTotals()
    for (date, _model), totals in aggregate.items():
        if date == today:
            merge_into(total, totals)
    return total


def sum_totals(aggregate: dict[tuple[str, str], UsageTotals]) -> UsageTotals:
    """모든 (date, model) 집계를 하나의 총합으로 더한다.

    Args:
        aggregate: `(date, model)` 키를 가진 usage 집계 딕셔너리.

    Returns:
        전체 총합 `UsageTotals`.
    """

    total = UsageTotals()
    for totals in aggregate.values():
        merge_into(total, totals)
    return total




def render_report_body(aggregate: dict[tuple[str, str], UsageTotals], sessions_dir: Path) -> str:
    """토큰 사용량 리포트의 본문(통계·테이블)만 렌더링한다.

    독립 실행형 리포트와, 다른 대시보드에 끼워 넣는 용도 양쪽에서 재사용한다.

    Args:
        aggregate: `(date, model)` 키를 가진 usage 집계 딕셔너리.
        sessions_dir: 리포트에 표시할 스캔 대상 디렉터리.

    Returns:
        `<section>`부터 시작하는 HTML 조각 문자열.
    """

    today_date = today_kst()
    today = today_totals(aggregate, today_date)
    today_model_table = render_today_model_rows(aggregate, today_date)
    daily_table = render_daily_rows(aggregate)
    empty_note = "" if aggregate else "<p class=\"empty\">집계할 usage/token 이벤트가 없습니다.</p>"

    return f"""
    <p class="report-meta">스캔 대상: {html.escape(str(sessions_dir))}</p>
    <section class="stats">
      <div class="stat"><div class="label">오늘 Total Tokens</div><div class="value">{format_number(today.total_tokens)}</div></div>
      <div class="stat"><div class="label">오늘 Input Tokens</div><div class="value">{format_number(today.input_tokens)}</div></div>
      <div class="stat"><div class="label">오늘 Output Tokens</div><div class="value">{format_number(today.output_tokens)}</div></div>
      <div class="stat"><div class="label">오늘 Usage Events</div><div class="value">{format_number(today.events)}</div></div>
    </section>
    {empty_note}
    <h2>오늘 사용량 기준일: {html.escape(today_date)} 00:00 KST</h2>
    <h2>오늘 모델별 사용량</h2>
    {today_model_table}
    <h2>날짜별 요약</h2>
    {daily_table}
"""




def render_tooltip_script() -> str:
    """`data-tip` 요소의 설명을 화면 최상단 floating tooltip으로 표시한다.

    테이블 컨테이너가 `overflow: auto`라 CSS pseudo-element tooltip은 잘릴 수 있다.
    그래서 이벤트 위임으로 tooltip을 `body`에 붙여 컬럼 설명이 안정적으로 보이게 한다.

    Returns:
        `<script>` 태그 문자열.
    """

    return """
  <script>
    (function () {
      var tooltip = null;
      var active = null;

      function ensureTooltip() {
        if (!tooltip) {
          tooltip = document.createElement("div");
          tooltip.className = "floating-tooltip";
          tooltip.hidden = true;
          document.body.appendChild(tooltip);
        }
        return tooltip;
      }

      function positionTooltip(anchor) {
        if (!tooltip || !anchor) {
          return;
        }
        var rect = anchor.getBoundingClientRect();
        var tipRect = tooltip.getBoundingClientRect();
        var top = rect.top - tipRect.height - 8;
        if (top < 8) {
          top = rect.bottom + 8;
        }
        var left = rect.left + (rect.width / 2) - (tipRect.width / 2);
        left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
        tooltip.style.top = top + "px";
        tooltip.style.left = left + "px";
      }

      function showTooltip(anchor) {
        var text = anchor && anchor.getAttribute("data-tip");
        if (!text) {
          return;
        }
        active = anchor;
        ensureTooltip();
        tooltip.textContent = text;
        tooltip.hidden = false;
        positionTooltip(anchor);
      }

      function hideTooltip() {
        active = null;
        if (tooltip) {
          tooltip.hidden = true;
        }
      }

      document.addEventListener("mouseover", function (event) {
        var anchor = event.target.closest("[data-tip]");
        if (anchor) {
          showTooltip(anchor);
        }
      });
      document.addEventListener("mouseout", function (event) {
        if (active && !active.contains(event.relatedTarget)) {
          hideTooltip();
        }
      });
      document.addEventListener("focusin", function (event) {
        var anchor = event.target.closest("[data-tip]");
        if (anchor) {
          showTooltip(anchor);
        }
      });
      document.addEventListener("focusout", hideTooltip);
      window.addEventListener("scroll", function () { positionTooltip(active); }, true);
      window.addEventListener("resize", function () { positionTooltip(active); });
    })();
  </script>
"""


def render_html(
    aggregate: dict[tuple[str, str], UsageTotals],
    sessions_dir: Path,
    refresh_seconds: int | None = None,
) -> str:
    """전체 HTML 리포트를 생성한다.

    Args:
        aggregate: `(date, model)` 키를 가진 usage 집계 딕셔너리.
        sessions_dir: 리포트에 표시할 스캔 대상 디렉터리.
        refresh_seconds: 갱신 주기(초). None이거나 0 이하이면 자동 갱신을 넣지 않는다.

    Returns:
        완성된 HTML 문서 문자열.
    """

    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    refresh_script = render_live_refresh_script("report-content", "/fragment", refresh_seconds or 0)

    return f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="generated-at" content="{html.escape(generated_at)}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Usage Report</title>
  <style>
{BASE_STYLE}
    header {{
      padding: 28px 32px 18px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }}
    main {{
      padding: 24px 32px 40px;
    }}
    h1 {{
      margin: 0 0 8px;
      font-size: 28px;
    }}
    h2 {{
      margin: 28px 0 12px;
      font-size: 18px;
    }}
    .meta {{
      margin: 0 0 24px;
      color: var(--muted);
      font-size: 14px;
    }}
{REPORT_STYLE}  </style>
</head>
<body>
  <header>
    <h1>Codex Usage Report</h1>
    <p class="meta">생성 시각: {html.escape(generated_at)}</p>
  </header>
  <main id="report-content">
    {render_report_body(aggregate, sessions_dir)}
  </main>
  {render_tooltip_script()}
  {refresh_script}
</body>
</html>
"""




def run_live_server(sessions_dir: Path, host: str, port: int, refresh_seconds: int) -> None:
    """요청마다 최신 세션 파일을 다시 집계하는 로컬 HTTP 서버를 실행한다.

    Args:
        sessions_dir: 스캔할 Codex 세션 디렉터리.
        host: 바인딩할 호스트.
        port: 바인딩할 포트.
        refresh_seconds: 브라우저 자동 새로고침 주기.

    Returns:
        None.
    """

    # 파일별 (mtime, 크기)가 이전과 같으면 다시 파싱하지 않는다. 실사용 중에는
    # 그날 활성 세션 파일 하나만 계속 바뀌므로, 요청마다 수백 개 파일을 전부
    # 다시 읽는 대신 바뀐 파일만 다시 읽는다.
    file_cache: FileCache = {}

    def current_aggregate() -> dict[tuple[str, str], UsageTotals]:
        return aggregate_usage(sessions_dir, file_cache, DEFAULT_FILE_CACHE_PATH)

    class LiveUsageHandler(http.server.BaseHTTPRequestHandler):
        """실시간 사용량 HTML만 제공하는 요청 핸들러."""

        def do_GET(self) -> None:
            """대시보드 HTML, 조각 HTML(/fragment) 중 하나를 응답한다."""

            if self.path == "/fragment":
                body = render_report_body(current_aggregate(), sessions_dir).encode("utf-8")
                send_body(self, body, "text/html; charset=utf-8")
                return

            if self.path not in ("/", "/index.html"):
                self.send_error(404)
                return

            body = render_html(current_aggregate(), sessions_dir, refresh_seconds).encode("utf-8")
            send_body(self, body, "text/html; charset=utf-8")

        def log_message(self, format: str, *args: Any) -> None:
            """기본 HTTP 로그를 간단한 한 줄로 출력한다.

            /fragment는 열어둔 탭마다 반복 호출되므로 로그 노이즈를 줄이기 위해 건너뛴다.
            """

            if self.path == "/fragment":
                return
            print(f"{self.address_string()} - {format % args}")

    # 페이지가 열려 있는 동안 연결 하나가 keep-alive로 유지되면서, 백그라운드
    # /fragment 폴링용 새 연결을 못 받는 문제가 있어 단일 스레드 서버 대신 사용한다.
    with http.server.ThreadingHTTPServer((host, port), LiveUsageHandler) as server:
        print(f"serving live report at http://{host}:{port}")
        print(f"scanning {sessions_dir}")
        print("press Ctrl+C to stop")
        # 세션 폴더가 크면 최초 집계가 수십 초 걸릴 수 있어, 첫 방문자가 그 대기를
        # 그대로 겪지 않도록 서버가 요청을 받기 전에 백그라운드에서 미리 데워둔다.
        threading.Thread(target=current_aggregate, daemon=True).start()
        server.serve_forever()


def parse_args() -> argparse.Namespace:
    """CLI 인자를 파싱한다.

    Returns:
        argparse가 생성한 인자 네임스페이스.
    """

    parser = argparse.ArgumentParser(
        description="Scan Codex session JSONL files and generate an HTML token usage report."
    )
    parser.add_argument(
        "--sessions-dir",
        type=Path,
        default=default_sessions_dir(),
        help="Codex session JSONL directory. Default: ~/.codex/sessions",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("codex_usage_report.html"),
        help="Output HTML file path. Default: codex_usage_report.html",
    )
    parser.add_argument(
        "--serve",
        action="store_true",
        help="Start a live local web dashboard instead of writing a static HTML file.",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host for --serve. Default: 127.0.0.1",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8765,
        help="Port for --serve. Default: 8765",
    )
    parser.add_argument(
        "--refresh-seconds",
        type=int,
        default=3,
        help="Browser refresh interval for --serve. Default: 3",
    )
    return parser.parse_args()


def main() -> None:
    """CLI 진입점."""

    args = parse_args()
    sessions_dir = args.sessions_dir.expanduser()
    if args.serve:
        run_live_server(sessions_dir, args.host, args.port, args.refresh_seconds)
        return

    aggregate = aggregate_usage(sessions_dir, disk_cache_path=DEFAULT_FILE_CACHE_PATH)
    html_report = render_html(aggregate, sessions_dir)
    args.output.write_text(html_report, encoding="utf-8")
    print(f"wrote {args.output} ({len(aggregate)} date/model rows)")


if __name__ == "__main__":
    main()
