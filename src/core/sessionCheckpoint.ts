/**
 * Safe-stop checkpoints: recoverable snapshots of the working tree taken when
 * a provider quota window is about to run out mid-session.
 *
 * The problem this solves: when credits run out during an agent run, the run
 * stops wherever it happens to be - often with a half-written refactor on disk
 * that no longer compiles. A warning alone doesn't help if the files are
 * already in that state; something has to capture "here is exactly what the
 * tree looked like" so the user can diff it, finish it, or throw it away.
 *
 * ### Why not `git stash` / a WIP commit
 *
 * Both move state the user (or a still-running agent) may be relying on:
 * `git stash` reverts the working tree, and a WIP commit moves `HEAD` and the
 * branch. Either can break an agent mid-edit. Instead this writes a real commit
 * object through a **temporary index file**, so:
 *
 * - the working tree is never modified,
 * - the user's real index (`.git/index`) is never touched - staged changes stay staged,
 * - `HEAD` and all branches stay put, so `git status` looks identical afterwards,
 * - untracked-but-not-ignored files are included (plain `git stash create` drops them,
 *   which would miss brand-new files an agent just created - usually the most
 *   important part of unfinished work),
 * - the snapshot is reachable from `refs/ai-insights/checkpoints/*`, so git will
 *   not garbage-collect it, and it stays out of `git branch` listings.
 *
 * Every function fails soft: a non-git folder, a repo with no commits, or any
 * git error resolves to `null`/`[]` rather than throwing, because this runs
 * automatically on a timer and must never interrupt the user's work.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REF_NAMESPACE = 'refs/ai-insights/checkpoints';

export interface Checkpoint {
  /** Full ref name, e.g. `refs/ai-insights/checkpoints/2026-10-03T12-00-00Z`. */
  ref: string;
  /** Commit SHA of the snapshot. */
  commitSha: string;
  /** ISO creation time. */
  createdAt: string;
  repoRoot: string;
  /** Why it was taken, e.g. "Claude 5h window at 94%". */
  reason: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** `git diff --name-status HEAD <snapshot>` output, capped for display. */
  nameStatus: string;
}

/**
 * Runs git with an argument array via `execFileSync` - no shell involved.
 * This matters beyond hygiene: format strings like `%(refname)` and revisions
 * like `HEAD^{tree}` contain characters a shell would interpret, and quoting
 * them per-platform is a losing game.
 */
function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return cp.execFileSync('git', args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 16 * 1024 * 1024,
  }).toString().trim();
}

export function findRepoRoot(startPath: string): string | null {
  try {
    return git(['rev-parse', '--show-toplevel'], startPath);
  } catch {
    return null;
  }
}

function hasCommits(repoRoot: string): boolean {
  try {
    git(['rev-parse', '--verify', 'HEAD'], repoRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * Snapshots the current working tree into a commit under `refs/ai-insights/checkpoints/`.
 *
 * Returns `null` when there is nothing to snapshot (tree identical to `HEAD`),
 * when the folder isn't a git repo, or when the repo has no commits yet - all
 * normal conditions, not errors.
 */
export function createCheckpoint(repoRootOrPath: string, reason: string): Checkpoint | null {
  const repoRoot = findRepoRoot(repoRootOrPath);
  if (!repoRoot || !hasCommits(repoRoot)) { return null; }

  const tempIndex = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'ai-insights-ckpt-')),
    'index',
  );

  try {
    const env = { GIT_INDEX_FILE: tempIndex };

    // Seed the throwaway index from HEAD, then stage everything in the worktree.
    // `git add -A` honours .gitignore, so node_modules/dist stay out.
    git(['read-tree', 'HEAD'], repoRoot, env);
    git(['add', '-A'], repoRoot, env);
    const tree = git(['write-tree'], repoRoot, env);

    const headTree = git(['rev-parse', 'HEAD^{tree}'], repoRoot);
    if (tree === headTree) { return null; } // clean tree - nothing worth saving

    const createdAt = new Date();
    const message = `AI Insights safe-stop checkpoint\n\nReason: ${reason}\nCreated: ${createdAt.toISOString()}\n`;
    const commitSha = cp.execFileSync('git', ['commit-tree', tree, '-p', 'HEAD', '-F', '-'], {
      cwd: repoRoot,
      input: message,
      stdio: ['pipe', 'pipe', 'ignore'],
    }).toString().trim();

    const ref = `${REF_NAMESPACE}/${createdAt.toISOString().replace(/[:.]/g, '-')}`;
    git(['update-ref', ref, commitSha], repoRoot);

    const stats = readDiffStats(repoRoot, commitSha);

    return {
      ref,
      commitSha,
      createdAt: createdAt.toISOString(),
      repoRoot,
      reason,
      ...stats,
    };
  } catch {
    return null;
  } finally {
    try { fs.rmSync(path.dirname(tempIndex), { recursive: true, force: true }); } catch { /* temp dir already gone */ }
  }
}

