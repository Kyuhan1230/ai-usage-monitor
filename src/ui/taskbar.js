"use strict";
const label = document.getElementById("usage");
async function refresh() {
  try {
    const usage = await window.__TAURI__.core.invoke("taskbar_usage");
    label.textContent = usage.percent == null ? "--%" : `${usage.percent}%`;
    label.classList.toggle("stale", usage.stale);
    document.body.classList.toggle("dark", !usage.light);
    label.title = usage.tooltip;
  } catch (_) {
    label.textContent = "--%";
  }
}
refresh();
setInterval(refresh, 30000);
