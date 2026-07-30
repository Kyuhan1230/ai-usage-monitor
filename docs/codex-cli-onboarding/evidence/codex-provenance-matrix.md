# Codex CLI provenance matrix

> 상태: Incomplete — `verified_publisher` 미승인
> 조사 기준일: 2026-07-31
> Release 영향: 운영 호환 후보 사용은 가능하지만 publisher 진본 보증은 No-Go

이 문서는 “Codex처럼 실행된다”는 capability와 “OpenAI가 배포한 binary임을 검증했다”는 provenance를 분리한다. 경로, version 문자열 또는 로컬 SHA-256 하나만으로 publisher를 보증하지 않는다.

## 현재 판정

| 후보 유형 | 운영 호환성 판정 | 현재 provenance | 근거 | 남은 검증 |
| --- | --- | --- | --- | --- |
| 현재 tracked 공식 installer operation에서 새로 생긴 단일 compatible candidate | version/capability probe 통과 시 `ready` | `tracked_official_install` | 공식 URL에서 시작한 operation의 target-bound pre/post identity·hash delta | publisher signer와 공식 manifest |
| 문서의 기본 standalone 위치에서 발견 | probe 통과 시 `ready` | `unverified` | 발견 source는 `default_standalone_path`일 뿐 | signer/hash 계약 |
| `CODEX_INSTALL_DIR`, PATH 또는 manual picker | probe 통과 시 `ready` | `unverified` | 위치와 capability만 확인 | signer/hash 계약 |
| legacy npm launcher | launcher, Node와 capability probe 통과 시 `ready` | `unverified` | package-manager 설치 위치와 runtime evidence | package provenance 정책 |
| Microsoft Store desktop resource | CLI 후보로 사용하지 않음 | 해당 없음 | protected desktop bundle rejection | 없음 |
| Windows App Execution Alias | CLI 후보로 사용하지 않음 | 해당 없음 | execution-alias rejection | 없음 |
| signature가 있으나 검증 실패한 후보 | 자동 선택 차단 | `invalid` | offline `WinVerifyTrust` failure가 재현된 경우에만 사용 | 실패 분류 fixture |

`tracked_official_install`은 installer operation과 후보 변화 사이의 인과관계만 나타낸다. Authenticode publisher 또는 공식 binary hash manifest를 확인했다는 뜻이 아니다.

## 현재 evidence

- [공식 installer 계약 snapshot](official-contract-2026-07-30.md)은 공식 script URL과 당시 script SHA-256을 기록한다.
- [원격 T2 snapshot](REMOTE_T2_2026-07-31.md)은 공식 script가 설치한 Windows x64 CLI `0.146.0`이 두 설치 위치에서 capability probe를 통과했음을 기록한다.
- T2는 installed executable의 안정적인 signer subject/chain/timestamp allowlist를 확정하지 않았다.
- OpenAI가 각 Windows binary와 비교할 수 있는 signed hash manifest를 제공한다는 반복 가능한 계약은 아직 확인하지 못했다.
- Windows ARM64 standalone provenance는 측정하지 않았다.

따라서 현재 구현과 UI는 compatible candidate를 `ready`로 사용할 수 있지만 `verified_publisher`라고 표시하면 안 된다.

## `verified_publisher`를 열기 위한 필수 조사

1. 공식 installer로 x64와 ARM64 standalone을 각각 새 disposable Windows 환경에 설치한다.
2. 최소 두 개의 서로 다른 Codex version에서 다음을 기록한다.
   - Authenticode signature 존재 여부
   - `WinVerifyTrust` offline/cache-only 결과
   - signer subject, issuer chain과 timestamp
   - binary architecture
3. 같은 파일을 독립 PowerShell `Get-AuthenticodeSignature`로 교차 확인한다.
4. revocation 확인을 위해 예고 없는 network 요청을 시작하지 않는다.
5. offline에서 chain을 확정할 수 없으면 `invalid`가 아니라 `unverified`로 남긴다.
6. 공식 signed manifest 또는 release metadata가 binary SHA-256을 제공하는지 확인한다.
7. signer/hash 계약이 version과 architecture에서 안정적일 때만 좁은 allowlist를 제안한다.
8. allowlist 변경은 code, fixture, 이 문서와 remote evidence를 한 PR에서 검토한다.
9. `--version`과 help를 흉내 내는 malicious fixture가 `verified_publisher`가 되지 않는 negative test를 둔다.

## 즉시 No-Go

- 기본 위치라는 이유로 “OpenAI 공식 binary”라고 표시
- official installer exit `0`만으로 publisher 검증 완료 선언
- 공식 비교 대상 없이 로컬 SHA-256만 기록하고 진본이라고 선언
- offline trust 확인 실패를 근거 없이 악성 또는 `invalid`로 분류
- x64 결과를 ARM64 signer 계약으로 확대

위 조사가 완료될 때까지 `verified_publisher`는 비활성 상태로 유지한다.
