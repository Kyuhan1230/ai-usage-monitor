# SignPath Foundation 신청 및 재신청 기록

이 문서는 SignPath Foundation에 제출한 공개 프로젝트 정보와 재신청 조건을 기록한다. 2026-07-23 첫 신청은 프로젝트 품질 문제가 아니라 외부 신뢰와 공개 인지도 신호가 아직 부족하다는 이유로 승인되지 않았다. 유지관리자의 실명, 이메일, 약관 동의 및 개인정보 처리 동의는 저장소에 기록하지 않는다.

## 2026-07-23 결과

SignPath가 예로 든 재검토 근거는 GitHub star·fork·기여자, 외부 글, 독립적인 Reddit·Stack Overflow·YouTube 등의 언급, 기관 지원, 지속적인 활동과 참여다.

다음 증거가 쌓이기 전에는 같은 내용으로 반복 신청하지 않는다.

- 확인된 Windows 설치 사용자와 구체적인 사용 후기
- GitHub star, fork, issue, discussion과 외부 기여
- 프로젝트 작성자가 아닌 사용자의 독립적인 언급
- 안정화 릴리스와 지속적인 유지관리 기록
- 설치 파일, 해시, 미서명 상태와 개인정보 경계의 일관된 공개

재신청 목표는 고정 숫자만으로 자동 판단하지 않는다. 최소 30일간의 공개 활동을 기록한 뒤 [출시 계획](LAUNCH_PLAN.md)의 지표와 외부 근거 링크를 함께 검토한다.

## 공개 프로젝트 정보

| 신청 항목 | 입력할 값 |
| --- | --- |
| Project Name | `Codex Claude Usage` |
| Repository URL | `https://github.com/Kyuhan1230/ai-usage-monitor` |
| Homepage URL | `https://github.com/Kyuhan1230/ai-usage-monitor` |
| Download URL | `https://github.com/Kyuhan1230/ai-usage-monitor/releases/latest` |
| Privacy Policy URL | `https://github.com/Kyuhan1230/ai-usage-monitor/blob/main/docs/PRIVACY.md` |
| Wikipedia URL | 비워 둔다. |
| Maintainer Type | `Individual maintainer(s)` |
| Build System | `GitHub Actions` |

### Tagline

> A local Windows tray application for monitoring Codex CLI and Claude Code usage.

### Description

> Codex Claude Usage is an MIT-licensed Windows desktop application that monitors local Codex CLI and Claude Code usage. It displays current limits, exhaustion forecasts, local history, costs, and actions in a tray interface and embedded application windows. Usage data is processed on the user's PC, and verified Windows releases are distributed through GitHub Actions and GitHub Releases.

### Reputation

새 프로젝트이므로 사용량이나 보도 실적을 부풀리지 않는다. 다음처럼 현재 확인 가능한 공개 근거와 신규 프로젝트라는 사실을 함께 적는다.

> This is a newly released open-source project, and we do not claim broad adoption yet. Its source, MIT license, automated tests, release workflow, and downloadable artifacts are public. GitHub-hosted CI builds and verifies the Windows release assets before publishing them. Public evidence: https://github.com/Kyuhan1230/ai-usage-monitor/actions and https://github.com/Kyuhan1230/ai-usage-monitor/releases.

## 유지관리자가 직접 입력할 필수 항목

- First Name
- Last Name
- Email
- Primary Discovery Channel 및 필요한 경우 exact source
- SignPath Foundation Code of Conduct 동의
- SignPath의 개인정보 저장 및 처리 동의
- reCAPTCHA가 표시되는 경우 직접 확인

광고성 연락 수신 동의는 필수가 아니므로 유지관리자가 원하는 경우에만 선택한다.

## 재신청 및 승인 후 확인

1. GitHub 계정과 SignPath 계정에 다중 인증을 활성화한다.
2. 최신 릴리스와 개인정보 처리방침이 공개 상태인지 확인한다.
3. 다운로드 페이지가 SignPath Foundation 코드 서명 문구와 현재 미서명 상태를 모두 정확히 표시하는지 확인한다.
4. 첫 신청 이후 확보한 공개 신뢰 근거를 과장 없이 추가하고, 유지관리자 본인이 필수 동의 항목을 확인한 뒤 재신청한다.
5. 승인 후 발급되는 조직 ID, 프로젝트 slug, artifact configuration slug, signing policy slug 및 API token을 사용해 Release 워크플로를 연결한다.

재승인 전에는 가짜 SignPath 식별자나 API token을 GitHub Actions에 등록하지 않는다. 승인 후에는 서명되지 않은 릴리스가 공개되지 않도록 Release 워크플로의 서명 단계를 필수 게이트로 전환한다.
