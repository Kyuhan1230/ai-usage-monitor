# Windows install smoke report

Copy this file to `docs/community/install-smoke-<windows-version>-<app-version>-<date>.md` and replace every placeholder. Use a disposable VM, spare Windows account, or test machine that contains no sensitive sessions.

This report records state classifications, versions, hashes, and safe error codes. It must not contain usernames, account identifiers, email addresses, organization/workspace names, credentials, OAuth callbacks, MFA data, raw auth output, raw session JSONL, private project names, actual quota values, or full home/temporary paths.

## Result identity

- Test tier: `<T3 human remote Windows>`
- Date: `<YYYY-MM-DD>`
- App version: `<X.Y.Z>`
- App commit: `<40-character commit SHA>`
- Installer filename: `<versioned installer filename>`
- Installer byte size: `<bytes>`
- Installer SHA-256: `<64-character digest>`
- Candidate artifact or draft Release URL: `<URL>`
- Same-commit T2 default job URL: `<URL>`
- Same-commit T2 custom job URL: `<URL>`
- T2 default/custom result: `<PASS/PASS>`
- Independent review evidence: `<PR review, approval URL, or pending>`
- Final T3 Issue body SHA-256 in independent approval: `<64-character digest or pending>`

The installer SHA-256 above must identify the exact bytes intended for public Release. Rebuilding the installer invalidates this report. The complete report, from Environment through Result, must be embedded directly in the T3 Issue body; a repository or external link may be supplementary but cannot replace it. After the final report is placed in the T3 Issue, the independent reviewer must hash the current Issue body returned by the GitHub API and put that digest in the approval comment as `T3_REPORT_BODY_SHA256`. Editing the Issue body after approval invalidates that approval.

## Environment

- Test environment: `<disposable cloud VM | spare account | test machine>`
- Windows edition and version: `<example: Windows 11 Pro 24H2>`
- OS build: `<build>`
- Architecture: `<x64 | ARM64>`
- Account privilege used for app test: `<standard user>`
- WebView2 version: `<version or preinstalled>`
- PowerShell environment: `<Windows PowerShell 5.1; PowerShell 7 present yes/no>`
- Node.js before test: `<absent | present, version only>`
- npm before test: `<absent | present, version only>`
- Rust before test: `<absent | present, version only>`
- Fresh pre-auth image or snapshot: `<yes/no>`
- Sensitive personal/work sessions absent: `<yes/no>`

Do not include the cloud account, VM resource ID, Windows username, computer name, public IP, or any full filesystem path.

## Initial Codex inventory

- Codex desktop resource present: `<yes/no>`
- Windows App Execution Alias present: `<yes/no/not tested>`
- Standalone CLI present: `<yes/no>`
- npm legacy CLI present: `<yes/no>`
- Other same-name executable present: `<yes/no>`
- Initial candidate source classification: `<none | desktop_bundle_only | alias_only | other safe source>`
- Initial Codex version: `<none | version>`
- Raw `where codex` output excluded from report: `<yes/no>`

If a path was needed during diagnosis, record only a source classification and privacy-safe candidate tag. Do not paste the path.

## Trust and monitor install

- GitHub/draft asset digest matched: `<yes/no>`
- `Get-AuthenticodeSignature` result: `<NotSigned or verified publisher/status>`
- SmartScreen appeared: `<yes/no>`
- Exact SmartScreen path, without account or desktop screenshots: `<brief steps>`
- NSIS Codex offer defaulted to **No**: `<yes/no>`
- Codex offer was declined for the missing-state baseline: `<yes/no>`
- Monitor installer completed despite the decline: `<yes/no>`
- Unexpected network or permission prompt: `<none or sanitized description>`

## Required state transitions

Use the product's exact state names when available. A terminal opening is not a successful operation, and a login process exiting is not proof of authentication.

| ID | Checkpoint/action | Expected CLI state | Actual CLI state | Expected operation state | Actual operation state | Expected auth state | Actual auth state | Safe error code | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S01 | First Setup, Codex absent | `missing` | `<state>` | install/login `idle` | `<state>` | `unavailable` | `<state>` | `<none/code>` | `<PASS/FAIL>` |
| S02 | Decline official install, check again | `missing` | `<state>` | install `cancelled/idle` | `<state>` | `unavailable` | `<state>` | `<none/code>` | `<PASS/FAIL>` |
| S03 | Approve Setup official install | not yet `ready` while running | `<state>` | install `running` | `<state>` | `unavailable` | `<state>` | `<none/code>` | `<PASS/FAIL>` |
| S04 | Official installer process exits | `ready` only after validation | `<state>` | install `succeeded` | `<state>` | `unauthenticated` | `<state>` | `<none/code>` | `<PASS/FAIL>` |
| S05 | Start app login action | `ready` | `<state>` | login `running` | `<state>` | `unauthenticated` | `<state>` | `<none/code>` | `<PASS/FAIL>` |
| S06 | Human completes browser OAuth/MFA | `ready` | `<state>` | login `exited` | `<state>` | automatic recheck → `authenticated` | `<state>` | `<none/code>` | `<PASS/FAIL>` |
| S07 | First live usage request | `ready` | `<state>` | usage request completes | `<state>` | `authenticated` | `<state>` | `<none/code>` | `<PASS/FAIL>` |
| S08 | App fully quit and reopened | same selected CLI | `<state>` | `idle` | `<state>` | `authenticated` | `<state>` | `<none/code>` | `<PASS/FAIL>` |
| S09 | Windows reboot and recheck | same selected CLI | `<state>` | `idle` | `<state>` | `authenticated` | `<state>` | `<none/code>` | `<PASS/FAIL>` |
| S10 | Add approved legacy npm CLI | deterministic standalone selection + conflict warning | `<state>` | `idle` | `<state>` | selected CLI auth state | `<state>` | `<none/code>` | `<PASS/FAIL>` |
| S11 | Uninstall monitor only | provider preserved | `<state>` | uninstall complete | `<state>` | credential preserved | `<state>` | `<none/code>` | `<PASS/FAIL>` |

