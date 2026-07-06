import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { navCss, navTopbarHtml, navPagebarHtml, navJs, NAV_COMMANDS } from './navShared';
import { designTokensCss } from './designSystem';
import { AbTestConfig, AbTestProgress, AbVariant } from '../abtest/types';
import { runAbTest, CancelSignal } from '../abtest/runner';
import { isGitRepo, teardownAbTestWorktree, listOrphanedAbTestWorktrees } from '../abtest/worktree';

const COPILOT_MODELS: Array<{ id: string; label: string }> = [
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4.7', label: 'Claude Opus 4.7' },
  { id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
];

const CLAUDE_CODE_MODELS: Array<{ id: string; label: string }> = [
  { id: '', label: 'Default' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
  { id: 'haiku', label: 'Haiku' },
];

const CODEX_MODELS: Array<{ id: string; label: string }> = [
  { id: '', label: 'Default' },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
];

const MAX_ATTACH_CHARS = 20000;

interface ActiveFileSnapshot {
  relPath: string;
  content: string;
  truncated: boolean;
  isSelection: boolean;
  lineCount: number;
}

/**
 * The GitHub Copilot variant is a bare `vscode.lm.sendRequest` call with no tools and no
 * implicit editor context (unlike real Copilot Chat, which auto-attaches the open file) — a
 * prompt like "refactor this function" otherwise reaches the model with nothing to act on.
 * Snapshotting the active editor (or its selection) and prepending it to the prompt gives every
 * variant, including the CLI-based ones, identical grounding for a fair comparison.
 */
function getActiveFileSnapshot(workspaceRoot: string): ActiveFileSnapshot | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') { return null; }

  const relPath = path.relative(workspaceRoot, editor.document.uri.fsPath);
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) { return null; }

  const isSelection = !editor.selection.isEmpty;
  const fullText = isSelection ? editor.document.getText(editor.selection) : editor.document.getText();
  const truncated = fullText.length > MAX_ATTACH_CHARS;

  return {
    relPath,
    content: truncated ? fullText.slice(0, MAX_ATTACH_CHARS) : fullText,
    truncated,
    isSelection,
    lineCount: fullText.split('\n').length,
  };
}

function buildPromptWithContext(prompt: string, snapshot: ActiveFileSnapshot | null): string {
  if (!snapshot) { return prompt; }
  const label = snapshot.isSelection ? 'Selected code' : 'Active file';
  const note = snapshot.truncated ? ' (truncated)' : '';
  return `${label}: \`${snapshot.relPath}\`${note}\n\n\`\`\`\n${snapshot.content}\n\`\`\`\n\n---\n\n${prompt}`;
}

export class AbTestViewProvider {
  static readonly viewType = 'aiInsights.abTest';
  private static currentPanel: vscode.WebviewPanel | undefined;
  private static cancelSignal: CancelSignal | undefined;
  private static lastResults: Array<{ id: string; worktreePath?: string }> = [];

  static async createPanel(context: vscode.ExtensionContext): Promise<void> {
    if (AbTestViewProvider.currentPanel) {
      AbTestViewProvider.currentPanel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      AbTestViewProvider.viewType,
      'A/B Test Prompts',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')],
      },
    );

