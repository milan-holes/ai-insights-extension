/**
 * Builds a handoff brief for work that was cut short by a quota wall, so the
 * remainder can be continued by another agent (or the same one after a reset)
 * without re-deriving context from scratch.
 *
 * Everything here comes from data the providers already parse per interaction -
 * `promptPreview` (the goal), `fileAccesses` (the work surface), `commandRuns`
 * (how to verify) - plus the git state at the moment the session stopped. No
 * new collection, no network calls, nothing leaves the machine unless the user
 * explicitly delegates.
 *
 * Two outputs, for two different consumers:
 *
 * | Function                      | Output                                        | Used for                               |
 * |-------------------------------|-----------------------------------------------|----------------------------------------|
 * | `buildHandoffMarkdown()`      | Full brief with git state and recovery commands | File written to disk, reviewed by a human |
 * | `buildHandoffPrompt()`        | Compact instruction referencing that file       | Pasted/piped into the receiving agent  |
 *
 * The prompt deliberately *points at* the markdown file rather than inlining
 * it: it keeps the receiving agent's first turn small, survives shell quoting,
 * and lets the user edit the brief before the agent reads it.
 */
import * as path from 'path';
import { Session, Interaction, ProviderId } from '../types';
import { QuotaRisk, HandoffTarget, formatMinutes } from './quotaGuard';
import { Checkpoint, buildRestoreInstructions } from './sessionCheckpoint';

/** How many requests from the session to carry into the handoff prompt. */
const PROMPT_CHAIN_LENGTH = 6;

/** Tools that mutate files - these define the unfinished work surface. */
const WRITE_TOOLS = new Set([
  'edit', 'write', 'multiedit', 'notebookedit', 'apply_patch', 'create_file',
  'str_replace_editor', 'insert_edit_into_file', 'replace_string_in_file', 'editfile',
]);

export interface HandoffInput {
  session: Session;
  risk: QuotaRisk | null;
  checkpoint: Checkpoint | null;
  targets: HandoffTarget[];
  /** `git status --short` at cut-off time. */
  gitStatus: string;
  /** `git diff --stat HEAD` at cut-off time. */
  gitDiffStat: string;
  branch: string;
  repoRoot: string;
  generatedAt?: Date;
}

export interface SessionWorkSummary {
  /** Most recent user requests, newest last - the goal being pursued. */
  prompts: string[];
  filesWritten: string[];
  filesRead: string[];
  commands: string[];
  turns: number;
  models: string[];
  totalTokens: number;
  estimatedCostUsd: number;
  /** Minutes between first and last interaction. */
  durationMinutes: number;
}

/** Distils the parsed interactions down to what a receiving agent needs. */
export function summarizeSessionWork(session: Session, maxPrompts = 4): SessionWorkSummary {
  const prompts: string[] = [];
  const filesWritten = new Set<string>();
  const filesRead = new Set<string>();
  const commands: string[] = [];

  for (const interaction of session.interactions) {
    collectPrompt(interaction, prompts);
    for (const access of interaction.fileAccesses ?? []) {
      const bucket = WRITE_TOOLS.has(access.tool.toLowerCase()) ? filesWritten : filesRead;
      bucket.add(access.path);
    }
    for (const command of interaction.commandRuns ?? []) {
      if (commands[commands.length - 1] !== command) { commands.push(command); }
    }
  }

  const first = session.interactions[0];
  const last = session.interactions[session.interactions.length - 1];
  const durationMinutes = first && last
    ? Math.max(0, (last.timestamp.getTime() - first.timestamp.getTime()) / 60_000)
    : 0;

  // Files that were written are the work surface; drop them from the read list
  // so "also consulted" stays genuinely informational.
  for (const written of filesWritten) { filesRead.delete(written); }

  return {
    prompts: selectPrompts(prompts, maxPrompts),
    filesWritten: [...filesWritten],
    filesRead: [...filesRead].slice(0, 25),
    commands: commands.slice(-8),
    turns: session.interactions.length,
    models: session.models,
    totalTokens: session.totalTokens,
    estimatedCostUsd: session.estimatedCostUsd ?? 0,
    durationMinutes,
  };
}

