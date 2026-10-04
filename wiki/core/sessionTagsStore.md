# sessionTagsStore

**File**: [`src/core/sessionTagsStore.ts`](../../src/core/sessionTagsStore.ts)

## Purpose

Persists user-defined tags for sessions. Tags are stored as `Record<sessionId, string[]>` in a JSON file inside `globalStorageUri`.

## Storage path

`{globalStorageUri}/session-tags.json`

## API

```typescript
new SessionTagsStore(storageDir: string)

getAll(): Record<string, string[]>
getTags(sessionId: string): string[]
addTag(sessionId: string, tag: string): void    // normalizes: lowercase, spaces→hyphens, max 32 chars
removeTag(sessionId: string, tag: string): void // auto-deletes empty session entry
allTags(): string[]                              // sorted list of all unique tags
```

## Normalization

Tags are normalized on `addTag`: `.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 32)`. The same normalization is applied optimistically in the webview JS so display is consistent before the server-side round-trip.

## Integration

- Instantiated in `extension.ts` after `snapshotStore` init
- Passed to `SessionsViewProvider.createPanel` / `pushUpdate` as `tagsMap: Record<string, string[]>`
- Tag mutations flow through `SessionsViewProvider._addTag` / `_removeTag` callbacks set in `extension.ts`
