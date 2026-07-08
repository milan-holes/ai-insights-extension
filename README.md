# AI Insights - Token Tracker for VS Code

Track token usage, costs, and AI metrics across **GitHub Copilot**, **Antigravity**, **Claude Code**, and **Codex** - all from your VS Code status bar.

All data is read from local session logs - **nothing leaves your machine**.

![alt text](https://github.com/milan-holes/ai-insights-extension/blob/main/screenshots/screenshot-1.png?raw=true "AI Insights Dashboard")

## Features

### 📊 Real-time Token Tracking

Displays current day and 30-day token usage directly in the VS Code status bar.

### 🤖 Multi-Provider Support

Track usage across AI coding assistants simultaneously:

| Provider           | Data Source                                                              | Token Data                                       |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------ |
| **GitHub Copilot** | `workspaceStorage/*/chatSessions/` (VS Code, Cursor, VSCodium, Insiders) | Actual counts when available, else estimated     |
| **Antigravity**    | `~/.gemini/antigravity/brain/`                                           | Estimated from conversation text                 |
| **Claude Code**    | `~/.claude/projects/`                                                    | Actual input/output/cache token counts           |
| **Codex**          | `~/.codex/sessions/`                                                     | Actual usage snapshots from local Codex rollouts |

### 📈 Dashboard Views

- **Main Dashboard** - Developer impact metrics (hours saved, value generated, AI spend, ROI multiplier) and a Usage Health Score breakdown with actionable insights (shown above), plus token/session/interaction totals, cache hit rate, an activity heatmap, and a daily token usage vs. cost chart.
  ![alt text](https://github.com/milan-holes/ai-insights-extension/blob/main/screenshots/screenshot-2.png?raw=true "AI Insights Dashboard")
- **Sessions Overview** - Active session tracking, total sessions/tokens/estimated cost/workspaces, a daily token consumption chart, and a usage-by-provider breakdown.
  ![alt text](https://github.com/milan-holes/ai-insights-extension/blob/main/screenshots/screenshot-3.png?raw=true "Sessions")
- **Session Activity & History** - Highest-cost session callout, most-read/edited files, most-used tools, commands run, and a filterable, sortable, exportable session table.
  ![alt text](https://github.com/milan-holes/ai-insights-extension/blob/main/screenshots/screenshot-4.png?raw=true "Session Analysis")
- **Session Context Analysis** - Per-session drill-down with a CQ (context quality) score, context size/budget allocation, and a turn-by-turn timeline of input/output/tool-call activity.
  ![alt text](https://github.com/milan-holes/ai-insights-extension/blob/main/screenshots/screenshot-5.png?raw=true "Context Analysis")

### 💰 Cost Estimation

Per-model pricing for 30+ models across OpenAI, Anthropic, and Google:

- Cache-aware pricing (Anthropic prompt caching, OpenAI prefix matching)
- Input/output token cost breakdown
- Daily and projected yearly cost

### 🔗 Real GitHub Copilot Credits (optional)

Connect your GitHub account and AI Insights pulls your **real, live Copilot premium-request quota** (entitlement, remaining, reset date, plan tier) straight from GitHub - see [GitHub Copilot: Real AI Credits/Quota Usage](#-github-copilot-real-ai-creditsquota-usage) below.

### 🧪 Prompt A/B Testing

![alt text](https://github.com/milan-holes/ai-insights-extension/blob/main/screenshots/screenshot-6.png?raw=true "Prompt A/B Testing")

Run the same prompt against multiple provider/model variants (Claude Code, Copilot, Codex) side by side and compare responses, token usage, cost, wall time, and lines of code produced.

Each variant runs in its own **isolated git worktree**, so nothing touches your actual working copy:

- For every variant, AI Insights creates a disposable worktree at `.ai-abtest/<variantId>` off a new `abtest/<variantId>` branch, branched from your current `HEAD`. This directory is kept out of `git status` via a local (untracked) exclude entry, not your tracked `.gitignore`.
- The provider/model adapter for that variant (its own CLI or agent tool loop) runs against the prompt **inside that worktree only**, free to read/write files without any risk to your real branch or working directory.
- Because each variant is a real worktree on a real branch, you can open any of them in a new VS Code window ("Open in New Window") to inspect the result, and since it's just a normal git branch, a variant you like can be **merged back into your main worktree** with an ordinary `git merge abtest/<variantId>` (or cherry-picked/rebased) from the primary repo - no extra tooling needed.
- Variants run one at a time; results include a real `git diff --numstat` against `HEAD` for lines added/deleted/files changed (falling back to counting fenced code blocks in the response if nothing was written to disk).
- Worktrees/branches are cleaned up via the panel's "Clean up worktrees" button; any left over from a crashed or reloaded window (only tracked in memory per session) are detected as orphans on next open and can be cleaned up in one click.
- Requires the workspace to be a git repository - if it isn't, the panel prompts you to run `git init`.

## ⚠️ Accuracy & Limitations

AI Insights computes every metric from **AI session logs stored locally on your machine** - nothing is uploaded. Because it's local-only, the numbers can diverge from your provider's official billing/usage page:

- **Multiple computers, same subscription** - if you use the same account from another machine, that machine's sessions aren't scanned here. Totals only reflect activity on the machine running the extension.
- **Cleared/deleted history** - clearing chat history, workspace storage, or provider log directories (`~/.claude`, `~/.codex`, etc.) removes that usage from future calculations. Past totals already shown are not retroactively corrected.
- **Hidden system prompts** - providers inject a system prompt plus tool/agent instructions server-side that aren't always exposed in local session logs, so real input/context size can be higher than what's shown. Where this applies (currently Copilot JSON sessions), the `aiInsights.providers.copilot.inputTokenMultiplier` setting lets you set a default multiplier to approximate the missing overhead.
- **GitHub Copilot cache tracking depends on one Copilot setting** - `chatSessions`/`transcripts` files alone never carry a cache-read/cache-write breakdown, so by default Copilot's Cache Hit Rate / Cache Savings numbers are a **calculated estimate** (turn-over-turn context diffing, flagged "(calc.)" everywhere it's shown), not measured data. If you turn on GitHub Copilot's own `github.copilot.chat.agentDebugLog.fileLogging` setting, Copilot additionally writes real per-request `inputTokens`/`outputTokens`/`cachedTokens` to local debug-log files, and AI Insights reads those automatically and uses them in place of the estimate wherever they exist - real data for sessions logged after you enable it, calculated estimates for everything else (older sessions, or if you leave it off). AI Insights will offer to turn this Copilot setting on for you the first time it runs (one-time prompt, never silent) - see "GitHub Copilot: Real Cache/Token Data" below for what that involves and how to trigger it manually. Cache metrics for providers with real per-request cache counts by default (e.g. Claude Code) are unaffected.
- **Single-turn Copilot sessions never show a cache estimate, by design** - the calculated estimate above works by comparing a turn's context size to the _previous turn in the same session_; a session with only one exchange (one message, one reply) has no earlier turn to compare against, so its cache numbers are `0` regardless of settings. This is expected, not a sign the estimate is broken - most Copilot sessions on a typical machine turn out to be single-turn, which is usually why cache data looks sparse when scanning older history.

Treat these numbers as a **local, best-effort estimate** for tracking trends - not an exact reconciliation of your invoice.

## 🔓 GitHub Copilot: Real Cache/Token Data

By default, GitHub Copilot's local session files don't include a cache-read/cache-write breakdown, so AI Insights calculates one via turn-over-turn context diffing and marks it "(calc.)" everywhere it's shown - see [Accuracy & Limitations](#️-accuracy--limitations) above.

GitHub Copilot itself can produce **real** per-request `inputTokens` / `outputTokens` / `cachedTokens` if you turn on its own setting:

```json
"github.copilot.chat.agentDebugLog.fileLogging.enabled": true
```

Once this is on, Copilot writes that data to local files at `debug-logs/{sessionId}/main.jsonl` (inside your VS Code `workspaceStorage`), and AI Insights reads it automatically - no restart or extra configuration needed on the AI Insights side, including on Remote-WSL/SSH/Codespaces setups where the session file and its debug log can live on different filesystems (client vs. remote host) sharing the same workspace folder. Real data covers sessions logged _after_ you enable it; older sessions keep using the calculated estimate. `transcripts/{sessionId}.jsonl`, the session format this depends on, has been confirmed present since at least Copilot Chat 0.46.0, so most current installs already have it.

**What enabling it actually does, so you can decide for yourself:** this is a GitHub Copilot setting, not an AI Insights one - it makes the Copilot Chat extension write your full prompts and code context to local, unencrypted debug-log files that don't otherwise exist. Nothing is sent anywhere new (it's still 100% local, same as every other file AI Insights reads), but it is an additional local copy of your conversation content being persisted to disk. If that's a concern for your workplace's data-handling policy, leave it off - AI Insights works fine either way, just with estimates instead of exact cache numbers.

**How to enable it:**

- AI Insights shows a one-time prompt on first activation (if GitHub Copilot Chat is installed) offering to turn this setting on for you - click "Enable" if you want real data, "Not now" to be asked again later, or "Don't ask again" to dismiss permanently.
- Missed the prompt, or want to enable it later? Click **"✅ Enable Real Cache Data"** in the dashboard's or Copilot credits page's Cache Efficiency widget (shown whenever the setting is off and you have Copilot usage), or run **AI Insights: Enable GitHub Copilot Real Cache Data** from the Command Palette at any time - both trigger the same confirmation dialog.
- Prefer to do it yourself, or never be asked? Set `github.copilot.chat.agentDebugLog.fileLogging.enabled` directly in `settings.json`, and/or turn off `aiInsights.providers.copilot.promptToEnableRealCacheData` so AI Insights stops asking.

## 🔗 GitHub Copilot: Real AI Credits/Quota Usage

Everything above (token counts, cost estimates, cache stats) is derived from local session logs. Separately, if you **connect your GitHub account**, AI Insights also pulls your **real, live Copilot premium-request quota** directly from GitHub - the same entitlement/remaining/reset-date data the Copilot Chat extension itself uses to enforce limits.

- **How to connect** - run **AI Insights: Connect GitHub to Auto-Set Budget** from the Command Palette, or click **"Connect GitHub"** in the Copilot credits/pricing view. You'll be prompted to sign in via VS Code's built-in GitHub auth; AI Insights only requests the minimal `read:user` scope.
- **What you get once connected**:
  - Real premium-request **entitlement, remaining, and percent used** for the current billing cycle (not estimated from local logs).
  - **Days/hours until quota reset**, based on GitHub's actual reset date.
  - **Overage tracking** if you've gone past your included quota (for plans with pay-as-you-go overage).
  - A **burn-rate prediction** (low/medium/high confidence) estimating daily usage and days until exhaustion, built from a local rolling history of your quota snapshots (kept per GitHub account, up to 90 data points).
  - Your Copilot **plan tier** (Free/Pro/Business/Enterprise) is auto-detected and used to set a sensible default monthly budget for cost-vs-budget comparisons; if GitHub doesn't expose your plan via the API, you'll be asked to pick it manually.
- **Where it shows up** - the status bar tooltip, the main dashboard, and the Copilot credits/pricing view all surface this real quota data (labeled distinctly from the "(calc.)" local estimates) once available.
- **Scope and privacy** - this only fetches your own Copilot quota metadata (numbers, dates, plan name) from GitHub's API; it does not read or transmit any prompt/chat content. The access token is managed by VS Code's built-in GitHub authentication, not stored by AI Insights.
- **Disconnecting** - run **AI Insights: Disconnect GitHub Account**, or use the "Disconnect" button next to your connected account in the pricing view, to stop fetching quota data and clear the stored account link.
- **Notes/limitations**:
  - This uses an undocumented GitHub endpoint (`copilot_internal/user`), so it can occasionally 403/404 for some accounts, orgs, or during outages - AI Insights fails silently in that case and simply won't show real quota data until the next successful refresh.
  - This is independent of the "real cache/token data" toggle above - one is about per-request token counts from local debug logs, the other is about your account-level quota from GitHub's servers. You can use either, both, or neither.

## Install

### From Source

```bash
git clone https://github.com/milan-holes/ai-insights-extension
cd ai-insights-extension
npm install
npm run compile
```

### Run in Development

Press `F5` in VS Code to launch the Extension Development Host.

### Package as VSIX

```bash
npx @vscode/vsce package
```

### Install VSIX

```bash
code --install-extension ai-insights-0.1.0.vsix
```

## Commands

| Command                                              | Description                                                                                                                                                                                                    |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI Insights: Refresh Token Usage`                   | Manually refresh token counts                                                                                                                                                                                  |
| `AI Insights: Show Token Usage Dashboard`            | Open the main dashboard                                                                                                                                                                                        |
| `AI Insights: Show Token Usage Charts`               | Open interactive charts                                                                                                                                                                                        |
| `AI Insights: Generate Diagnostic Report`            | Generate system diagnostic report                                                                                                                                                                              |
| `AI Insights: Enable GitHub Copilot Real Cache Data` | Turn on Copilot's `agentDebugLog.fileLogging` setting for real cache/token data (see [GitHub Copilot: Real Cache/Token Data](#-github-copilot-real-cachetoken-data) above)                                     |
| `AI Insights: Connect GitHub to Auto-Set Budget`     | Sign in with GitHub to pull real Copilot premium-request quota/credits and auto-detect your plan budget (see [GitHub Copilot: Real AI Credits/Quota Usage](#-github-copilot-real-ai-creditsquota-usage) above) |
| `AI Insights: Disconnect GitHub Account`             | Stop fetching real Copilot quota data and clear the connected account                                                                                                                                          |
| `AI Insights: A/B Test Prompts Across Providers`     | Open the Prompt A/B Testing panel to compare providers/models on the same prompt, each in its own isolated git worktree (see [Prompt A/B Testing](#-prompt-ab-testing) above)                                  |

## Settings

| Setting                                                    | Default | Description                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aiInsights.display.compactNumbers`                        | `true`  | Use K/M suffixes for numbers                                                                                                                                                                                                                                                                      |
| `aiInsights.providers.copilot.enabled`                     | `true`  | Enable Copilot tracking                                                                                                                                                                                                                                                                           |
| `aiInsights.providers.copilot.promptToEnableRealCacheData` | `true`  | One-time prompt offering to enable Copilot's real cache/token telemetry - see above                                                                                                                                                                                                               |
| `aiInsights.providers.antigravity.enabled`                 | `true`  | Enable Antigravity tracking                                                                                                                                                                                                                                                                       |
| `aiInsights.providers.claudeCode.enabled`                  | `true`  | Enable Claude Code tracking                                                                                                                                                                                                                                                                       |
| `aiInsights.providers.codex.enabled`                       | `true`  | Enable Codex tracking                                                                                                                                                                                                                                                                             |
| `aiInsights.providers.<provider>.additionalSessionPaths`   | `[]`    | Extra folders to scan for that provider's sessions, for non-standard storage locations (moved home dir, synced backup, remote mount, etc.). Available for every provider - see the ⚙️ Settings panel (`AI Insights: Show Diagnostics`) for the full editable list with per-provider descriptions. |
| `aiInsights.refreshIntervalMinutes`                        | `5`     | Auto-refresh interval                                                                                                                                                                                                                                                                             |

## Status Bar

The extension shows token usage in the format:

```
$(pulse) <today> | <30 days>
```

**Hover** for detailed breakdown including:

- Today's tokens, sessions, and cost
- Last 30 days summary
- Per-provider breakdown

**Click** to open the full dashboard.

```bash
# Type check
npm run compile

# Watch mode for development
npm run watch

# Production build
npm run package

# Create VSIX
npx @vscode/vsce package
```

## Session Log Locations

### GitHub Copilot

Supported IDEs (sessions stored as JSON - readable):

| IDE              | Linux                                              | macOS                                                                  | Windows                                            |
| ---------------- | -------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| VS Code          | `~/.config/Code/User/workspaceStorage/`            | `~/Library/Application Support/Code/User/workspaceStorage/`            | `%APPDATA%\Code\User\workspaceStorage\`            |
| VS Code Insiders | `~/.config/Code - Insiders/User/workspaceStorage/` | `~/Library/Application Support/Code - Insiders/User/workspaceStorage/` | `%APPDATA%\Code - Insiders\User\workspaceStorage\` |
| Cursor           | `~/.config/Cursor/User/workspaceStorage/`          | `~/Library/Application Support/Cursor/User/workspaceStorage/`          | `%APPDATA%\Cursor\User\workspaceStorage\`          |
| VSCodium         | `~/.config/VSCodium/User/workspaceStorage/`        | `~/Library/Application Support/VSCodium/User/workspaceStorage/`        | `%APPDATA%\VSCodium\User\workspaceStorage\`        |

WSL is also supported - the extension automatically scans Windows-side AppData paths via `/mnt/c/Users/`.

**Not fully supported** (binary session formats, not parseable):

| IDE                                                | Reason                                                                            |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| JetBrains (PyCharm, WebStorm, PhpStorm, IntelliJ…) | Sessions stored in Xodus binary DB (`.idea/copilot/chatSessions/`), no JSON files |
| Visual Studio                                      | Sessions stored as binary files (`.vs/<project>/copilot-chat/sessions/`)          |

### Antigravity

- **All platforms**: `~/.gemini/antigravity/brain/{conversation-id}/.system_generated/logs/overview.txt`

### Claude Code

- **All platforms**: `~/.claude/projects/{project}/*.jsonl`

## License

MIT