/**
 * Trims a long prompt chain while always keeping the **first** request. A plain
 * "last N" slice loses the original goal on any session longer than N turns,
 * leaving the receiving agent with only refinements and no idea what they refine.
 */
function selectPrompts(prompts: string[], maxPrompts: number): string[] {
  if (prompts.length <= maxPrompts) { return prompts; }
  return [prompts[0], ...prompts.slice(-(maxPrompts - 1))];
}

function collectPrompt(interaction: Interaction, prompts: string[]): void {
  const preview = interaction.promptPreview?.trim();
  if (!preview) { return; }
  if (prompts[prompts.length - 1] === preview) { return; }
  prompts.push(preview);
}

export function buildHandoffMarkdown(input: HandoffInput): string {
  const { session, risk, checkpoint, targets, gitStatus, gitDiffStat, branch, repoRoot } = input;
  const generatedAt = input.generatedAt ?? new Date();
  const work = summarizeSessionWork(session);
  const lines: string[] = [];

  lines.push('# Session handoff - work interrupted by a quota limit', '');
  lines.push(
    `> **Generated:** ${generatedAt.toISOString()}`,
    `> **Interrupted provider:** ${session.providerName}${session.models.length ? ` (${session.models.join(', ')})` : ''}`,
    `> **Session:** ${session.title ? `${session.title} · ` : ''}\`${session.id}\``,
    `> **Repo:** \`${repoRoot}\`${branch ? ` on branch \`${branch}\`` : ''}`,
  );
  if (risk) { lines.push(`> **Reason:** ${risk.message}`); }
  lines.push('');

  lines.push('## What this session was doing', '');
  if (work.prompts.length > 0) {
    lines.push('Most recent requests, oldest first:', '');
    for (const prompt of work.prompts) {
      lines.push(`1. ${collapse(prompt)}`);
    }
  } else {
    lines.push('_No user prompts were captured for this session - rely on the git state below._');
  }
  lines.push('');

  lines.push('## Work in progress', '');
  lines.push('| Metric | Value |', '|---|---|');
  lines.push(`| Turns completed | ${work.turns} |`);
  lines.push(`| Elapsed | ${formatMinutes(work.durationMinutes)} |`);
  lines.push(`| Tokens spent | ${work.totalTokens.toLocaleString()} |`);
  if (work.estimatedCostUsd > 0) { lines.push(`| Estimated cost | $${work.estimatedCostUsd.toFixed(3)} |`); }
  lines.push(`| Files modified by the agent | ${work.filesWritten.length} |`);
  lines.push('');

  if (work.filesWritten.length > 0) {
    lines.push('### Files the agent was editing', '');
    lines.push('**These are the most likely places to find unfinished or non-compiling code.**', '');
    for (const file of work.filesWritten) {
      lines.push(`- \`${toRelative(file, repoRoot)}\``);
    }
    lines.push('');
  }

  if (work.filesRead.length > 0) {
    lines.push('### Also consulted (context, not modified)', '');
    lines.push(work.filesRead.map(f => `\`${toRelative(f, repoRoot)}\``).join(', '), '');
  }

  if (work.commands.length > 0) {
    lines.push('### Last commands run', '');
    lines.push('Use these to re-verify the build/tests after finishing the work.', '');
    lines.push('```bash');
    for (const command of work.commands) { lines.push(command); }
    lines.push('```', '');
  }

  lines.push('## Git state at cut-off', '');
  if (gitStatus) {
    lines.push('```', 'git status --short', gitStatus, '```', '');
  } else {
    lines.push('_Working tree was clean - the interrupted work may be unsaved or already committed._', '');
  }
  if (gitDiffStat) {
    lines.push('```', 'git diff --stat HEAD', gitDiffStat, '```', '');
  }

  lines.push('## Recovery checkpoint', '');
  if (checkpoint) {
    lines.push(
      `A snapshot of the working tree was taken **before** the limit was reached, so this exact state is recoverable even if the files are changed or reverted afterwards.`,
      '',
      `- **Commit:** \`${checkpoint.commitSha}\``,
      `- **Ref:** \`${checkpoint.ref}\``,
      `- **Captured:** ${checkpoint.createdAt}`,
      `- **Scope:** ${checkpoint.filesChanged} files, +${checkpoint.insertions}/-${checkpoint.deletions}`,
      '',
      '```bash',
      buildRestoreInstructions(checkpoint),
      '```',
      '',
    );
  } else {
    lines.push('_No checkpoint was taken (clean tree, not a git repository, or checkpointing disabled)._', '');
  }

  lines.push('## Suggested continuation', '');
  if (targets.length > 0) {
    lines.push('Providers with quota headroom right now, best first:', '');
    lines.push('| Provider | Headroom | Work time available | Basis |', '|---|---|---|---|');
    for (const target of targets) {
      const available = target.minutesOfWorkLeft !== null ? formatMinutes(target.minutesOfWorkLeft) : 'unknown';
      lines.push(`| ${providerLabel(target.provider)} | ${target.headroomPct.toFixed(0)}% | ${available} | ${target.reason} |`);
    }
    lines.push('');
  } else {
    lines.push(
      '_No other provider currently has measured headroom._ Either wait for the window to reset'
      + (risk?.minutesUntilReset != null ? ` (about ${formatMinutes(risk.minutesUntilReset)})` : '')
      + ', or continue manually.',
      '',
    );
  }

  lines.push('## Instructions for the receiving agent', '');
  lines.push(
    '1. Read the files listed under **Files the agent was editing** and determine what is incomplete.',
    '2. Check the build/tests with the commands above before changing anything, so you know the starting state.',
    '3. Finish the work described under **What this session was doing** - do not restart it from scratch.',
    '4. Leave existing committed code alone; only the uncommitted work above was in flight.',
    '',
  );

  return lines.join('\n');
}

