# Channel and directory research

Checked on 2026-07-23. Rules change, so re-open the linked source immediately before posting or submitting a pull request.

## Reddit

### r/ClaudeCode — primary candidate

The [current rules](https://www.reddit.com/r/ClaudeCode/about/rules) explicitly allow tools and resources when the post states:

- what the tool does;
- who benefits;
- any cost;
- the author's relationship to it.

The post must stay specific to Claude Code, use the right flair, avoid clickbait and referral links, and not repeat the promotion. Use the Claude-focused draft in [PROMOTION_COPY.md](PROMOTION_COPY.md), state that it is the author's free MIT project, and disclose the unsigned Windows installer before the link.

### r/codex — primary candidate

The [current rules](https://www.reddit.com/r/codex/about/rules) require direct relevance to the Codex tool suite, the right flair, and evidence or reproducible detail for usage-limit and problem posts. They also prohibit bot posting.

Use the Codex-specific draft and include the collection method, measured footprint, SHA-256 and unsigned limitation. Post manually; do not automate submission or voting.

### r/ChatGPTCoding — megathread only

The community currently runs recurring [self-promotion threads](https://www.reddit.com/r/ChatGPTCoding/comments/1s6prcr/self_promotion_thread/) and links to a promotion policy. Use the active megathread instead of a standalone promotion post unless the current rules clearly say otherwise.

### Excluded from the first wave

- `r/Python`: the product is not a Python package.
- `r/LocalLLaMA`: the product monitors hosted coding-tool subscription limits, not local models.
- broad AI and LangChain communities: low target fit.

## Awesome lists and showcases

### `tauri-apps/awesome-tauri` — eligible after the English README is on main

Candidate category: **Applications → Developer tools**.

The [current contribution guidelines](https://github.com/tauri-apps/awesome-tauri/blob/dev/.github/contributing.md) require:

- alphabetical placement;
- one suggestion per pull request;
- description under 24 words that does not start with “A” or “An”;
- Tauri version badge;
- English README;
- an original app making a reasonable effort to be fast, lightweight, and secure;
- signed commits.

Candidate entry:

```markdown
- [Codex Claude Usage](https://github.com/Kyuhan1230/ai-usage-monitor) ![v2] - Forecasts Codex and Claude quota exhaustion, detects spikes, and recommends next actions in a local Windows tray app.
```

This description is 18 words after the separator. Before opening the PR, verify that the maintainer's Git commit signing is configured and that the English README is visible on the default branch.

### `RoggeOhta/awesome-codex-cli` — eligible after initial proof of use

The [current contribution guidelines](https://github.com/RoggeOhta/awesome-codex-cli/blob/main/CONTRIBUTING.md) require direct Codex CLI relevance, active maintenance, a clear value description and a GitHub star badge. They reject self-promotion without substance and ask for real users or clear unique value.

The app has a distinct quota-forecast and Windows decision-surface angle, but submission is stronger after at least several confirmed installs and one external feedback item.

Candidate entry:

```markdown
- [Codex Claude Usage](https://github.com/Kyuhan1230/ai-usage-monitor) - Local Windows tray app that forecasts Codex quota exhaustion, detects usage spikes, and recommends next actions. ![GitHub stars](https://img.shields.io/github/stars/Kyuhan1230/ai-usage-monitor?style=flat-square)
```

### `jqueryscript/awesome-claude-code` — monitor, do not prioritize

The list has a matching [Usage & Observability section](https://github.com/jqueryscript/awesome-claude-code#-usage--observability), but its contribution guidelines currently say “Under Construction” and the repository has a large open pull-request backlog. Do not make it the first directory submission.

### `subinium/awesome-claude-code` — currently ineligible

The [README](https://github.com/subinium/awesome-claude-code) states that only repositories with 1,000 or more stars are listed. Do not submit until the requirement is met.

### Made with Tauri — secondary showcase

[Made with Tauri](https://madewithtauri.com/) is a focused app showcase. Check its current submission workflow after the English README, demo and default-branch assets are live.

## Posting gate

Before every community post:

- [ ] Open the live rules page again.
- [ ] Confirm the correct flair, megathread or showcase location.
- [ ] State the author's relationship to the project.
- [ ] State that the project is free and MIT-licensed.
- [ ] Disclose Windows-only and Authenticode-unsigned status before the download link.
- [ ] Put technical evidence or a useful lesson before the project link.
- [ ] Do not request votes, coordinate engagement or repeat the same copy.
