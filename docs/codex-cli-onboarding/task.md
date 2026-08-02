# Codex CLI 설치·탐지·로그인 강화 실행 계획

> 상태: In progress — implementation commit T2 통과, 최종 standard CI·same-commit T2 재실행과 사람 T3 대기
> 상위 명세: [spec.md](spec.md)
> 관련 이슈: [#33 Codex 로그인 이슈](https://github.com/Kyuhan1230/ai-usage-monitor/issues/33)
> 선행 수정: [PR #34](https://github.com/Kyuhan1230/ai-usage-monitor/pull/34)
> 최초 작성: 2026-07-30

## 1. 실행 원칙

이 문서는 구현 순서, 대상 파일, 선행 조건, 시험과 완료 기준을 정의한다. 체크박스는 코드가 작성됐다는 이유만으로 완료하지 않는다.

각 task의 공통 완료 조건:

1. 실패를 재현하거나 계약을 고정하는 시험을 먼저 추가한다.
2. 구현 뒤 해당 시험과 전체 regression suite가 통과한다.
3. raw credential, 계정 출력, 사용자 home path가 로그·fixture·screenshot에 없다.
4. 문서와 실제 UI 문구가 일치한다.
5. 변경된 상태와 오류 코드에 recovery 행동이 있다.
6. 원격 시험은 실행 URL, commit, artifact hash를 evidence로 남긴다.
7. “terminal을 열었다”는 사실을 설치 또는 로그인 성공 증거로 사용하지 않는다.

작업 중 임의의 최소 Codex version, unauthenticated exit code 또는 ARM64 지원을 추측하지 않는다. 조사 task에서 실제 evidence를 만든 뒤 확정한다.

## 2. 완료 정의

전체 계획은 다음 조건을 모두 만족할 때 완료한다.

- [ ] `spec.md`의 AC-01부터 AC-18까지 각각 자동 또는 수동 evidence가 있다.
- [ ] 모든 PR에서 T0 단위 시험과 T1 Windows process integration이 실행된다.
- [ ] Release candidate commit에서 T2 실제 공식 installer smoke가 통과한다.
- [ ] 폐기 가능한 remote Windows VM에서 T3 사용자 OAuth와 첫 사용량 확인이 통과한다.
- [ ] Node.js `22.12.0`, npm `10.9.0`, 정확한 Rust compiler가 repository와 CI에 고정돼 있다.
- [ ] 고객용 installer 실행에는 Node/npm/Rust가 필요하지 않다는 설명이 README와 Setup에 있다.
- [ ] 실제 로그인은 사용자가 브라우저에서 수행하고 앱은 선택 CLI 실행·상태 재확인만 담당한다.
- [ ] credential 인증과 현재 사용량 준비가 분리되고, `login status` exit `0`만으로 사용량 연결 성공을 표시하지 않는다.
- [ ] 설치·로그인·수집의 원문 출력과 전체 CLI path가 renderer에 노출되지 않는다.
- [ ] `README`, `PRIVACY`, historical refactor docs, smoke template이 현재 동작과 모순되지 않는다.
- [ ] rollback이 Codex CLI, credential, 사용자 PATH를 삭제하지 않는다는 시험 또는 검토 evidence가 있다.

### 2.1 현재 진행 상태

2026-07-31 현재 아래 표는 작업 branch의 진행 상황을 설명한다. 개별 체크박스는 해당 task의 요구사항뿐 아니라 시험 URL·commit·artifact hash까지 생긴 뒤에만 닫는다. 구현 코드가 존재하더라도 release commit의 최종 gate가 없으면 체크박스를 닫지 않는다.

| Phase | 상태 | 아직 닫지 않는 이유 |
| --- | --- | --- |
| 0 기준선·외부 계약 | 부분 완료 | 공식 계약·compatibility·T2 snapshot은 존재. T3 운영 값과 publisher provenance는 `TBD/No-Go` |
| 1 툴체인 고정 | 구현·로컬 검증 완료 | pinned Node.js `22.12.0`, npm `10.9.0`, Rust `1.97.1` local pass. 최종 release commit standard CI 필요 |
| 2 characterization | 구현 완료, ledger 보강 필요 | 현재/변경 동작과 exact command evidence를 최종 ledger에 연결 |
| 3~6 backend·operation·Setup UI | 대부분 구현, 후속 계약 필요 | credential auth와 usage readiness 분리 `CSH-058`, 실제 file map 정합화와 독립 review 필요 |
| 7 T0/T1 | local full suite PASS | implementation commit의 standard CI는 installed-app byte comparison에서 실패. 수정 commit의 full CI pending |
| 7 T2 | implementation commit PASS | `62c208c6821aa3db5c38da03c4ee2b8229d56492`의 [run 30567446372](https://github.com/Kyuhan1230/ai-usage-monitor/actions/runs/30567446372) default/custom PASS. 후속 documentation/수정 commit은 same-commit T2 재실행 필요 |
| 7 T3 | runbook 작성, **미실행** | pristine no-Codex/no-Node/npm/Rust baseline, 사람 OAuth/MFA, first usage, reboot/conflict/uninstall 필요 |
| 8 문서·개인정보 | 보강 중 | README troubleshooting, auth/usage 상태와 현재 UI의 최종 정합성 필요 |
| 9 Release | **No-Go** | final CI, release-commit T2, T3, 독립 tester/reviewer, environment 보호와 release immutability 미충족 |

따라서 “코드가 있다”, “가짜 CLI 시험이 통과했다”, “로그인 terminal이 열렸다”는 이유만으로 이 계획 전체를 완료 처리하지 않는다.

### 2.2 실제 구현 파일과 증거 map

계획 중 제안했던 `candidate.rs`, `select.rs`는 별도 파일로 만들지 않았고 현재 구현은 아래 파일에 통합돼 있다. 이후 task의 대상 파일은 이 map을 우선한다.

| 영역 | 실제 파일 | 구현 상태 | 남은 release 증거 |
| --- | --- | --- | --- |
| candidate inventory·canonicalization·selection | `src-tauri/src/codex_cli/discovery.rs`, `types.rs` | 구현·unit test 존재 | final Windows CI, release-commit T2 |
| version/capability/auth command | `src-tauri/src/codex_cli/probe.rs` | 구현·unit/live harness 존재 | credential/usage 분리 case |
| child process tree | `src-tauri/src/codex_cli/process_tree.rs` | Windows Job Object와 regression fixture 존재 | final Windows CI |
| install/login operation | `src-tauri/src/codex_cli/operation.rs`, `src-tauri/src/lib.rs` | tracked operation 존재 | T3 visible terminal·cancel·restart |
| safe errors·DTO | `src-tauri/src/codex_cli/error.rs`, `types.rs`, `src-tauri/src/lib.rs` | 구현·privacy test 존재 | CSH-058 DTO와 UI |
| Setup renderer | `src/ui/setup.js`, `setup-view.js`, `bridge.js`, `language.js` | 구현·UI test 존재 | auth/usage copy와 T3 |
| T2 | `.github/workflows/codex-cli-installer-smoke.yml`, `codex_live_install` example | implementation commit PASS | 변경된 release commit에서 재실행 |
| Release | `.github/workflows/release.yml`, `scripts/release-evidence.js` | gate 구현 | 외부 protection, T3와 immutable release |

[원격 T2 snapshot](evidence/REMOTE_T2_2026-07-31.md)은 official script hash, 두 job, CLI version과 sanitized artifact digest를 기록한다. [Standard CI run 30567446378](https://github.com/Kyuhan1230/ai-usage-monitor/actions/runs/30567446378)은 최종 green이 아니므로 전체 자동 gate를 완료로 표시하지 않는다.

## 3. 의존 관계와 권장 변경 묶음

```text
Phase 0 기준선·외부 계약
  ├─ Phase 1 툴체인 고정
  └─ Phase 2 현 동작 characterization
       └─ Phase 3 도메인·IPC 계약
            └─ Phase 4 후보 발견·검증·선택
                 └─ Phase 5 설치·로그인 orchestration
                      └─ Phase 6 Setup UI
                           └─ Phase 7 T0/T1/T2/T3 검증
                                └─ Phase 8 문서·개인정보
                                     └─ Phase 9 Release
```

변경은 다음처럼 작게 나눈다.

| 변경 묶음 | 포함 범위 | merge 조건 |
| --- | --- | --- |
| A | 기준선 시험, 툴체인 pin, safe error type | 현재 동작 regression 없음 |
| B | candidate inventory, version/capability probe, selection | T0/T1 discovery matrix green |
| C | tracked install/login operation과 IPC | process integration green |
| D | Setup state machine, conflict/custom path UI | UI state matrix와 accessibility green |
| E | T2 workflow, T3 runbook, privacy/docs, release gate | 실제 installer와 OAuth evidence |

PR #34는 App Execution Alias 제외의 선행 수정이다. 이 계획 전체가 끝났다는 증거로 취급하지 않는다.

## 4. Phase 0 — 기준선과 외부 계약 확정

### CSH-000 현재 evidence ledger 작성

- [ ] 담당 영역: QA/문서
- [ ] 선행 조건: 없음
- [ ] 대상:
  - `docs/codex-cli-onboarding/evidence/`
  - Issue #33
  - PR #34와 Actions run
- [ ] 실행:
  1. Issue #33의 앱 버전, Windows 버전, 재현 단계와 기대/실제 결과를 요약한다.
  2. PR #34의 commit, Actions run URL, Rust 시험 수, installer hash를 기록한다.
  3. 해당 시험이 fake `codex.cmd`를 사용했다는 한계를 명시한다.
  4. 기존 사용자 screenshot을 복제하지 않고 원격 Issue 링크만 둔다.
- [ ] 시험:
  - evidence에 이메일, 사용자명, 전체 home path가 없는지 review한다.
- [ ] 완료 기준:
  - 현재 확인된 사실과 아직 확인하지 못한 사실이 별도 목록으로 존재한다.

### CSH-001 문서 권위와 역사 기록 정리

- [ ] 담당 영역: 문서
- [ ] 선행 조건: CSH-000
- [ ] 대상:
  - `docs/refactor/1.0.2-cli-auth-detection.md`
  - `docs/refactor/1.0.3-live-path-refresh.md`
  - `docs/refactor/1.0.4-opt-in-codex-cli-install.md`
  - `docs/refactor/1.0.5-first-run-onboarding.md`
  - `docs/refactor/1.1.1-single-provider-onboarding.md`
- [ ] 실행:
  1. 각 파일 상단에 “historical decision record”임을 표시한다.
  2. 현재 Codex 계약은 `docs/codex-cli-onboarding/spec.md`를 보라고 링크한다.
  3. “Setup snapshot은 CLI를 실행하지 않는다”와 “Setup 진입 시 auth probe를 실행한다” 같은 버전별 차이를 삭제하지 말고 역사로 보존한다.
  4. 두 공급자 모두 인증해야 완료한다는 오래된 정책이 현재 단일 공급자 정책을 덮지 않게 한다.
  5. historical 문서를 대량 재작성하지 않는다. 후속 범위가 정해진 docs PR에서 각 파일 상단에 “역사 기록이며 현재 Codex 정본은 `docs/codex-cli-onboarding/spec.md`”라는 배너와 링크만 우선 추가한다.
- [ ] 완료 기준:
  - 새 기여자가 historical 문서를 현재 계약으로 오해할 수 없다.

### CSH-002 OpenAI 공식 계약 snapshot 확인

- [ ] 담당 영역: backend/QA
- [ ] 선행 조건: 없음
- [ ] 대상:
  - `docs/codex-cli-onboarding/evidence/official-contract-<date>.md`
- [ ] 실행:
  1. 공식 installer variable 문서에서 `install.ps1`, `CODEX_INSTALL_DIR`, `CODEX_NON_INTERACTIVE`, 기본 Windows 위치를 확인한다.
  2. 공식 command 문서에서 `codex login`, `--device-auth`, `codex login status`를 확인한다.
  3. 확인 날짜와 정확한 공식 URL을 기록한다.
  4. `CODEX_HOME/packages/standalone`은 cache이며 직접 실행 경로로 사용하지 않는다고 기록한다.
  5. installer script 자체를 내려받아 SHA-256과 주요 입력 환경 변수를 evidence에 기록하되 script 사본을 repository에 vendor하지 않는다.
- [ ] 완료 기준:
  - 구현에 사용한 모든 외부 가정이 날짜와 공식 출처를 가진다.

### CSH-003 Codex version·capability compatibility matrix 조사

- [ ] 담당 영역: backend/QA
- [ ] 선행 조건: CSH-002
- [ ] 대상:
  - `docs/codex-cli-onboarding/evidence/codex-compatibility-matrix.md`
- [ ] 실행:
  1. 현재 공식 standalone version을 기록한다.
  2. 지원 후보 version마다 다음 명령을 isolated VM 또는 CI에서 실행한다.
     - `codex --version`
     - `codex login --help`
     - `codex login status`
     - `codex app-server --help`
     - 인증된 T3 환경에서 `account/rateLimits/read`
  3. version 출력 형식, exit code, timeout, capability를 표로 기록한다.
  4. unauthenticated 상태에서 stdout/stderr 원문을 저장하지 않고 reviewer가 승인한 normalized signature만 fixture로 만든다.
  5. 현재 app-server 요청을 처음 지원한 검증 version을 최소 호환 baseline으로 제안한다.
  6. legacy npm Codex version별로 Node 없음, 후보 Node version, x64/ARM64 조합과 `node --version`/`process.arch`를 실측한다.
  7. npm client는 install/update에만 사용하고 실행 probe에는 Node runtime과 installed package가 핵심임을 matrix에 분리한다.
  8. 지원 Node 최소 version·architecture, 깨진 launcher control을 fixture로 만든다.
  9. 지원 중단 위험이 있는 experimental app-server 계약을 Release note에 명시한다.
- [ ] 완료 기준:
  - 최소 호환 version과 auth 판정 규칙이 추측이 아니라 실행 evidence에 근거한다.
  - legacy npm의 Node version·architecture 분류 기준도 실행 evidence에 근거한다.
  - 알 수 없는 nonzero를 `unauthenticated`로 취급하지 않는다.

### CSH-004 T3 remote Windows 운영 결정

- [ ] 담당 영역: release/보안
- [ ] 선행 조건: 없음
- [ ] 대상:
  - `docs/codex-cli-onboarding/remote-test-decision.md`
- [ ] 실행:
  1. Azure/AWS/GCP 또는 동등한 provider 중 Windows 11 desktop + RDP가 가능한 환경을 선택한다.
  2. 지원 image, x64/ARM64, 시간당 비용, egress, 최소 결제 단위를 기록한다.
  3. 월별 비용 한도와 자동 종료 시간을 정한다.
  4. 전용 ChatGPT 시험 계정의 소유자와 MFA 처리 책임을 정한다.
  5. VM image·snapshot에 credential을 남기지 않는 폐기 절차를 승인한다.
  6. provider credential은 repository와 GitHub artifact에 넣지 않는다.
  7. 문서의 subscription, region, image SKU/version, VM size, 비용 상한, auto-shutdown, tester/reviewer와 QA account owner의 모든 `TBD`를 닫는다.
- [ ] 완료 기준:
  - 다른 물리 PC 없이도 승인된 예산과 책임자로 T3를 재현할 수 있다.

### CSH-005 실제 Codex provenance 계약 조사

- [ ] 담당 영역: backend/보안/QA
- [ ] 선행 조건: CSH-002, CSH-003
- [ ] 대상:
  - `docs/codex-cli-onboarding/evidence/codex-provenance-matrix.md`
- [ ] 실행:
  1. 공식 installer로 설치한 x64/ARM64 standalone의 Authenticode 상태를 Windows `WinVerifyTrust`와 독립 PowerShell 확인으로 기록한다.
  2. signer subject, chain, timestamp가 version 간 안정적인지 조사한다.
  3. 공식 installer 또는 release metadata가 binary hash를 검증·공개하는지 확인한다.
  4. 반복 가능한 공식 signer/hash 계약이 없으면 publisher allowlist를 만들지 않는다.
  5. runtime verification은 cache-only/offline으로 실행해 예고 없는 revocation network 요청을 만들지 않게 한다.
  6. offline에서 확정할 수 없으면 실패가 아니라 `unverified`로 남긴다.
  7. `default_standalone_path`는 발견 위치일 뿐 진본 보증이 아니라고 source enum과 UI copy에 고정한다.
  8. provenance를 `verified_publisher / tracked_official_install / unverified / invalid`로 분리한다.
  9. 악성 fixture가 `--version`과 help를 흉내 내도 `verified_publisher`가 되지 않는 시험을 설계한다.
- [ ] 완료 기준:
  - `ready`라는 운영 호환성과 “실제 OpenAI publisher를 확인했다”는 provenance를 같은 값으로 표현하지 않는다.

## 5. Phase 1 — 개발 툴체인 재현성

### CSH-010 Node.js와 npm 고정

- [ ] 담당 영역: build/CI
- [ ] 선행 조건: 없음
- [ ] 대상:
  - `package.json`
  - `.node-version` 또는 repository에서 선택한 단일 version file
  - `.github/workflows/ci.yml`
  - `.github/workflows/release.yml`
  - 신규 `scripts/verify-toolchain.js`
- [ ] 구현:
  1. Node.js를 `22.12.0`으로 고정한다.
  2. npm을 `10.9.0`으로 고정하고 `package.json`에 `packageManager`를 추가한다.
  3. `engines.node`와 `engines.npm`은 exact 또는 CI가 강제할 수 있는 범위로 설정한다.
  4. CI에서 `node --version`과 `npm --version`을 preflight로 검사한다.
  5. version 불일치 시 dependency 설치 전에 실패한다.
  6. `package-lock.json` lockfileVersion과 `npm ci` 동작을 검증한다.
- [ ] 시험:
  - 정확한 version은 exit 0
  - patch 또는 npm client가 다르면 설명 가능한 exit nonzero
  - `npm ci` 뒤 worktree가 dirty하지 않음
- [ ] 완료 기준:
  - 로컬 문서, package metadata와 모든 workflow가 같은 Node/npm을 사용한다.

### CSH-011 Rust compiler 고정

- [ ] 담당 영역: build/CI
- [ ] 선행 조건: 현재 green CI
- [ ] 대상:
  - 신규 `rust-toolchain.toml`
  - `.github/workflows/ci.yml`
  - `.github/workflows/release.yml`
  - `README.md`
- [ ] 구현:
  1. current green Actions runner에서 `rustc -Vv`, `cargo -V`를 기록한다.
  2. 그 정확한 stable semver를 `rust-toolchain.toml`의 `channel`에 넣는다.
  3. 필요한 `rustfmt`, `clippy` component와 MSVC target을 명시한다.
  4. workflow의 floating `@stable` 입력을 toolchain file 기반 설치로 바꾼다.
  5. 정확한 version은 evidence에 쓰되 “latest stable”이라고 표현하지 않는다.
  6. rustup이 설치된 개발자 PC에서 repository의 `cargo`/`rustc`를 처음 실행하면 pinned toolchain이 없을 때 rustup이 자동 다운로드할 수 있음을 문서화한다.
  7. rustup 자체가 없으면 아무것도 자동 설치되지 않고 preflight가 실패한다는 경계를 문서화한다.
- [ ] 시험:
  - `cargo fmt --check`
  - `cargo clippy --locked --all-targets -- -D warnings`
  - `cargo test --locked`
- [ ] 완료 기준:
  - 새 stable release가 나와도 같은 commit의 compiler가 자동으로 바뀌지 않는다.

### CSH-012 GitHub Actions 공급망 pin

- [ ] 담당 영역: CI/보안
- [ ] 선행 조건: CSH-010, CSH-011
- [ ] 대상:
  - `.github/workflows/*.yml`
- [ ] 구현:
  1. `actions/checkout`, `actions/setup-node`, `actions/upload-artifact` 등 third-party action을 검토한다.
  2. mutable major tag 대신 검증한 commit SHA로 고정한다.
  3. 옆 주석에 사람이 읽을 수 있는 release tag를 남긴다.
  4. Dependabot 또는 정기 유지보수 PR로 SHA 업데이트 경로를 둔다.
  5. workflow permissions를 job에 필요한 최소 권한으로 유지한다.
- [ ] 시험:
  - CI와 Release workflow가 모두 새 SHA로 실행
  - permissions review
- [ ] 완료 기준:
  - workflow 실행 코드가 예고 없이 mutable tag를 따라가지 않는다.

### CSH-013 개발자 preflight와 고객 경계

- [ ] 담당 영역: build/문서
- [ ] 선행 조건: CSH-010, CSH-011
- [ ] 대상:
  - `scripts/verify-toolchain.js`
  - 필요 시 신규 `scripts/check-dev-environment.ps1`
  - `README.md`
- [ ] 구현:
  1. Node, npm, rustc, cargo, MSVC target, WebView2 build prerequisite를 검사한다.
  2. 누락 시 설치 링크와 필요한 version을 출력한다.
  3. preflight 자체는 전역 Node/npm/Rust를 자동 변경하지 않는다.
  4. rustup이 있는 기여자에게 일어날 수 있는 pinned toolchain 자동 다운로드와 전역 default 변경을 구분한다.
  5. rustup 없는 기여자, rustup 있는 기여자, CI, Release 고객의 네 경우를 표로 설명한다.
  6. CI는 pinned toolchain을 자동 설치하지만 고객용 앱은 어떤 개발 툴체인도 설치하지 않는다고 분리해 설명한다.
- [ ] 완료 기준:
  - “Rust가 자동 설치되는가?”에 고객/기여자/CI별로 하나의 일관된 답이 있다.

## 6. Phase 2 — 현재 동작 characterization

### CSH-020 resolver characterization 시험

- [ ] 담당 영역: backend/QA
- [ ] 선행 조건: 없음
- [ ] 대상:
  - `src-tauri/src/collector.rs`
  - 필요 시 `src-tauri/tests/codex_resolver_characterization.rs`
- [ ] 추가할 시험:
  - PATH `codex.exe`가 default standalone보다 먼저 선택되는 현재 동작
  - HKCU/HKLM PATH를 읽는 동작
  - `.exe/.cmd/.bat` launcher 확인
  - packaged resource 제외
  - App Execution Alias 제외
  - default standalone/npm/`.local` fallback
- [ ] 완료 기준:
  - resolver refactor 전후의 의도적 차이만 test diff로 드러난다.

### CSH-021 auth characterization 시험

- [ ] 담당 영역: backend/QA
- [ ] 선행 조건: 없음
- [ ] 대상:
  - `src-tauri/src/collector.rs`
- [ ] 추가할 시험:
  1. 정확한 선택 경로로 `login status`가 실행된다.
  2. stdin은 null이다.
  3. 8초 timeout이 적용된다.
  4. exit 0, exit 1, 다른 nonzero, spawn error, timeout을 별도 fixture로 만든다.
  5. 현재 구현이 nonzero를 모두 미인증으로 축약한다는 characterization을 먼저 고정한다.
  6. 새 구현 task에서 기대 상태를 세분화하면서 test expectation을 의도적으로 바꾼다.
- [ ] 완료 기준:
  - auth semantic 변경이 조용히 일어나지 않는다.

### CSH-022 설치·로그인 launcher characterization

- [ ] 담당 영역: backend/UI
- [ ] 선행 조건: 없음
- [ ] 대상:
  - `src-tauri/src/lib.rs`
  - `src/ui/bridge.js`
  - `src/ui/setup.js`
  - `tests/ui-tests.js`
- [ ] 추가할 시험:
  - 현재 Setup installer와 login이 `-NoExit`를 사용
  - command가 spawn 직후 `opened` 반환
  - UI가 수동 **상태 다시 확인**을 요구
  - installer URL과 `codex login` argument가 정확함
- [ ] 완료 기준:
  - tracked operation 도입 PR에서 제거해야 할 동작이 test 이름으로 명확하다.

### CSH-023 개인정보 characterization

- [ ] 담당 영역: 보안/QA
- [ ] 선행 조건: 없음
- [ ] 대상:
  - `src-tauri/src/collector.rs`
  - `src-tauri/src/lib.rs`
  - `tests/ui-tests.js`
- [ ] 추가할 시험:
  - auth output이 snapshot에 포함되지 않음
  - raw selected path가 snapshot에 포함되지 않음
  - error serialization이 home directory pattern을 제거
  - app-server stderr가 renderer로 전파되는 현재 경로를 식별하는 regression test
- [ ] 완료 기준:
  - 이후 privacy hardening이 검증 가능한 baseline을 가진다.

## 7. Phase 3 — 도메인 모델과 IPC 계약

### CSH-030 Codex setup 모듈 분리

- [ ] 담당 영역: backend
- [ ] 선행 조건: CSH-020~023
- [ ] 실제 대상:
  - 신규 `src-tauri/src/codex_cli/mod.rs`
  - 신규 `src-tauri/src/codex_cli/types.rs`
  - 신규 `src-tauri/src/codex_cli/discovery.rs`
  - 신규 `src-tauri/src/codex_cli/probe.rs`
  - 신규 `src-tauri/src/codex_cli/error.rs`
  - 신규 `src-tauri/src/codex_cli/operation.rs`
  - `src-tauri/src/collector.rs`
  - `src-tauri/src/lib.rs`
- [ ] 구현:
  1. 사용량 RPC와 CLI setup discovery를 분리한다.
  2. path를 가진 내부 type과 renderer DTO를 별도 type으로 둔다.
  3. `lib.rs` Tauri command는 orchestration 호출만 담당하게 얇게 만든다.
  4. 기존 Claude resolver는 동작을 바꾸지 않는다.
- [ ] 완료 기준:
  - candidate와 operation unit test가 Tauri runtime 없이 실행된다.

### CSH-031 상태와 후보 type 정의

- [ ] 담당 영역: backend
- [ ] 선행 조건: CSH-030
- [ ] 대상:
  - `src-tauri/src/codex_cli/*.rs`
- [ ] 구현 type:
  - `CandidateSource`: `current_path / user_path / machine_path / default_standalone_path / legacy_npm / local_bin / custom_install_dir / manual`
  - `LauncherType`
  - `CandidateRejection`
  - `Compatibility`
  - `ProvenanceConfidence`: `verified_publisher / tracked_official_install / unverified / invalid`
  - `CodexCandidate`
  - `CliState`: `probing / missing / desktop_bundle_only / invalid_candidate / runtime_dependency_missing / runtime_dependency_incompatible / unsupported / conflict / ready / probe_error`
  - `InstallOperationState`: `idle / consent_required / starting / running / long_running / succeeded / failed / cancelled / detached`
  - `LoginOperationState`: `idle / starting / running / long_running / exited / failed / cancelled / detached`
  - `AuthState`: `unavailable / checking / unauthenticated / authenticated / error`
  - `UsageReadiness`: `unavailable / checking / ready / unsupported / error` — CSH-058 후속 구현
  - `SetupSafeErrorCode`
- [ ] 규칙:
  - enum은 exhaustively match한다.
  - renderer 문자열은 `serde(rename_all = "snake_case")` 또는 명시적 mapping으로 고정한다.
  - unknown internal error를 raw string으로 공개하지 않는다.
- [ ] 완료 기준:
  - `spec.md` 상태와 code enum이 1:1로 대응한다.

### CSH-032 privacy-safe snapshot DTO

- [ ] 담당 영역: backend/UI
- [ ] 선행 조건: CSH-031
- [ ] 대상:
  - `src-tauri/src/codex_cli/*.rs`
  - `src-tauri/src/lib.rs`
  - `src/ui/setup-view.js`
- [ ] 구현:
  1. 내부 `PathBuf`를 serialize할 수 없는 private field/type 경계로 둔다.
  2. renderer에는 ephemeral candidate ID/tag, privacy-safe display label, 발견 source, launcher, version, compatibility와 provenance만 보낸다.
  3. operation ID는 무작위·비추측 값으로 만들고 credential과 관계없게 한다.
  4. install operation, login operation, auth와 usage readiness 상태를 서로 다른 object로 보낸다.
  5. 전체 path를 넣으려 하면 실패하는 serialization test를 둔다.
- [ ] 완료 기준:
  - snapshot JSON에 drive-letter user path나 `%USERPROFILE%` 확장값이 없다.

### CSH-033 safe error mapper

- [ ] 담당 영역: backend/보안
- [ ] 선행 조건: CSH-031
- [ ] 대상:
  - 신규 `src-tauri/src/codex_cli/error.rs` 또는 동등 파일
- [ ] 구현:
  1. OS error, process result, probe result를 `SetupSafeErrorCode`로 변환한다.
  2. raw error는 backend memory에서만 진단에 쓰고 renderer에는 code만 보낸다.
  3. 확실하지 않은 network/proxy/policy 원인을 단정하지 않는다.
  4. UI용 recovery action mapping을 pure function으로 만든다.
  5. 다음 공개 코드를 빠짐없이 고정한다.
     - `codex_not_found`
     - `desktop_bundle_only`
     - `candidate_not_executable`
     - `candidate_version_unrecognized`
     - `candidate_unsupported`
     - `candidate_conflict`
     - `runtime_dependency_missing`
     - `runtime_dependency_incompatible`
     - `candidate_provenance_invalid`
     - `path_refresh_failed`
     - `install_target_invalid`
     - `install_spawn_failed`
     - `install_exit_nonzero`
     - `install_no_valid_cli`
     - `install_cancelled`
     - `login_spawn_failed`
     - `login_cancelled`
     - `login_unconfirmed`
     - `auth_probe_timeout`
     - `auth_probe_failed`
     - `usage_capability_missing`
     - `usage_account_access_unavailable` — CSH-058 후속 구현
     - `usage_capture_failed`
     - `usage_capture_timeout`
     - `operation_already_running`
     - `unknown_setup_error`
- [ ] 완료 기준:
  - 모든 오류 코드에 사용자 행동과 unit test가 있다.

## 8. Phase 4 — 후보 발견·검증·선택

### CSH-040 전체 candidate inventory

- [ ] 담당 영역: backend
- [ ] 선행 조건: CSH-030~033
- [ ] 대상:
  - `src-tauri/src/codex_cli/discovery.rs`
  - `src-tauri/src/codex_cli/types.rs`
- [ ] 구현:
  1. `where.exe` 결과를 전부 읽는다.
  2. process, HKLM, HKCU 환경을 대소문자 비구분 map으로 합쳐 일반 변수 확장용 user-over-machine snapshot을 만들되 PATH 목록 자체는 세 source 모두 보존한다.
  3. registry value type을 보존해 `REG_EXPAND_SZ`와 `%NAME%` token을 snapshot으로 확장한다.
  4. 중첩 변수는 최대 4회, cycle 감지와 unresolved-token rejection을 적용한다.
  5. process PATH, 확장된 HKCU PATH, 확장된 HKLM PATH를 전부 읽는다.
  6. default standalone, npm fallback, `.local` fallback을 추가한다.
  7. process/HKCU/HKLM `CODEX_INSTALL_DIR`를 같은 규칙으로 확장·검증하고 후보를 추가한다.
  8. 바깥 따옴표·공백을 제거하고 빈 entry, 상대 경로, unresolved entry를 제외한다.
  9. `codex`, `.exe`, `.cmd`, `.bat`를 확인한다.
  10. 첫 후보에서 멈추지 않는다.
- [ ] 시험:
  - source별 1개
  - source 중복
  - registry PATH 설치가 process PATH에 없음
  - custom install dir
  - `%LOCALAPPDATA%`와 `%USERPROFILE%` expansion
  - nested variable
  - cycle, unknown variable, 빈 entry, 상대 경로 rejection
  - 따옴표와 공백이 있는 absolute path
- [ ] 완료 기준:
  - 하나의 inventory에 모든 발견 source가 들어간다.

### CSH-041 canonicalization과 deduplication

- [ ] 담당 영역: backend
- [ ] 선행 조건: CSH-040
- [ ] 구현:
  1. case-insensitive path key를 만든다.
  2. 가능한 경우 Windows final path를 얻는다.
  3. junction/symlink 실패 시 안전한 lexical fallback을 사용한다.
  4. 동일 파일의 source metadata를 합친다.
  5. canonicalization 접근 거부를 `candidate_not_executable`과 혼동하지 않는다.
- [ ] 시험:
  - 대소문자 차이
  - slash 방향 차이
  - quoted PATH entry
  - trailing separator
  - expansion 뒤 absolute path
  - junction 가능 환경
- [ ] 완료 기준:
  - 같은 binary가 conflict count를 부풀리지 않는다.

### CSH-042 desktop bundle·execution alias 필터 강화

- [ ] 담당 영역: backend/QA
- [ ] 선행 조건: CSH-040
- [ ] 대상:
  - `src-tauri/src/codex_cli/discovery.rs`
- [ ] 구현:
  1. packaged resource와 execution alias를 별도 rejection enum으로 둔다.
  2. `/`와 `\`, 대소문자, 확장자 유무를 정규화한다.
  3. 단순히 directory 이름에 `WindowsApps`가 있다는 이유만으로 모든 사용자 파일을 차단하지 않는다.
- [ ] 시험:
  - 실제 형태 packaged resource
  - `%LOCALAPPDATA%\Microsoft\WindowsApps\codex.exe`
  - 정상 standalone control
  - 이름만 비슷한 비시스템 경로 control
- [ ] 완료 기준:
  - Issue #33 회귀 시험이 새 inventory에서도 통과한다.

### CSH-043 executable·version probe

- [ ] 담당 영역: backend
- [ ] 선행 조건: CSH-041, CSH-042, CSH-003
- [ ] 대상:
  - `src-tauri/src/codex_cli/probe.rs`
- [ ] 구현:
  1. candidate 전체 경로에 `--version`을 argument로 전달한다.
  2. stdin null, timeout 5초, window hidden, output 합계 16 KiB 제한을 적용한다.
  3. compatibility matrix에서 승인한 version 형식을 parse한다.
  4. 0-byte, spawn failure, timeout, malformed output을 별도 rejection으로 둔다.
  5. `semver` dependency를 추가하면 direct dependency와 lockfile을 함께 검토한다.
  6. 모든 probe를 범위 제한된 Windows Job Object 또는 동등 guard 안에서 실행한다.
  7. timeout에는 direct child와 모든 descendant를 종료하고 wait/reap한다.
- [ ] 시험:
  - stable version
  - prerelease/build metadata
  - multiline/garbage
  - oversized output
  - hang
  - `.cmd`가 `node.exe` 손자를 만든 뒤 timeout
  - 정상 완료와 timeout 뒤 잔존 descendant 0
  - access denied
- [ ] 완료 기준:
  - 존재만 하는 파일은 `ready`가 될 수 없다.

### CSH-044 capability·provenance probe와 지원 version 정책

- [ ] 담당 영역: backend
- [ ] 선행 조건: CSH-003, CSH-005, CSH-043
- [ ] 구현:
  1. 계정 정보를 읽지 않는 help command로 `login status`와 `app-server` 지원을 확인한다.
  2. 최소 호환 version 상수를 evidence와 함께 추가한다.
  3. version 숫자와 capability 결과가 다르면 capability를 우선한다.
  4. newer untested version은 기본 허용 + warning, old incompatible version은 차단한다.
  5. compatibility 변경 시험을 fixture로 고정한다.
  6. CSH-005에서 안정적인 signer 계약을 확인한 경우에만 Windows signature verification을 구현한다.
  7. runtime verification은 cache-only/offline으로 제한하고 network가 필요하면 `unverified`로 남긴다.
  8. 후보 provenance를 `verified_publisher / tracked_official_install / unverified / invalid`로 분리한다.
  9. default path는 `default_standalone_path`라는 발견 source로만 표시하고 진본으로 부르지 않는다.
  10. 비교 가능한 공식 manifest 없이 local SHA-256만으로 provenance를 높이지 않는다.
  11. `--version`과 help를 흉내 내는 fake CLI가 `verified_publisher`가 되지 않는 시험을 둔다.
- [ ] 완료 기준:
  - 구버전 CLI를 로그인 필요로 오인하지 않고 update 행동을 보여 준다.
  - 운영 호환성과 publisher provenance가 별도 필드로 판정된다.

### CSH-045 package-manager child 환경

- [ ] 담당 영역: backend
- [ ] 선행 조건: CSH-003, CSH-040, CSH-043
- [ ] 구현:
  1. `.cmd/.bat`는 `cmd.exe /D /C <launcher> <args>`로 실행한다.
  2. current + fresh user/machine PATH를 dedupe해 child environment에 명시한다.
  3. Node executable 누락을 generic auth 실패와 분리한다.
  4. 같은 환경의 `node --version`과 `node -p process.arch`를 bounded probe한다.
  5. compatibility matrix에서 확인한 Node 최소 version·architecture와 비교한다.
  6. Node 없음은 `runtime_dependency_missing`, Node old/wrong-architecture는 `runtime_dependency_incompatible`로 분류한다.
  7. 깨진 launcher 또는 잘못된 Codex package를 근거 없이 Node 문제로 단정하지 않는다.
  8. 설치된 launcher 실행에는 npm client가 매번 필요하지 않으며 npm client version은 개발 툴체인과 설치/update 맥락임을 진단 문구에 반영한다.
  9. PATHEXT 또는 shell injection에 의존하지 않는다.
- [ ] 시험:
  - npm launcher + 호환 Node
  - npm launcher + Node 없음
  - Node가 너무 오래됨
  - wrong Node architecture
  - Node 정상 + launcher 손상
  - stale process PATH + fresh HKCU Node
  - path 공백·한글
  - argument injection 문자열
- [ ] 완료 기준:
  - “npm 설치 파일은 찾았지만 실행 못함”의 원인이 정확히 표시된다.

### CSH-046 결정적 selection과 conflict

- [ ] 담당 영역: backend
- [ ] 선행 조건: CSH-040~045
- [ ] 대상:
  - `src-tauri/src/codex_cli/discovery.rs`
  - `src-tauri/src/codex_cli/probe.rs`
  - `src-tauri/src/codex_cli/types.rs`
- [ ] 구현:
  1. 명세 9.7의 priority를 pure function으로 구현한다.
  2. 명시적 사용자 선택 뒤에는 검증된 publisher, tracked official install, default-path, custom/PATH, legacy 순서를 적용한다.
  3. default path를 official provenance로 간주하지 않는다.
  4. default-path standalone + legacy npm은 deterministic candidate를 선택하고 conflict warning과 provenance를 남긴다.
  5. 같은 priority의 서로 다른 후보는 `conflict`로 멈춘다.
  6. invalid/unsupported/provenance-invalid 후보는 선택 목록에서 제외하되 진단 count에 남긴다.
  7. 순서를 섞은 동일 input에서 결과가 같다는 property-style test를 둔다.
- [ ] 완료 기준:
  - `where.exe` 출력 순서가 바뀌어도 선택 결과가 바뀌지 않는다.

### CSH-047 사용자 선택과 manual path

- [ ] 담당 영역: backend/UI/보안
- [ ] 선행 조건: CSH-032, CSH-046
- [ ] 대상:
  - Tauri native file picker integration
  - `src-tauri/src/codex_cli/discovery.rs`
  - `src-tauri/src/lib.rs`
  - 앱 로컬 selection state
- [ ] 구현:
  1. conflict 후보는 ephemeral candidate ID로 선택한다.
  2. 후보 DTO에 `사용자 PATH #2` 같은 privacy-safe display label, 짧은 session-only candidate tag와 provenance를 넣는다.
  3. 같은 source/version/launcher 후보도 tag로 구분한다.
  4. 실제 위치 확인은 renderer에 raw path를 주지 않고 명시적 클릭에서 backend native Explorer/file picker를 연다.
  5. native picker는 backend가 열고 raw path를 renderer에 돌려주지 않는다.
  6. 선택 candidate는 즉시 version/capability/provenance를 재검증한다.
  7. 발견 후보 선택은 app-local salt + canonical path fingerprint만 저장한다.
  8. off-PATH manual path는 기본적으로 session-only로 두고 지속 사용 방법을 안내한다.
  9. encrypted persistence를 도입하려면 별도 threat model과 개인정보 문서 승인을 먼저 받는다.
- [ ] 완료 기준:
  - custom path를 사용할 수 있고 raw path 저장·노출 없이 재선택할 수 있다.

### CSH-048 선택 경로의 전 단계 일관성

- [ ] 담당 영역: backend/QA
- [ ] 선행 조건: CSH-046
- [ ] 구현:
  1. version, auth, login, app-server가 하나의 `SelectedCodex` handle을 받게 한다.
  2. 각 단계에서 `resolve_codex_command()`를 다시 호출하지 않는다.
  3. 실행 직전 file identity가 바뀌면 전체 discovery로 돌아간다.
- [ ] 시험:
  - PATH의 첫 후보와 selected 후보가 다를 때 모든 command가 selected fixture에 도달
  - 실행 사이 파일 삭제·교체
- [ ] 완료 기준:
  - “검사는 A, 로그인은 B, 수집은 C”인 경로 혼선이 불가능하다.

## 9. Phase 5 — 설치·로그인 operation 추적

### CSH-050 operation manager

- [ ] 담당 영역: backend
- [ ] 선행 조건: CSH-031~033
- [ ] 대상:
  - `src-tauri/src/codex_cli/operation.rs`
  - `RuntimeState`
- [ ] 구현:
  1. process kind, operation ID, start time, state, safe error, child handle을 관리한다.
  2. install과 login에 별도 operation state를 두고 auth 사실 상태와 섞지 않는다.
  3. provider별 동시 operation을 하나로 제한한다.
  4. state transition을 단일 함수로 검증한다.
  5. visible child process를 background worker가 wait한다.
  6. process tree 취소는 Windows Job Object 또는 범위가 검증된 동등 방식으로 구현한다.
  7. image 이름 기반의 광범위한 `taskkill`은 사용하지 않는다.
  8. 10분 soft timeout은 `long_running`으로만 바꾸고 자동 kill하지 않는다.
- [ ] 시험:
  - 정상 exit
  - nonzero
  - duplicate start
  - cancel
  - app state drop
  - long-running
- [ ] 완료 기준:
  - operation state가 허용되지 않은 순서로 전이하지 않는다.

### CSH-051 tracked official installer

- [ ] 담당 영역: backend/UI
- [ ] 선행 조건: CSH-003, CSH-005, CSH-040~050
- [ ] 대상:
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/codex_cli/operation.rs`
  - `src/ui/bridge.js`
- [ ] 구현:
  1. 설치 전 consent payload에 공식 URL과 변경 범위를 제공한다.
  2. 승인 시점의 fresh process/HKCU/HKLM environment에서 install target을 `process > HKCU > HKLM > default`로 결정하고 pre-install candidate inventory와 함께 operation ID에 묶어 backend memory에 기록한다.
  3. 우선순위가 가장 높은 명시적 `CODEX_INSTALL_DIR`가 unresolved·cycle·relative·file·invalid metadata이면 낮은 scope/default로 fallback하지 않고 `install_target_invalid`로 installer 시작 전에 실패한다.
  4. inventory에는 canonical path의 salted fingerprint, file identity, size와 SHA-256을 사용하고 raw path를 renderer, log 또는 영구 저장소에 보내지 않는다.
  5. 승인 뒤 visible PowerShell을 `-NoExit` 없이 tracked child로 실행한다.
  6. interactive user flow에는 `CODEX_NON_INTERACTIVE`를 설정하지 않는다.
  7. child exit 뒤 fresh environment로 전체 candidate를 재탐지하고 pre/post inventory delta를 계산한다.
  8. operation target 안에서 새로 생기거나 file identity/hash가 변경된 compatible candidate가 정확히 하나일 때만 `tracked_official_install`을 부여한다.
  9. 설치 전부터 있던 unchanged candidate, target 밖의 concurrent candidate, 여러 delta로 인과관계가 모호한 후보는 provenance를 승격하지 않는다.
  10. default path 또는 exit 0만으로 공식 provenance를 추론하지 않는다.
  11. exit 0이지만 유효 후보가 없으면 실패다.
  12. nonzero라도 유효 후보가 있으면 ready와 warning을 함께 반환한다.
  13. 설치 뒤 auth probe를 자동 한 번 실행한다.
  14. operation이 terminal 상태가 되면 pre-install inventory 원본을 폐기한다.
- [ ] 시험:
  - spawn failure
  - exit 0 + valid
  - exit 0 + missing
  - nonzero + valid
  - nonzero + missing
  - cancel
  - preexisting default-path candidate unchanged → provenance 승격 없음
  - operation target에 새 candidate 하나 생성 → `tracked_official_install`
  - operation target의 기존 candidate binary 변경 → `tracked_official_install`
  - target 밖에서 concurrent candidate 생성 → 해당 후보는 `unverified`
  - operation target에 compatible delta 둘 이상 → provenance 승격 없음
  - process/HKCU/HKLM target precedence와 invalid highest-scope fail-closed
  - renderer snapshot, log와 persisted state에 raw path 없음
- [ ] 완료 기준:
  - UI의 설치 완료는 유효 CLI 재발견 뒤에만 표시된다.
  - `tracked_official_install`은 operation에 묶인 단일 pre/post delta로만 생성되며 publisher signature 보증과 구분된다.

### CSH-052 tracked browser OAuth login

- [ ] 담당 영역: backend/UI
- [ ] 선행 조건: CSH-048, CSH-050
- [ ] 구현:
  1. selected full path에 `login` argument를 전달한다.
  2. visible terminal을 `-NoExit` 없이 tracked child로 실행한다.
  3. 앱은 browser URL, credential, token을 가로채지 않는다.
  4. 시작/실행/장기 실행을 login operation의 `starting/running/long_running`으로 표시한다.
  5. child exit는 login operation을 `exited`, auth를 `checking`으로 바꾼다.
  6. selected CLI로 auth probe를 자동 실행한다.
  7. auth 확인이 실패하면 process exit를 로그인 성공으로 보지 않고 auth는 `unauthenticated` 또는 `error`, safe error는 `login_unconfirmed`로 둔다.
  8. 앱의 명시적 취소만 login operation `cancelled`로 분류한다. terminal 직접 종료는 `exited` 뒤 재probe한다.
- [ ] 시험:
  - fake CLI가 executable path와 exact args를 기록
  - browser login success simulation
  - user closes terminal
  - exit 0 but auth unconfirmed
  - timeout/long-running
- [ ] 완료 기준:
  - 앱이 어디까지 실행하고 사용자가 어디서 인증하는지 UI와 코드가 일치한다.

### CSH-053 device-code login

- [ ] 담당 영역: backend/UI
- [ ] 선행 조건: CSH-003, CSH-052
- [ ] 구현:
  1. 공식 지원이 확인된 candidate에만 **device code 방식**을 표시한다.
  2. selected full path에 `login --device-auth`를 전달한다.
  3. device code는 terminal에서 Codex가 사용자에게 직접 표시한다.
  4. 앱이 code를 capture하거나 저장하지 않는다.
  5. 완료 뒤 browser OAuth와 같은 auth probe를 수행한다.
- [ ] 완료 기준:
  - browser launch가 차단된 remote/enterprise 환경에 공식 fallback이 있다.

### CSH-054 operation event와 bounded polling

- [ ] 담당 영역: backend/UI
- [ ] 선행 조건: CSH-050~053
- [ ] 구현:
  1. Tauri event 또는 bounded polling API 중 하나를 선택한다.
  2. event payload는 privacy-safe install/login operation snapshot만 포함한다.
  3. frontend reload나 window recreate 뒤 현재 state를 다시 읽을 수 있다.
  4. polling을 택하면 interval과 최대 빈도를 고정하고 무한 1초 polling을 피한다.
- [ ] 완료 기준:
  - 사용자가 수동 새로고침을 누르지 않아도 operation 종료가 UI에 반영된다.

### CSH-055 앱 종료·재시작 복구

- [ ] 담당 영역: backend/QA
- [ ] 선행 조건: CSH-050
- [ ] 구현:
  1. 앱 종료 때 tracked child가 살아 있으면 명시적으로 cancel하지 않는 한 강제 종료하지 않는다.
  2. 다음 앱 시작은 stale operation 성공 상태를 복원하지 않는다.
  3. 이전 login operation은 `detached` 진단만 남기고 성공 여부는 추정하지 않는다.
  4. 전체 candidate discovery와 auth probe로 실제 상태를 재구성한다.
  5. 저장된 operation metadata에는 credential이나 path가 없다.
- [ ] 시험:
  - installer running 중 app 종료
  - login browser 중 app 종료
  - 재실행 전 install 완료
  - 재실행 전 install 실패
- [ ] 완료 기준:
  - 앱 process lifetime과 설치·OAuth 결과가 분리되어도 복구 가능하다.

### CSH-056 NSIS와 Setup 정책 통합

- [ ] 담당 영역: Windows installer/backend/QA
- [ ] 선행 조건: CSH-040~051
- [ ] 대상:
  - `src-tauri/windows/hooks.nsh`
  - 생성 상수 또는 static contract test
  - `tests/ui-tests.js`
- [ ] 구현:
  1. 공식 URL과 default path가 Setup과 일치하는지 자동 검사한다.
  2. NSIS가 PATH/custom install을 무시해 불필요한 질문을 하지 않도록 detection을 개선한다.
  3. silent `/S`는 질문·다운로드를 계속 금지한다.
  4. interactive prompt 기본값은 No를 유지한다.
  5. NSIS 설치 실패가 monitor 설치를 실패시키지 않는 정책을 유지한다.
  6. NSIS 뒤 첫 Setup에서 실제 candidate validation을 수행한다.
- [ ] 완료 기준:
  - installer와 앱이 서로 다른 “설치됨” 정의를 사용하지 않는다.

### CSH-057 사용량 연결 상태의 진실성

- [x] 담당 영역: backend/frontend/QA
- [x] 선행 조건: CSH-044, CSH-048
- [x] 대상:
  - `src-tauri/src/collector.rs`
  - `src-tauri/src/lib.rs`
  - `src-tauri/src/codex_cli/error.rs`
  - `src/ui/status-health.js`
  - `src/ui/compact.js`
  - `src/ui/insights.js`
  - `src/ui/setup-view.js`
  - `src/ui/language.js`
- [x] 구현:
  1. app-server capability가 확인된 selected CLI만 사용량 수집에 사용한다.
  2. 현재 refresh가 실패하면 오래된 성공 status를 현재 연결 성공처럼 표시하지 않는다.
  3. last successful data와 current connection health를 별도 field로 둔다.
  4. app-server stderr를 raw renderer error로 전달하지 않는다.
  5. capture 실패는 raw `String` 대신 identity/spawn/io/protocol/timeout/shutdown/storage/capability/authentication typed enum으로 반환한다.
  6. 실패 status는 `parse_status=failed`와 빈 current limits를 기록하고 정제된 직전 성공값만 `last_success`에 보존한다.
  7. 반복 실패에도 `last_success`를 유지하고 현재 세션 in-memory status로 저장 실패 시 stale success가 다시 connected가 되는 것을 막는다.
  8. timeout은 `usage_capture_timeout`, 명시적 JSON-RPC method-not-found만 `usage_capability_missing`으로 공개한다.
  9. capture 실패 뒤 auth re-probe가 명시적으로 unauthenticated일 때만 `login_unconfirmed`로 분류한다.
- [x] 시험:
  - [x] 이전 성공 + 현재 실패 + 반복 실패
  - [x] auth 만료의 `login_unconfirmed` 재분류
  - [x] app-server unsupported의 method-not-found code
  - [x] timeout의 독립 safe code
  - [x] raw stderr/path가 status와 renderer allowlist에 들어오지 않음
- [x] 완료 기준:
  - 로그인 성공과 현재 사용량 연결 성공을 구분해 표시한다.

### CSH-058 credential 인증과 사용량 준비 분리

- [ ] 담당 영역: backend/frontend/QA
- [ ] 선행 조건: CSH-044, CSH-048, CSH-057
- [ ] 실제 대상:
  - `src-tauri/src/codex_cli/types.rs`
  - `src-tauri/src/codex_cli/probe.rs`
  - `src-tauri/src/collector.rs`
  - `src-tauri/src/lib.rs`
  - `src/ui/setup-view.js`
  - `src/ui/status-health.js`
  - `tests/ui-tests.js`
- [ ] 배경:
  - 공식 Codex CLI는 ChatGPT browser sign-in과 API key credential을 모두 지원한다.
  - `codex login status` exit `0`은 credential 존재 증거지만 ChatGPT subscription의 `account/rateLimits/read` 성공 증거가 아니다.
- [ ] 구현:
  1. `AuthState::Authenticated`를 credential 사실로만 정의한다.
  2. `UsageReadiness`를 `unavailable / checking / ready / unsupported / error`로 별도 유지한다.
  3. 같은 `SelectedCodex`의 현재 `account/rateLimits/read`가 성공한 경우에만 usage를 `ready`로 둔다.
  4. auth exit `0` 뒤 usage method-not-found, 명시적 account access/entitlement error, timeout과 protocol error를 각각 typed 내부 결과와 safe code로 분류한다. 명시적 account access 거절만 `usage_account_access_unavailable`로 공개하고 timeout이나 임의 문자열로 auth method를 추정하지 않는다.
  5. 안정적인 machine-readable auth-method 계약이 없으면 `login status`의 사람이 읽는 stdout을 파싱해 ChatGPT/API key를 추정하지 않는다.
  6. API key, access token, auth method 원문, workspace와 account identity를 renderer 또는 evidence에 보내지 않는다.
  7. Setup의 “로그인 확인”과 “사용량 연결 확인” 문구를 분리하고 credential만으로 현재 사용량 성공을 표시하지 않는다.
  8. 앱은 `--with-api-key` 또는 `--with-access-token` flow를 시작하지 않는다.
- [ ] 시험:
  - auth exit `0` + current usage success → auth `authenticated`, usage `ready`
  - auth exit `0` + method-not-found → auth `authenticated`, usage `unsupported`
  - auth exit `0` + timeout/protocol failure → auth `authenticated`, usage `error`
  - auth unauthenticated → usage `unavailable`
  - API-key/unknown credential fake control이 사용량 성공으로 오인되지 않음
  - previous success 뒤 current failure가 `ready`로 남지 않음
  - snapshot에 API key, access token, raw auth output과 account identity 없음
- [ ] 완료 기준:
  - credential을 확인한 상태와 이 모니터가 현재 subscription usage를 읽을 수 있는 상태가 UI·DTO·저장·시험에서 구분된다.

## 10. Phase 6 — Setup UI 상태 머신

### CSH-060 pure view model 확장

- [ ] 담당 영역: frontend/QA
- [ ] 선행 조건: CSH-031~033
- [ ] 대상:
  - `src/ui/setup-view.js`
  - `tests/ui-tests.js`
- [ ] 구현:
  1. CLI, install operation, login operation, auth와 usage readiness 다섯 축으로 view를 계산한다.
  2. 모든 enum 조합에서 status kind, headline, detail, CTA를 반환한다.
  3. `ready`가 아닌 상태에서 login 버튼을 금지한다.
  4. `usage=ready`가 아닌 상태에서 사용량 연결 성공 문구를 금지한다. `authenticated`만으로는 충분하지 않다.
  5. unknown enum은 safe generic error로 처리한다.
- [ ] 완료 기준:
  - DOM 없이 상태 조합을 전부 unit test할 수 있다.

### CSH-061 설치 UX

- [ ] 담당 영역: frontend
- [ ] 선행 조건: CSH-051, CSH-054, CSH-060
- [ ] 대상:
  - `src/ui/setup.html`
  - `src/ui/setup.js`
  - `src/ui/setup.css`
- [ ] 구현:
  1. consent에 공식 URL과 네트워크/PATH 변경 가능성을 표시한다.
  2. `starting/running/long_running/succeeded/failed/cancelled`를 구분한다.
  3. 실행 중 중복 설치 버튼을 비활성화한다.
  4. long-running에는 기다리기와 취소를 제공한다.
  5. process exit 뒤 재탐지 결과를 자동 반영한다.
- [ ] 완료 기준:
  - 설치 창을 연 직후 완료 문구가 나타나지 않는다.

### CSH-062 로그인 UX와 책임 경계

- [ ] 담당 영역: frontend/문서
- [ ] 선행 조건: CSH-052~054, CSH-060
- [ ] 구현:
  1. 버튼 설명을 “앱이 선택된 Codex CLI에서 로그인 명령을 시작”한다고 쓴다.
  2. 앱이 선택 CLI로 `codex login`을 시작하고 Codex CLI가 browser를 열며, 계정 입력·MFA·workspace 선택과 OAuth 승인은 사용자가 직접 수행한다고 쓴다.
  3. login operation의 `starting/running/long_running/exited/cancelled/detached`와 auth의 `checking/unauthenticated/authenticated/error`를 조합한다.
  4. `login_unconfirmed`는 auth 상태가 아니라 safe error code로만 사용한다.
  5. 자동 auth recheck와 수동 **상태 다시 확인**을 둘 다 제공한다.
  6. browser를 열 수 없고 선택 후보가 `--device-auth`를 지원하는 경우에만 device-code CTA를 제공한다. 계정 보안 설정 또는 workspace 정책에서 허용되지 않을 수 있음을 안내한다.
- [ ] 완료 기준:
  - 사용자가 “앱이 로그인까지 대신 하는가?”를 오해하지 않는다.

### CSH-063 conflict와 custom path UX

- [ ] 담당 영역: frontend/backend
- [ ] 선행 조건: CSH-046, CSH-047, CSH-060
- [ ] 구현:
  1. 발견 source, version, launcher, provenance, privacy-safe display label과 session candidate tag를 표시한다.
  2. raw path를 보여 주지 않는다.
  3. default path를 official provenance로 부르지 않고 legacy warning과 분리한다.
  4. 같은 source/version/launcher 두 후보도 tag로 구분하고 backend native 위치 확인 행동을 제공한다.
  5. 모호한 conflict는 사용자 선택 전 login을 막는다.
  6. **다른 Codex CLI 선택** native picker를 제공한다.
  7. off-PATH 수동 경로가 session-only임을 명확히 한다.
- [ ] 완료 기준:
  - 여러 설치가 있어도 어떤 CLI를 사용할지 사용자와 앱이 같은 상태를 본다.

### CSH-064 오류 copy와 접근성

- [ ] 담당 영역: frontend/QA
- [ ] 선행 조건: CSH-033, CSH-060
- [ ] 구현:
  1. safe error code별 한국어 headline과 recovery action을 작성한다.
  2. color만으로 상태를 구분하지 않는다.
  3. 진행 상태에 `aria-live`를 사용한다.
  4. keyboard로 설치 동의, candidate 선택, cancel, retry가 가능하다.
  5. 200% scaling과 작은 Setup 창에서 CTA가 잘리지 않는다.
- [ ] 완료 기준:
  - 모든 오류가 “실행 실패: raw error”로 끝나지 않는다.

## 11. Phase 7 — 엄격한 시험 구현

### CSH-070 T0 unit matrix

- [ ] 담당 영역: backend/frontend QA
- [ ] 선행 조건: Phase 3~6
- [ ] 대상:
  - Rust unit tests
  - `tests/ui-tests.js`
- [ ] 필수 case:
  - missing
  - desktop resource only
  - execution alias only
  - default-path candidate only
  - npm only
  - custom install only
  - default-path candidate + alias
  - default-path candidate + outdated npm
  - same-priority conflict
  - 같은 source/version/launcher conflict의 privacy-safe 구분
  - invalid binary
  - version unrecognized
  - unsupported capability
  - provenance verified/tracked/unverified/invalid
  - environment expansion/unresolved/cycle/relative path
  - Node missing/old/wrong-architecture/broken launcher
  - auth success/unauth/error/timeout
  - auth exit `0` + usage ready/unsupported/error
  - install/login operation의 모든 상태와 auth 독립성
  - snapshot privacy
- [ ] 완료 기준:
  - 명세의 각 enum과 safe error code가 최소 한 번 시험된다.

### CSH-071 T1 Windows process integration

- [ ] 담당 영역: backend/CI
- [ ] 선행 조건: CSH-043~055
- [ ] 대상:
  - `src-tauri/tests/codex_process_integration.rs` 또는 동등 test binary
  - fake CLI fixture/generator
- [ ] 구현:
  1. fake CLI가 모든 받은 argument와 선택된 fixture ID를 temp file에 기록한다.
  2. 예상하지 않은 argument는 즉시 nonzero로 실패한다.
  3. version, help, auth, app-server mode를 독립 제어한다.
  4. process hang과 cancel을 재현한다.
  5. alias/standalone/npm directory를 실제 Windows child PATH로 구성한다.
  6. path 공백·한글 case를 포함한다.
  7. `.cmd → node.exe → 손자 process` fixture로 timeout/cancel을 재현한다.
  8. 정상 완료와 timeout/cancel 뒤 Job Object 잔존 process가 0인지 확인한다.
  9. test temp 파일은 계정 데이터 없이 종료 시 정리한다.
- [ ] 완료 기준:
  - 단순 string assertion이 아니라 실제 Windows process boundary를 통과한다.

### CSH-072 NSIS interactive/silent smoke 자동화

- [ ] 담당 영역: Windows installer/QA
- [ ] 선행 조건: CSH-056
- [ ] 구현:
  1. `/S` 설치에서 prompt와 Codex network 호출이 없음을 확인한다.
  2. interactive install의 기본 No를 확인한다.
  3. install script exit 0/nonzero가 monitor install 성공과 분리됨을 확인한다.
  4. 기존 valid CLI가 있으면 prompt하지 않음을 확인한다.
  5. desktop alias만 있을 때는 독립 CLI를 제안함을 확인한다.
- [ ] 완료 기준:
  - 문자열 존재 검사 외에 최소 한 번 실제 NSIS process smoke가 있다.
  - 현재 Windows CI smoke는 실제 `/S` 설치·제거 전후의 알려진 Codex 파일과 User/Machine PATH 불변성, 그리고 `IfSilent` 정적 분기를 검증한다.
  - hosted runner에서 모든 자손 프로세스의 outbound 시도를 동적으로 기록·차단하는 증거는 아직 없다. 이 관찰 장치를 신뢰성 있게 추가하기 전에는 “정책과 알려진 부작용 불변”까지만 자동 증거로 보고하고 “패킷 시도 0”은 주장하지 않는다.

### CSH-073 T2 실제 공식 installer workflow

- [ ] 담당 영역: CI/QA
- [ ] 선행 조건: CSH-002, CSH-043~046
- [ ] 대상:
  - 신규 `.github/workflows/codex-cli-installer-smoke.yml`
  - live integration harness
- [ ] trigger:
  - `workflow_dispatch`
  - 주 1회 schedule
  - default branch 반영 전에는 maintainer가 `test:codex-t2` label을 붙인 PR의 `labeled`/`synchronize` event
- [ ] workflow:
  1. 기본 위치와 custom 위치의 독립 `windows-latest` job 두 개를 만든다.
  2. 두 job 모두 비어 있는 temp `CODEX_HOME`을 설정하고 credential 파일 부재를 assert한다.
  3. 기본 위치 job은 `CODEX_INSTALL_DIR`를 설정하지 않고 exact default target과 fresh HKCU PATH 반영을 검증한다.
  4. custom 위치 job은 공백·비ASCII 문자를 포함한 비어 있는 temp `CODEX_INSTALL_DIR`를 설정한다.
  5. hosted runner 전체의 `where codex` 부재를 가정하지 않고 controlled effective PATH와 목표 directory 부재만 검증한다.
  6. preexisting global candidate가 있으면 삭제하지 않고 발견 source를 evidence에 기록한다.
  7. 공식 `install.ps1`을 download하고 script SHA-256을 출력한다.
  8. `CODEX_NON_INTERACTIVE=1`을 사용한다.
  9. script 실행과 exit code를 기록한다.
  10. 실제 `codex --version`
  11. help capability와 provenance probe
  12. 격리 `CODEX_HOME`의 credential 없는 `login status` 판정
  13. repository live resolver test
  14. sanitized evidence artifact 업로드
- [ ] 금지:
  - ChatGPT account secret
  - OAuth 자동화
  - raw auth output artifact
- [ ] 완료 기준:
  - “공식 installer로 실제 Codex를 기본 위치와 custom 위치에 설치했다”는 독립 evidence가 생긴다.
  - 2026-07-31 implementation snapshot은 [REMOTE_T2_2026-07-31.md](evidence/REMOTE_T2_2026-07-31.md)에 기록돼 있다. 후속 code/docs commit의 Release gate에는 같은 commit의 새 run이 필요하다.

### CSH-073A 기존 1.2.7 고객 업그레이드 gate

- [ ] 담당 영역: CI/QA/release
- [ ] 선행 조건: CSH-062, CSH-073, exact `1.2.8` candidate
- [ ] 대상:
  - `scripts/windows-upgrade-smoke.ps1`
  - `.github/workflows/ci.yml`
  - `.github/workflows/release.yml`
- [ ] 자동 gate:
  1. 공개 `v1.2.7` annotated tag가 commit `d417cb919c5e0c491a647ee45031ea03b296c5eb`로 resolve되는지 확인한다.
  2. 공개 installer가 `2,299,068 bytes`, SHA-256 `2F194A0D25A59DC024D26C2BB3367BC78EA91082EECBE953FEDF43CF75F271FC`인지 확인한다.
  3. GitHub-hosted Windows의 fresh user에서 `v1.2.7`을 disposable path에 설치한다.
  4. valid app-data marker, history, update state와 격리 `CODEX_HOME` credential sentinel을 seed한다.
  5. 기본 Codex 경로와 custom `CODEX_INSTALL_DIR` 두 mode를 각각 실행한다.
  6. candidate를 Tauri updater와 같은 passive/update mode인 `/P /UPDATE`로 설치한다.
  7. candidate payload exact bytes, DisplayVersion, 기존 install location과 stale file 부재를 확인한다.
  8. baseline·candidate launch가 5초 동안 즉시 crash하지 않는지 확인한다.
  9. 앱 데이터, Codex CLI 후보, credential sentinel, custom install directory와 process/HKCU/HKLM PATH 불변성을 확인한다.
  10. candidate 제거 뒤 install directory와 uninstall entry만 없어지고 앱 데이터와 provider 상태는 유지되는지 확인한다.
- [ ] fail-closed:
  - script는 기본적으로 `GITHUB_ACTIONS=true`와 `RUNNER_TEMP`가 없는 환경에서 실행을 거부한다.
  - public baseline tag, size 또는 SHA-256이 바뀌면 실행을 중단한다.
  - passive update가 Codex 설치 prompt에서 멈추면 bounded timeout으로 실패한다.
- [ ] 완료 기준:
  - PR CI candidate와 updater-signed draft exact candidate가 모두 같은 gate를 통과한다.
  - 사람 T3가 별도 standard user 또는 pre-auth snapshot에서 실제 기존 고객 상태를 다시 확인한다.
  - public updater endpoint를 사용하는 stock `1.2.7 -> 1.2.8` canary는 공개 직후 disposable Windows에서 수행한다.

### CSH-074 T3 remote Windows runbook

- [ ] 담당 영역: QA/보안/문서
- [ ] 선행 조건: CSH-004, CSH-062
- [ ] 대상:
  - 신규 `docs/codex-cli-onboarding/REMOTE_WINDOWS_TEST.md`
  - `docs/community/INSTALL_SMOKE_REPORT_TEMPLATE.md`
- [ ] runbook 포함:
  1. VM 생성과 RDP 보안
  2. standard user 생성
  3. standard user에서 `codex`, `node`, `npm`, `rustc`가 모두 absent임을 확인하고 하나라도 있으면 reimage
  4. 전용 browser profile
  5. installer hash 확인
  6. missing → decline → install → unauthenticated → 사람 OAuth → credential authenticated → usage ready
  7. Node/npm/Rust가 없는 상태에서 앱 재실행과 Windows reboot까지 완료
  8. baseline 완료 뒤에만 승인된 Node/npm과 legacy Codex를 설치해 conflict 확인
  9. uninstall 후 Codex 보존
  10. screenshot redaction
  11. VM 종료·disk·snapshot 폐기
- [ ] 완료 기준:
  - 처음 보는 tester가 계정 정보를 repository에 남기지 않고 같은 시험을 수행할 수 있다.

### CSH-075 T3 첫 실행과 evidence

- [ ] 담당 영역: 지정 human tester
- [ ] 선행 조건: CSH-004, CSH-074, Release candidate
- [ ] 실행:
  1. 새 VM에서 runbook을 처음부터 끝까지 수행한다.
  2. 실제 앱 로그인 버튼이 선택 CLI의 terminal을 시작하고 Codex CLI가 browser를 여는지 확인한다.
  3. tester가 직접 OAuth/MFA를 완료한다.
  4. 자동 auth recheck와 첫 rate limit 수집을 확인한다.
  5. reboot 뒤 재탐지와 auth 상태를 확인한다.
  6. pristine baseline 완료 시점까지 Node.js, npm과 Rust가 없었음을 확인한다.
  7. 그 뒤에만 approved legacy Node/npm package를 추가한다.
  8. sanitized smoke report를 commit한다.
  9. 실패는 숨기지 않고 follow-up Issue를 만든다.
- [ ] 완료 기준:
  - `PASS` 또는 release blocker가 명시된 `FAIL` report가 존재한다.
  - `PASS WITH ISSUES`는 blocker가 없고 owner/date가 있는 follow-up만 허용한다.

### CSH-076 확장 Windows matrix

- [ ] 담당 영역: QA/release
- [ ] 선행 조건: CSH-075
- [ ] 대상 조합:
  - Windows 10 x64
  - Windows 11 ARM64
  - PowerShell 7 병행 설치
  - enterprise proxy 또는 offline
  - 제한된 ExecutionPolicy/AppLocker
  - 한글·공백 경로
- [ ] 완료 기준:
  - 공개 지원으로 쓰는 조합은 evidence가 있고, 나머지는 검증 예정으로 표시한다.

## 12. Phase 8 — 문서와 개인정보 정합성

### CSH-080 README 고객 흐름 갱신

- [ ] 담당 영역: 문서
- [ ] 선행 조건: CSH-061~063
- [ ] 대상:
  - `README.md`
  - `docs/README.ko.md`
- [ ] 포함할 내용:
  - Release installer 고객은 Node/npm/Rust가 필요 없음
  - 앱이 명시적 동의 후 공식 installer terminal을 시작
  - 앱이 선택된 CLI 전체 경로로 `codex login`을 시작
  - Codex CLI가 browser를 열고 사용자는 계정·MFA·workspace·OAuth를 직접 완료
  - device auth는 후보 capability와 계정/workspace 허용 조건을 모두 만족할 때만 사용 가능
  - 앱은 완료 뒤 상태를 자동 재확인하며 수동 재확인도 가능
  - credential 확인과 실제 사용량 연결 성공은 별도 상태
  - 비표준 PATH/manual picker, legacy npm Node 오류와 일반 고객의 무 Rust 설치 troubleshooting
  - rustup 없는 기여자/있는 기여자/CI의 pinned Rust 준비 차이
  - 상세 spec/runbook 링크
- [ ] 완료 기준:
  - README만 읽어도 고객과 앱의 역할을 구분할 수 있다.

### CSH-081 개인정보 처리방침 갱신

- [ ] 담당 영역: 보안/문서
- [ ] 선행 조건: CSH-032, CSH-051~057
- [ ] 대상:
  - `docs/PRIVACY.md`
- [ ] 실행:
  1. installer/login process tracking에서 처리하는 최소 metadata를 적는다.
  2. raw path, auth stdout/stderr, credential을 저장하지 않는다고 적는다.
  3. candidate fingerprint를 저장한다면 목적·삭제 위치를 적는다.
  4. app-server stderr sanitize 정책을 적는다.
  5. 현재 activity-triggered refresh 설명과 “수동 때만”이라는 오래된 문구를 정합화한다.
  6. NSIS가 실제로 Codex만 제안하는지 양쪽 공급자를 제안하는지 코드와 맞춘다.
- [ ] 완료 기준:
  - 정책 문서가 현재 network/process/storage 동작과 일치한다.

### CSH-082 smoke report template 강화

- [ ] 담당 영역: QA/문서
- [ ] 선행 조건: CSH-074
- [ ] 대상:
  - `docs/community/INSTALL_SMOKE_REPORT_TEMPLATE.md`
- [ ] 추가 field:
  - install 전후 `where codex` 결과의 redacted 분류
  - selected source와 version
  - provenance confidence와 privacy-safe candidate tag
  - expected/actual CLI·install·auth state
  - safe error code
  - install/login process 결과
  - auto recheck 여부
  - reboot 결과
  - legacy conflict 결과
  - artifact/run URL
- [ ] 완료 기준:
  - happy path yes/no만이 아니라 실패 원인을 재현할 수 있다.

### CSH-083 Setup copy reference 정합화

- [ ] 담당 영역: frontend/문서
- [ ] 선행 조건: CSH-060~064
- [ ] 대상:
  - Setup copy reference 문서
  - `src/ui/setup.js`
  - `src/ui/setup-view.js`
- [ ] 실행:
  1. 모든 상태, CTA, 금지 문구를 표로 맞춘다.
  2. “창을 열었습니다”와 “완료했습니다”를 구분한다.
  3. provider hardcoding과 한 공급자 완료 정책을 검토한다.
- [ ] 완료 기준:
  - copy reference와 code 문자열 차이를 static test가 감지한다.

### CSH-084 기여자·release 문서 갱신

- [ ] 담당 영역: 문서/release
- [ ] 선행 조건: CSH-010~013, CSH-073~075
- [ ] 대상:
  - `CONTRIBUTING.md`
  - `docs/BETA_RELEASE_CHECKLIST.md`
  - release runbook
- [ ] 실행:
  1. pinned toolchain과 preflight 명령을 추가한다.
  2. T0/T1/T2/T3의 의미와 실행 주체를 적는다.
  3. T2/T3 evidence가 없으면 Release를 막는 기준을 추가한다.
  4. historical refactor 문서는 대량 수정하지 않고, 별도 scoped docs 변경에서 정본 spec 배너를 추가한다.
  5. `production-release`의 required reviewer, prevent self-review, administrator bypass 차단과 release immutability의 owner·현재 상태를 기록한다.
- [ ] 완료 기준:
  - release 담당자가 기억에 의존하지 않고 gate를 실행할 수 있다.

## 13. Phase 9 — Release, 관찰, rollback

### CSH-090 최종 자동 gate

- [ ] 담당 영역: CI/release
- [ ] 선행 조건: Phase 1~8
- [ ] 같은 commit에서 실행:

```powershell
node scripts/verify-toolchain.js
npm ci
npm test
npm run dist:ci
git diff --check
```

- [ ] 추가:
  - T2 workflow green
  - installer SHA-256
  - artifact retention 확인
  - worktree dirty 여부 확인
  - 문서 변경을 포함한 final release commit에서 standard CI와 T2 default/custom 재실행
- [ ] 완료 기준:
  - 자동 gate 하나라도 실패하면 Release candidate를 만들지 않는다.

### CSH-091 T3 release gate review

- [ ] 담당 영역: release owner + 독립 reviewer
- [ ] 선행 조건: CSH-075, CSH-090
- [ ] review:
  - 실제 official standalone 설치
  - 실제 browser OAuth
  - 실제 첫 사용량
  - reboot
  - uninstall 보존
  - privacy redaction
- [ ] 완료 기준:
  - tester와 reviewer 두 사람이 report에 승인 기록을 남긴다.
  - 현재 repository collaborator가 한 명뿐이면 충족할 수 없다. 두 번째 권한 있는 collaborator와 역할 분리가 확인될 때까지 No-Go다.

### CSH-092 제한된 beta rollout

- [ ] 담당 영역: product/release
- [ ] 선행 조건: CSH-090, CSH-091
- [ ] 실행:
  1. 먼저 pre-release로 배포한다.
  2. 신규 설치, 기존 npm, Codex desktop 동시 설치 사용자를 구분해 feedback을 받는다.
  3. setup safe error code와 version/source만 수동 report로 받는다.
  4. credential 또는 전체 path 제출을 요구하지 않는다.
  5. blocker가 없을 때 public Release로 승격한다.
- [ ] 완료 기준:
  - Issue #33 재현 사용자 또는 동등 환경에서 해결 확인이 있다.

### CSH-093 rollback rehearsal

- [ ] 담당 영역: backend/release/QA
- [ ] 선행 조건: CSH-092 전
- [ ] 실행:
  1. 새 resolver 선택을 feature flag로 끄는 경로를 시험한다.
  2. rollback 뒤 공식 guide와 수동 상태 재확인이 작동하는지 확인한다.
  3. rollback이 Codex CLI, npm package, credential, PATH를 삭제하지 않는지 확인한다.
  4. 이전 앱 version 설치로 내려갈 때 selection fingerprint가 무해한지 확인한다.
- [ ] 완료 기준:
  - 기능을 되돌려도 사용자 공급자 환경을 파괴하지 않는다.

### CSH-094 Issue #33 종료 조건

- [ ] 담당 영역: maintainer
- [ ] 선행 조건: CSH-090~093
- [ ] Issue에 남길 내용:
  - root cause
  - 수정 Release
  - T1/T2/T3 evidence 링크
  - 실제 OAuth를 누가 수행했는지의 역할 설명
  - known limitation과 follow-up Issue
- [ ] 완료 기준:
  - Issue reporter 환경 또는 동등 T3 환경에서 “설치 후 로그인했으나 앱이 인식하지 못함”이 재현되지 않는다.

## 14. 필수 시험 행렬

| ID | 초기 환경 | 사용자 행동 | 기대 CLI 상태 | 기대 operation | 기대 auth 상태 | 시험 tier |
| --- | --- | --- | --- | --- | --- | --- |
| M01 | 아무 Codex 없음 | Setup 열기 | `missing` | install/login `idle` | `unavailable` | T0/T1/T3 |
| M02 | desktop resource만 | Setup 열기 | `desktop_bundle_only` | `idle` | `unavailable` | T0/T1 |
| M03 | execution alias만 | Setup 열기 | `desktop_bundle_only` | `idle` | `unavailable` | T0/T1/T3 |
| M04 | alias + default-path standalone | 상태 확인 | `ready`, source와 provenance 분리 | `idle` | 실제 상태 | T1/T2 |
| M05 | npm launcher + 호환 Node | 상태 확인 | `ready` legacy | `idle` | 실제 상태 | T1/T3 |
| M06a | npm launcher, Node 없음 | 상태 확인 | `runtime_dependency_missing` | `idle` | `unavailable` | T1 |
| M06b | npm launcher, Node old/wrong-architecture | 상태 확인 | `runtime_dependency_incompatible` | `idle` | `unavailable` | T0/T1 |
| M06c | Node 정상, launcher 손상 | 상태 확인 | `invalid_candidate` | `idle` | `unavailable` | T1 |
| M07 | default-path candidate + outdated npm | 상태 확인 | `ready` + conflict warning | `idle` | 선택 후보 상태 | T0/T1/T3 |
| M08 | 같은 우선순위 valid 2개 | 상태 확인 | `conflict`, 서로 다른 tag | `idle` | `unavailable` | T0/T1 |
| M09 | custom `CODEX_INSTALL_DIR` | 상태 확인 | `ready` custom | `idle` | 실제 상태 | T1/T2 |
| M10a | 실행·version 확인 실패 동명 파일 | 상태 확인 | `invalid_candidate` | `idle` | `unavailable` | T0/T1 |
| M10b | version/help를 흉내 내는 binary | 상태 확인 | 운영 호환 결과와 별개로 provenance `unverified` | `idle` | probe 결과 | T0/T1 |
| M11 | valid but old CLI | 상태 확인 | `unsupported` | `idle` | `unavailable` | T0/T1 |
| M12 | 설치 exit 0 + valid | 설치 승인 | `ready` | install `succeeded` | 자동 확인 | T1/T2/T3 |
| M13 | 설치 exit 0 + missing | 설치 승인 | `missing` | install `failed` | `unavailable` | T1 |
| M14 | 설치 nonzero | 설치 승인 | 실제 재탐지 결과 | install 실제 결과 | 실제 auth 결과 | T1 |
| M15 | 로그인 성공 | OAuth 완료 | `ready` | login `exited`, auth 재확인 | `authenticated` | T1/T3 |
| M16 | 로그인 terminal 직접 닫기 | terminal 종료 | `ready` | login `exited` | `unauthenticated` 또는 `error` | T1/T3 |
| M17 | status timeout | 상태 확인 | `ready` | login `idle` | `error` | T0/T1 |
| M18 | 브라우저 차단 | device auth | `ready` | login `running → exited` | 완료 뒤 `authenticated` | T1/T3 |
| M19 | 앱 재실행 | 설치/로그인 중 앱 종료 후 재실행 | 재탐지 결과 | 이전 operation `detached` 진단 | 재probe 결과 | T1/T3 |
| M20 | Windows reboot | 로그인 뒤 reboot | 동일 선택 | `idle` | `authenticated` | T3 |
| M21 | 이전 usage 성공 + 현재 실패 | 사용량 확인 | `ready` 또는 원인 상태 | `idle` | auth와 별도 | T0/T1/T3 |
| M22 | app uninstall | 제거 | 해당 없음 | 해당 없음 | Codex와 credential 보존 | T3 |
| M23 | signature 검증 실패 후보 | 상태 확인 | 자동 선택 제외 | `idle` | `unavailable` | T0/T1 |
| M24 | `%USERPROFILE%`/nested registry PATH | 상태 확인 | 확장 뒤 실제 결과 | `idle` | 실제 상태 | T0/T1 |
| M25 | credential 있음, account usage 미지원/실패 | 상태·사용량 확인 | `ready` | `idle` | auth `authenticated`, usage `unsupported/error` | T0/T1/T3 |
| M26 | Codex/Node/npm/Rust 없는 pristine Windows | install→OAuth→usage→reboot | standalone `ready` | tracked install/login | auth `authenticated`, usage `ready` | T3 |
| M27 | process/HKCU/HKLM `CODEX_INSTALL_DIR` 충돌 | 설치 승인 | 가장 높은 explicit target 판정 | invalid면 installer 미시작 | `unavailable` 또는 실제 상태 | T0/T1 |

## 15. Go/No-Go

### Go

- T0/T1 전부 green
- 같은 commit T2 기본 위치·custom 위치 job green
- T3 실제 OAuth·첫 사용량·reboot `PASS`
- T3 standalone baseline 시작 시 Codex/Node/npm/Rust 모두 absent
- credential auth와 usage readiness 분리 case green
- blocker/critical setup Issue 0
- raw credential/path 노출 0
- 고객/기여자/CI dependency 문서 일치
- rollback rehearsal 통과

### No-Go

- fake CLI 시험만으로 실제 설치 또는 OAuth를 통과했다고 주장
- 설치 또는 로그인 terminal spawn을 성공으로 표시
- unknown nonzero를 로그인 필요로 오인
- 여러 후보 중 `where.exe` 첫 결과를 무조건 선택
- 기본 경로라는 이유만으로 후보를 “OpenAI 공식 바이너리”라고 표시
- official installer exit 0만 보고 CLI 검증 생략
- login operation 상태와 auth 사실 상태를 하나의 enum으로 혼합
- credential 인증을 현재 subscription usage 연결 성공으로 표시
- 명시적 invalid `CODEX_INSTALL_DIR`를 낮은 scope/default로 조용히 fallback
- Node/npm/Rust floating version
- T3 없이 공개 Release
- evidence에 계정 이메일, 조직, token, 전체 home path 포함