/**
 * Compact instruction for the receiving agent, referencing the written brief.
 * Kept short on purpose - the detail lives in the file, which keeps the first
 * turn cheap (the whole point, given quota just ran out) and avoids shell
 * quoting problems when this is passed to a CLI.
 */
export function buildHandoffPrompt(handoffFilePath: string, input: HandoffInput): string {
  const work = summarizeSessionWork(input.session, PROMPT_CHAIN_LENGTH);
  const relative = toRelative(handoffFilePath, input.repoRoot);

  const parts = [
    `A previous ${input.session.providerName} session was interrupted mid-task because its usage limit ran out, so there may be unfinished or non-compiling code in the working tree.`,
    '',
    `Read \`${relative}\` first - it contains the full handoff brief: what was being done, which files were being edited, the git state at cut-off, and a recovery checkpoint.`,
  ];

  // The whole recent chain, not just the newest message: follow-ups are
  // routinely fragments ("also add the Session class") that mean nothing
  // without the request they refine.
  if (work.prompts.length === 1) {
    parts.push('', `The task being worked on was: ${collapse(work.prompts[0], 300)}`);
  } else if (work.prompts.length > 1) {
    parts.push('', 'The requests being worked on, oldest first:');
    for (const prompt of work.prompts) {
      parts.push(`- ${collapse(prompt, 300)}`);
    }
  }
  if (work.filesWritten.length > 0) {
    parts.push(
      '',
      `Files that were mid-edit: ${work.filesWritten.slice(0, 10).map(f => `\`${toRelative(f, input.repoRoot)}\``).join(', ')}.`,
    );
  }

  parts.push(
    '',
    'Please verify the current state builds, finish the incomplete work, and do not redo parts that are already done.',
  );

  return parts.join('\n');
}

/** Default on-disk location for handoff briefs. */
export function buildHandoffFileName(session: Session, at = new Date()): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  return `handoff-${session.provider}-${stamp}.md`;
}

function providerLabel(provider: ProviderId): string {
  const labels: Partial<Record<ProviderId, string>> = {
    claudeCode: 'Claude Code',
    copilot: 'GitHub Copilot',
    codex: 'Codex',
    antigravity: 'Antigravity',
    jetbrainsAI: 'JetBrains AI',
    visualStudio: 'Visual Studio',
  };
  return labels[provider] ?? provider;
}

function toRelative(filePath: string, repoRoot: string): string {
  if (!repoRoot || !path.isAbsolute(filePath)) { return filePath; }
  const relative = path.relative(repoRoot, filePath);
  return relative.startsWith('..') ? filePath : relative;
}

function collapse(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
