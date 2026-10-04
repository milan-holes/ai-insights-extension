# AntigravityProvider

**File**: [src/providers/antigravity.ts](../../src/providers/antigravity.ts)  
**Provider ID**: `antigravity`

Reads Antigravity (Google Gemini CLI) session logs from `~/.gemini/antigravity/brain/`.

## Log format

Antigravity stores one directory per conversation:

```
~/.gemini/antigravity/brain/
└── <conversation-id>/
    └── .system_generated/
        └── logs/
            └── overview.txt   ← parsed by this provider
```

`overview.txt` contains a human-readable transcript of the conversation (USER / MODEL turns). It does **not** expose raw token counts.

## Token estimation

Because the log file is plain text, `AntigravityProvider` uses `BaseProvider.estimateTokens()` with a ratio of **0.24 chars per token** (calibrated for Gemini's tokeniser on typical code + prose).

Turn count is inferred from the number of `USER:` / `MODEL:` / `Assistant:` boundary markers. Tokens are split 30 % input / 70 % output per turn as a rough heuristic.

### Synthetic-turn timestamps (fractional attribution)

When no entry in the log carries real per-turn token counts, `parseOverview()` falls back to the turn-count/estimation path above and must assign a timestamp to each synthetic interaction. It now interpolates evenly across the real `[startTime, endTime]` span observed from any `entry.created_at` values seen in the file (falling back to the file's mtime only if no real timestamps were found at all). Previously every synthetic turn got the exact same timestamp (the file's mtime), so a multi-day session's tokens were all counted on a single day in `sessionAggregator.ts`'s daily bucketing - the fix keeps that day-attribution correct for sessions that only have this fallback path available.

### Context references

`extractContextRefs()` ([contextReferences.ts](../core/contextReferences.md)) is applied to the most recent `USER_INPUT` entry's content when a real per-entry interaction is pushed (the token-count-bearing branch). It is **not** applied in the synthetic fallback branch above, since those interactions don't map to a specific user turn.

## Additional session roots (`additionalSessionPaths`)

`aiInsights.providers.antigravity.additionalSessionPaths` (array, default `[]`) lets a user point at extra Antigravity **home-style roots** beyond `~/.gemini/antigravity/` - e.g. a second Gemini profile or a synced backup copy. Each extra path is expected to itself contain `brain/` and `conversations/` subfolders, mirroring the default layout; it is not a flat folder of loose session files like Claude Code's `additionalSessionPaths`.

Internally, `AntigravityProvider` now holds a `roots: { brainDir, conversationsDir }[]` array (`[defaultRoot, ...additionalRoots]`) instead of single fixed `brainDir`/`conversationsDir` fields, and `discoverSessionFiles()` runs the existing two-phase scan (conversations/*.pb, then leftover brain/ dirs) once per root. The trickier part was `parsePbSession()` / `extractWorkspaceFromBrain()` / `extractTitleFromBrain()`, which all used to read `this.brainDir` directly - with multiple roots that would silently look up a `.pb` file from an additional root's metadata in the *default* root's `brain/` (or vice versa) and get the wrong workspace/title, since IDs aren't guaranteed unique across roots. Fixed by deriving the correct `brainDir` per file from the `.pb` path itself (`<root>/conversations/<id>.pb` → sibling `<root>/brain`) rather than trusting instance state - `parseOverviewSession()` already did this correctly via `path.resolve(filePath, '..','..','..')` and needed no change.

## Limitations

- Token counts are **estimates**, not exact values.
- Cache token fields are always 0 (Antigravity does not expose caching metrics).
- Model is always recorded as `'gemini'` - specific model version is not available from the log format.
- Workspace is derived from the first 8 characters of the conversation ID (opaque).

## Improving accuracy

If Antigravity adds a structured log format in the future, replace `parseOverview()` with a JSON parser and set `cacheReadTokens` / `cacheWriteTokens` from the real data.
