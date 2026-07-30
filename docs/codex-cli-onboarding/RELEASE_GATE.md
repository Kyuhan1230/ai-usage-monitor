# Codex onboarding Release gate

이 문서는 Codex 설치·로그인 변경이 포함된 Windows Release를 **draft 준비**와 **공개**로 분리하는 운영 계약이다. 핵심 원칙은 간단하다.

> T3에서 사람이 시험한 installer bytes만 공개한다. T3 뒤에는 installer를 다시 빌드하지 않는다.

`.github/workflows/release.yml`은 이 원칙을 다음 두 job으로 강제한다.

| 단계 | job | 만드는 것 | 공개 여부 |
| --- | --- | --- | --- |
| 준비 | `prepare-draft` | updater 서명이 포함된 NSIS installer, alias, `.sig`, `latest.json`, `release-evidence.json` | 비공개 draft |
| 공개 | `publish-existing-draft` | 새 파일을 만들지 않고 기존 draft를 내려받아 검증한 뒤 draft 상태만 해제 | T2·T3·독립 승인 후 공개 |

Tag push는 준비 job만 실행한다. 준비 job 안에는 공개 명령이 없다. 공개는 별도의 `workflow_dispatch` 또는 `workflow_call`에서 `operation=publish`를 명시해야만 실행된다.

## 1. Draft 준비

Release tag `v<package-version>`을 `main` tip에 만든다. Tag push가 자동으로 준비를 시작하며, 필요하면 Actions UI에서 `operation=prepare`와 기존 tag를 입력해 수동으로 시작할 수 있다.

준비 job은 다음을 확인한다.

1. tag, `package.json` version과 checkout commit이 정확히 일치한다.
2. tagged commit이 준비 시점의 `origin/main` tip이다.
3. Node.js 22.12.0, npm 10.9.0과 Rust 1.97.1 toolchain이 정확하다.
4. 전체 Rust·UI·Release test가 통과한다.
5. Tauri updater private key로 installer updater signature를 만든다.
6. draft에 다음 5개 asset만 올린다.

   - `Codex-Claude-Usage-Setup-<version>.exe`
   - `Codex-Claude-Usage-Setup.exe`
   - `Codex-Claude-Usage-Setup-<version>.exe.sig`
   - `latest.json`
   - `release-evidence.json`

`release-evidence.json`에는 release tag, version, full commit, 준비 workflow run ID와 앞의 네 배포 파일별 byte size·SHA-256이 들어간다. 이 JSON 자체의 SHA-256을 공개 입력과 T3 보고서에 함께 고정하므로 네 배포 파일 전체가 하나의 digest로 묶인다. 편의용 installer alias는 versioned installer와 byte-for-byte로 같아야 한다.

준비 job은 같은 `release-evidence.json`을 `release-preparation-evidence-<run-id>-<attempt>` Actions artifact로도 올린다. 공개 job은 JSON 안의 run ID를 숫자로만 믿지 않고 GitHub API로 해당 run의 성공 상태, exact commit, release workflow 경로, 성공한 `prepare-draft` job, exact attempt의 만료되지 않은 artifact와 그 파일 hash를 확인한다. 공개 직전에도 run·job·artifact identity를 다시 확인한다.

Draft Release 본문에도 full commit, versioned installer SHA-256과 `release-evidence.json` SHA-256을 기록한다. 준비 검증과 공개 검증이 이 세 줄을 다시 확인하므로 고객에게 보이는 checksum과 gate 입력이 갈라지지 않는다.

이미 같은 tag의 draft가 있으면 workflow는 asset을 `--clobber`하지 않는다. 기존 파일과 새 파일이 모두 같을 때만 재검증을 허용하고, 하나라도 다르면 중단한다. 기존 draft를 삭제하고 다시 준비하면 이전 T3 보고서는 즉시 무효가 된다.

준비 단계에 필요한 secret:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

현재 workflow는 기존 secret 배치를 깨뜨리지 않도록 준비 job에도 `production-release` environment를 사용한다. 위 secret이 repository 또는 이 environment에서 제공되어야 한다. 이 서명은 Tauri updater signature이며, Authenticode 적용 여부와는 별도다.