function readDiffStats(repoRoot: string, commitSha: string): Pick<Checkpoint, 'filesChanged' | 'insertions' | 'deletions' | 'nameStatus'> {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  let nameStatus = '';

  try {
    const shortstat = git(['diff', '--shortstat', 'HEAD', commitSha], repoRoot);
    filesChanged = Number(shortstat.match(/(\d+) files? changed/)?.[1] ?? 0);
    insertions = Number(shortstat.match(/(\d+) insertions?/)?.[1] ?? 0);
    deletions = Number(shortstat.match(/(\d+) deletions?/)?.[1] ?? 0);
  } catch { /* stats are cosmetic - the snapshot itself is what matters */ }

  try {
    nameStatus = git(['diff', '--name-status', 'HEAD', commitSha], repoRoot)
      .split('\n')
      .slice(0, 100)
      .join('\n');
  } catch { /* same */ }

  return { filesChanged, insertions, deletions, nameStatus };
}

/** Existing checkpoints, newest first. */
export function listCheckpoints(repoRootOrPath: string): Checkpoint[] {
  const repoRoot = findRepoRoot(repoRootOrPath);
  if (!repoRoot) { return []; }

  try {
    const output = git(
      [
        'for-each-ref',
        REF_NAMESPACE,
        '--sort=-creatordate',
        '--format=%(refname)%09%(objectname)%09%(creatordate:iso-strict)%09%(subject)',
      ],
      repoRoot,
    );
    if (!output) { return []; }

    return output.split('\n').map(line => {
      const [ref, commitSha, createdAt, subject] = line.split('\t');
      return {
        ref,
        commitSha,
        createdAt,
        repoRoot,
        reason: subject ?? '',
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        nameStatus: '',
      };
    });
  } catch {
    return [];
  }
}

export function deleteCheckpoint(checkpoint: Checkpoint): boolean {
  try {
    git(['update-ref', '-d', checkpoint.ref, checkpoint.commitSha], checkpoint.repoRoot);
    return true;
  } catch {
    return false;
  }
}

/** Short `git status --short` snapshot, used to describe unfinished work in a handoff. */
export function readShortStatus(repoRootOrPath: string, maxLines = 60): string {
  const repoRoot = findRepoRoot(repoRootOrPath);
  if (!repoRoot) { return ''; }
  try {
    return git(['status', '--short'], repoRoot).split('\n').slice(0, maxLines).join('\n');
  } catch {
    return '';
  }
}

/** `git diff --stat HEAD` for the current uncommitted work. */
export function readDiffStat(repoRootOrPath: string): string {
  const repoRoot = findRepoRoot(repoRootOrPath);
  if (!repoRoot) { return ''; }
  try {
    return git(['diff', '--stat', 'HEAD'], repoRoot);
  } catch {
    return '';
  }
}

export function readCurrentBranch(repoRootOrPath: string): string {
  const repoRoot = findRepoRoot(repoRootOrPath);
  if (!repoRoot) { return ''; }
  try {
    return git(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  } catch {
    return '';
  }
}

/**
 * Copy-pasteable recovery commands. Deliberately read-only first: inspect
 * before restoring, since the working tree may well be the newer state.
 */
export function buildRestoreInstructions(checkpoint: Checkpoint): string {
  return [
    '# Inspect what the checkpoint holds',
    `git show --stat ${checkpoint.commitSha}`,
    `git diff ${checkpoint.commitSha}            # checkpoint -> current tree`,
    '',
    '# Restore everything from the checkpoint into the working tree',
    `git restore --source=${checkpoint.commitSha} --worktree -- .`,
    '',
    '# Or restore a single file',
    `git restore --source=${checkpoint.commitSha} --worktree -- path/to/file.ts`,
    '',
    '# Or branch off it to continue there',
    `git switch -c recovered-work ${checkpoint.commitSha}`,
  ].join('\n');
}
