"use strict";
const label = document.getElementById("usage");
function updateLevel(percent, stale) {
  label.classList.toggle("caution", !stale && percent != null && percent > 10 && percent <= 15);
  label.classList.toggle("warning", !stale && percent != null && percent > 5 && percent <= 10);
  label.classList.toggle("critical", !stale && percent != null && percent <= 5);
}
async function refresh() {
  try {
    const usage = await window.__TAURI__.core.invoke("taskbar_usage");
    label.textContent = usage.percent == null ? "--%" : `${usage.percent}%`;
    label.classList.toggle("stale", usage.stale);
    updateLevel(usage.percent, usage.stale);
    document.body.classList.toggle("dark", !usage.light);
    label.title = usage.tooltip;
  } catch (_) {
    label.textContent = "--%";
    label.classList.toggle("stale", false);
    updateLevel(null, false);
  }
}
refresh();
setInterval(refresh, 30000);