## 2. 같은 commit의 T2

Draft가 준비되면 `Codex CLI official installer smoke`를 **release commit 자체에서** 수동 실행한다. 공개 job에 전달할 run ID는 다음 조건을 모두 만족해야 한다.

- workflow path가 `.github/workflows/codex-cli-installer-smoke.yml`이다.
- run `head_sha`가 release commit과 같다.
- 완료 시점이 공개 시각 기준 최근 7일 이내다.
- 전체 run conclusion이 `success`다.
- `T2 official installer (default)`와 `T2 official installer (custom)` job이 각각 하나이고 모두 같은 commit에서 성공했다.
- 현재 run attempt의 `codex-cli-t2-default-...`, `codex-cli-t2-custom-...` evidence artifact가 만료되지 않았다.
- 두 JSON evidence의 모든 필수 step과 repository live harness가 성공했다.
- 격리한 `CODEX_HOME`에서 OAuth를 시도하지 않았고 authenticated로 보고하지 않았다.

T2는 실제 공식 installer와 실제 CLI를 검증하지만 사람의 브라우저 OAuth를 검증하지 않는다. T2 run을 T3로 표현하면 안 된다.

## 3. 사람의 T3 보고서

[원격 Windows T3 시험 절차](REMOTE_WINDOWS_TEST.md)를 **draft의 versioned installer**로 수행한다. 상세 보고서는 기존 smoke report template을 따라 **전문을 gate Issue 본문에 직접 포함**해야 한다. 저장소 문서나 외부 URL은 보조 자료로 링크할 수 있지만 authoritative report를 대신할 수 없다. 이렇게 해야 독립 승인이 해시로 묶는 Issue 본문과 실제 상태 전이·redaction 보고서가 정확히 같은 바이트가 된다. ChatGPT credential, token, cookie, MFA 값과 raw auth 출력은 보고서, Issue나 Actions secret에 넣지 않는다.

시험자는 이 저장소의 새 Issue를 만들고 허용된 증거와 상세 보고서 위치를 기록한다. Issue 작성자는 repository collaborator여야 하며, 시험 완료 뒤 `release:t3-approved` label을 붙이고 `completed` 상태로 닫는다. 본문에는 다음 marker가 각각 정확히 한 줄씩 있어야 한다.

Repository 관리자는 최초 운영 전에 `release:t3-approved` label을 만들어야 한다. 이름은 대소문자까지 정확해야 하며 일반 QA 진행 label과 구분한다.

```text
T3_RESULT: PASS
RELEASE_TAG: v<version>
RELEASE_COMMIT: <full-40-character-sha>
RELEASE_VERSION: <version>
INSTALLER_ASSET: Codex-Claude-Usage-Setup-<version>.exe
INSTALLER_SHA256: <64-hex-sha256>
RELEASE_EVIDENCE_SHA256: <release-evidence.json-64-hex-sha256>
T2_RUN_ID: <workflow-run-id>
T3_DETAIL_REPORT: EMBEDDED
HUMAN_OAUTH: PASS
FIRST_USAGE: PASS
APP_RESTART: PASS
WINDOWS_REBOOT: PASS
LEGACY_NPM_CONFLICT: PASS
UNINSTALL_PRESERVATION: PASS
REDACTION_REVIEW: PASS
NO_CREDENTIALS_IN_CI: CONFIRMED
```

`T3_DETAIL_REPORT: EMBEDDED`는 smoke report template의 Environment부터 Result까지 필요한 절과 S01–S11 PASS 행이 모두 이 Issue 본문에 있다는 뜻이다. 공개 workflow는 이 구조와 최소 길이를 검사한다. 링크된 문서만 있거나 marker만 있는 skeletal Issue는 실패한다.

`HUMAN_OAUTH: PASS`는 RDP 세션의 권한 있는 사람이 Codex가 연 브라우저에서 직접 OAuth/MFA를 완료했다는 뜻이다. 자동 브라우저, 재사용 token, Actions secret 또는 fake CLI 결과로 이 값을 채우면 안 된다.

