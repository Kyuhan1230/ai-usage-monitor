"use strict";

// 로컬 집계 결과만 표시하며 원본 세션 본문은 다루지 않는다.

let allRows = [];
let selectedProvider = "all";

function formatNumber(value) {
  return new Intl.NumberFormat("ko-KR").format(Number(value || 0));
}

function cell(text, className = "") {
  const element = document.createElement("td");
  element.textContent = text;
  element.className = className;
  return element;
}

function renderRows() {
  const body = document.getElementById("rows");
  const rows = selectedProvider === "all"
    ? allRows
    : allRows.filter((row) => row.provider === selectedProvider);
  body.replaceChildren();
  for (const row of rows) {
    const tableRow = document.createElement("tr");
    const cost = Number.isFinite(row.estimatedUsd) ? `$${row.estimatedUsd.toFixed(4)}` : "--";
    tableRow.append(
      cell(row.date),
      cell(row.provider === "codex" ? "Codex" : "Claude"),
      cell(row.model, "model"),
      cell(formatNumber(row.inputTokens), "number"),
      cell(formatNumber(row.cachedInputTokens), "number"),
      cell(formatNumber(row.cacheCreationInputTokens), "number"),
      cell(formatNumber(row.outputTokens), "number"),
      cell(formatNumber(row.totalTokens), "number"),
      cell(cost, "number"),
    );
    body.appendChild(tableRow);
  }
  document.getElementById("empty").hidden = rows.length > 0;
}

function render(snapshot) {
  const analytics = snapshot.analytics;
  allRows = analytics && analytics.usage && Array.isArray(analytics.usage.rows)
    ? analytics.usage.rows
    : [];
  const totalTokens = allRows.reduce((total, row) => total + Number(row.totalTokens || 0), 0);
  document.getElementById("summary").textContent = `${allRows.length}개 날짜·모델 행 · ${formatNumber(totalTokens)} tokens · 최대 500행`;
  renderRows();
}

async function refresh(force = false) {
  const button = document.getElementById("refresh");
  button.disabled = true;
  try {
    render(force ? await window.usageApp.refreshSnapshot() : await window.usageApp.snapshot());
  } finally {
    button.disabled = false;
  }
}

for (const button of document.querySelectorAll(".filter")) {
  button.addEventListener("click", () => {
    selectedProvider = button.dataset.provider;
    for (const candidate of document.querySelectorAll(".filter")) {
      candidate.classList.toggle("is-active", candidate === button);
    }
    renderRows();
  });
}

document.getElementById("refresh").addEventListener("click", () => refresh(true));
refresh();
