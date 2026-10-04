/**
 * Executes the safe-stop flow: checkpoint the tree, write a handoff brief, and
 * optionally hand the remaining work to a provider that still has quota.
 *
 * ### What is and isn't possible here
 *
 * AI Insights observes provider session logs - it has no API to pause, inject
 * into, or migrate an in-flight Claude Code / Copilot / Codex agent run. So
 * there is deliberately **no claim of seamless mid-turn failover**: that cannot
 * be built from an extension, and pretending otherwise would silently drop
 * context exactly when the user is least able to notice.
 *
 * What it does instead is make the interruption survivable and the restart
 * cheap: a recoverable snapshot taken *before* the wall, a brief describing the
 * unfinished work, and a one-click launch of that brief in a provider with
 * headroom. The receiving agent starts a fresh run that already knows what was
 * being done and where the half-finished code is.
 *
 * ### Delegation routes
 *
 * | Target        | Mechanism                                                     |
 * |---------------|---------------------------------------------------------------|
 * | Copilot       | `workbench.action.chat.open` with the handoff prompt prefilled |
 * | Claude Code   | terminal running the `claude` CLI pointed at the brief         |
 * | Codex         | terminal running the `codex` CLI pointed at the brief          |
 * | Anything else | brief copied to the clipboard                                  |
 *
 * The CLI routes pass a short prompt that *references* the brief file rather
 * than inlining it, which avoids shell-quoting hazards entirely.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProviderId, Session } from '../types';
import { QuotaRisk, HandoffTarget } from './quotaGuard';
import {
  Checkpoint,
  createCheckpoint,
  findRepoRoot,
  readCurrentBranch,
  readDiffStat,
  readShortStatus,
} from './sessionCheckpoint';
import {
  buildHandoffFileName,
  buildHandoffMarkdown,
  buildHandoffPrompt,
  HandoffInput,
} from './handoffBuilder';
import { findClaudeBin, findCodexBin } from '../benchmark/adapters';

export interface HandoffResult {
  handoffFilePath: string;
  handoffMarkdown: string;
  handoffPrompt: string;
  checkpoint: Checkpoint | null;
  repoRoot: string;
}

export interface PrepareHandoffOptions {
  session: Session;
  risk: QuotaRisk | null;
  targets: HandoffTarget[];
  /** Workspace folder to snapshot and write into. */
  workspacePath: string;
  /** Directory for handoff briefs, relative to the workspace root. */
  handoffDirectory: string;
  /** Whether to take a git checkpoint as part of this. */
  checkpointEnabled: boolean;
  reason: string;
}

/**
 * Takes the checkpoint and writes the brief. Checkpoint first, deliberately:
 * if anything later fails, the recoverable snapshot still exists, which is the
 * part that actually protects the user's work.
 */
export function prepareHandoff(options: PrepareHandoffOptions): HandoffResult | null {
  const repoRoot = findRepoRoot(options.workspacePath) ?? options.workspacePath;

  const checkpoint = options.checkpointEnabled
    ? createCheckpoint(options.workspacePath, options.reason)
    : null;

  const generatedAt = new Date();
  const input: HandoffInput = {
    session: options.session,
    risk: options.risk,
    checkpoint,
    targets: options.targets,
    gitStatus: readShortStatus(options.workspacePath),
    gitDiffStat: readDiffStat(options.workspacePath),
    branch: readCurrentBranch(options.workspacePath),
    repoRoot,
    generatedAt,
  };

  const handoffMarkdown = buildHandoffMarkdown(input);
  const outputDir = path.isAbsolute(options.handoffDirectory)
    ? options.handoffDirectory
    : path.join(repoRoot, options.handoffDirectory);

  let handoffFilePath = path.join(outputDir, buildHandoffFileName(options.session, generatedAt));
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(handoffFilePath, handoffMarkdown, 'utf8');
    ensureGitIgnored(repoRoot, options.handoffDirectory);
  } catch {
    // Can't write into the repo (read-only, permissions) - fall back to a temp
    // file so the brief is never lost just because the location was awkward.
    try {
      const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-insights-handoff-'));
      handoffFilePath = path.join(fallbackDir, buildHandoffFileName(options.session, generatedAt));
      fs.writeFileSync(handoffFilePath, handoffMarkdown, 'utf8');
    } catch {
      return null;
    }
  }

  return {
    handoffFilePath,
    handoffMarkdown,
    handoffPrompt: buildHandoffPrompt(handoffFilePath, input),
    checkpoint,
    repoRoot,
  };
}

/**
 * Adds the handoff directory to `.git/info/exclude` rather than `.gitignore`,
 * so generated briefs stay out of `git status` without editing a tracked file
 * the user (or their team) owns. Mirrors the approach abtest/worktree.ts uses
 * for its own scratch directory.
 */
function ensureGitIgnored(repoRoot: string, handoffDirectory: string): void {
  if (path.isAbsolute(handoffDirectory)) { return; }
  try {
    const excludePath = path.join(repoRoot, '.git', 'info', 'exclude');
    if (!fs.existsSync(path.dirname(excludePath))) { return; }
    const pattern = `${handoffDirectory.replace(/^\.\//, '').replace(/\/$/, '')}/`;
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
    if (existing.split('\n').some(line => line.trim() === pattern)) { return; }
    fs.appendFileSync(excludePath, `${existing.endsWith('\n') || !existing ? '' : '\n'}${pattern}\n`);
  } catch { /* best effort - a visible handoff file is harmless */ }
}