Issue 작성자는 모든 marker와 상세 보고서를 최종 상태로 만든 뒤 Issue를 닫고 label을 붙인다. 그 뒤 Issue 작성자와 다른 repository collaborator가 원문·redaction·draft SHA-256을 검토한다. reviewer는 로컬 파일이 아니라 GitHub API가 반환한 **현재 Issue 본문 UTF-8 바이트**의 SHA-256을 계산하고 같은 Issue에 다음 comment를 남긴다.

```text
T3_REVIEW: APPROVED
RELEASE_TAG: v<version>
RELEASE_COMMIT: <full-40-character-sha>
RELEASE_VERSION: <version>
INSTALLER_SHA256: <64-hex-sha256>
RELEASE_EVIDENCE_SHA256: <release-evidence.json-64-hex-sha256>
T2_RUN_ID: <workflow-run-id>
T3_REPORT_BODY_SHA256: <current-issue-body-utf8-64-hex-sha256>
```

reviewer는 다음 PowerShell처럼 REST API 응답의 `body` 문자열을 그대로 사용한다. `<owner/repo>`와 `<issue-number>`를 실제 값으로 바꾸되 본문을 파일로 복사하거나 줄바꿈을 다시 저장해 hash를 만들지 않는다.

```powershell
$issue = gh api 'repos/<owner/repo>/issues/<issue-number>' | ConvertFrom-Json
$algorithm = [Security.Cryptography.SHA256]::Create()
try {
  $bytes = [Text.Encoding]::UTF8.GetBytes([string]$issue.body)
  $reportBodySha256 = [BitConverter]::ToString(
    $algorithm.ComputeHash($bytes)
  ).Replace('-', '')
} finally {
  $algorithm.Dispose()
}
$reportBodySha256
```

공개 job은 Issue 번호와 review comment ID를 받아 두 작성자가 서로 다른지, marker가 draft installer와 정확히 일치하는지, 상세 보고서 필수 절과 S01–S11 PASS 행이 본문에 모두 있는지 확인하고, 현재 Issue 본문에서 SHA-256을 다시 계산해 `T3_REPORT_BODY_SHA256`과 비교한다. review 뒤 Issue 제목이 아닌 **본문**을 한 글자라도 수정하면 기존 승인은 무효다. 수정된 본문을 독립 reviewer가 다시 검토하고 새 hash를 담은 새 approval comment를 남겨야 한다. 구조화 marker는 사람의 시험을 대신하지 않는다. 사람이 수행한 최종 보고서를 변경 불가능한 release identity에 묶는 장치다.

## 4. 독립 environment 승인

`publish-existing-draft`는 `production-release` environment에 배포한다. 저장소 설정에서 다음 protection을 먼저 구성해야 한다.

- required reviewer가 한 명 이상 있어야 한다.
- **Prevent self-review**를 켜야 한다.
- administrator bypass를 막아야 한다.
- 가능하면 tag/branch deployment policy를 Release 운영 범위로 제한한다.

Workflow도 GitHub API로 required reviewer rule, `prevent_self_review=true`와 `can_admins_bypass=false`를 다시 확인한다. 현재 설정이 다르면 environment 승인을 받은 뒤에도 공개 직전에 실패한다. GitHub의 공식 설명은 [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)와 [Reviewing deployments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/review-deployments)를 따른다.

GitHub plan이나 repository visibility 때문에 required reviewer를 사용할 수 없는 저장소에서는 이 gate를 우회해 공개하지 않는다. 별도 독립 승인 수단을 설계하고 workflow에 검증 가능한 protection으로 반영할 때까지 Release는 No-Go다. 이 저장소는 public repository이므로 현재 GitHub plan에서 environment required reviewer를 사용할 수 있다.

