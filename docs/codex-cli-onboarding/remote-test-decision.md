# Codex onboarding T3 원격 Windows 운영 결정

> 상태: Draft decision — 운영 값 미확정으로 T3 시작 No-Go
> 작성일: 2026-07-31
> 적용 대상: Codex onboarding 공개 Release 전 사람 T3

이 문서는 별도 물리 PC가 없을 때 사용할 원격 Windows 시험 환경의 책임, 비용, image와 폐기 조건을 확정하기 위한 운영 기록이다. 실제 단계별 시험은 [REMOTE_WINDOWS_TEST.md](REMOTE_WINDOWS_TEST.md), 공개 승인 계약은 [RELEASE_GATE.md](RELEASE_GATE.md)를 따른다.

## 결정된 원칙

- T2는 GitHub-hosted `windows-latest`, T3는 사람이 RDP 또는 Bastion으로 접속하는 일회성 Windows 11 x64 desktop에서 수행한다.
- 우선 검토 provider는 Azure다. `MicrosoftWindowsDesktop` publisher와 `Windows-11` offer의 지원 image를 사용한다.
- Windows Server, 브라우저 전용 test service와 GitHub-hosted runner는 T3 대체 수단이 아니다.
- 관리자 계정은 VM 준비에만 쓰고 제품 시험은 별도 standard user에서 수행한다.
- T3 시작 시 standard user 환경에는 Codex desktop/CLI, Node.js, npm과 Rust가 모두 없어야 한다.
- OAuth 뒤 snapshot 또는 reusable image를 만들지 않는다. 시험 뒤 VM, disk, snapshot, public IP와 임시 firewall rule을 삭제한다.
- tester가 Codex CLI가 연 browser에서 계정, MFA와 workspace 승인을 직접 완료한다. 앱, CI와 maintainer가 credential을 대신 입력하지 않는다.

## 공개 Release 전에 확정할 값

아래에서 `TBD`가 하나라도 남아 있으면 T3를 시작하거나 공개 Release를 승인하지 않는다.

| 결정 항목 | 현재 값 | 확정 책임 | 완료 증거 |
| --- | --- | --- | --- |
| Azure subscription과 비용 승인자 | `TBD — No-Go` | Release owner | 승인 기록 URL 또는 내부 승인 ID |
| Region | `TBD — No-Go` | Release owner | 실제 VM region |
| Exact image publisher/offer/SKU/version | publisher `MicrosoftWindowsDesktop`, offer `Windows-11`; SKU/version `TBD — No-Go` | Tester + reviewer | Azure image reference |
| VM size | `TBD — No-Go` | Tester | 실제 size와 vCPU/RAM |
| 시험 1회 비용 상한 | `TBD — No-Go` | 비용 승인자 | 통화와 최대 금액 |
| 월별 T3 비용 상한 | `TBD — No-Go` | 비용 승인자 | 통화와 최대 금액 |
| 자동 종료 제한 | `TBD — No-Go` | Cloud owner | 정책/설정 screenshot의 redacted 확인 |
| T3 tester | `TBD — No-Go` | Release owner | GitHub collaborator identity |
| 독립 reviewer | `TBD — No-Go` | Release owner | tester와 다른 collaborator identity |
| QA ChatGPT 계정 owner | `TBD — No-Go` | Security owner | credential을 포함하지 않은 소유 확인 |
| MFA 복구 책임자 | `TBD — No-Go` | Security owner | 역할 확인 |
| Resource 폐기 확인자 | `TBD — No-Go` | Independent reviewer | 삭제 checklist |

가격과 image availability는 subscription, region, 라이선스와 시점에 따라 바뀌므로 이 저장소에서 임의의 금액이나 SKU를 고정하지 않는다. 생성 직전에 Azure portal 또는 CLI가 제공하는 실제 값으로 표를 확정하고 독립 reviewer가 확인한다.

## 연결 보안

1. Azure Bastion을 사용할 수 있으면 public RDP를 만들지 않는다.
2. 직접 RDP가 필요하면 source CIDR을 tester의 현재 공인 IP 하나로 제한한다.
3. TCP 3389를 `0.0.0.0/0`에 열지 않는다.
4. clipboard와 drive redirection은 기본 차단한다.
5. RC installer를 한 번 전달한 뒤 redirection을 다시 차단한다.
6. 개인 browser sync, 업무 drive, SSH/Git credential을 VM에 넣지 않는다.

## 실행 승인 순서

1. exact release commit의 standard CI와 T2 default/custom job을 확인한다.
2. 비공개 draft의 versioned installer와 `release-evidence.json` hash를 고정한다.
3. 위 TBD 표를 모두 닫는다.
4. pristine standard-user precondition을 확인한다.
5. [REMOTE_WINDOWS_TEST.md](REMOTE_WINDOWS_TEST.md)를 수행한다.
6. T3 Issue 본문과 독립 reviewer approval를 exact bytes에 묶는다.
7. VM과 모든 부속 resource 삭제를 확인한다.

유료 resource 생성, cloud 약관 동의, QA 계정 로그인과 MFA는 자동화하지 않는다.

## 2026-07-31 외부 Release blocker snapshot

아래 값은 GitHub 외부 설정이 바뀌면 다시 확인해야 하는 dated snapshot이다.

- repository collaborator가 한 명뿐이어서 서로 다른 T3 tester와 independent reviewer를 지정할 수 없음
- `production-release` environment의 `prevent_self_review=true`
- `production-release` environment의 `can_admins_bypass=false`
- `release:t3-approved` label은 생성했지만 사람 T3 증거 전에는 적용하지 않음
- repository release immutability 활성(`enabled=true`, 향후 공개 Release부터 적용)
- T3 tester, reviewer, QA account owner와 비용 승인자 미지정

Workflow가 이 설정을 자동으로 완화하거나 우회하지 않는다. 저장소 통제는 fail-closed 상태지만, 독립 reviewer와 T3 역할 분리, 실제 T3 증거와 승인 label이 모두 확인되기 전까지 공개 Release는 No-Go다.

## 공식 운영 참고

- [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Azure Windows 11 deployment eligibility](https://learn.microsoft.com/en-us/azure/virtual-machines/windows/windows-desktop-multitenant-hosting-deployment)
- [Azure Windows VM RDP](https://learn.microsoft.com/en-us/azure/virtual-machines/windows/connect-rdp)
- [Azure secure admin access choices](https://learn.microsoft.com/en-us/azure/networking/design-guide/developer-admin-access)
