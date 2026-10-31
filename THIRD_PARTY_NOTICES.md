# Third-party notices

Codex Claude Usage 자체 소스는 [MIT License](LICENSE)로 배포됩니다. 앱은 아래 주요 구성 요소와 그 의존성을 사용합니다. 각 구성 요소에는 해당 프로젝트의 라이선스가 적용됩니다.

- [Tauri](https://github.com/tauri-apps/tauri), Wry, Tao와 Tauri 플러그인(notification, single-instance, updater)
- Rust 라이브러리: chrono, regex, semver, serde, serde_json, windows, winreg
- Microsoft Edge WebView2 Runtime: 별도로 설치된 시스템 런타임을 사용하며, 설치본에 포함하거나 자동 다운로드하지 않습니다.

`@tauri-apps/cli`와 Tauri bundler는 개발·패키징 도구입니다. 앱의 Rust 의존성 및 버전은 [Cargo.lock](src-tauri/Cargo.lock), 개발용 Node.js 의존성은 [package-lock.json](package-lock.json)을 참고하세요. 위 목록은 주요 구성 요소를 안내하며 전체 전이 의존성의 라이선스 고지 목록은 아닙니다.

OpenAI, Codex, Anthropic 및 Claude의 이름과 표장은 각 권리자의 자산입니다. 이 프로젝트는 OpenAI 또는 Anthropic이 제작·보증·후원한 공식 제품이 아닙니다.

Compact 화면의 Claude glyph 경로는 Simple Icons의 Claude 아이콘을 사용하며 CC0 1.0 조건으로 제공된다. Claude 표장은 Anthropic의 자산이다. Codex 식별에는 OpenAI 공식 브랜드 가이드가 제공하는 Blossom 원본 형태를 사용하며 OpenAI의 표장 사용 조건을 따른다.
