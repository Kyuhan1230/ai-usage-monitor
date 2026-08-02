# Unsigned Windows beta release checklist

Use this checklist for every public release until Authenticode code signing is available. Tauri updater signing and Windows Authenticode are separate controls.

## Required release evidence

- [ ] CI, Rust tests, UI tests, and release-contract tests pass.
- [ ] The installer was produced by the repository's GitHub Actions release workflow.
- [ ] Installer filename, byte size, and SHA-256 are recorded in the release notes.
- [ ] Authenticode state is stated explicitly as either `Unsigned` or the verified publisher and status.
- [ ] Tauri updater `.exe.sig` and `latest.json` are present and verified.
- [ ] The release notes link to installation, removal, privacy, and known-issues instructions.
- [ ] SmartScreen behavior was checked on a clean or representative Windows account.
- [ ] A sanitized install and first-refresh smoke test passed for at least one supported provider.
- [ ] Upgrade from the previous supported release preserves `~/.codex-usage-wrapper`.
- [ ] Rollback or manual reinstall behavior is documented if the release changes storage or updating.

Community testers can use the [Windows install smoke report template](community/INSTALL_SMOKE_REPORT_TEMPLATE.md) without sharing account or session data.

## SHA-256

GitHub displays a digest for release assets. Repeat the installer digest in the release body so users can verify it without opening API metadata.

```powershell
Get-FileHash '.\Codex-Claude-Usage-Setup-<version>.exe' -Algorithm SHA256
```

The value must match the digest on the GitHub Release asset. A checksum proves byte identity, not that an unsigned program is trustworthy.

## Authenticode

```powershell
Get-AuthenticodeSignature '.\Codex-Claude-Usage-Setup-<version>.exe' |
  Select-Object Status, StatusMessage, SignerCertificate
```

Until a certificate is available, publish `Authenticode: unsigned` and warn that SmartScreen can show **Unknown publisher**. Do not describe the Tauri updater signature as Windows publisher signing.

## VirusTotal

If the final public installer is submitted to VirusTotal, link to the report for the exact SHA-256 and record the scan date. Do not call the result a safety certificate. Engines can change their verdicts, heuristic detections can occur, and zero detections do not prove that a program is safe.

Do not submit private, pre-release, credential-bearing, or user-specific artifacts. Only submit the exact installer already intended for public release.

## Install and remove

Install:

1. Download only from the official GitHub Release.
2. Verify SHA-256.
3. Review the unsigned-publisher warning.
4. Run the current-user NSIS installer.
5. Connect at least one already installed and authenticated CLI.

Remove:

1. Quit the app from the tray menu.
2. Uninstall **Codex Claude Usage** from Windows Installed apps.
3. To remove locally derived history and settings too, delete `~/.codex-usage-wrapper`.
4. Codex CLI and Claude Code are separate programs and are not removed with this app.

## Release-note skeleton

```markdown
> [!WARNING]
> Authenticode: **unsigned**. Windows SmartScreen may show **Unknown publisher**.

## Download verification

- Installer: `Codex-Claude-Usage-Setup-X.Y.Z.exe`
- Size: `<bytes>`
- SHA-256: `<digest>`
- Tauri updater signature: verified by the release workflow
- VirusTotal: `<exact-hash report or "not submitted">`

## Install and remove

See the [installation and trust guide](https://github.com/Kyuhan1230/ai-usage-monitor#installation-and-trust).

## Known issues

- `<issue or "none known">`

## Changes

- `<user-visible change>`
```