## Official standalone result

- Official installer consent copy was accurate: `<yes/no>`
- Installer terminal visibly started: `<yes/no>`
- App avoided declaring success merely because the terminal opened: `<yes/no>`
- Installer process outcome: `<succeeded/failed/cancelled/detached>`
- Post-install automatic rediscovery occurred: `<yes/no>`
- Selected source: `<default_standalone_path | other>`
- Selected Codex version: `<version>`
- Provenance confidence: `<tracked_official_install | verified_publisher | unverified | invalid>`
- Privacy-safe candidate tag: `<tag>`
- HKCU PATH refresh was recognized without app restart: `<yes/no>`
- Pre-login `codex login status` zero exit: `<yes/no; expected no>`
- Auth output stored or copied: `<no; anything else is FAIL>`

## Human OAuth and first usage

- Login was initiated from the app: `<yes/no>`
- App used the already selected CLI candidate: `<yes/no>`
- Browser opened from `codex login`: `<yes/no>`
- OAuth/MFA was completed manually by the authorized tester: `<yes/no>`
- Account secret was placed in GitHub Actions or a script: `<no; anything else is FAIL>`
- Automatic auth recheck occurred after the login process: `<yes/no>`
- Manual **Check status again** fallback worked: `<yes/no>`
- Post-login `codex login status` zero exit, output discarded: `<yes/no>`
- First live `account/rateLimits/read` succeeded: `<yes/no>`
- Quota/reset UI appeared without copying actual values into evidence: `<yes/no>`
- Cached prior success was not presented as the current result: `<yes/no>`

## Restart, reboot, and conflict

- App quit from tray succeeded: `<yes/no>`
- App restart selected the same source/tag: `<yes/no>`
- Windows reboot completed: `<yes/no>`
- Reboot preserved CLI detection: `<yes/no>`
- Reboot preserved authentication: `<yes/no>`
- Reboot live usage request succeeded: `<yes/no>`
- Approved legacy npm test version: `<version>`
- Legacy npm source was discovered: `<yes/no>`
- Standalone remained the deterministic selection: `<yes/no>`
- Conflict warning and recovery action were understandable: `<yes/no + short reason>`
- Login probe and usage used the same selected candidate: `<yes/no>`

## Optional real App Execution Alias

- Microsoft Store was available: `<yes/no>`
- Real alias-only scenario was run: `<yes/no>`
- Alias-only was classified as `desktop_bundle_only`: `<yes/no/not run>`
- Alias plus standalone selected the standalone: `<yes/no/not run>`
- If not run, reason and coverage retained at T1: `<reason>`

Do not describe a fake T1 alias fixture as a real Microsoft-created App Execution Alias.

## Remove and data behavior

- Windows uninstall succeeded: `<yes/no>`
- `~/.codex-usage-wrapper` behavior matched the privacy documentation: `<yes/no + kept or manually removed>`
- Standalone Codex remained installed: `<yes/no>`
- Legacy npm Codex remained installed: `<yes/no/not installed>`
- Codex credential remained managed by Codex after monitor removal: `<yes/no>`
- Monitor uninstall changed provider PATH or credential: `<no; anything else is FAIL>`

## Privacy and disposal

- No credential, token, cookie, MFA data, auth output, account identity, full path, session content, or actual quota value appears in this report: `<yes/no>`
- Screenshots were cropped and permanently redacted before export: `<yes/no/not attached>`
- Redaction originals remained on the disposable VM only: `<yes/no/not applicable>`
- No post-auth reusable snapshot/image was created: `<yes/no>`
- VM deleted: `<yes/no/not a VM>`
- OS/data disks and snapshots deleted: `<yes/no/not a VM>`
- Public IP and temporary RDP rule deleted: `<yes/no/not a VM>`

## Friction and evidence

- Biggest point of friction: `<one concise paragraph>`
- Sanitized screenshots: `<links or none>`
- T2 evidence artifacts: `<links>`
- Follow-up Issue with owner and due date: `<link or none>`
- Known untested supported combination: `<none or explicit combination and release impact>`

## Result

`<PASS | PASS WITH ISSUES | FAIL>`

Definitions:

- `PASS`: every required transition passed, exact installer bytes were tested, and privacy/disposal checks passed.
- `PASS WITH ISSUES`: no release blocker failed; every issue has an owner, due date, and link.
- `FAIL`: a required transition, exact-byte check, OAuth/usage/reboot/conflict/uninstall check, or privacy rule failed or was skipped.

Short conclusion:

> `<What worked, what stopped the test, whether the exact candidate may be released, and the next required action.>`

Independent reviewer conclusion:

> `<Approved / rejected, with evidence link. Do not include personal or account identifiers.>`
