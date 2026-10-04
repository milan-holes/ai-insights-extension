# CacheManager

**File**: [src/core/cacheManager.ts](../../src/core/cacheManager.ts)

File cache that avoids re-parsing session log files that have not changed. Backed by a JSON file
in the extension's global storage, so a VS Code restart does not have to re-read and re-parse
every session log.

## API

```ts
class CacheManager {
  load(storageDir: string): void           // read the persisted cache; call once at activation
  flush(): void                            // write the cache if anything changed
  needsUpdate(filePath: string, mtimeMs?: number): boolean
  set(filePath: string, session: Session | null, mtimeMs?: number): void
  get(filePath: string): Session | null | undefined
  pruneMissing(knownFiles: Set<string>): void   // drop entries no longer on disk
  getStats(): { entries: number; hitRate: number }
  clear(): void
}
```

`load()` is optional. Without it the cache is memory-only and behaves as it did before
persistence was added.

## Persistence

| | |
| --- | --- |
| File | `<globalStorage>/session-parse-cache.json` |
| Format | `{ version: 1, entries: SerializedEntry[] }` |
| Dates | `startTime`, `endTime` and each `interaction.timestamp` are stored as ISO strings and revived on load |
| Typical size | ~0.6 MB for ~220 sessions |

A version mismatch, a parse failure or a missing file all start from an empty cache. Write
failures are swallowed - the cache is an optimization and must not break a refresh.

`flush()` is a no-op unless an entry actually changed, so an unchanged refresh writes nothing.
It is called at the end of each refresh and from `deactivate()`.

## Eviction policy

- Maximum 1 000 entries.
- When full: sort by `lastProcessed` ascending, evict the oldest 25 %.
- `pruneMissing()` drops entries whose source file was not seen in the latest scan.

## Change detection

`needsUpdate()` compares the file's mtime against the stored `lastModified`. Pass `mtimeMs` when
the caller has already stat'd the file - the refresh loop does, so the same path is not stat'd
twice. Without it the method falls back to its own `fs.statSync`.

## Usage in refresh loop

```ts
let stats: fs.Stats;
try { stats = fs.statSync(file); } catch { continue; }   // one stat per file, reused below
if (stats.mtime < cutoff) { continue; }

if (!cacheManager.needsUpdate(file, stats.mtimeMs)) {
  const cached = cacheManager.get(file);
  if (cached) { sessions.push(cached); }
  continue;
}
const session = await provider.parseSessionFile(file, stats);
cacheManager.set(file, session, stats.mtimeMs);   // stores null for empty/invalid files
if (session) { sessions.push(session); }
```

Storing `null` for empty files prevents re-parsing files that are known to produce no sessions -
roughly half of the discovered Copilot files fall into this category.

## Why it is persisted

Parsing the discovered session logs costs several seconds of blocking I/O (~29 MB of Copilot JSON
alone on a typical machine). With a memory-only cache that cost was paid on every activation and
separately in every window. Persisting it takes a warm refresh from ~8 s to ~2.4 s, the remainder
being discovery rather than parsing. See
[sessions/2026-10-03-startup-performance.md](../sessions/2026-10-03-startup-performance.md).
