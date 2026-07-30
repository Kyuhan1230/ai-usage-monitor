# Codex CLI compatibility matrix

Status: measured compatibility snapshot
Measured: 2026-07-30
Release architecture: Windows x64

This document records privacy-safe command outcomes only. The probes used a newly created empty `CODEX_HOME`; raw stdout, stderr, account data, paths, and authentication material were not retained. This is T1/local compatibility evidence, not a substitute for the human T3 OAuth and live-usage test.

## Decision

- Runtime acceptance remains **capability based**, not version-string based. A candidate must produce a recognized version and pass bounded `login --help` and `app-server --help` probes.
- `0.58.0` is the lowest version measured in this snapshot. It is a tested lower bound, not a claim that every earlier version is incompatible.
- The exact legacy npm candidate for the release T3 conflict scenario is **`@openai/codex@0.144.5` on Node.js `22.12.0`, npm `10.9.0`, Windows x64**.
- Every sampled `@openai/codex` manifest declares `engines.node: >=16`. The app therefore requires Node.js `>=16.0.0` for a legacy npm launcher and requires `process.arch` to match the app architecture.
- npm is needed to install or update the legacy package, but it is not probed when an existing launcher runs. The runtime dependency is Node.js plus the installed package.
- The official standalone path remains the release-user default. It does not require Node.js, npm, or Rust.
- ARM64 legacy npm execution was not measured. The current Windows release target and this gate are x64; ARM64 must not be advertised as T3-covered.
- A process-tree fixture found that Node.js `22.12.0` on this Windows host exits with access violation when a JavaScript parent loaded from a non-ASCII directory spawns PowerShell; Node.js `20.10.0` did not reproduce it. This is not treated as an app or official-standalone success. A real legacy npm launcher in such a path must pass the bounded operational probes or be rejected, and non-ASCII legacy npm support is not advertised by this matrix. The native standalone custom-path T2 is separate and uses a path containing spaces and Korean characters.

## Package and command matrix

All rows were installed from the public `@openai/codex` npm package into separate disposable prefixes. Node.js was `22.12.0` x64 and the empty-home auth result was normalized only as the known unauthenticated signature: exit `1`, final normalized line `Not logged in`.

| Package version | `--version` | `login --help` exit / `status` / `--device-auth` | `login status` | `app-server --help` | Result |
| --- | --- | --- | --- | --- | --- |
| `0.58.0` | exit 0, recognized `0.58.0` | `0` / present / present | known unauthenticated | exit 0, capability present | PASS |
| `0.100.0` | exit 0, recognized `0.100.0` | `0` / present / present | known unauthenticated | exit 0, capability present | PASS |
| `0.144.5` | exit 0, recognized `0.144.5` | `0` / present / present | known unauthenticated | exit 0, capability present | PASS |
| `0.146.0` | exit 0, recognized `0.146.0` | `0` / present / present | known unauthenticated | exit 0, capability present | PASS |

The same normalized probe set was repeated with the officially published Node.js `16.20.2` x64 archive:

| Package version | Node.js | Node architecture | Version/help/status/app-server contract | Result |
| --- | --- | --- | --- | --- |
| `0.58.0` | `16.20.2` | `x64` | all expected outcomes above reproduced | PASS |
| `0.146.0` | `16.20.2` | `x64` | all expected outcomes above reproduced | PASS |

Node.js `16.20.2` archive SHA-256 was checked against the matching official `SHASUMS256.txt`: `f8bb35f6c08dc7bf14ac753509c06ed1a7ebf5b390cd3fbdc8f8c1aedd020ec3`.

The app's unit tests separately cover:

- Node absent → `runtime_dependency_missing`
- Node below `16.0.0`, malformed version, or wrong architecture → `runtime_dependency_incompatible`
- compatible and incompatible legacy candidates coexisting with standalone selection
- `.cmd` quoting, bounded timeout, and descendant process-tree termination

## Approved T3 legacy candidate

T3 must use exactly:

```text
Package: @openai/codex@0.144.5
Node.js: 22.12.0 x64
npm: 10.9.0
Package integrity: sha512-jjB+K+OMv572mKhS+2QuLxWXDJNdpwbPenf+V+8bdq7wg4Scqt3cn6WEekD8wPqDVZqck0HSX17K9rD9kbDJQA==
```

On the disposable VM, install it only after the standalone install/login/restart baseline is complete:

```powershell
node --version
npm --version
npm install --global '@openai/codex@0.144.5'
```

The first two commands must report exactly `v22.12.0` and `10.9.0`. T3 then refreshes Setup and records only source, version, candidate tag, selection, and conflict-warning behavior. It must not copy `where codex`, auth output, account identity, or full paths into the report.

## Live account boundary

`account/rateLimits/read` was not run in this local matrix because it requires an authorized human account. The release T3 must prove that request with the exact selected standalone candidate before and after reboot. The legacy npm candidate exists to test deterministic conflict detection; it must not silently replace the already selected standalone candidate.

Until that T3 row is PASS, the release remains No-Go.

## Sources and reproducibility

- OpenAI Codex CLI reference: <https://developers.openai.com/codex/cli/reference>
- OpenAI Codex authentication: <https://developers.openai.com/codex/auth>
- Official npm package metadata: <https://registry.npmjs.org/@openai/codex>
- Approved package tarball: <https://registry.npmjs.org/@openai/codex/-/codex-0.144.5.tgz>
- Official Node.js archive index: <https://nodejs.org/dist/v16.20.2/>

Re-running this matrix must use new disposable directories, an empty `CODEX_HOME`, bounded commands, and the same privacy normalization. A changed package version, Node version, architecture, or integrity value creates a new matrix row; it does not overwrite this evidence.
