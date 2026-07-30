# Codex onboarding local validation

Validated: 2026-07-31 KST
Branch: `fix/codex-login-detection`
Scope: implementation, tests, workflow syntax, local official-CLI probe, and unsigned CI-mode NSIS build

This evidence was produced after the implementation and workflow changes and before the final documentation-only evidence update. It does not replace the exact-commit remote T2 or human T3 gates defined by the [specification](../spec.md).

## Pinned environment

| Component | Required | Result |
| --- | --- | --- |
| Node.js | `22.12.0` | PASS |
| npm | `10.9.0` | PASS |
| rustc/cargo | `1.97.1` | PASS |
| Rust target | `x86_64-pc-windows-msvc` | PASS |
| MSVC Build Tools | installed | PASS |
| WebView2 Runtime | installed | PASS |

`npm ci` completed from the committed lockfile and reported zero known vulnerabilities in the installed npm dependency set.

## Automated implementation tests

The pinned environment ran `npm test` successfully.

| Gate | Result |
| --- | --- |
| `cargo fmt --check` | PASS |
| all-target Clippy with `-D warnings` | PASS |
| Rust tests | PASS — 96/96 |
| UI contract tests | PASS — 11 scripts |
| release/evidence tamper tests | PASS |
| actionlint over all four workflows | PASS |
| PowerShell AST parse over 38 `pwsh` workflow blocks | PASS |
| `git diff --check` | PASS |

The Windows `.cmd → node.exe → PowerShell descendant` normal-exit, timeout, and explicit-cancel regression was also run three consecutive times with Node.js `22.12.0`; all three runs passed. The selected launcher path included spaces and Korean characters. The worker fixture was kept in an ASCII temporary directory because pinned Node.js `22.12.0` itself crashes when its test-only JavaScript parent is loaded from a non-ASCII path and then spawns PowerShell; the product still validates the selected non-ASCII `.cmd` path and fails closed if a real legacy launcher cannot execute.

## Existing official CLI live probe

The repository live harness used the installed native standalone candidate at the documented default location with a newly created empty `CODEX_HOME`. No account secret, API key, OAuth automation, or retained raw command output was used.

```json
{
  "schema_version": 1,
  "selected_expected_candidate": true,
  "selected_source": "default_standalone_path",
  "selected_version": "0.144.5",
  "provenance": "unverified",
  "auth_state": "unauthenticated",
  "safe_error_code": null
}
```

`unverified` is expected here: the candidate was found and capability-probed successfully, but it was not installed by the currently tracked app operation. A default path alone is not promoted to `tracked_official_install`.

## CI-mode NSIS build

`npm run dist:ci` completed successfully.

| Field | Value |
| --- | --- |
| Bundle | unsigned x64 NSIS CI bundle |
| Size | `2,368,051` bytes |
| SHA-256 | `A860738B7CD2F1D691CF0736ED9B6674E88914BC8ECB396C0548BCD00867B847` |

This is a local validation artifact, not a public release candidate. Any subsequent code, dependency, toolchain, or bundling change invalidates this hash.

## Explicit evidence boundary

The following gates were **not** completed by this local run:

- Actual `/S` install and uninstall were not run locally because that could overwrite uninstall registration for the user's existing installation. The disposable remote Windows CI smoke must execute them.
- The new official-installer T2 workflow has not yet run on the pushed commit. Its default and custom jobs must install the current official script, produce matching script hashes and CLI versions, and pass the live harness.
- CI currently proves the `IfSilent` branch plus known Codex-file and User/Machine PATH invariance. It does not dynamically prove that every process in the installer tree attempted zero outbound packets.
- Browser OAuth/MFA, first authenticated `account/rateLimits/read`, app restart, Windows reboot, legacy npm conflict, and uninstall preservation were not run. A human must complete those steps on a disposable Windows desktop by following the [T3 runbook](../REMOTE_WINDOWS_TEST.md).
- GitHub release immutability, independent T3 tester/reviewer, and the protected `production-release` environment are external release prerequisites and remain No-Go until configured and evidenced.

No local or T1/T2 result may be reported as proof of human login.
