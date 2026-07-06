import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ABTEST_DIR_NAME = '.ai-abtest';

function exec(cmd: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.exec(cmd, { cwd }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`${cmd}: ${stderr || err.message}`)); }
      else { resolve(stdout.trim()); }
    });
  });
}

export function isGitRepo(repoRoot: string): boolean {
  try {
    return cp.execSync('git rev-parse --is-inside-work-tree', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() === 'true';
  } catch {
    return false;
  }
}

function abTestBranch(variantId: string): string {
  return `abtest/${variantId}`;
}

function abTestWorktreePath(repoRoot: string, variantId: string): string {
  return path.join(repoRoot, ABTEST_DIR_NAME, variantId);
}

/**
 * Hides `.ai-abtest/` from `git status` for this repo only, without touching the user's tracked
 * `.gitignore`. Git already treats a nested worktree (it has its own `.git` file) as a repository
 * boundary and won't descend into or report on it — this exclude entry additionally keeps the
 * parent `.ai-abtest/` directory itself from showing as untracked before any worktree exists in it.
 */
function ensureLocalExclude(repoRoot: string): void {
  try {
    const gitDir = cp.execSync('git rev-parse --git-dir', { cwd: repoRoot }).toString().trim();
    const excludePath = path.join(path.isAbsolute(gitDir) ? gitDir : path.join(repoRoot, gitDir), 'info', 'exclude');
    const entry = `/${ABTEST_DIR_NAME}/`;
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    if (!existing.split('\n').includes(entry)) {
      fs.mkdirSync(path.dirname(excludePath), { recursive: true });
      fs.appendFileSync(excludePath, `${existing.endsWith('\n') || !existing ? '' : '\n'}${entry}\n`);
    }
  } catch { /* best-effort — worktree still works without this, just visible in git status */ }
}

/** Creates (or recreates) a clean worktree at HEAD for one A/B variant. No files are modified. */
export async function setupAbTestWorktree(repoRoot: string, variantId: string): Promise<{ worktreePath: string; branch: string }> {
  const worktreePath = abTestWorktreePath(repoRoot, variantId);
  const branch = abTestBranch(variantId);

  await teardownAbTestWorktree(repoRoot, variantId).catch(() => {});
  ensureLocalExclude(repoRoot);

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  await exec(`git worktree add -b ${branch} "${worktreePath}" HEAD`, repoRoot);

  return { worktreePath, branch };
}

export async function teardownAbTestWorktree(repoRoot: string, variantId: string): Promise<void> {
  const worktreePath = abTestWorktreePath(repoRoot, variantId);
  const branch = abTestBranch(variantId);

  try { await exec(`git worktree remove --force "${worktreePath}"`, repoRoot); } catch { /* already gone */ }
  try { await exec(`git branch -D ${branch}`, repoRoot); } catch { /* already gone */ }
}

/**
 * Finds `abtest/*` worktrees left over from a previous VS Code session (the panel only tracks
 * the last run's worktrees in memory, so a reloaded window or a crash orphans anything not
 * explicitly cleaned up via the panel's "Clean up worktrees" button before closing).
 */
export async function listOrphanedAbTestWorktrees(repoRoot: string): Promise<Array<{ variantId: string; worktreePath: string }>> {
  let output: string;
  try {
    output = await exec('git worktree list --porcelain', repoRoot);
  } catch {
    return [];
  }

  const orphans: Array<{ variantId: string; worktreePath: string }> = [];
  let currentPath: string | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ') && currentPath) {
      const branch = line.slice('branch '.length).trim();
      const match = branch.match(/^refs\/heads\/abtest\/(.+)$/);
      if (match) { orphans.push({ variantId: match[1], worktreePath: currentPath }); }
      currentPath = null;
    } else if (line === '') {
      currentPath = null;
    }
  }
  return orphans;
}

interface CodeStats {
  linesAdded: number;
  linesDeleted: number;
  filesChanged: number;
  estimated: boolean;
}

/**
 * Measures how much code a variant produced, by diffing the worktree against HEAD (staging
 * first with `git add -A` so newly created files count too — safe, this worktree is thrown away
 * or handed to the user). All three adapters can write files now (Claude Code/Codex via their
 * own CLI tools, Copilot via `CopilotAgentAdapter`'s `write_file` tool), so this real diff is the
 * common case; the fenced-code-block estimate from the response text is only a fallback for when
 * nothing was actually written (e.g. the model just answered inline, or a run predates the
 * write_file tool).
 */
export async function measureCodeProduced(worktreePath: string, responseText: string): Promise<CodeStats> {
  try {
    await exec('git add -A', worktreePath);
    const numstat = await exec('git diff --cached --numstat HEAD', worktreePath);
    if (numstat) {
      let linesAdded = 0;
      let linesDeleted = 0;
      let filesChanged = 0;
      for (const line of numstat.split('\n').filter(Boolean)) {
        const [added, deleted] = line.split('\t');
        filesChanged++;
        if (added !== '-') { linesAdded += parseInt(added, 10) || 0; }
        if (deleted !== '-') { linesDeleted += parseInt(deleted, 10) || 0; }
      }
      if (linesAdded + linesDeleted > 0) {
        return { linesAdded, linesDeleted, filesChanged, estimated: false };
      }
    }
  } catch { /* not fatal — fall through to the text-based estimate */ }

  return estimateCodeFromResponse(responseText);
}

function estimateCodeFromResponse(responseText: string): CodeStats {
  const codeBlocks = responseText.match(/```[\s\S]*?```/g) ?? [];
  let linesAdded = 0;
  for (const block of codeBlocks) {
    const inner = block.replace(/```[^\n]*\n?/, '').replace(/```$/, '');
    linesAdded += inner.split('\n').filter(l => l.trim().length > 0).length;
  }
  return { linesAdded, linesDeleted: 0, filesChanged: codeBlocks.length, estimated: true };
}
