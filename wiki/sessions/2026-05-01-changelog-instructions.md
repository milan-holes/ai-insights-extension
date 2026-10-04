# Session: changelog instructions - 2026-05-01

## What was done

- Added a mandatory instruction for Claude Code to auto-update CHANGELOG.md on shipped behavior changes.
- Added a mandatory instruction for Antigravity/Cursor/Windsurf to auto-update CHANGELOG.md on shipped behavior changes.
- Added a new repository Copilot instructions file with explicit CHANGELOG.md auto-update guidance.
- Updated shared llm-wiki setup docs to include changelog-update policy and Copilot instruction file location.

## Files changed

- `CLAUDE.md` - added mandatory changelog update rule.
- `.cursorrules` - added mandatory changelog update rule.
- `.github/copilot-instructions.md` - added new Copilot repository instructions including changelog rule.
- `wiki/llm-wiki-setup.md` - documented changelog policy and Copilot instruction path.

## Decisions made

- Used the same trigger language across all three instruction entry points to keep behavior consistent.
- Scoped changelog updates to shipped behavior changes to avoid noise from internal-only edits.

## Follow-up / known gaps

- If additional agent-specific instruction files are introduced later, mirror the same changelog rule there.