    const nonce = crypto.randomBytes(16).toString('hex');
    const logoUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'assets', 'logo.png'));
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath;
    const gitAvailable = !!workspaceRoot && isGitRepo(workspaceRoot);

    panel.webview.html = AbTestViewProvider.buildHTML(nonce, panel.webview.cspSource, logoUri.toString(), !!workspaceRoot, gitAvailable);

    const postActiveFileInfo = () => {
      const snapshot = workspaceRoot ? getActiveFileSnapshot(workspaceRoot) : null;
      panel.webview.postMessage({
        type: 'activeFileInfo',
        relPath: snapshot?.relPath ?? null,
        isSelection: snapshot?.isSelection ?? false,
        lineCount: snapshot?.lineCount ?? 0,
      });
    };
    postActiveFileInfo();
    const editorChangeListener = vscode.window.onDidChangeActiveTextEditor(postActiveFileInfo);
    const selectionChangeListener = vscode.window.onDidChangeTextEditorSelection(postActiveFileInfo);

    if (gitAvailable && workspaceRoot) {
      listOrphanedAbTestWorktrees(workspaceRoot).then(orphans => {
        if (orphans.length > 0) {
          panel.webview.postMessage({ type: 'orphanedWorktrees', count: orphans.length });
        }
      });
    }

    panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      const p = AbTestViewProvider.currentPanel;
      if (!p) { return; }

      if (msg.command && NAV_COMMANDS[msg.command as string]) {
        vscode.commands.executeCommand(NAV_COMMANDS[msg.command as string]);
        return;
      }

      if (!workspaceRoot) { return; }

      if (msg.command === 'runAbTest') {
        if (!gitAvailable) { return; }

        const snapshot = msg.attachActiveFile ? getActiveFileSnapshot(workspaceRoot) : null;
        const config: AbTestConfig = {
          prompt: buildPromptWithContext(String(msg.prompt ?? ''), snapshot),
          variants: msg.variants as AbVariant[],
          workspaceRoot,
        };

        const cancelSignal: CancelSignal = { cancelled: false };
        AbTestViewProvider.cancelSignal = cancelSignal;

        try {
          const results = await runAbTest(config, (progress: AbTestProgress) => {
            p.webview.postMessage({ type: 'progress', progress });
          }, cancelSignal);
          AbTestViewProvider.lastResults = results.map(r => ({ id: r.variant.id, worktreePath: r.worktreePath }));
        } catch (err) {
          p.webview.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        } finally {
          AbTestViewProvider.cancelSignal = undefined;
        }
        return;
      }

      if (msg.command === 'stopAbTest') {
        if (AbTestViewProvider.cancelSignal) { AbTestViewProvider.cancelSignal.cancelled = true; }
        return;
      }

      if (msg.command === 'openInNewWindow') {
        const worktreePath = String(msg.worktreePath ?? '');
        if (!worktreePath) { return; }
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(worktreePath), { forceNewWindow: true });
        return;
      }

      if (msg.command === 'cleanupWorktrees') {
        for (const entry of AbTestViewProvider.lastResults) {
          if (entry.worktreePath) {
            await teardownAbTestWorktree(workspaceRoot, entry.id).catch(() => {});
          }
        }
        AbTestViewProvider.lastResults = [];
        p.webview.postMessage({ type: 'cleanupDone' });
        return;
      }

      if (msg.command === 'cleanupOrphaned') {
        const orphans = await listOrphanedAbTestWorktrees(workspaceRoot);
        for (const orphan of orphans) {
          await teardownAbTestWorktree(workspaceRoot, orphan.variantId).catch(() => {});
        }
        p.webview.postMessage({ type: 'orphanedCleanupDone', count: orphans.length });
        return;
      }
    }, undefined, context.subscriptions);

    panel.onDidDispose(() => {
      AbTestViewProvider.currentPanel = undefined;
      editorChangeListener.dispose();
      selectionChangeListener.dispose();
    }, null, context.subscriptions);
    AbTestViewProvider.currentPanel = panel;
  }

  private static buildHTML(nonce: string, cspSource: string, logoUri: string, hasWorkspace: boolean, gitAvailable: boolean): string {
    const copilotModelsJson = JSON.stringify(COPILOT_MODELS);
    const claudeModelsJson = JSON.stringify(CLAUDE_CODE_MODELS);
    const codexModelsJson = JSON.stringify(CODEX_MODELS);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>A/B Test Prompts</title>
<style>
  ${designTokensCss()}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg-base); color: var(--text-primary); font-family: var(--font-primary); font-size: 13px; height: 100vh; overflow: hidden; display: flex; flex-direction: column; }
  ${navCss()}
  .scroll-area { flex: 1; overflow-y: auto; }
  .subtitle-bar { padding: 12px 24px 0; font-size: 12px; color: var(--text-secondary); }

  .warning-wrap { padding: 40px 24px; display: flex; justify-content: center; }
  .warning-box { max-width: 480px; display: flex; gap: 12px; background: rgba(251,191,36,0.08); border: 1px solid rgba(251,191,36,0.25); border-radius: 10px; padding: 18px 20px; }
  .warning-icon { font-size: 20px; flex-shrink: 0; }
  .warning-title { font-size: 13px; font-weight: 600; color: #fbbf24; margin-bottom: 6px; }
  .warning-text { font-size: 12px; color: var(--text-secondary); line-height: 1.6; }
  .warning-text code { background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 4px; }

  .layout { display: grid; grid-template-columns: 320px 1fr; height: 100%; }
  .sidebar { border-right: 1px solid var(--border); padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 18px; background: var(--bg-surface); }
  .main { padding: 24px 28px; overflow-y: auto; }
  .section-label { font-size: 9px; font-weight: 700; letter-spacing: 1.8px; color: var(--text-secondary); text-transform: uppercase; margin-bottom: 8px; }
  textarea.prompt-input { width: 100%; min-height: 110px; background: var(--bg-base); border: 1px solid var(--border); border-radius: 7px; padding: 9px 11px; color: var(--text-primary); font-size: 12.5px; font-family: var(--font-primary); outline: none; resize: vertical; }
  textarea.prompt-input:focus { border-color: rgba(0,122,255,0.4); }

  .context-toggle-row { display: flex; align-items: center; gap: 7px; cursor: pointer; padding: 2px; }
  .context-toggle-row input[type=checkbox] { accent-color: var(--primary); }
  .context-toggle-row span { font-size: 12px; color: var(--text-primary); }
  .context-status { font-size: 11px; color: var(--text-secondary); margin-top: 4px; padding-left: 1px; }
  .context-status.has-file { color: #34d399; }

  .provider-group { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
  .provider-group-title { font-size: 11.5px; font-weight: 600; color: var(--text-primary); margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
  .model-row { display: flex; align-items: center; gap: 7px; padding: 4px 2px; cursor: pointer; border-radius: 5px; }
  .model-row:hover { background: var(--bg-surface-high); }
  .model-row input[type=checkbox] { accent-color: var(--primary); }
  .model-row span { font-size: 12px; color: var(--text-primary); }
  .custom-model-row { display: flex; gap: 6px; margin-top: 6px; }
  .custom-model-row input[type=text] { flex: 1; background: var(--bg-base); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; color: var(--text-primary); font-size: 11.5px; font-family: var(--font-primary); }
  .custom-model-row button { background: var(--bg-surface-high); border: 1px solid var(--border); border-radius: 6px; padding: 5px 10px; color: var(--text-secondary); font-size: 11px; cursor: pointer; }
  .custom-model-row button:hover { color: var(--text-primary); }

  .btn-run { width: 100%; padding: 11px; background: var(--primary); border: none; border-radius: 8px; color: #fff; font-size: 13px; font-weight: 600; font-family: var(--font-primary); cursor: pointer; }
  .btn-run:hover:not(:disabled) { opacity: 0.88; }
  .btn-run:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-stop { width: 100%; padding: 11px; background: var(--danger, #f87171); border: none; border-radius: 8px; color: #fff; font-size: 13px; font-weight: 600; font-family: var(--font-primary); cursor: pointer; display: none; }
  .btn-cleanup { width: 100%; padding: 9px; background: transparent; border: 1px solid var(--border); border-radius: 8px; color: var(--text-secondary); font-size: 12px; font-family: var(--font-primary); cursor: pointer; margin-top: 8px; }
  .btn-cleanup:hover { color: var(--text-primary); border-color: rgba(255,255,255,0.2); }

  .empty-state { text-align: center; padding: 60px 20px; color: var(--text-secondary); }
  .empty-icon { font-size: 32px; margin-bottom: 12px; opacity: 0.5; }
  .empty-title { font-size: 14px; font-weight: 500; color: var(--text-primary); margin-bottom: 6px; }

  .results-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }
  .result-card { border: 1px solid var(--border); border-radius: 10px; padding: 16px; background: var(--bg-surface); display: flex; flex-direction: column; gap: 12px; }
  .result-card-head { display: flex; align-items: center; justify-content: space-between; }
  .result-title { font-size: 13px; font-weight: 600; }
  .status-badge { font-size: 10px; font-weight: 700; letter-spacing: 0.6px; padding: 2px 8px; border-radius: 10px; text-transform: uppercase; }
  .status-pending { background: rgba(255,255,255,0.08); color: var(--text-secondary); }
  .status-running { background: rgba(0,122,255,0.15); color: var(--primary); }
  .status-done { background: rgba(52,211,153,0.15); color: #34d399; }
  .status-error { background: rgba(248,113,113,0.15); color: #f87171; }

  .stat-tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .stat-tile { background: var(--bg-base); border: 1px solid var(--border); border-radius: 7px; padding: 7px 9px; display: flex; flex-direction: column; gap: 3px; }
  .stat-tile-label { font-size: 8.5px; font-weight: 700; letter-spacing: 1.2px; color: var(--text-secondary); text-transform: uppercase; }
  .stat-tile-value { font-size: 12px; font-weight: 600; color: var(--text-primary); font-family: 'SF Mono', 'Fira Code', monospace; }
  .stat-tile-value .diff-add { color: #34d399; }
  .stat-tile-value .diff-del { color: #f87171; }
  .stat-tile-sub { font-size: 9.5px; color: var(--text-secondary); }

  .result-worktree { font-size: 10.5px; color: var(--text-secondary); font-family: 'SF Mono', 'Fira Code', monospace; word-break: break-all; }
  .result-response { font-size: 12px; line-height: 1.55; white-space: pre-wrap; max-height: 260px; overflow-y: auto; background: var(--bg-base); border: 1px solid var(--border); border-radius: 7px; padding: 10px 12px; }
  .result-error { font-size: 12px; color: #f87171; background: rgba(248,113,113,0.08); border: 1px solid rgba(248,113,113,0.2); border-radius: 7px; padding: 8px 10px; }
  .result-actions { display: flex; gap: 8px; }
  .btn-open { flex: 1; background: var(--bg-surface-high); border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; color: var(--text-primary); font-size: 11.5px; font-family: var(--font-primary); cursor: pointer; }
  .btn-open:hover:not(:disabled) { border-color: rgba(255,255,255,0.2); }
  .btn-open:disabled { opacity: 0.35; cursor: not-allowed; }
  .error-banner { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.2); border-radius: 8px; padding: 12px 16px; color: #f87171; font-size: 12px; margin-bottom: 16px; display: none; }
  .orphan-banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: rgba(251,191,36,0.08); border: 1px solid rgba(251,191,36,0.22); border-radius: 8px; padding: 10px 16px; margin: 16px 24px 0; font-size: 12px; color: #fbbf24; }
  .orphan-banner button { background: var(--bg-surface-high); border: 1px solid var(--border); border-radius: 6px; padding: 5px 12px; color: var(--text-primary); font-size: 11.5px; font-family: var(--font-primary); cursor: pointer; white-space: nowrap; }
  .orphan-banner button:hover { border-color: rgba(255,255,255,0.2); }
  .provider-note { font-size: 10.5px; color: var(--text-secondary); line-height: 1.5; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
</style>
</head>
<body>
${navTopbarHtml(logoUri, false)}
${navPagebarHtml('abTest', 'A/B Test Prompts')}
${!hasWorkspace ? `
  <div class="warning-wrap"><div class="warning-box"><span class="warning-icon">&#9888;</span>
    <div><div class="warning-title">No workspace open</div>
    <div class="warning-text">Open a folder to use A/B prompt testing.</div></div>
  </div></div>
` : !gitAvailable ? `
  <div class="warning-wrap"><div class="warning-box"><span class="warning-icon">&#9888;</span>
    <div><div class="warning-title">Git repository required</div>
    <div class="warning-text">This feature isn't available in this workspace. Each provider/model variant runs in its own isolated <code>git worktree</code> so it can be opened in a separate VS Code window without touching your working copy. Run <code>git init</code> in this folder to enable A/B testing.</div></div>
  </div></div>
` : `
  <div class="subtitle-bar">Compare how different providers and models respond to the same prompt — each runs in its own git worktree.</div>
  <div class="scroll-area">
    <div class="orphan-banner" id="orphanBanner" style="display:none;">
      <span></span>
      <button id="btnCleanupOrphaned">Clean up now</button>
    </div>
    <div class="layout">
      <div class="sidebar">
        <div>
          <div class="section-label">Prompt</div>
          <textarea class="prompt-input" id="promptInput" placeholder="Enter the prompt to compare across providers/models..."></textarea>
        </div>
        <div>
          <label class="context-toggle-row"><input type="checkbox" id="attachActiveFile" checked><span>Attach active editor as context</span></label>
          <div class="context-status" id="contextStatus">No active file detected</div>
        </div>
        <div>
          <div class="section-label">Providers &amp; Models</div>
          <div id="providerGroups"></div>
        </div>
        <button class="btn-run" id="btnRun" disabled>Run A/B Test</button>
        <button class="btn-stop" id="btnStop">Stop</button>
        <button class="btn-cleanup" id="btnCleanup" style="display:none;">Clean up worktrees</button>
      </div>
      <div class="main">
        <div class="error-banner" id="errorBanner"></div>
        <div id="resultsArea">
          <div class="empty-state">
            <div class="empty-icon">&#9878;</div>
            <div class="empty-title">No results yet</div>
            <div>Select at least one provider/model variant and run the test.</div>
          </div>
        </div>
      </div>
    </div>
  </div>
`}
<script nonce="${nonce}">
(function() {
  var vscode = acquireVsCodeApi();
  window.vscode = vscode;
  var gitAvailable = ${gitAvailable};
  if (!gitAvailable) { return; }

  var COPILOT_MODELS = ${copilotModelsJson};
  var CLAUDE_MODELS = ${claudeModelsJson};
  var CODEX_MODELS = ${codexModelsJson};
  var customCounter = 0;

  function variantId(provider, model) {
    var safeModel = (model || 'default').replace(/[^a-z0-9.-]+/gi, '-');
    return provider + '-' + safeModel;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function(c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var PROVIDER_NOTES = {
    'copilot': 'Can read, list, search, write, and edit files scoped to its own worktree via a bounded tool loop (up to 50 tool calls) — not the full Copilot Chat product, but can now explore and build multi-file features, not just print content.',
    'claude-code': 'Has full autonomous file access to the whole worktree via its own tools — best for whole-project prompts, but can take much longer to respond than a single chat call.',
    'codex': 'Has full autonomous file access to the whole worktree via its own tools — best for whole-project prompts, but can take much longer to respond than a single chat call.',
  };

  function renderProviderGroup(providerId, providerLabel, models, allowCustom) {
    var html = '<div class="provider-group"><div class="provider-group-title">' + providerLabel + '</div>';
    models.forEach(function(m) {
      html += '<label class="model-row"><input type="checkbox" data-provider="' + providerId + '" data-model="' + escapeHtml(m.id) + '" data-label="' + escapeHtml(m.label) + '"><span>' + escapeHtml(m.label) + '</span></label>';
    });
    if (allowCustom) {
      html += '<div class="custom-model-row"><input type="text" placeholder="Custom model id..." id="custom-' + providerId + '"><button data-add-custom="' + providerId + '">Add</button></div>';
      html += '<div id="customList-' + providerId + '"></div>';
    }
    if (PROVIDER_NOTES[providerId]) {
      html += '<div class="provider-note">' + escapeHtml(PROVIDER_NOTES[providerId]) + '</div>';
    }
    html += '</div>';
    return html;
  }

  var groupsEl = document.getElementById('providerGroups');
  groupsEl.innerHTML =
    renderProviderGroup('claude-code', 'Claude Code', CLAUDE_MODELS, false) +
    renderProviderGroup('copilot', 'GitHub Copilot', COPILOT_MODELS, false) +
    renderProviderGroup('codex', 'Codex', CODEX_MODELS, true);

  groupsEl.querySelectorAll('[data-add-custom]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var providerId = btn.getAttribute('data-add-custom');
      var input = document.getElementById('custom-' + providerId);
      var model = input.value.trim();
      if (!model) { return; }
      customCounter++;
      var list = document.getElementById('customList-' + providerId);
      var row = document.createElement('label');
      row.className = 'model-row';
      row.innerHTML = '<input type="checkbox" checked data-provider="' + providerId + '" data-model="' + escapeHtml(model) + '" data-label="' + escapeHtml(model) + '"><span>' + escapeHtml(model) + '</span>';
      list.appendChild(row);
      input.value = '';
      updateRunButton();
    });
  });

  function selectedVariants() {
    var boxes = groupsEl.querySelectorAll('input[type=checkbox]:checked');
    var variants = [];
    boxes.forEach(function(box) {
      var provider = box.getAttribute('data-provider');
      var model = box.getAttribute('data-model') || '';
      var label = box.getAttribute('data-label') || model || 'Default';
      variants.push({ id: variantId(provider, model) + '-' + Math.random().toString(36).slice(2, 7), provider: provider, model: model, label: label });
    });
    return variants;
  }

  function updateRunButton() {
    var promptVal = document.getElementById('promptInput').value.trim();
    var count = groupsEl.querySelectorAll('input[type=checkbox]:checked').length;
    document.getElementById('btnRun').disabled = !promptVal || count < 1;
  }

  document.getElementById('promptInput').addEventListener('input', updateRunButton);
  groupsEl.addEventListener('change', updateRunButton);

  var resultsArea = document.getElementById('resultsArea');
  var errorBanner = document.getElementById('errorBanner');
  var btnRun = document.getElementById('btnRun');
  var btnStop = document.getElementById('btnStop');
  var btnCleanup = document.getElementById('btnCleanup');

  function statusLabel(s) {
    return { pending: 'Pending', running: 'Running', done: 'Done', error: 'Error' }[s] || s;
  }

  function tokensTile(r) {
    if (!r.tokens) { return '<div class="stat-tile"><div class="stat-tile-label">Tokens</div><div class="stat-tile-value">—</div></div>'; }
    var t = r.tokens;
    return '<div class="stat-tile"><div class="stat-tile-label">Tokens</div><div class="stat-tile-value">' + (t.inputTokens || 0) + ' in / ' + (t.outputTokens || 0) + ' out</div>' +
      (t.tokenSource === 'estimated' ? '<div class="stat-tile-sub">estimated</div>' : '') + '</div>';
  }

  function codeTile(r) {
    if (!r.codeStats) { return '<div class="stat-tile"><div class="stat-tile-label">Code produced</div><div class="stat-tile-value">—</div></div>'; }
    var c = r.codeStats;
    var value = '<span class="diff-add">+' + c.linesAdded + '</span> / <span class="diff-del">-' + c.linesDeleted + '</span>';
    var sub = c.filesChanged + (c.filesChanged === 1 ? ' file' : ' files') + (c.estimated ? ' · estimated from response' : '');
    return '<div class="stat-tile"><div class="stat-tile-label">Code produced</div><div class="stat-tile-value">' + value + '</div><div class="stat-tile-sub">' + sub + '</div></div>';
  }

  function timeTile(r) {
    var value = typeof r.wallTimeMs === 'number' ? (r.wallTimeMs / 1000).toFixed(1) + 's' : '—';
    return '<div class="stat-tile"><div class="stat-tile-label">Time</div><div class="stat-tile-value">' + value + '</div></div>';
  }

  function renderResults(results) {
    if (!results || !results.length) { return; }
    var html = '<div class="results-grid">';
    results.forEach(function(r) {
      html += '<div class="result-card">';
      html += '<div class="result-card-head"><div class="result-title">' + escapeHtml(r.variant.label) + '</div><span class="status-badge status-' + r.status + '">' + statusLabel(r.status) + '</span></div>';
      html += '<div class="stat-tiles">' + tokensTile(r) + codeTile(r) + timeTile(r) + '</div>';
      if (r.worktreePath) { html += '<div class="result-worktree">' + escapeHtml(r.worktreePath) + '</div>'; }
      if (r.error) { html += '<div class="result-error">' + escapeHtml(r.error) + '</div>'; }
      if (r.response) { html += '<div class="result-response"></div>'; }
      html += '<div class="result-actions"><button class="btn-open" data-worktree="' + escapeHtml(r.worktreePath || '') + '" ' + (r.worktreePath ? '' : 'disabled') + '>Open in New Window</button></div>';
      html += '</div>';
    });
    html += '</div>';
    resultsArea.innerHTML = html;

    var responseEls = resultsArea.querySelectorAll('.result-response');
    var withResponse = results.filter(function(r) { return !!r.response; });
    responseEls.forEach(function(el, i) { el.textContent = withResponse[i].response; });

    resultsArea.querySelectorAll('.btn-open').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var worktreePath = btn.getAttribute('data-worktree');
        if (!worktreePath) { return; }
        vscode.postMessage({ command: 'openInNewWindow', worktreePath: worktreePath });
      });
    });

    if (results.some(function(r) { return r.status === 'done' || r.status === 'error'; })) {
      btnCleanup.style.display = 'block';
    }
  }

  btnRun.addEventListener('click', function() {
    var prompt = document.getElementById('promptInput').value.trim();
    var variants = selectedVariants();
    if (!prompt || !variants.length) { return; }
    errorBanner.style.display = 'none';
    btnCleanup.style.display = 'none';
    btnRun.disabled = true;
    btnStop.style.display = 'block';
    var attachActiveFile = document.getElementById('attachActiveFile').checked;
    vscode.postMessage({ command: 'runAbTest', prompt: prompt, variants: variants, attachActiveFile: attachActiveFile });
  });

  btnStop.addEventListener('click', function() {
    vscode.postMessage({ command: 'stopAbTest' });
  });

  btnCleanup.addEventListener('click', function() {
    btnCleanup.disabled = true;
    vscode.postMessage({ command: 'cleanupWorktrees' });
  });

  var orphanBanner = document.getElementById('orphanBanner');
  document.getElementById('btnCleanupOrphaned').addEventListener('click', function() {
    this.disabled = true;
    vscode.postMessage({ command: 'cleanupOrphaned' });
  });

  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (msg.type === 'progress') {
      renderResults(msg.progress.results);
      if (msg.progress.status === 'done' || msg.progress.status === 'error') {
        btnRun.disabled = false;
        btnStop.style.display = 'none';
        updateRunButton();
      }
    } else if (msg.type === 'error') {
      errorBanner.textContent = msg.message;
      errorBanner.style.display = 'block';
      btnRun.disabled = false;
      btnStop.style.display = 'none';
      updateRunButton();
    } else if (msg.type === 'cleanupDone') {
      btnCleanup.style.display = 'none';
      btnCleanup.disabled = false;
    } else if (msg.type === 'activeFileInfo') {
      var statusEl = document.getElementById('contextStatus');
      if (msg.relPath) {
        var kind = msg.isSelection ? 'selection in' : 'full file';
        statusEl.textContent = 'Will attach ' + kind + ' ' + msg.relPath + ' (' + msg.lineCount + ' lines)';
        statusEl.classList.add('has-file');
      } else {
        statusEl.textContent = 'No active file detected';
        statusEl.classList.remove('has-file');
      }
    } else if (msg.type === 'orphanedWorktrees') {
      orphanBanner.querySelector('span').textContent = 'Found ' + msg.count + ' leftover worktree' + (msg.count === 1 ? '' : 's') + ' from a previous session.';
      orphanBanner.style.display = 'flex';
    } else if (msg.type === 'orphanedCleanupDone') {
      orphanBanner.style.display = 'none';
    }
  });

  updateRunButton();
})();
${navJs()}
</script>
</body>
</html>`;
  }
}
