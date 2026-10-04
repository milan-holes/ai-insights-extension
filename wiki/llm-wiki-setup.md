# LLM-Wiki Setup

This repository uses the **llm-wiki** approach: AI assistants are the primary authors of the `wiki/` directory. The wiki is written and maintained automatically as part of every coding session.

## Folder structure

```
wiki/
├── README.md               Index - always keep this current
├── architecture.md         System overview, data flow, module map
├── llm-wiki-setup.md       This file - approach & instructions
├── providers/
│   ├── base.md
│   ├── claudeCode.md
│   ├── antigravity.md
│   ├── copilot.md
│   └── codex.md
├── core/
│   ├── sessionAggregator.md
│   ├── costEstimation.md
│   ├── environmentalImpact.md
│   └── cacheManager.md
└── sessions/
    └── YYYY-MM-DD-<topic>.md   One file per significant coding session
```

## Rules for AI assistants

These rules apply to **all** AI tools working in this repository (Claude Code, Antigravity, Codex, Cursor, Windsurf, Copilot Chat, etc.).

### 1. Auto-document every significant change

After completing a task that adds a feature, fixes a bug with architectural impact, refactors a module, or changes a public API:

- If a wiki file for the affected component already exists → **update it** (do not create a duplicate).
- If no wiki file exists → **create one** at the appropriate path.

### 1b. Auto-update CHANGELOG.md

For every shipped behavior change (feature, fix, refactor with user impact, provider parsing change, or new setting), update `CHANGELOG.md` in the same task.

- Add entries under the current unreleased section or bump/create the next version section.
- Keep entries concise and user-facing.

### 1c. Do not regress performance

Everything this extension does runs on the VS Code extension host thread, shared with every other
extension. Before changing `src/extension.ts`, `src/providers/*`, `src/core/cacheManager.ts` or
`src/core/sessionSnapshotStore.ts`, read **[performance.md](performance.md)** - it is mandatory, not
advisory, and each rule in it corresponds to a measured regression.

The short version:

- Nothing scans from `activate()`; the first refresh is deferred.
- `await` on a sync-bodied `async` function does **not** yield - use `yieldToHost()` every ~20 items.
- No per-file work that is O(files x roots); index once per scan.
- List a directory rather than probing fixed paths inside it.
- Stat each file once and pass `fs.Stats` through.
- Never read-modify-write a whole JSON store per item; batch and `flush()` once.
- Treat WSL's `/mnt/c` as ~100x slower than native; gate and throttle anything that walks it.

Every performance claim needs a before/after measurement run **alternately** in one session (the OS
page cache makes a single before-then-after comparison worthless), plus - for discovery or parsing
changes - a diff proving the output is identical.

### 1d. Keep rival research out of this wiki

This wiki documents **our own** product: architecture, modules, providers, session logs.
Research about other projects in the same space is maintained separately, outside `wiki/`,
and must not appear here or in `CHANGELOG.md` - no names, no versions, no feature
comparisons, no threat levels, no gap analysis, no "where we lead" claims.

A fact we verified ourselves still belongs in the wiki - stated on its own evidence, with
no attribution to whoever first pointed at it. Dependency is one-way: the separate research
folder may link into `wiki/`, but `wiki/` never links back out to it.

See rule 6 in `CLAUDE.md` / `.cursorrules` / `.github/copilot-instructions.md` for where
that research lives.

### 2. Write a session log for major work

For sessions involving multiple file changes, a refactor, or a significant feature addition, create a session log:

```
wiki/sessions/YYYY-MM-DD-<short-topic>.md
```

Session log format:

```markdown
# Session: <topic> - YYYY-MM-DD

## What was done

- Bullet list of completed changes

## Files changed

- `src/foo/bar.ts` - description

## Decisions made

- Any non-obvious choices and why

## Follow-up / known gaps

- Anything left open
```

### 3. Update README.md if structure changes

If you add a new wiki file that isn't in the table in `wiki/README.md`, add a row for it.

### 4. Style guidelines

- Keep each file focused - one component or concept per file.
- Use `##` for top-level sections, `###` for sub-sections.
- Prefer tables and code blocks over long prose.
- Link to source files using relative paths from the wiki root: `[src/foo.ts](../../src/foo.ts)`.
- Do not duplicate information that is already in the source code or type definitions - link instead.

---

## AI tool configuration

### Claude Code

Instructions are in [CLAUDE.md](../CLAUDE.md) at the repository root. Claude Code reads this file automatically on every session.

### GitHub Copilot

Instructions are in [.github/copilot-instructions.md](../.github/copilot-instructions.md). Copilot Chat uses this file as repository guidance.

### Antigravity (Gemini CLI)

Instructions are in [.cursorrules](../.cursorrules) at the repository root. Antigravity reads `.cursorrules` as its system context when working inside this directory.

### Codex

Instructions are in [.codex](../.codex) at the repository root. Codex reads this file as repository guidance for documentation and changelog behavior.

### Cursor / Windsurf

Also read `.cursorrules` by default. No additional setup needed.

---

## What NOT to put in the wiki

- **Conversation transcripts** or raw prompt/response pairs.
- **Temporary notes** or in-progress scratch work.
- **Code** (link to source instead).
- Anything that will be outdated within days (use git commits for that).
- **Anything about other projects in this space** - see rule 1d. That research is
  maintained outside `wiki/`.
