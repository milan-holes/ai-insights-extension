# DiffTracker

**Source:** [src/core/diffTracker.ts](../../src/core/diffTracker.ts)

Tracks GitHub Copilot code-diff outcomes — accepted, updated (user-edited before applying), and declined — for the current VS Code session.

## Type

```typescript
export interface DiffMetrics {
  shown: number;        // TabInputTextDiff tabs opened
  accepted: number;     // diff applied as-is
  updated: number;      // diff applied after user edits
  declined: number;     // diff closed without changes
  acceptanceRate: number; // accepted / (accepted + updated + declined)
  since: Date;
}
```

## Detection strategy

Copilot (inline-chat, "Apply in Editor", workspace edits) presents proposed changes as a `TabInputTextDiff` tab where:
- **original** side: a virtual snapshot URI (scheme ≠ `file:` / `git:`)  
- **modified** side: the actual workspace file URI

The tracker hooks `vscode.window.tabGroups.onDidChangeTabs`:

| Event | Action |
|-------|--------|
| Tab opened (matching pattern) | `shown++`, capture `proposed` (modified-side content) and `snapshot` (original-side content) |
| Tab closed | compare current file content to `snapshot` and `proposed` → classify outcome |

### Outcome classification

| Condition | Outcome |
|-----------|---------|
| `current === snapshot` (unchanged) | **declined** |
| `current === proposed` (exact match) | **accepted** |
| `current ≠ snapshot && current ≠ proposed` | **updated** |

## Registration

```typescript
const diffTracker = new DiffTracker();
// in activate():
diffTracker.register(context);
```

## Display

The `DiffMetrics` are passed to `DashboardProvider.createPanel()` as the `diffMetrics` parameter and rendered in the **📋 Code Diff Outcomes** section that appears in the Copilot tab of the dashboard alongside the existing Suggestion Acceptance Rate section.

## Limitations

- Resets on VS Code reload (session-scoped).
- Only tracks diff views opened as VS Code tabs; inline ghost-text completions are tracked separately by `AcceptanceTracker`.
- Virtual doc opening (`original` side) may fail silently for some URI schemes — falls back to empty string for `snapshot`.
