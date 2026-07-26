"use strict";

// 모든 WebView가 같은 로컬 테마 값을 사용한다. 유효하지 않은 값은 기존 기본값인 dark로 복구한다.
(function initializeTheme() {
  const STORAGE_KEY = "ai-usage-monitor-theme";
  const VALID_THEMES = new Set(["dark", "light"]);

  function normalizeTheme(value) {
    return VALID_THEMES.has(value) ? value : "dark";
  }

  function applyTheme(value) {
    const theme = normalizeTheme(value);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    return theme;
  }

  function readTheme() {
    try {
      return normalizeTheme(window.localStorage.getItem(STORAGE_KEY));
    } catch (_error) {
      return "dark";
    }
  }

  function setTheme(value) {
    const theme = applyTheme(value);
    try {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } catch (_error) {
      // 저장소를 사용할 수 없어도 현재 창의 테마 변경은 유지한다.
    }
    return theme;
  }

  applyTheme(readTheme());
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) {
      applyTheme(event.newValue);
    }
  });

  window.usageTheme = { applyTheme, readTheme, setTheme, STORAGE_KEY };
}());
