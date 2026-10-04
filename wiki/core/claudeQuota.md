# claudeQuota

**File**: [src/core/claudeQuota.ts](../../src/core/claudeQuota.ts)

Fetches the authenticated user's **real** Claude Code plan-quota (5-hour and weekly rate-limit-window utilization %) by reusing the OAuth access token Claude Code already wrote to `~/.claude/.credentials.json` from `claude login`. This is the same 5h/7d number shown on `claude.ai/settings/usage` - distinct from [claudeAccountView.ts](../webview/claudeAccountView.md)'s `calcWindow()` local estimate, which only approximates usage from session-log timestamps.

## Why it exists

Claude Code already writes a usable OAuth access token to disk, and Anthropic returns plan-window utilization in `anthropic-ratelimit-unified-*-utilization` response headers. Together those make the real 5h/7d numbers reachable with **no API key entry and no login flow of our own** - replacing this codebase's now-removed dead "connect API key" UI, which demanded a pasted Anthropic API key and then only showed per-minute API rate limits (see `docs/dead-code-audit.md`).

## No login flow of our own

Unlike `copilotQuota.ts` (which requires the user to run **AI Insights: Connect GitHub**), this needs no explicit connect step - it only reads a token that already exists because the user is signed into Claude Code. It ships **on by default**; disable via `aiInsights.providers.claudeCode.liveQuota.enabled` to keep this fully local.

## API

```ts
readClaudeOAuthAccessToken(): string | null
fetchClaudeRateLimitHeaders(accessToken: string): Promise<ClaudeRateLimitSnapshot | null>
shouldRefreshClaudeQuota(lastFetchAt: Date | null, now?: Date): boolean

interface ClaudeRateLimitSnapshot {
  fiveHourPct: number | null;
  fiveHourResetsAt: string | null;
  sevenDayPct: number | null;
  sevenDayResetsAt: string | null;
  fetchedAt: string;
}
```

`readClaudeOAuthAccessToken()` tries a couple of plausible key paths (`claudeAiOauth.accessToken`, `accessToken`) since the credentials file format is undocumented; any failure (missing file, bad JSON, no token) returns `null`, never throws.

`fetchClaudeRateLimitHeaders()` makes a minimal `POST /v1/messages` request (`max_tokens: 1`, one filler character) using `Authorization: Bearer <token>` plus `anthropic-beta: oauth-2025-04-20` (the header Claude Code itself uses for OAuth-token API calls, not an `x-api-key`). Reads `anthropic-ratelimit-unified-5h-utilization` / `-7d-utilization` and their `-reset` counterparts off the response - present on both success and 4xx responses. No message content is sent beyond the filler character, and nothing is stored remotely.

## Throttling

`shouldRefreshClaudeQuota()` gates calls to at most once per `MIN_REFRESH_INTERVAL_MS` (5 minutes). `extension.ts`'s `refreshClaudeQuota()` calls it every `refresh()` cycle (same cadence as `refreshCopilotQuota()`), guarded by: setting enabled AND at least one `claudeCode` session present AND the throttle AND a token being readable. Failures are logged to the output channel and swallowed, same pattern as `refreshCopilotQuota()`.

## Integration (`extension.ts`)

```ts
let claudeQuota: ClaudeRateLimitSnapshot | null = null;
let claudeQuotaLastFetchAt: Date | null = null;

async function refreshClaudeQuota(): Promise<void> { /* see refresh() */ }
```

`claudeQuota` is threaded through `ClaudeAccountViewProvider.createPanel`/`getHtml`/`pushMetrics` as a trailing optional param.

## UI ([claudeAccountView.ts](../webview/claudeAccountView.md))

The "Usage Limits" section's badge switches from `session files` to `live · Anthropic API` when a snapshot is available, and the session/weekly cards render real percentage + progress bar (amber ≥70%, red ≥90%) + real reset countdown instead of the local token-based estimate. Falls back to the pre-existing `calcWindow()` estimate (badge stays `session files`) when no snapshot is available - no credentials file, fetch failed, or the setting is off.

## Setting

`aiInsights.providers.claudeCode.liveQuota.enabled` (boolean, default `true`) - documented in `package.json` and in README's Privacy/Accuracy section alongside every other outbound call this extension makes.
