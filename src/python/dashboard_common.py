"""Shared HTML/dashboard helpers for local usage dashboards."""

from __future__ import annotations

import html
import http.server
from pathlib import Path
from typing import Any, TypeAlias


FileCache: TypeAlias = dict[Path, tuple[tuple[float, int], dict[tuple[str, str], Any]]]


BASE_STYLE = """
    :root {
      color-scheme: dark;
      --bg: #0a0c10;
      --surface: #12151b;
      --surface-2: #181c24;
      --border: #242933;
      --text: #e7e9ee;
      --muted: #8891a3;
      --accent: #e8b34c;
      --accent-soft: rgba(232, 179, 76, 0.12);
      --ok: #5fd4a0;
      --warn: #e8b34c;
      --critical: #f0645f;
      --mono: "Cascadia Code", "Cascadia Mono", Consolas, "SFMono-Regular", Menlo, monospace;
    }
    :root[data-theme="light"] {
      color-scheme: light;
      --bg: #f5f6f8;
      --surface: #ffffff;
      --surface-2: #eef1f5;
      --border: #d8dee8;
      --text: #1b2430;
      --muted: #667085;
      --accent: #b7791f;
      --accent-soft: rgba(183, 121, 31, 0.12);
      --ok: #16815a;
      --warn: #b7791f;
      --critical: #cf3f3a;
    }
    * {
      box-sizing: border-box;
    }
    * {
      scrollbar-width: thin;
      scrollbar-color: color-mix(in srgb, var(--muted) 55%, transparent) var(--surface-2);
    }
    *::-webkit-scrollbar {
      width: 10px;
      height: 10px;
    }
    *::-webkit-scrollbar-track {
      background: var(--surface-2);
      border-radius: 999px;
    }
    *::-webkit-scrollbar-thumb {
      background: color-mix(in srgb, var(--muted) 55%, transparent);
      border: 2px solid var(--surface-2);
      border-radius: 999px;
    }
    *::-webkit-scrollbar-thumb:hover {
      background: color-mix(in srgb, var(--muted) 75%, transparent);
    }
    body {
      margin: 0;
      font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    h1, h2 {
      font-weight: 600;
      letter-spacing: 0;
    }
    code {
      font-family: var(--mono);
    }
    [data-tip] {
      position: relative;
      cursor: help;
      border-bottom: 1px dotted var(--muted);
    }
    .floating-tooltip {
      position: fixed;
      background: #1c2029;
      color: var(--text);
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      font-size: 12px;
      font-weight: 400;
      line-height: 1.45;
      max-width: 340px;
      white-space: normal;
      text-transform: none;
      letter-spacing: 0;
      box-shadow: 0 8px 20px rgba(0, 0, 0, .5);
      pointer-events: none;
      z-index: 9999;
    }
"""


REPORT_STYLE = """
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin: 0 0 24px;
    }
    .stat {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 16px;
    }
    .stat .label {
      color: var(--muted);
      font-size: 13px;
    }
    .stat .value {
      margin-top: 8px;
      font-family: var(--mono);
      font-size: 24px;
      font-weight: 600;
    }
    .table-wrap {
      max-height: 420px;
      overflow: auto;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    table {
      width: 100%;
      min-width: 880px;
      border-collapse: collapse;
      font-size: 14px;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
    }
    th {
      position: sticky;
      top: 0;
      text-align: left;
      background: var(--surface-2);
      color: var(--muted);
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .04em;
      z-index: 1;
    }
    tbody tr:hover td {
      background: var(--surface-2);
    }
    tr:last-child td {
      border-bottom: 0;
    }
    td {
      font-family: var(--mono);
    }
    td:first-child, td:nth-child(2) {
      font-family: inherit;
    }
    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .total {
      color: var(--accent);
      font-weight: 600;
    }
    .empty {
      padding: 16px;
      background: var(--accent-soft);
      border: 1px solid var(--accent);
      border-radius: 8px;
    }
"""


def render_th(label: str, class_name: str = "", tooltip_text: str | None = None) -> str:
    """Render a table header cell with an optional tooltip.

    Args:
        label: Header label to display.
        class_name: Optional CSS class for the th element.
        tooltip_text: Optional tooltip text.

    Returns:
        HTML th fragment.
    """

    class_attr = f' class="{html.escape(class_name)}"' if class_name else ""
    if not tooltip_text:
        return f"<th{class_attr}>{html.escape(label)}</th>"
    escaped_tip = html.escape(tooltip_text)
    return f'<th{class_attr}><span tabindex="0" data-tip="{escaped_tip}" title="{escaped_tip}">{html.escape(label)}</span></th>'


def render_usage_table(rows: list[dict[str, str]], columns: list[tuple[str, str, str | None]]) -> str:
    """Render shared usage table markup from declared columns.

    Args:
        rows: Row dictionaries containing already escaped cell HTML strings.
        columns: Tuples of field name, header label, and optional tooltip text.

    Returns:
        Complete table wrapper HTML.
    """

    headers = []
    text_fields = {"date", "model", "models"}
    for field_name, header_label, tooltip_text in columns:
        class_name = "" if field_name in text_fields else "num"
        headers.append(render_th(header_label, class_name, tooltip_text))

    body_rows: list[str] = []
    for row in rows:
        cells = []
        for field_name, _header_label, _tooltip_text in columns:
            class_name = ""
            if field_name not in text_fields:
                class_name = "num total" if field_name == "total_tokens" else "num"
            class_attr = f' class="{class_name}"' if class_name else ""
            cells.append(f"<td{class_attr}>{row.get(field_name, '')}</td>")
        body_rows.append("<tr>" + "".join(cells) + "</tr>")

    body_html = "\n".join(body_rows)
    return f"""
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            {"".join(headers)}
          </tr>
        </thead>
        <tbody>
          {body_html}
        </tbody>
      </table>
    </div>
"""


def render_live_refresh_script(target_id: str, fragment_path: str, refresh_seconds: int) -> str:
    """Render JavaScript that periodically refreshes one HTML fragment.

    Args:
        target_id: Element id to replace.
        fragment_path: HTTP path returning fragment HTML.
        refresh_seconds: Refresh interval in seconds.

    Returns:
        Script tag or an empty string when disabled.
    """

    if refresh_seconds <= 0:
        return ""

    return f"""
  <script>
    (function () {{
      var target = document.getElementById("{target_id}");
      var lastBody = target ? target.innerHTML : "";
      var inFlight = false;
      function refresh() {{
        if (inFlight) {{
          return;
        }}
        inFlight = true;
        fetch("{fragment_path}", {{ cache: "no-store" }})
          .then(function (res) {{ return res.ok ? res.text() : null; }})
          .then(function (body) {{
            if (body !== null && target && body !== lastBody) {{
              lastBody = body;
              target.innerHTML = body;
              target.classList.remove("is-loading");
            }}
          }})
          .catch(function () {{}})
          .finally(function () {{ inFlight = false; }});
      }}
      refresh();
      setInterval(refresh, {refresh_seconds * 1000});
    }})();
  </script>
"""


def send_body(handler: http.server.BaseHTTPRequestHandler, body: bytes, content_type: str) -> None:
    """Send a no-store HTTP 200 response and ignore client disconnects.

    Args:
        handler: Request handler.
        body: Response body bytes.
        content_type: Content-Type header value.

    Returns:
        None.
    """

    handler.send_response(200)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    try:
        handler.end_headers()
        handler.wfile.write(body)
    except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
        pass
