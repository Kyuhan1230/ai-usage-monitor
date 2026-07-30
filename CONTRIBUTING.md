# Contributing

Codex Claude Usage에 관심을 가져주셔서 감사합니다. 버그 수정, 기능 개선, 문서 보완과 테스트 추가를 환영합니다.

## Before you start

- 큰 기능이나 동작 변경은 먼저 GitHub Issue에서 방향을 논의해 주세요.
- 보안 취약점은 공개 Issue 대신 [SECURITY.md](SECURITY.md)의 비공개 신고 절차를 사용해 주세요.
- 실제 세션 JSONL, 인증 정보, 사용자 홈 경로가 포함된 로그는 커밋하거나 Issue에 첨부하지 마세요.

## Development setup

필요 환경:

- Windows 10 이상
- Node.js 22.12.0과 npm 10.9.0
- Rust 1.97.1 MSVC toolchain, `rustfmt`, `clippy`
- Microsoft C++ Build Tools와 WebView2

Node/npm/Rust는 소스 개발과 빌드에만 필요하다. GitHub Release의 설치 파일을 실행하는 일반 고객 PC에는 이 개발 툴체인이 필요하지 않으며 앱이 자동 설치하지도 않는다.

> [!IMPORTANT]
> Node/npm과 Rust compiler의 repository-level pin은 [Codex CLI 온보딩 실행 계획](docs/codex-cli-onboarding/task.md)의 선행 Release 계약이다. `.node-version`, `packageManager`, `rust-toolchain.toml`, CI 값과 toolchain preflight를 함께 갱신하며 floating `stable`을 workflow에 추가하지 않는다.

```powershell
git clone https://github.com/Kyuhan1230/ai-usage-monitor.git
cd ai-usage-monitor
npm run verify:toolchain
npm ci
npm run app
```

전체 Windows 사전 점검은 `powershell -ExecutionPolicy Bypass -File scripts/check-dev-environment.ps1`로 실행한다. rustup이 설치된 개발자 PC에서 `cargo`를 처음 실행하면 repository에 고정된 toolchain을 내려받을 수 있다. 이는 전역 default Rust를 바꾸는 것과 다르다. rustup이 없거나 network·MSVC component가 준비되지 않은 PC에는 Rust가 자동 설치되지 않으며 preflight가 실패 원인을 표시한다.

## Making changes

1. 최신 `main`에서 작업 브랜치를 만듭니다.
2. 변경 범위를 작게 유지하고 관련 테스트를 함께 추가합니다.
3. 사용자에게 보이는 동작이나 설정이 바뀌면 README 또는 관련 문서를 갱신합니다.
4. Pull request 전에 전체 검증을 실행합니다.

```powershell
npm test
npm run dist
```

## Codex 설치·로그인 시험 등급

Codex CLI의 설치, 발견, 버전, 로그인 또는 Setup 상태를 바꾸는 PR은 [정본 명세](docs/codex-cli-onboarding/spec.md)의 시험 등급을 구분해 보고해야 한다.

| 등급 | 위치와 주체 | 범위 | 계정 사용 |
| --- | --- | --- | --- |
| T0 | Rust/UI 순수 단위 시험 | path, version, 상태·오류 mapping과 privacy-safe DTO | 없음 |
| T1 | PR의 GitHub Windows 자식 프로세스 시험 | fake CLI, 실제 process/timeout/cancel, alias·standalone·npm 조합 | 없음 |
| T2 | [`Codex CLI official installer smoke`](.github/workflows/codex-cli-installer-smoke.yml) | 실제 공식 installer의 기본/custom 위치, 실제 CLI capability, 비어 있는 `CODEX_HOME`, repository live resolver | 없음 |
| T3 | [일회성 원격 Windows 11 절차](docs/codex-cli-onboarding/REMOTE_WINDOWS_TEST.md) | 사람 OAuth/MFA, 첫 실제 사용량, 재부팅, legacy 충돌, uninstall 보존 | 권한 있는 tester가 VM browser에서 직접 사용 |

T0/T1 결과를 실제 공식 installer 또는 OAuth 결과라고 부르지 않는다. T2는 GitHub-hosted runner에서 account secret 없이 실행하므로 OAuth와 실제 사용량을 증명하지 않는다. T3 credential을 GitHub Actions secret, test fixture, Issue 또는 PR에 넣지 않는다.

T2 workflow의 `test:codex-live-install` entrypoint는 다음 계약을 가져야 한다.

- `AI_USAGE_MONITOR_T2_CODEX_PATH`: workflow가 실제 설치한 CLI 경로. log나 renderer에 원문을 출력하지 않는다.
- `AI_USAGE_MONITOR_T2_CODEX_HOME`: 비어 있는 격리 credential root.
- `AI_USAGE_MONITOR_T2_EXPECTED_SOURCE`: `default_standalone_path` 또는 `custom_install_dir`. 공식 URL로 설치했다는 operation evidence와 발견 위치 source를 혼합하지 않는다.
- resolver, version/capability probe와 auth probe가 실제 설치 후보를 사용했는지 확인한다.
- raw path와 CLI stdout/stderr를 artifact로 만들지 않는다.
- harness가 없거나 실행된 test가 0개면 T2는 실패해야 한다.

T2는 `workflow_dispatch`와 주간 schedule로 실행한다. workflow가 아직 default branch에 없는 PR은 maintainer가 `test:codex-t2` label을 붙였을 때만 같은 credential-free workflow를 실행한다. 외부 설치 서비스 장애가 모든 PR을 막지는 않지만 공개 Release 후보에는 같은 commit의 기본/custom job 성공 evidence가 필요하다.

T3 tester는 [smoke report template](docs/community/INSTALL_SMOKE_REPORT_TEMPLATE.md)을 사용한다. 보고서의 SHA-256과 최종 공개 installer가 다르거나 T3 뒤 installer를 다시 빌드하면 시험을 다시 해야 한다.

## Pull requests

PR 설명에는 다음 내용을 포함해 주세요.

- 무엇을 왜 변경했는지
- 사용자에게 미치는 영향
- 실행한 테스트와 수동 검증
- 설치, 로컬 데이터 처리 또는 개인정보 보호 경계에 미치는 영향
- 실행한 시험 등급과 실행하지 못한 상위 등급
- evidence에 credential, 계정 식별자, raw CLI 출력과 전체 사용자 경로가 없다는 확인

리뷰 가능한 크기로 유지하고, 관련 없는 포맷 변경이나 생성 파일을 함께 넣지 않는 것을 권장합니다.
