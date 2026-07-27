"use strict";

// 로컬 집계 결과만 표시하며 원본 세션 본문은 다루지 않는다.

const { detailProviders } = window.usageProviderView;
const PROVIDER_LABELS = { codex: "Codex", claude: "Claude" };

let allRows = [];
let selectedProvider = "all";

function formatNumber(value) {
  return new Intl.NumberFormat(window.usageLanguage.locale()).format(Number(value || 0));
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
      cell(PROVIDER_LABELS[row.provider] || row.provider),
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

function renderFilters(snapshot) {
  const toolbar = document.querySelector(".toolbar");
  const providers = detailProviders(snapshot);
  if (providers.length <= 1) {
    selectedProvider = providers[0] || "all";
    toolbar.hidden = true;
    toolbar.replaceChildren();
    return;
  }

  if (selectedProvider !== "all" && !providers.includes(selectedProvider)) {
    selectedProvider = "all";
  }
  toolbar.hidden = false;
  toolbar.replaceChildren();
  for (const provider of ["all", ...providers]) {
    const button = document.createElement("button");
    button.className = `filter${provider === selectedProvider ? " is-active" : ""}`;
    button.type = "button";
    button.dataset.provider = provider;
    button.textContent = provider === "all" ? "전체" : PROVIDER_LABELS[provider];
    button.addEventListener("click", () => {
      selectedProvider = provider;
      renderFilters(snapshot);
      renderRows();
    });
    toolbar.appendChild(button);
  }
}

function render(snapshot) {
  const analytics = snapshot.analytics;
  allRows = analytics && analytics.usage && Array.isArray(analytics.usage.rows)
    ? analytics.usage.rows
    : [];
  const totalTokens = allRows.reduce((total, row) => total + Number(row.totalTokens || 0), 0);
  document.getElementById("summary").textContent = `${allRows.length}개 날짜·모델 행 · ${formatNumber(totalTokens)} tokens · 최대 500행`;
  renderFilters(snapshot);
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

document.getElementById("refresh").addEventListener("click", () => refresh(true));
refresh();
