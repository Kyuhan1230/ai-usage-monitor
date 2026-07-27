# Third-party notices

Codex Claude Usage 자체 소스는 [MIT License](LICENSE)로 배포된다. v1.0 설치본은 Rust로 컴파일되며 다음 주요 오픈소스 구성 요소와 그 전이 의존성을 사용한다.

- Tauri, Wry와 Tao
- serde, serde_json, chrono, regex와 winreg
- tauri-plugin-notification
- Microsoft Edge WebView2 Runtime(Windows 시스템 구성요소, 설치본에 번들하거나 자동 다운로드하지 않음)

`@tauri-apps/cli`와 Tauri bundler는 개발·패키징 도구로만 사용된다. 이 버전은 Electron, Chromium, Node.js 런타임, CPython, FastAPI, Uvicorn과 node-pty를 설치본에 포함하지 않는다.

각 Rust crate와 빌드 도구는 해당 프로젝트의 라이선스 조건에 따라 제공된다. OpenAI, Codex, Anthropic 및 Claude의 이름과 표장은 각 권리자의 자산이다. 이 프로젝트는 OpenAI 또는 Anthropic이 제작·보증·후원한 공식 제품이 아니다.

Compact 화면의 Claude glyph 경로는 Simple Icons의 Claude 아이콘을 사용하며 CC0 1.0 조건으로 제공된다. Claude 표장은 Anthropic의 자산이다. Codex 식별에는 OpenAI 공식 브랜드 가이드가 제공하는 Blossom 원본 형태를 사용하며 OpenAI의 표장 사용 조건을 따른다.
