# Session: Sessions Screen Empty Fix - 2026-05-01

## What was done

- Diagnosed why "AI Sessions" screen showed no data despite Claude Code sessions existing in `~/.claude/projects/`
- Found two separate bugs causing the empty screen
- Fixed both bugs and added a diagnostic banner

## Files changed

- [`src/extension.ts`](../../src/extension.ts) - `showSessions()` now always calls `refresh()` before `createPanel()`
- [`src/webview/sessionsList.ts`](../../src/webview/sessionsList.ts) - switched data injection from base64 to inline `window.__INITIAL_SESSIONS__`; added debug banner; improved empty-state messages; explicit Date→ISO conversion
- [`CHANGELOG.md`](../../CHANGELOG.md) - added Unreleased section
- [`wiki/webview/sessionsList.md`](../webview/sessionsList.md) - documented data flow and bug fixes

## Root causes found

### Bug 1 - stale `allSessions` in `showSessions`

```typescript
// Before (broken)
async function showSessions(context) {
  if (allSessions.length === 0) {
    // ← only refreshed when empty
    await refresh(getEnabledProviders());
  }
  SessionsListProvider.createPanel(context, allSessions);
}

// After (fixed)
async function showSessions(context) {
  await refresh(getEnabledProviders()); // always refresh
  SessionsListProvider.createPanel(context, allSessions);
}
```

If Claude Code or Antigravity sessions had already populated `allSessions`, any Copilot sessions created after the last auto-refresh would never appear.

### Bug 2 - `Buffer.from` not evaluating in compiled webview HTML

The TypeScript source used:

```typescript
const b64 = "${Buffer.from(sessionsJson).toString('base64')}";
```

esbuild compiled the outer template literal to a single-quoted string, so the webview received the **literal text** `${Buffer.from(s).toString("base64")}` - not actual base64. `atob()` then failed silently, leaving `ALL_SESSIONS = []`.

**Fix**: inject via an inline script tag before the main script:

```html
<script>
  window.__INITIAL_SESSIONS__ = ${safeJson};
</script>
```

The main script reads `window.__INITIAL_SESSIONS__ || []` - the standard pattern for seeding a webview with server-rendered state.

## Decisions made

- Chose inline JSON injection over base64 to avoid the compile-step evaluation ambiguity entirely
- Added a visible debug banner (shows "N sessions loaded - claudeCode: 5 · copilot: 2") so users can self-diagnose filter issues without opening DevTools
- Dates are converted to ISO strings explicitly before serialisation; relying on `JSON.stringify(Date)` is correct but explicit `.toISOString()` makes it clear and avoids any future class instance issues

## Follow-up / known gaps

- Claude Code parser doesn't deduplicate by `requestId` - streaming fragments inflate token counts. This doesn't break display but overcounts tokens compared with deduplicating by `requestId`
- The `<synthetic>` model appearing in sessions is from assistant events with `isApiErrorMessage: true` - harmless but noisy in the models column
