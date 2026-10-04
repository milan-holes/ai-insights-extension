# sessionHandoff

**Files**: [src/core/handoffBuilder.ts](../../src/core/handoffBuilder.ts) (pure brief generation), [src/core/handoffCoordinator.ts](../../src/core/handoffCoordinator.ts) (checkpoint + write + delegate)

Turns an interrupted session into a brief another agent can continue from, and routes that brief to a provider with quota left.

## What is and isn't possible

AI Insights observes provider session logs. It has **no API to pause, inject into, or migrate an in-flight agent run** - so there is deliberately no claim of seamless mid-turn failover. That cannot be built from an extension, and pretending otherwise would silently drop context exactly when the user is least able to notice.

What it does instead: make the interruption survivable and the restart cheap. A recoverable snapshot taken before the wall, a brief describing the unfinished work, and a one-click launch of that brief wherever there is headroom. The receiving agent starts a *fresh* run that already knows what was being done and where the half-finished code is.

## Data source

Entirely data the providers already parse per interaction - no new collection, no network calls, nothing leaves the machine unless the user explicitly delegates:

| Field                        | Role in the brief                          |
| ---------------------------- | ------------------------------------------ |
| `Interaction.promptPreview`  | What was being asked (the goal)            |
| `Interaction.fileAccesses`   | Work surface - write tools vs. read-only   |
| `Interaction.commandRuns`    | How to re-verify the build/tests           |
| `Session.models` / tokens    | Cost and scope of what was already spent   |
| `git status` / `diff --stat` | What is actually uncommitted               |
| [sessionCheckpoint.md](sessionCheckpoint.md) | Recovery ref for the exact cut-off state |

## Two outputs

| Function                 | Output                                              | Consumer                        |
| ------------------------ | --------------------------------------------------- | ------------------------------- |
| `buildHandoffMarkdown()` | Full brief: git state, file list, recovery commands | File on disk, reviewed by human |
| `buildHandoffPrompt()`   | Compact instruction *referencing* that file         | The receiving agent             |

The prompt points at the file rather than inlining it: the receiving agent's first turn stays small (the point, given quota just ran out), shell quoting is a non-issue, and the user can edit the brief before the agent reads it.

**The prompt carries the whole recent request chain, not just the newest message.** Follow-ups are routinely fragments - "also add the Session class" - that mean nothing without the request they refine. `selectPrompts()` also always keeps the **first** prompt when trimming a long chain, since a plain "last N" slice loses the original goal on any session longer than N turns.

## Delegation routes

| Target        | Mechanism                                                       |
| ------------- | --------------------------------------------------------------- |
| Claude Code   | terminal running the `claude` CLI pointed at the brief          |
| Codex         | terminal running the `codex` CLI pointed at the brief           |
| Copilot       | `workbench.action.chat.open` with the prompt prefilled          |
| Anything else | brief opened in the editor, or prompt copied to the clipboard    |

Routes only appear when their mechanism is actually present (CLI on disk via the `findClaudeBin`/`findCodexBin` resolvers exported from [benchmark/adapters.ts](../../src/benchmark/adapters.ts), chat command registered), and they are **ordered by live quota headroom** from `rankHandoffTargets()` - the recommendation is grounded in real remaining quota, not a guess. Terminal routes send the command without executing it, so the user sees exactly what will run.

## Output location

Briefs are written to `aiInsights.quotaGuard.handoffDirectory` (default `.ai-insights/`) under the repo root, and that directory is added to **`.git/info/exclude`** rather than `.gitignore` - keeping generated files out of `git status` without editing a tracked file the user's team owns. Mirrors how [abtest/worktree.ts](../../src/abtest/worktree.ts) hides its own scratch directory. If the repo can't be written to, the brief falls back to a temp directory rather than being lost.

## API

```ts
// handoffBuilder.ts - pure
summarizeSessionWork(session: Session, maxPrompts?): SessionWorkSummary
buildHandoffMarkdown(input: HandoffInput): string
buildHandoffPrompt(handoffFilePath: string, input: HandoffInput): string
buildHandoffFileName(session: Session, at?: Date): string

// handoffCoordinator.ts - side effects
prepareHandoff(options: PrepareHandoffOptions): HandoffResult | null
resolveDelegationRoutes(targets: HandoffTarget[]): Promise<DelegationRoute[]>
promptForDelegation(result: HandoffResult, targets: HandoffTarget[]): Promise<void>
```

`prepareHandoff()` takes the checkpoint **first**, deliberately: if anything later fails, the recoverable snapshot still exists - that is the part that protects the user's work.

## Commands

| Command                                              | Does                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `AI Insights: Prepare Session Handoff (Quota Safe-Stop)` | Checkpoint + brief + delegation quick-pick              |
| `AI Insights: Create Safe-Stop Checkpoint`           | Snapshot only                                               |
| `AI Insights: Show Safe-Stop Checkpoints`            | List checkpoints, copy restore commands                     |
| `AI Insights: Show Quota Windows`                    | Live quota across providers, highest usage first            |

## Known limitations

- **No mid-turn failover**, by design - see above.
- **`promptPreview` is the first ~200 chars** of each request, so a long or multi-part prompt is truncated in the brief.
- **Copilot sessions have no `promptPreview`** today, so a Copilot handoff leans on the git state and file list rather than the stated goal.
- **Provider-agnostic brief** - it does not translate tool conventions between agents; it describes files and commands, which all of them understand.

## Related

- [quotaGuard.md](quotaGuard.md) - the risk signal that triggers a handoff
- [sessionCheckpoint.md](sessionCheckpoint.md) - the recovery snapshot
