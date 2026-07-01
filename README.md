# AI Insights - Token Tracker for VS Code

Track token usage, costs, and AI metrics across **GitHub Copilot**, **Antigravity**, **Claude Code**, and **Codex** - all from your VS Code status bar.

All data is read from local session logs - **nothing leaves your machine**.

![alt text](https://github.com/milan-holes/ai-insights-extension/blob/main/screenshots/screenshot-2.png?raw=true "AI Insights Dashboard")
![alt text](https://github.com/milan-holes/ai-insights-extension/blob/main/screenshots/screenshot-3.png?raw=true "AI Insights Dashboard")
![alt text](https://github.com/milan-holes/ai-insights-extension/blob/main/screenshots/screenshot-1.png?raw=true "Token Usage")
![alt text](https://github.com/milan-holes/ai-insights-extension/blob/main/screenshots/screenshot-4.png?raw=true "Sessions")

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

- **Main Dashboard** - Token totals, cost estimates, provider breakdown, model usage
- **Interactive Charts** - Daily usage bars, stacked model breakdown, provider doughnut
- **Diagnostics** - System info, session file discovery, cache stats, JSON export

### 💰 Cost Estimation

Per-model pricing for 30+ models across OpenAI, Anthropic, and Google:

- Cache-aware pricing (Anthropic prompt caching, OpenAI prefix matching)
- Input/output token cost breakdown
- Daily and projected yearly cost

## ⚠️ Accuracy & Limitations

AI Insights computes every metric from **AI session logs stored locally on your machine** - nothing is uploaded. Because it's local-only, the numbers can diverge from your provider's official billing/usage page:

- **Multiple computers, same subscription** - if you use the same account from another machine, that machine's sessions aren't scanned here. Totals only reflect activity on the machine running the extension.
- **Cleared/deleted history** - clearing chat history, workspace storage, or provider log directories (`~/.claude`, `~/.codex`, etc.) removes that usage from future calculations. Past totals already shown are not retroactively corrected.
- **Hidden system prompts** - providers inject a system prompt plus tool/agent instructions server-side that aren't always exposed in local session logs, so real input/context size can be higher than what's shown. Where this applies (currently Copilot JSON sessions), the `aiInsights.providers.copilot.inputTokenMultiplier` setting lets you set a default multiplier to approximate the missing overhead.
- **No GitHub Copilot cache tracking** - GitHub's usage-based billing meters cached prompt tokens separately (and at a discount), but Copilot's local session logs don't expose a cache-read/cache-write breakdown - the underlying `assistant.usage` events report `cacheReadTokens`/`cacheWriteTokens` as `0` regardless of model ([github/copilot-sdk#1073](https://github.com/github/copilot-sdk/issues/1073)), and enabling Copilot's chat debug file logging only writes a combined input-token count, not a separate cache figure ([microsoft/vscode#311186](https://github.com/microsoft/vscode/issues/311186)). So Cache Hit Rate / Cache Savings will show `0%`/`$0` for Copilot even if your real invoice includes a cache discount. Cache metrics for providers with real per-request cache counts (e.g. Claude Code) are unaffected.

Treat these numbers as a **local, best-effort estimate** for tracking trends - not an exact reconciliation of your invoice.

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

| Command                                   | Description                       |
| ----------------------------------------- | --------------------------------- |
| `AI Insights: Refresh Token Usage`        | Manually refresh token counts     |
| `AI Insights: Show Token Usage Dashboard` | Open the main dashboard           |
| `AI Insights: Show Token Usage Charts`    | Open interactive charts           |
| `AI Insights: Generate Diagnostic Report` | Generate system diagnostic report |

## Settings

| Setting                                    | Default | Description                  |
| ------------------------------------------ | ------- | ---------------------------- |
| `aiInsights.display.compactNumbers`        | `true`  | Use K/M suffixes for numbers |
| `aiInsights.providers.copilot.enabled`     | `true`  | Enable Copilot tracking      |
| `aiInsights.providers.antigravity.enabled` | `true`  | Enable Antigravity tracking  |
| `aiInsights.providers.claudeCode.enabled`  | `true`  | Enable Claude Code tracking  |
| `aiInsights.providers.codex.enabled`       | `true`  | Enable Codex tracking        |
| `aiInsights.refreshIntervalMinutes`        | `5`     | Auto-refresh interval        |

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