export interface DelegationRoute {
  id: string;
  label: string;
  detail: string;
  provider: ProviderId | null;
  run: (result: HandoffResult) => Promise<void>;
}

/**
 * Delegation routes that are actually usable right now, ordered by the quota
 * headroom in `targets` so the recommended option comes first. A route only
 * appears if its mechanism is present (CLI on disk, Copilot chat available).
 */
export async function resolveDelegationRoutes(targets: HandoffTarget[]): Promise<DelegationRoute[]> {
  const routes: DelegationRoute[] = [];
  const headroomOf = (provider: ProviderId) =>
    targets.find(t => t.provider === provider)?.headroomPct ?? null;

  const [claudeBin, codexBin] = await Promise.all([findClaudeBin(), findCodexBin()]);

  if (claudeBin) {
    routes.push({
      id: 'claude-cli',
      label: '$(terminal) Continue in Claude Code',
      detail: describeTarget('claudeCode', headroomOf('claudeCode'), 'runs the claude CLI in a new terminal'),
      provider: 'claudeCode',
      run: async (result) => runInTerminal('Claude Code handoff', claudeBin, result),
    });
  }

  if (codexBin) {
    routes.push({
      id: 'codex-cli',
      label: '$(terminal) Continue in Codex',
      detail: describeTarget('codex', headroomOf('codex'), 'runs the codex CLI in a new terminal'),
      provider: 'codex',
      run: async (result) => runInTerminal('Codex handoff', codexBin, result),
    });
  }

  if (await isCopilotChatAvailable()) {
    routes.push({
      id: 'copilot-chat',
      label: '$(comment-discussion) Continue in Copilot Chat',
      detail: describeTarget('copilot', headroomOf('copilot'), 'opens Copilot Chat with the handoff prefilled'),
      provider: 'copilot',
      run: async (result) => {
        await vscode.commands.executeCommand('workbench.action.chat.open', {
          query: result.handoffPrompt,
        });
      },
    });
  }

  // Sort available agent routes by measured headroom; unknown headroom sinks
  // below anything measured, since an unverified target is a weaker suggestion.
  routes.sort((a, b) => {
    const ah = a.provider ? headroomOf(a.provider) : null;
    const bh = b.provider ? headroomOf(b.provider) : null;
    return (bh ?? -1) - (ah ?? -1);
  });

  routes.push(
    {
      id: 'open-file',
      label: '$(file) Open the handoff brief',
      detail: 'review the unfinished work yourself',
      provider: null,
      run: async (result) => {
        const doc = await vscode.workspace.openTextDocument(result.handoffFilePath);
        await vscode.window.showTextDocument(doc, { preview: false });
      },
    },
    {
      id: 'clipboard',
      label: '$(clippy) Copy handoff prompt',
      detail: 'paste into any other agent',
      provider: null,
      run: async (result) => {
        await vscode.env.clipboard.writeText(result.handoffPrompt);
        vscode.window.showInformationMessage('AI Insights: handoff prompt copied to the clipboard.');
      },
    },
  );

  return routes;
}

function describeTarget(provider: ProviderId, headroomPct: number | null, mechanism: string): string {
  const headroom = headroomPct !== null ? `${headroomPct.toFixed(0)}% quota headroom · ` : '';
  return `${headroom}${mechanism}`;
}

async function isCopilotChatAvailable(): Promise<boolean> {
  try {
    const commands = await vscode.commands.getCommands(true);
    return commands.includes('workbench.action.chat.open');
  } catch {
    return false;
  }
}

/**
 * Opens a terminal in the repo and sends the agent command. The prompt is a
 * single short argument referencing the brief file, so quoting stays safe; the
 * command is sent but *not* auto-executed-with-no-trace - the user sees exactly
 * what will run in their own terminal.
 */
async function runInTerminal(name: string, bin: string, result: HandoffResult): Promise<void> {
  const terminal = vscode.window.createTerminal({ name, cwd: result.repoRoot });
  terminal.show();
  const prompt = result.handoffPrompt.replace(/'/g, "'\\''");
  terminal.sendText(`${bin} '${prompt}'`, false);
  vscode.window.showInformationMessage(
    `AI Insights: handoff prepared in a terminal. Press Enter to start ${name}.`,
  );
}

/** Quick-pick over the available routes. */
export async function promptForDelegation(
  result: HandoffResult,
  targets: HandoffTarget[],
): Promise<void> {
  const routes = await resolveDelegationRoutes(targets);
  const picked = await vscode.window.showQuickPick(
    routes.map(route => ({ label: route.label, detail: route.detail, route })),
    {
      title: 'Delegate the unfinished work',
      placeHolder: 'Pick where to continue - ordered by live quota headroom',
      ignoreFocusOut: true,
    },
  );
  if (picked) { await picked.route.run(result); }
}
