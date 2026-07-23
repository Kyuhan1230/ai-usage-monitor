# Windows install smoke report

Copy this file to `docs/community/install-smoke-<windows-version>.md` and replace every placeholder. Use a VM, spare Windows account, or test machine that contains no sensitive sessions. Do not include usernames, account identifiers, authentication data, raw session JSONL, private project names, or full home-directory paths.

## Environment

- Date: `<YYYY-MM-DD>`
- App version: `<X.Y.Z>`
- Installer SHA-256: `<digest>`
- Windows edition and version: `<example: Windows 11 Pro 24H2>`
- WebView2 version: `<version or preinstalled>`
- Provider tested: `<Codex CLI | Claude Code>`
- Provider CLI version: `<version>`
- Test environment: `<VM | spare account | test machine>`

## Trust and install

- GitHub Release digest matched: `<yes/no>`
- `Get-AuthenticodeSignature` result: `<NotSigned or verified publisher>`
- SmartScreen appeared: `<yes/no>`
- Exact SmartScreen path, without screenshots containing personal data: `<brief steps>`
- Installer completed: `<yes/no>`
- Unexpected network or permission prompt: `<none or sanitized description>`

## First run

- Setup opened automatically: `<yes/no>`
- CLI detected: `<yes/no>`
- Existing login detected without exposing account identity: `<yes/no>`
- First refresh succeeded: `<yes/no>`
- Quota/reset values appeared: `<yes/no>`
- Forecast wording was understandable: `<yes/no + short reason>`
- Window close left the tray app running: `<yes/no>`

## Remove

- Quit from tray succeeded: `<yes/no>`
- Windows uninstall succeeded: `<yes/no>`
- `~/.codex-usage-wrapper` behavior matched the documentation: `<yes/no + kept or manually removed>`
- Provider CLI remained installed: `<yes/no>`

## Friction and evidence

- Biggest point of friction: `<one concise paragraph>`
- Sanitized screenshots or logs: `<links or none>`
- Follow-up Issue: `<link or none>`

## Result

`<PASS | PASS WITH ISSUES | FAIL>`

Short conclusion:

> `<What worked, what stopped the test, and the next recommended change.>`
