# CodexProvider

**File**: [src/providers/codex.ts](../../src/providers/codex.ts)  
**Provider ID**: `codex`

Reads Codex local rollout session logs from `~/.codex/sessions/`.

## Log format

Codex stores JSONL rollout files (for example `rollout-*.jsonl`) with per-event token snapshots.

Typical metadata and usage fields consumed by this provider:

| Field                                                   | Purpose                                     |
| ------------------------------------------------------- | ------------------------------------------- |
| `type=session_meta`                                     | Session metadata (id, cwd/workspace, model) |
| `timestamp`                                             | Event timestamp                             |
| `payload.info.last_token_usage.input_tokens`            | Input token count                           |
| `payload.info.last_token_usage.cached_input_tokens`     | Cache-read input tokens                     |
| `payload.info.last_token_usage.output_tokens`           | Output token count                          |
| `payload.info.last_token_usage.reasoning_output_tokens` | Thinking/reasoning token count              |
| `payload.info.last_token_usage.total_tokens`            | Total token count when provided             |
| `payload.rate_limits`                                   | Real quota state - see below                |

Lines with missing usage are skipped (but `rate_limits` is captured first, since a `token_count` entry can carry quota data without usable token numbers).

## Real quota data, no network call

Codex records its own rate-limit state on **every** `token_count` event - the same entries this provider already reads for token usage:

```json
"rate_limits": {
  "limit_id": "codex", "plan_type": "free",
  "primary":   { "used_percent": 58.0, "window_minutes": 10080, "resets_at": 1778185368 },
  "secondary": null, "credits": null, "rate_limit_reached_type": null
}
```

This is genuine quota data for a provider with **no public quota endpoint** - unlike [copilotQuota.md](../core/copilotQuota.md) (internal API call) and Claude Code (rate-limit response headers), it needs no network request and no credentials at all. Parsed into `Session.rateLimits` (`SessionRateLimits` in [types.ts](../../src/types.ts)) and consumed by [quotaGuard.md](../core/quotaGuard.md).

| Field                     | Meaning                                                      |
| ------------------------- | ------------------------------------------------------------ |
| `primary`                 | Shorter window (`window_minutes`, e.g. 10080 = 7d)           |
| `secondary`               | Longer window when the plan has one                          |
| `used_percent`            | 0-100 utilization                                            |
| `resets_at`               | **Unix seconds** - converted to ISO on parse                 |
| `plan_type`               | `free`, `plus`, ...                                          |
| `rate_limit_reached_type` | Non-null once a limit was actually hit                       |
| `credits`                 | Remaining prepaid credits, when reported                     |

The shape is undocumented and may change, so `extractRateLimits()` returns `undefined` for anything unparseable rather than throwing. Because this is a *recording* rather than a live reading, [quotaGuard.md](../core/quotaGuard.md) discards snapshots older than 60 minutes and windows whose `resets_at` has already passed.

Each interaction also carries `promptPreview` (first ~200 chars of the triggering `user_message`), which [sessionHandoff.md](../core/sessionHandoff.md) uses to state the goal of an interrupted session.

## Discovery behavior

- Scans `~/.codex/sessions/` recursively (up to bounded depth).
- Parses files named `rollout-*.jsonl`.
- Uses filesystem modification time as fallback timestamp when an event timestamp is missing.

## Key properties

- Uses **exact token counts** when usage snapshots are present.
- Tracks cache-read tokens separately (`cached_input_tokens`).
- Resolves workspace from session metadata (`cwd`) when available.

## Limitations

- Cache write tokens are not currently surfaced in this log stream and are recorded as `0`.
- Events without token snapshots are ignored, so sparse logs may under-report totals.

## Improving accuracy

If Codex adds richer session index metadata or explicit cache-write fields, update parser extraction so cost and cache analytics can use those fields directly.
