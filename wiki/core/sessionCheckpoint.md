# sessionCheckpoint

**File**: [src/core/sessionCheckpoint.ts](../../src/core/sessionCheckpoint.ts)

Recoverable snapshots of the working tree, taken when a quota window is about to run out mid-session.

## Why it exists

When credits run out during an agent run, the run stops wherever it happens to be - often with a half-written refactor on disk that no longer compiles. A warning alone doesn't help once the files are already in that state. This captures "here is exactly what the tree looked like" so the work can be diffed, finished, or discarded.

This is the layer that actually addresses *"unfinished code makes a non-working project"*; [quotaGuard.md](quotaGuard.md) only provides the trigger.

## Why not `git stash` or a WIP commit

Both move state the user - or a still-running agent - may be relying on. `git stash` reverts the working tree; a WIP commit moves `HEAD` and the branch. Either can break an agent mid-edit, which rules them out for something that fires automatically.

Instead a real commit object is written through a **temporary index file** (`GIT_INDEX_FILE`):

```bash
GIT_INDEX_FILE=$tmp git read-tree HEAD    # seed throwaway index
GIT_INDEX_FILE=$tmp git add -A            # stage everything, .gitignore honoured
GIT_INDEX_FILE=$tmp git write-tree        # -> tree sha
git commit-tree <tree> -p HEAD -F -       # -> commit sha
git update-ref refs/ai-insights/checkpoints/<ts> <commit>
```

| Property                                            | Why it matters                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| Working tree never modified                         | Safe to run while an agent is mid-edit                                   |
| Real index (`.git/index`) never touched             | Staged changes stay staged                                               |
| `HEAD` and branches stay put                        | `git status` is byte-identical before and after                          |
| Untracked (non-ignored) files included              | `git stash create` drops these - usually the most important new work     |
| Reachable from `refs/ai-insights/checkpoints/*`     | Not garbage-collected, and stays out of `git branch`                     |

`.gitignore` is honoured by `git add -A`, so `node_modules/` and `dist/` stay out.

## Failure behavior

Every function fails soft - `null` or `[]`, never a throw. A non-git folder, a repo with no commits, or any git error is a normal condition here, because this runs automatically and must never interrupt the user. `createCheckpoint()` also returns `null` when the tree matches `HEAD`: there is nothing worth saving.

All git invocations use `execFileSync` with an argument array rather than a shell string. This is load-bearing, not hygiene: `%(refname)` in `for-each-ref --format` and `HEAD^{tree}` both contain characters a shell interprets, and quoting them per-platform is a losing game.

## API

```ts
createCheckpoint(repoRootOrPath: string, reason: string): Checkpoint | null
listCheckpoints(repoRootOrPath: string): Checkpoint[]        // newest first
deleteCheckpoint(checkpoint: Checkpoint): boolean
buildRestoreInstructions(checkpoint: Checkpoint): string     // copy-pasteable recovery commands
findRepoRoot(startPath: string): string | null
readShortStatus(repoRootOrPath: string, maxLines?): string   // git status --short
readDiffStat(repoRootOrPath: string): string                 // git diff --stat HEAD
readCurrentBranch(repoRootOrPath: string): string
```

## Recovery

`buildRestoreInstructions()` leads with read-only inspection, deliberately - the working tree may well be the newer state:

```bash
git show --stat <sha>                                  # what the checkpoint holds
git diff <sha>                                         # checkpoint -> current tree
git restore --source=<sha> --worktree -- .             # restore everything
git restore --source=<sha> --worktree -- path/to/file  # or one file
git switch -c recovered-work <sha>                     # or branch off it
```

Reachable from **`AI Insights: Show Safe-Stop Checkpoints`**, which copies these commands for a chosen checkpoint.

## Settings

| Setting                                  | Default | Purpose                                             |
| ---------------------------------------- | ------- | --------------------------------------------------- |
| `aiInsights.quotaGuard.autoCheckpoint`   | `true`  | Snapshot automatically when a quota warning fires   |

Automatic by default because the snapshot has to exist *before* the wall hits - including when the user is away from the keyboard - and taking it is non-invasive by construction.

## Known limitations

- **Requires a git repository with at least one commit.** No fallback for non-git workspaces; `createCheckpoint()` returns `null`.
- **Checkpoints are never pruned automatically.** Refs are small (tree + commit objects, sharing blobs with history), but they accumulate. `deleteCheckpoint()` exists; nothing calls it on a schedule.
- **Only the primary workspace folder** is snapshotted in a multi-root workspace.
- **Unsaved editor buffers are not captured** - this reads the tree from disk, so dirty VS Code buffers are outside its reach.

## Related

- [quotaGuard.md](quotaGuard.md) - what triggers a checkpoint
- [sessionHandoff.md](sessionHandoff.md) - references the checkpoint in the brief
