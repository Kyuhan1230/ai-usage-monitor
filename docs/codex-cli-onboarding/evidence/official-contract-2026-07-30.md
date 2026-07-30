# OpenAI Codex installation and authentication contract snapshot

Verified: 2026-07-30
Authority: OpenAI documentation and the official installer served by OpenAI

This snapshot records the external assumptions used by the implementation. The installer body is not vendored because it changes independently; the release T2 downloads it again and records the exact SHA-256 used in each run.

## Windows standalone installer

Source: <https://chatgpt.com/codex/install.ps1>

The downloaded script measured:

```text
SHA-256: 391f247de2c70c7e99041979ec02dae7e76be27ac9cfc1dfe7c1eb21d48d8b97
Bytes: 37146
```

Observed contract:

- `CODEX_NON_INTERACTIVE` accepts `1`, `true`, or `yes`, case-insensitively.
- The default visible executable directory is under `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`.
- A non-empty `CODEX_INSTALL_DIR` replaces that visible executable directory.
- `CODEX_HOME\packages\standalone` is an installer-managed package/cache location. It is not treated as a user-facing executable discovery root by this app.
- The script downloads a native Windows asset. It does not invoke npm, Cargo, or rustup.

Consequences for the app:

- A release user choosing the official standalone flow does not need Node.js, npm, Rust, Cargo, or Codex preinstalled.
- The app launches this exact HTTPS URL only after explicit consent. It does not vendor or silently replace the script.
- Interactive Setup must not set `CODEX_NON_INTERACTIVE`; the user must see progress in the new PowerShell window.
- T2 may set `CODEX_NON_INTERACTIVE=1` in a disposable runner, but T2 must not claim to cover human OAuth.
- Both default and custom T2 jobs record the script hash. Publication requires the two hashes and installed CLI versions to match.

## Authentication commands

Official references:

- <https://developers.openai.com/codex/auth>
- <https://developers.openai.com/codex/cli/reference>

Verified contract:

- `codex login` opens the ChatGPT OAuth browser flow when no alternative flag is supplied.
- `codex login --device-auth` uses the OAuth device-code flow instead of launching a browser.
- `codex login status` exits with `0` when logged in.
- The human user—not this app—enters the account, chooses the permitted workspace, completes MFA, and grants approval.

Consequences for the app:

- The app may start the selected CLI's login command and display its progress; it never enters account data or completes MFA.
- Browser login is the default action. Device auth is offered only if the selected candidate's help output confirms `--device-auth`.
- A login process exiting is not authentication proof. The app reruns `login status` using the same selected file identity.
- Unknown nonzero output is an auth probe error. Only the measured, normalized unauthenticated signature becomes `unauthenticated`; raw auth output is discarded.
- Passwords, tokens, cookies, device codes, OAuth callbacks, account identities, and raw auth output are forbidden in CI and release evidence.

## Change handling

This is a dated snapshot, not an evergreen promise. A changed installer hash is expected upstream and is not by itself a failure. The T2 evidence must bind the exact script bytes used by both install modes, while the app continues to validate the resulting executable's version and required capabilities rather than trusting a path or download completion alone.
