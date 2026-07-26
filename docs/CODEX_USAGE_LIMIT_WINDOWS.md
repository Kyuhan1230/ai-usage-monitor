# How to Check Codex Usage Limits on Windows

If you are looking for your **Codex usage limit**, **weekly limit reset**, or an always-visible **Codex quota monitor for Windows**, start with the official Codex commands. A separate monitor is useful only when you want the limits visible outside the terminal or want to compare Codex with Claude Code.

## Quick answer

Open Codex in a terminal and use:

```text
/usage
```

This is the most direct built-in view for account usage. Current Codex documentation describes `/usage` as the command for viewing account token activity and rate-limit resets.

Two related commands are also useful:

```text
/status
/statusline
```

- `/status` displays session configuration, context usage, and rate-limit information.
- `/statusline` lets you choose persistent footer fields, including limit information.

See OpenAI's current [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands) for the authoritative command list. Commands and available fields can change with Codex versions and account configuration.

## Option 1: Use the official Codex CLI

1. Open PowerShell or Windows Terminal.
2. Start Codex:

   ```powershell
   codex
   ```

3. Enter `/usage` to inspect account usage and reset information.
4. Enter `/statusline` if you want limit information in the terminal footer.
5. Enter `/status` when you also need the current session and context details.

The official commands should be your first choice when you only need to check the quota occasionally.

## Account quota is not the same as context usage

These numbers answer different questions:

| Number | What it means |
| --- | --- |
| Account or rate limit | How much plan usage remains before a provider limit or reset |
| Context usage | How much of the current conversation's context window is occupied |
| Local token total | Token counts read from local session records; not necessarily the subscription quota |

A session can have plenty of context remaining while the account is close to a rate limit. It can also have a nearly full context window while the account still has quota available.

## Option 2: Keep Codex limits visible on Windows

The official terminal commands are enough for occasional checks. A Windows tray monitor can be more convenient when you:

- use Codex CLI throughout the day;
- want the remaining percentage and reset time outside the active terminal;
- use Codex and Claude Code on the same machine;
- want a local history of how the remaining percentage changes;
- want a warning when the recent pace may exhaust a limit before reset.

[Codex Claude Usage](https://github.com/Kyuhan1230/ai-usage-monitor) is a free, MIT-licensed Windows tray app for this use case.

| Need | Official Codex commands | Codex Claude Usage |
| --- | --- | --- |
| Check usage on demand | `/usage` or `/status` | Refresh in the app |
| Keep limits in the terminal footer | `/statusline` | Not required |
| View Codex outside the terminal | No separate tray window | Compact Windows window and tray |
| Compare Codex and Claude Code | Separate provider views | Both providers in one local app |
| Estimate whether recent pace reaches zero before reset | Not the primary purpose | Local history-based forecast |

## Install the Windows monitor

1. Open the [latest GitHub Release](https://github.com/Kyuhan1230/ai-usage-monitor/releases/latest).
2. Download `Codex-Claude-Usage-Setup-<version>.exe`.
3. Compare its SHA-256 digest with the digest shown in the release notes.
4. Run Setup and connect Codex CLI, Claude Code, or both.
5. Use **Check status again** after signing in with the provider's own CLI.

> [!WARNING]
> The current installer is not Authenticode-signed. Windows SmartScreen may show **Unknown publisher**. Download only from the official GitHub Release, verify the published SHA-256 digest, build from source, or wait for a future signed release.

The project does not currently publish a portable ZIP. A portable build would remove the installer step, but an unsigned portable executable could still trigger SmartScreen.

## What the forecast does—and does not do

The app records changes in the remaining percentage locally and estimates a recent depletion rate. It then compares a range of possible exhaustion times with the provider's displayed reset time.

The forecast means:

> If the observed pace remains similar, is the quota likely to reach zero before reset?

It does **not** know the size of your next coding task and does not guarantee that a particular task will finish. New installations also need enough local history before the forecast becomes useful. The current remaining percentage and reset time are still available before a confident forecast exists.

For the implementation details, see [Building a Windows quota forecaster for Codex CLI and Claude Code](ENGINEERING_STORY.md).

## Privacy

The app:

- reads quota numbers through already authenticated local CLIs;
- reads token counts from local session records;
- does not store prompts or response text;
- does not operate a developer-owned telemetry server;
- stores its status and derived history under `~/.codex-usage-wrapper`.

See the complete [privacy and network inventory](PRIVACY.md).

## Troubleshooting

### `/usage` or `/statusline` is not available

Confirm that you are using a current Codex release and consult the official [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands). Command availability can change between versions and product surfaces.

### The Windows app cannot find Codex

Run:

```powershell
codex login
```

Then reopen Setup and select **Check status again**. The app uses the installed Codex CLI and its existing authentication; it does not ask for or store the credential itself.

### The forecast says that there is not enough history

The remaining percentage must change over time before a depletion rate can be estimated. You can still use the current remaining percentage and reset time while more samples are collected.

## Frequently asked questions

### Does Codex show a weekly usage limit?

Use `/usage`, `/status`, or an enabled limit field in `/statusline` to inspect the limits exposed for your current Codex account and version. The available rows can depend on the account configuration.

### Can I monitor Codex usage in the Windows taskbar?

Codex can show limits in its terminal status line. Codex Claude Usage adds a separate compact Windows window and tray app for users who want the information outside the terminal.

### Does the monitor send my prompts to another server?

No. The app does not store prompt or response bodies and has no developer-operated analytics server. Provider requests are made through the respective installed CLIs.

### Is there a portable Codex usage monitor?

This project currently publishes an NSIS installer, not a portable ZIP. Portable distribution is being evaluated as a way to reduce setup friction, but it would not remove the unsigned-publisher warning by itself.

## Related links

- [Download the latest Windows release](https://github.com/Kyuhan1230/ai-usage-monitor/releases/latest)
- [Main project documentation](../README.md)
- [Korean guide](README.ko.md)
- [Privacy policy](PRIVACY.md)
- [Report installation or first-refresh feedback](https://github.com/Kyuhan1230/ai-usage-monitor/issues/19)
