# githubAuth

[src/core/githubAuth.ts](../../src/core/githubAuth.ts)

Opt-in GitHub authentication service that detects the user's Copilot plan and updates the budget setting.

## Exported API

| Symbol | Description |
|---|---|
| `ConnectedGitHubUser` | Interface: `{ login, planName, monthlyBudgetUsd }` |
| `connectGitHubAndDetectPlan()` | Async function — authenticates, fetches plan, updates config |
| `getGitHubAccessToken(options?)` | Async function — returns a GitHub session token, or `undefined`. `options.createIfNone` (default `true`) controls whether it prompts a sign-in dialog when no session exists; pass `{ createIfNone: false }` for background/periodic checks that must never surprise an unconnected user with a popup. `options.forceNewSession` forces the account picker. |

## Plan → budget mapping

| GitHub plan | Label | `copilotPlanBudget` |
|---|---|---|
| `free` | Free | $0 |
| `pro` | Pro | $10 |
| `team` | Business | $19 |
| `enterprise` | Enterprise | $39 |

## Flow

1. Calls `vscode.authentication.getSession('github', ['read:user'], { createIfNone: true })` — VS Code handles OAuth.
2. `GET https://api.github.com/user` with the session token.
3. If `user.plan.name` is present, uses it directly. If not (requires elevated scope), shows a `showQuickPick` for the user to select manually.
4. Writes `aiInsights.copilotPlanBudget` to global VS Code config.
5. Returns `ConnectedGitHubUser` (stored in `globalState` by the caller).

## Callers

- `extension.ts` — `aiInsights.connectGitHub` command handler (`connectGitHubAndDetectPlan()`). Persists the returned user with `context.globalState.update(...)` and passes it to `DashboardProvider.createPanel()` for display.
- `extension.ts` — `refreshCopilotQuota()` (see [copilotQuota.md](copilotQuota.md)) calls `getGitHubAccessToken({ createIfNone: false })` on every refresh cycle, once the user has connected GitHub, to fetch the real live Copilot quota without ever prompting a sign-in dialog on its own.
- `extension.ts` — `handleTeamServerSharing()` calls `getGitHubAccessToken()` (default `createIfNone: true`) to authenticate team-server uploads.
