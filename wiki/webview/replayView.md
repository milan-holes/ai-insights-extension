# replayView — Session Replay Panel

[src/webview/replayView.ts](../../src/webview/replayView.ts)

Turn-by-turn interactive replay of any recorded session: watch context fill, tokens accumulate, and cost grow as you scrub through interactions.

## Activation

Launched by clicking **Replay** on any session row in the Sessions view.  
Command: `aiInsights.showSessionReplay(sessionId: string)`

```
Sessions view
  └─ Replay button  →  postMessage {command:'replaySession', sessionId}
       └─ extension.ts registers 'aiInsights.showSessionReplay'
            └─ ReplayViewProvider.createPanel(context, session)
```

## Layout

```
┌─ Topbar ─────────────────────────────────────────────────────┐
│ ← Sessions  |  <title>  ·  <date>  ·  <provider>            │
├─ Summary cards ──────────────────────────────────────────────┤
│ Turns | Duration | Total Cost | Peak Context | Total Tokens  │
├─ Replay panel ───────────────────────────────────────────────┤
│ ⏮ ⏪ ▶ ⏩ ⏭  Speed▾   Turn N / M   HH:MM:SS  ← → Space     │
│ ── Timeline strip (click/drag to seek) ──────────────────── │
│ Context Window ████████░░░░  45K / 200K · 22.5%            │
│ Cum. Cost | Cum. Tokens | Cum. Output | Turns Done          │
├─ Token Breakdown  │  Turn Activity ───────────────────────── │
│ bar chart         │  Mode · Tools · Commands · Files        │
│ Input/Output/…    │  Prompt preview (italic)                │
│ Turn Cost $       │  Compaction banner (if applicable)      │
└───────────────────────────────────────────────────────────── ┘
```

## Data flow

All session interactions are serialised to a JSON literal embedded in the `<script>` block (`ReplayTurn[]`). No back-channel requests after the panel loads.

### `ReplayTurn` fields

| Field | Source |
|-------|--------|
| `idx`, `ts`, `model`, `mode` | `Interaction.*` |
| `inputTokens` … `effectiveContextTokens` | `Interaction.*` |
| `toolCalls`, `commandRuns`, `fileAccesses` | `Interaction.*` |
| `promptPreview` | `Interaction.promptPreview` (≤200 chars) |
| `isCompactionEvent`, `compactionTrigger` | `Interaction.*` |
| `preCompactionTokens`, `postCompactionTokens` | `Interaction.*` |
| `costUsd` | computed via `calculateCost()` at build time |
| `webSearchRequests` | `Interaction.webSearchRequests` |

### Context bar colour thresholds

| Fill % | Colour |
|--------|--------|
| < 50 % | `--primary` (blue) |
| 50–75 % | `--stage-3` (yellow) |
| 75–90 % | `--stage-2` (orange) |
| ≥ 90 % | `--stage-1` (red) |

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `←` / `h` | Step back one turn |
| `→` / `l` | Step forward one turn |
| `Space` / `k` | Play / Pause |
| `Home` | Go to first turn |
| `End` | Go to last turn |

## Playback speeds

0.5× · 1× · 2× · 5× · 10× (turns per second).  
Changing speed while playing restarts the interval at the new rate.

## Compaction events

Turns where `isCompactionEvent === true` render with:
- Orange block on the timeline (`tc-compact` class)
- `⚡ Auto/Manual context compaction · N → M tokens (K freed)` banner
- No prompt preview shown

## Files changed by this feature

| File | Change |
|------|--------|
| `src/webview/replayView.ts` | New file — full panel implementation |
| `src/webview/navShared.ts` | `'replay'` added to `NavTab`; `showSessionReplay` added to `NAV_COMMANDS` |
| `src/extension.ts` | Import + `aiInsights.showSessionReplay` command registration |
| `src/webview/sessionsView.ts` | `replaySession()` JS function; `replayBtn` in row; message handler |