Repository 설정의 **Enable release immutability**도 반드시 켜야 한다. 이 설정은 공개 뒤 tag와 asset 교체를 GitHub 자체에서 막는다. Publication job은 공개 전에 공식 `GET /repos/{owner}/{repo}/immutable-releases` endpoint를 읽어 `enabled=true`인지 확인하며, 설정이 꺼져 있거나 상태를 읽지 못하면 fail-closed로 중단한다. Workflow는 이 administration 설정을 변경하지 않는다. repository 관리자가 [Preventing changes to your releases](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes)에 따라 먼저 활성화해야 한다. 현재 원격 저장소는 이 설정이 꺼져 있으므로 활성화 전까지 Release는 No-Go다.

## 5. 공개 입력과 검증

Actions UI에서 `Release` workflow를 열고 다음 값을 입력한다.

| 입력 | 값 |
| --- | --- |
| `operation` | `publish` |
| `release_tag` | draft의 정확한 tag |
| `release_commit` | full 40-character tagged commit |
| `release_version` | `v`를 제외한 package version |
| `installer_sha256` | T3가 시험한 versioned draft installer SHA-256 |
| `release_evidence_sha256` | 준비 summary에 기록된 `release-evidence.json` SHA-256 |
| `t2_run_id` | 같은 commit, 최근 7일 내 T2 success run |
| `t3_report_issue` | 닫힌 T3 PASS Issue 번호 |
| `t3_review_comment_id` | 독립 reviewer comment ID |
| `confirmation` | `PUBLISH_VERIFIED_DRAFT` |

공개 job은 source를 다시 build하지 않는다. 기존 draft asset 5개를 새 temporary directory로 내려받아 다음을 확인한다.

1. tag, package version, full commit과 입력이 일치한다.
2. 입력한 `release_evidence_sha256`, `release-evidence.json`과 네 배포 파일의 size·SHA-256이 모두 일치한다.
3. versioned installer와 alias가 같은 bytes다.
4. updater manifest와 updater signature가 유효하다.
5. T2 run, 두 matrix job과 두 evidence artifact가 release commit에 묶여 있다.
6. T3 Issue와 독립 review comment가 같은 tag·commit·version·installer SHA·T2 run을 가리킨다.
7. `production-release`가 required reviewer와 self-review 방지를 사용한다.
8. repository release immutability가 실제로 활성화되어 있다.

모두 통과한 뒤에만 `gh release edit <tag> --draft=false --latest`를 실행한다. 공개 직후에는 remote tag commit을 다시 확인하고 5개 asset을 전부 다시 내려받아 공개 전 SHA-256과 비교한 뒤, release evidence와 updater manifest/signature를 재검증한다. 이어지는 canary는 `releases/latest`의 direct installer와 updater manifest가 방금 검증한 bytes/version을 제공하는지 확인한다.

## 6. Reusable workflow 호출

다른 workflow에서 호출할 때도 같은 gate가 적용된다.

```yaml
jobs:
  publish:
    uses: ./.github/workflows/release.yml
    with:
      operation: publish
      release_tag: v1.2.8
      release_commit: 0123456789abcdef0123456789abcdef01234567
      release_version: 1.2.8
      installer_sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      release_evidence_sha256: abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
      t2_run_id: "123456789"
      t3_report_issue: "123"
      t3_review_comment_id: "456789"
      confirmation: PUBLISH_VERIFIED_DRAFT
    secrets: inherit
```

Caller가 가진 token permission은 reusable workflow의 job permission을 더 줄일 수 있다. 공개 호출에는 최소 `actions: read`, `contents: write`, `deployments: read`, `issues: read`가 필요하다. 준비 호출에는 draft asset을 쓸 `contents: write`와 updater signing secret이 필요하다.

## 7. 즉시 No-Go

다음 경우에는 공개하지 않는다.

- Tag push 직후 T3 없이 draft를 공개함
- T3 뒤 installer를 다시 build하거나 draft asset을 교체함
- T2의 commit, run attempt, default/custom evidence 중 하나가 다르거나 만료됨
- T3 Issue 또는 reviewer comment의 version·commit·SHA가 draft와 다름
- T3 tester와 reviewer가 같은 사람임
- environment self-review가 허용됨
- CI에서 OAuth credential을 사용하거나 OAuth 성공을 자동 생성함
- T3 Issue에 credential, token, raw auth 출력 또는 전체 사용자 경로가 포함됨
