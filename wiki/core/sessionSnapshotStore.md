# SessionSnapshotStore

**File**: [src/core/sessionSnapshotStore.ts](../../src/core/sessionSnapshotStore.ts)

Persists parsed Copilot session data to disk so analytics survive Copilot chat clears.

## Why it exists

GitHub Copilot stores sessions as mutable JSON files in VS Code's `workspaceStorage` / `globalStorage`. When a user clears a chat session, Copilot deletes or overwrites the underlying file. Claude Code uses append-only JSONL and is unaffected by `/clear` or `/compact`.

Without snapshotting, any Copilot session cleared between extension refresh cycles would be permanently lost from the analytics.

## Storage

Snapshots are written to:

```
{context.globalStorageUri}/copilot-session-snapshots.json
```

This is VS Code's extension-specific global storage directory, which survives workspace changes and VS Code restarts.

## File format

```json
{
  "version": 1,
  "snapshots": {
    "<session-id>": { ...SerializedSession }
  }
}
```

Dates (`startTime`, `endTime`, interaction `timestamp`) are stored as ISO 8601 strings and revived to `Date` objects on read.

## API

```ts
class SessionSnapshotStore {
  constructor(storageDir: string, maxSnapshots?: number)
  setMaxSnapshots(maxSnapshots: number): void  // update cap at runtime
  beginScan(): void                 // flush pending writes, then drop the in-memory copy
  flush(): void                     // write pending mutations to disk
  save(session: Session): void      // upsert by session.id (in memory)
  loadAll(): Session[]              // deserialize all snapshots
  prune(cutoff: Date): void         // remove snapshots older than cutoff (in memory)
}
```

## Write batching (2026-10-03)

`save()`, `loadAll()` and `prune()` operate on one in-memory copy of the snapshot file; only
`flush()` touches disk.

Previously each `save()` did a full `readFileSync` + `JSON.parse` + `JSON.stringify` +
`writeFileSync` of the entire file - and the refresh loop calls `save()` once per parsed Copilot
session. That is O(n) full-file rewrites per refresh, scaling with `maxSnapshots` (default 2 000),
so the cost grew quadratically as the snapshot file filled up.

The refresh loop now calls:

| Call | When | Effect |
| --- | --- | --- |
| `beginScan()` | start of each refresh | flushes anything pending, then drops the in-memory copy so the next read picks up writes from other VS Code windows |
| `save()` / `prune()` | during the pass | mutate memory, set a dirty flag |
| `flush()` | end of the pass, and from `deactivate()` | one write, skipped entirely if nothing changed |

Dropping the copy in `beginScan()` keeps cross-window freshness at refresh granularity, which is
what the previous read-per-save actually provided.

## Limits

- Maximum snapshot count is configurable via `aiInsights.providers.copilot.maxSessionSnapshots` (default **2 000**, range 100–20 000). When exceeded, the oldest by `endTime` are evicted on the next `save()`. Changing the setting calls `setMaxSnapshots()` on the live instance (see `onDidChangeConfiguration` in `extension.ts`) — no reload needed.
- `prune(cutoff)` is called on every refresh with the same `sessionLookbackDays` cutoff used for live files (default 400 days).

## Integration in refresh loop (`extension.ts`)

```ts
// After a Copilot file is parsed:
snapshotStore.save(session);
liveCopilotIds.add(session.id);

// After all live files are processed:
for (const snap of snapshotStore.loadAll()) {
  if (!liveCopilotIds.has(snap.id) && isSessionRecent(snap, cutoff)) {
    sessions.push(snap);   // fill in cleared sessions
  }
}
snapshotStore.prune(cutoff);
snapshotStore.flush();   // single write for the whole pass
```

The `liveCopilotIds` set prevents double-counting sessions that still have their source files.

## Failure behaviour

`flush()` swallows write errors silently — analytics degrade gracefully rather than crashing the extension. `save()` and `prune()` cannot fail on I/O any more, since they only mutate memory.
