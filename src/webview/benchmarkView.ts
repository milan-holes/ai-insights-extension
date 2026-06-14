import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { navCss, navTopbarHtml, navPagebarHtml, navJs, NAV_COMMANDS } from './navShared';
import { designTokensCss } from './designSystem';
import { BUILT_IN_TECHNIQUES } from '../benchmark/techniques';
import { BUILT_IN_TASKS } from '../benchmark/tasks';
import { runBenchmark } from '../benchmark/runner';
import { buildAdapter, ADAPTER_DEFS } from '../benchmark/adapters';
import { BenchmarkConfig, BenchmarkProgress, RotState, TechniqueAvailability } from '../benchmark/types';
import { scanRepo } from '../benchmark/worktree';
import { checkTechniqueAvailability } from '../benchmark/techniques';
import { CancelSignal } from '../benchmark/runner';

const ANTHROPIC_KEY_SECRET = 'aiInsights.benchmarkApiKey';
const JUDGE_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

export class BenchmarkViewProvider {
  static readonly viewType = 'aiInsights.benchmark';
  private static currentPanel: vscode.WebviewPanel | undefined;
  private static cancelSignal: CancelSignal | undefined;

  static async createPanel(context: vscode.ExtensionContext): Promise<void> {
    if (BenchmarkViewProvider.currentPanel) {
      BenchmarkViewProvider.currentPanel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      BenchmarkViewProvider.viewType,
      'Technique Benchmark',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')],
      },
    );

    const nonce = crypto.randomBytes(16).toString('hex');
    const cspSource = panel.webview.cspSource;
    const logoUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'assets', 'logo.png'),
    );

    const storedKey = await context.secrets.get(ANTHROPIC_KEY_SECRET);
    panel.webview.html = BenchmarkViewProvider.buildHTML(nonce, cspSource, logoUri.toString(), !!storedKey);

    panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      const p = BenchmarkViewProvider.currentPanel;
      if (!p) { return; }

      if (msg.command && NAV_COMMANDS[msg.command as string]) {
        vscode.commands.executeCommand(NAV_COMMANDS[msg.command as string]);
        return;
      }

      if (msg.command === 'saveApiKey') {
        await context.secrets.store(ANTHROPIC_KEY_SECRET, String(msg.key ?? ''));
        p.webview.postMessage({ type: 'apiKeySaved' });
        return;
      }

      if (msg.command === 'checkAdapter') {
        const adapterId = String(msg.adapterId ?? '');
        const apiKey = await context.secrets.get(ANTHROPIC_KEY_SECRET) ?? '';
        const adapter = buildAdapter(adapterId as any, apiKey, DEFAULT_MODEL);
        const check = await adapter.isAvailable();
        p.webview.postMessage({ type: 'adapterStatus', adapterId, ...check });
        return;
      }

      if (msg.command === 'scanWorkspace') {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders?.length) { return; }
        const scan = scanRepo(workspaceFolders[0].uri.fsPath);
        const availability: Record<string, TechniqueAvailability> = {};
        for (const t of BUILT_IN_TECHNIQUES) {
          availability[t.id] = checkTechniqueAvailability(t, scan);
        }
        p.webview.postMessage({ type: 'scanResult', availability, scan });
        return;
      }

      if (msg.command === 'exportResults') {
        const results = msg.results as unknown[];
        if (!results?.length) { return; }
        const ts = new Date().toISOString().slice(0, 10);
        const uri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(`benchmark-${ts}.json`),
          filters: { 'JSON': ['json'] },
          title: 'Export Benchmark Results',
        });
        if (!uri) { return; }
        const content = Buffer.from(JSON.stringify(results, null, 2), 'utf8');
        await vscode.workspace.fs.writeFile(uri, content);
        vscode.window.showInformationMessage(`Exported ${results.length} benchmark results.`);
        return;
      }

      if (msg.command === 'stopBenchmark') {
        if (BenchmarkViewProvider.cancelSignal) {
          BenchmarkViewProvider.cancelSignal.cancelled = true;
        }
        return;
      }

      if (msg.command === 'runBenchmark') {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders?.length) {
          p.webview.postMessage({ type: 'error', message: 'No workspace folder open.' });
          return;
        }

        const adapterId = String(msg.adapterId ?? 'claude-code-cli');
        const apiKey = await context.secrets.get(ANTHROPIC_KEY_SECRET) ?? '';

        // Validate: Anthropic adapter requires a key
        if (adapterId === 'anthropic-api' && !apiKey) {
          p.webview.postMessage({ type: 'error', message: 'Anthropic API key required. Enter it in the provider section.' });
          return;
        }

        const config: BenchmarkConfig = {
          techniqueIds: msg.techniqueIds as string[],
          taskIds: msg.taskIds as string[],
          rotStates: msg.rotStates as RotState[],
          adapterId,
          model: DEFAULT_MODEL,
          runsPerCombination: Number(msg.runs) || 1,
          apiKey: apiKey || undefined,
          judgeModel: JUDGE_MODEL,
          workspaceRoot: workspaceFolders[0].uri.fsPath,
        };

        const cancelSignal: CancelSignal = { cancelled: false };
        BenchmarkViewProvider.cancelSignal = cancelSignal;

        try {
          await runBenchmark(config, (progress: BenchmarkProgress) => {
            p.webview.postMessage({ type: 'progress', progress });
          }, cancelSignal);
        } catch (err) {
          p.webview.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        } finally {
          BenchmarkViewProvider.cancelSignal = undefined;
        }
        return;
      }
    }, undefined, context.subscriptions);

    panel.onDidDispose(() => { BenchmarkViewProvider.currentPanel = undefined; }, null, context.subscriptions);
    BenchmarkViewProvider.currentPanel = panel;
  }

  private static buildHTML(nonce: string, cspSource: string, logoUri: string, hasAnthropicKey: boolean): string {
    const techniquesJson = JSON.stringify(
      BUILT_IN_TECHNIQUES.map(t => ({ id: t.id, name: t.name, family: t.family, description: t.description })),
    );
    const tasksJson = JSON.stringify(
      BUILT_IN_TASKS.map(t => ({ id: t.id, name: t.name, category: t.category, rotStates: t.rotStates })),
    );
    const adaptersJson = JSON.stringify(ADAPTER_DEFS);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Technique Benchmark</title>
<style>
  ${designTokensCss()}
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg-base); color: var(--text-primary); font-family: var(--font-primary); font-size: 13px; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
  .scroll-area { flex: 1; overflow-y: auto; }
  ${navCss()}

  /* Config panel */
  .bench-layout { display: grid; grid-template-columns: 300px 1fr; gap: 0; height: 100%; }
  .bench-sidebar { border-right: 1px solid var(--border); padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 18px; background: var(--bg-surface); }
  .bench-main { padding: 24px 28px; overflow-y: auto; }
  .sidebar-section { display: flex; flex-direction: column; gap: 8px; }
  .sidebar-label { font-size: 9px; font-weight: 700; letter-spacing: 1.8px; color: var(--text-secondary); text-transform: uppercase; }
  .check-row { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-radius: 6px; cursor: pointer; transition: background 0.1s; }
  .check-row:hover { background: var(--bg-surface-high); }
  .check-row input[type=checkbox] { margin-top: 2px; accent-color: var(--primary); flex-shrink: 0; }
  .check-label { display: flex; flex-direction: column; gap: 2px; }
  .check-name { font-size: 12px; font-weight: 500; color: var(--text-primary); }
  .check-desc { font-size: 11px; color: var(--text-secondary); line-height: 1.4; }
  .family-badge { font-size: 9px; font-weight: 600; letter-spacing: 0.8px; padding: 1px 5px; border-radius: 3px; background: rgba(255,255,255,0.07); color: var(--text-secondary); text-transform: uppercase; width: fit-content; }
  .rot-chips { display: flex; gap: 4px; flex-wrap: wrap; }
  .rot-chip { border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-size: 11px; font-weight: 500; color: var(--text-secondary); cursor: pointer; transition: all 0.15s; background: transparent; font-family: var(--font-primary); }
  .rot-chip.active { background: var(--primary); border-color: var(--primary); color: #fff; }
  .bench-input { width: 100%; background: var(--bg-base); border: 1px solid var(--border); border-radius: 7px; padding: 7px 10px; color: var(--text-primary); font-size: 12px; font-family: var(--font-primary); outline: none; }
  .bench-input:focus { border-color: rgba(0,122,255,0.4); }
  .bench-select { width: 100%; background: var(--bg-base); border: 1px solid var(--border); border-radius: 7px; padding: 7px 10px; color: var(--text-primary); font-size: 12px; font-family: var(--font-primary); outline: none; cursor: pointer; }
  .key-row { display: flex; gap: 6px; }
  .key-row .bench-input { flex: 1; }
  .btn-save { background: var(--bg-surface-high); border: 1px solid var(--border); border-radius: 7px; padding: 7px 12px; color: var(--text-secondary); font-size: 11px; font-family: var(--font-primary); cursor: pointer; white-space: nowrap; transition: all 0.15s; }
  .btn-save:hover { color: var(--text-primary); border-color: rgba(255,255,255,0.15); }
  .btn-run { width: 100%; padding: 11px; background: var(--primary); border: none; border-radius: 8px; color: #fff; font-size: 13px; font-weight: 600; font-family: var(--font-primary); cursor: pointer; transition: opacity 0.15s; margin-top: 4px; }
  .btn-run:hover { opacity: 0.88; }
  .btn-run:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-stop { width: 100%; padding: 11px; background: var(--danger); border: none; border-radius: 8px; color: #fff; font-size: 13px; font-weight: 600; font-family: var(--font-primary); cursor: pointer; transition: opacity 0.15s; margin-top: 4px; display: none; }
  .btn-stop:hover { opacity: 0.88; }
  .btn-stop:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Results */
  .result-tabs-row { display: flex; align-items: center; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
  .result-tabs { display: flex; gap: 2px; flex: 1; }
  .result-tab { padding: 7px 14px 11px; font-size: 12.5px; font-weight: 500; color: var(--text-secondary); background: transparent; border: none; cursor: pointer; font-family: var(--font-primary); position: relative; transition: color 0.15s; }
  .result-tab:hover { color: var(--text-primary); }
  .result-tab.active { color: var(--text-primary); font-weight: 600; }
  .result-tab.active::after { content: ''; position: absolute; left: 8px; right: 8px; bottom: -1px; height: 2px; background: #39FF14; border-radius: 2px; }
  .btn-export { background: transparent; border: 1px solid var(--border); border-radius: 6px; padding: 5px 12px; color: var(--text-secondary); font-size: 11px; font-family: var(--font-primary); cursor: pointer; white-space: nowrap; transition: all 0.15s; margin-bottom: 8px; }
  .btn-export:hover:not(:disabled) { color: var(--text-primary); border-color: rgba(255,255,255,0.2); }
  .btn-export:disabled { opacity: 0.25; cursor: not-allowed; }
  .result-view { display: none; }
  .result-view.active { display: block; }

  /* Progress */
  .progress-bar-wrap { background: var(--bg-surface); border-radius: 6px; height: 6px; overflow: hidden; margin: 12px 0 6px; }
  .progress-bar-fill { height: 100%; background: var(--primary); border-radius: 6px; transition: width 0.3s; }
  .progress-label { font-size: 11px; color: var(--text-secondary); }

  /* Comparison table */
  .bench-table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 8px 12px; font-size: 9px; letter-spacing: 1.5px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; border-bottom: 1px solid var(--border); white-space: nowrap; }
  td { padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: top; }
  tr:hover td { background: rgba(255,255,255,0.02); }
  .score-pill { display: inline-block; padding: 2px 7px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .score-good { background: rgba(52,211,153,0.15); color: #34d399; }
  .score-warn { background: rgba(251,191,36,0.15); color: #fbbf24; }
  .score-bad  { background: rgba(248,113,113,0.15); color: #f87171; }
  .rot-badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 600; }
  .rot-fresh   { background: rgba(52,211,153,0.15); color: #34d399; }
  .rot-warm    { background: rgba(251,191,36,0.12); color: #fbbf24; }
  .rot-bloated { background: rgba(248,113,113,0.12); color: #f87171; }
  .rot-critical{ background: rgba(248,113,113,0.25); color: #f87171; }
  .technique-name { font-weight: 500; color: var(--text-primary); }
  .mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; }
  .empty-state { text-align: center; padding: 60px 20px; color: var(--text-secondary); }
  .empty-icon { font-size: 32px; margin-bottom: 12px; opacity: 0.5; }
  .empty-title { font-size: 14px; font-weight: 500; color: var(--text-primary); margin-bottom: 6px; }
  .section-title { font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 14px; }
  .error-banner { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.2); border-radius: 8px; padding: 12px 16px; color: #f87171; font-size: 12px; margin-bottom: 16px; display: none; }
  .key-status { font-size: 11px; color: var(--success); margin-top: 4px; display: none; }
  .adapter-status { font-size: 11px; margin-top: 6px; min-height: 16px; }
  .avail-badge { font-size: 10px; padding: 1px 6px; border-radius: 4px; margin-top: 3px; display: none; }
  .avail-ok { background: rgba(52,211,153,0.12); color: #34d399; display: inline-block; }
  .avail-warn { background: rgba(251,191,36,0.12); color: #fbbf24; display: inline-block; cursor: help; }
  .check-row.unavailable { opacity: 0.55; }

  /* Experiment notice */
  .experiment-notice { display: flex; align-items: flex-start; gap: 10px; background: rgba(251,191,36,0.07); border: 1px solid rgba(251,191,36,0.22); border-radius: 8px; padding: 11px 14px; margin-bottom: 18px; }
  .experiment-notice-icon { font-size: 15px; flex-shrink: 0; margin-top: 1px; }
  .experiment-notice-body { display: flex; flex-direction: column; gap: 3px; }
  .experiment-notice-title { font-size: 12px; font-weight: 600; color: #fbbf24; }
  .experiment-notice-text { font-size: 11px; color: var(--text-secondary); line-height: 1.5; }

  /* Confirm modal */
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 100; display: none; align-items: center; justify-content: center; }
  .modal-overlay.visible { display: flex; }
  .modal-box { background: var(--bg-surface); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 24px 26px; width: 360px; max-width: 90vw; display: flex; flex-direction: column; gap: 16px; box-shadow: 0 24px 48px rgba(0,0,0,0.5); }
  .modal-title { font-size: 14px; font-weight: 600; color: var(--text-primary); }
  .modal-warning { font-size: 12px; color: #fbbf24; background: rgba(251,191,36,0.08); border: 1px solid rgba(251,191,36,0.18); border-radius: 7px; padding: 9px 12px; line-height: 1.5; }
  .modal-recap { display: flex; flex-direction: column; gap: 6px; background: var(--bg-base); border-radius: 7px; padding: 12px 14px; }
  .modal-recap-row { display: flex; justify-content: space-between; font-size: 12px; }
  .modal-recap-row span:first-child { color: var(--text-secondary); }
  .modal-recap-row span:last-child { color: var(--text-primary); font-weight: 500; }
  .modal-recap-divider { height: 1px; background: var(--border); margin: 4px 0; }
  .modal-recap-total span:first-child { color: var(--text-primary); font-weight: 600; }
  .modal-recap-total span:last-child { color: #fbbf24; font-weight: 700; font-size: 13px; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .btn-modal-cancel { background: transparent; border: 1px solid var(--border); border-radius: 7px; padding: 8px 16px; color: var(--text-secondary); font-size: 12px; font-family: var(--font-primary); cursor: pointer; transition: all 0.15s; }
  .btn-modal-cancel:hover { color: var(--text-primary); border-color: rgba(255,255,255,0.2); }
  .btn-modal-confirm { background: var(--primary); border: none; border-radius: 7px; padding: 8px 18px; color: #fff; font-size: 12px; font-weight: 600; font-family: var(--font-primary); cursor: pointer; transition: opacity 0.15s; }
  .btn-modal-confirm:hover { opacity: 0.88; }
</style>
</head>
<body>
${navTopbarHtml(logoUri, false)}
${navPagebarHtml('benchmark', 'Technique Benchmark')}

<div class="scroll-area">
<div class="bench-layout">

  <!-- SIDEBAR: config -->
  <div class="bench-sidebar">

    <div class="sidebar-section">
      <div class="sidebar-label">Provider</div>
      <div id="adapterList"></div>
      <div class="adapter-status" id="adapterStatus"></div>
    </div>

    <div class="sidebar-section" id="apiKeySection" style="display:none">
      <div class="sidebar-label">Anthropic API Key <span style="color:var(--text-secondary);font-weight:400;letter-spacing:0">(for Anthropic adapter &amp; judge scoring)</span></div>
      <div class="key-row">
        <input class="bench-input" type="password" id="apiKeyInput" placeholder="${hasAnthropicKey ? '••••••••••••••••' : 'sk-ant-…'}" autocomplete="off">
        <button class="btn-save" id="btnSaveKey">Save</button>
      </div>
      <div class="key-status" id="keyStatus">✓ Key saved</div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-label">Techniques</div>
      <div id="techniqueList"></div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-label">Tasks</div>
      <div id="taskList"></div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-label">Context Rot State</div>
      <div class="rot-chips" id="rotChips">
        <button class="rot-chip active" data-rot="fresh">Fresh</button>
        <button class="rot-chip active" data-rot="warm">Warm</button>
        <button class="rot-chip active" data-rot="bloated">Bloated</button>
        <button class="rot-chip active" data-rot="critical">Critical</button>
      </div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-label">Runs per combination</div>
      <select class="bench-select" id="runsSelect">
        <option value="1">1 (quick)</option>
        <option value="3" selected>3 (recommended)</option>
        <option value="5">5 (thorough)</option>
      </select>
    </div>

    <button class="btn-run" id="btnRun">▶ Run Benchmark</button>
    <button class="btn-stop" id="btnStop">⏹ Stop</button>

  </div>

  <!-- MAIN: results -->
  <div class="bench-main">
    <div class="experiment-notice">
      <div class="experiment-notice-icon">⚗️</div>
      <div class="experiment-notice-body">
        <div class="experiment-notice-title">Experimental Feature</div>
        <div class="experiment-notice-text">This benchmark is an experiment. Results may vary and running all combinations can consume a significant number of tokens — especially with multiple runs or the Anthropic API adapter.</div>
      </div>
    </div>
    <div class="error-banner" id="errorBanner"></div>

    <div id="progressSection" style="display:none; margin-bottom: 20px;">
      <div class="progress-label" id="progressLabel">Starting…</div>
      <div class="progress-bar-wrap"><div class="progress-bar-fill" id="progressBar" style="width:0%"></div></div>
      <div class="progress-label" id="progressCurrent"></div>
      <details id="liveOutputDetails" style="margin-top:10px; display:none;">
        <summary style="font-size:11px; cursor:pointer; color:var(--text-secondary); user-select:none;">Live Output</summary>
        <pre id="liveOutputPre" style="margin-top:6px; font-size:11px; font-family:'SF Mono','Fira Code',monospace; color:var(--text-primary); background:var(--bg-surface); border:1px solid var(--border); border-radius:6px; padding:10px 12px; max-height:220px; overflow-y:auto; white-space:pre-wrap; line-height:1.5;"></pre>
      </details>
    </div>

    <div class="result-tabs-row">
      <div class="result-tabs">
        <button class="result-tab active" data-view="comparison">Technique Comparison</button>
        <button class="result-tab" data-view="rot">Rot Degradation</button>
        <button class="result-tab" data-view="raw">Raw Results</button>
      </div>
      <button class="btn-export" id="btnExport" disabled>↓ Export JSON</button>
    </div>

    <div class="result-view active" id="view-comparison">
      <div class="empty-state" id="emptyComparison">
        <div class="empty-icon">⚗️</div>
        <div class="empty-title">No results yet</div>
        <div>Configure techniques and tasks, then click Run Benchmark.</div>
      </div>
      <div class="bench-table-wrap" id="comparisonTable" style="display:none"></div>
    </div>

    <div class="result-view" id="view-rot">
      <div class="empty-state" id="emptyRot">
        <div class="empty-icon">🌀</div>
        <div class="empty-title">No rot degradation data yet</div>
        <div>Run with multiple rot states to see degradation analysis.</div>
      </div>
      <div class="bench-table-wrap" id="rotTable" style="display:none"></div>
    </div>

    <div class="result-view" id="view-raw">
      <div class="empty-state" id="emptyRaw">
        <div class="empty-icon">📋</div>
        <div class="empty-title">No raw results yet</div>
      </div>
      <div id="rawResults" style="display:none"></div>
    </div>
  </div>

</div>
</div>

<!-- Confirm modal -->
<div class="modal-overlay" id="confirmModal">
  <div class="modal-box">
    <div class="modal-title">Confirm Benchmark Run</div>
    <div class="modal-warning">⚠ Running all combinations can use a large number of tokens. Review the breakdown below before proceeding.</div>
    <div class="modal-recap">
      <div class="modal-recap-row"><span>Techniques</span><span id="modalTechniques">—</span></div>
      <div class="modal-recap-row"><span>Tasks</span><span id="modalTasks">—</span></div>
      <div class="modal-recap-row"><span>Rot states</span><span id="modalRotStates">—</span></div>
      <div class="modal-recap-row"><span>Runs per combination</span><span id="modalRuns">—</span></div>
      <div class="modal-recap-divider"></div>
      <div class="modal-recap-row modal-recap-total"><span>Total runs</span><span id="modalTotal">—</span></div>
    </div>
    <div class="modal-actions">
      <button class="btn-modal-cancel" id="btnModalCancel">Cancel</button>
      <button class="btn-modal-confirm" id="btnModalConfirm">▶ Run Benchmark</button>
    </div>
  </div>
</div>

<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  window.vscode = vscode;
  ${navJs()}

  const TECHNIQUES = ${techniquesJson};
  const TASKS = ${tasksJson};
  const ADAPTERS = ${adaptersJson};
  let allResults = [];
  let selectedAdapterId = 'claude-code-cli';
  let workspaceScan = null;
  let lastAvailability = {};

  // ── Build adapter selector ────────────────────────────────────────────────
  const adapterList = document.getElementById('adapterList');
  const groups = [...new Set(ADAPTERS.map(a => a.group))];
  groups.forEach(group => {
    const groupLabel = document.createElement('div');
    groupLabel.style.cssText = 'font-size:10px;color:var(--text-secondary);font-weight:600;letter-spacing:1px;text-transform:uppercase;padding:6px 0 3px;';
    groupLabel.textContent = group;
    adapterList.appendChild(groupLabel);

    ADAPTERS.filter(a => a.group === group).forEach(a => {
      const row = document.createElement('label');
      row.className = 'check-row';
      row.style.paddingLeft = '4px';
      row.innerHTML = \`
        <input type="radio" name="adapter" value="\${a.id}" \${a.id === selectedAdapterId ? 'checked' : ''}>
        <div class="check-label"><span class="check-name">\${a.label}</span></div>\`;
      row.querySelector('input').addEventListener('change', () => {
        selectedAdapterId = a.id;
        onAdapterChange();
      });
      adapterList.appendChild(row);
    });
  });

  function onAdapterChange() {
    const isAnthropic = selectedAdapterId === 'anthropic-api';
    document.getElementById('apiKeySection').style.display = isAnthropic ? 'block' : 'none';
    renderTechniqueDescriptions();
    applyAvailability(lastAvailability);
    document.getElementById('adapterStatus').textContent = 'Checking…';
    document.getElementById('adapterStatus').style.color = 'var(--text-secondary)';
    vscode.postMessage({ command: 'checkAdapter', adapterId: selectedAdapterId });
  }
  // Check default adapter on load
  onAdapterChange();

  // ── Build technique + task lists ──────────────────────────────────────────
  const techniqueList = document.getElementById('techniqueList');
  TECHNIQUES.forEach(t => {
    const row = document.createElement('label');
    row.className = 'check-row';
    row.dataset.tid = t.id;
    row.innerHTML = \`
      <input type="checkbox" value="\${t.id}" checked>
      <div class="check-label">
        <span class="check-name">\${t.name}</span>
        <span class="family-badge">\${t.family}</span>
        <span class="avail-badge" id="avail-\${t.id}"></span>
        <span class="check-desc" id="desc-\${t.id}">\${t.description}</span>
      </div>\`;
    techniqueList.appendChild(row);
  });

  function getTechniqueDescription(t) {
    if (!selectedAdapterId.startsWith('copilot-')) {
      return t.description;
    }
    const copilotDescriptions = {
      'caveman-output-style': 'No context docs + compressed terse response style via prompt prefix. Claude Code output-style files are ignored by Copilot.',
      'claude-md-full': 'Copilot instructions only: .github/copilot-instructions.md is used; CLAUDE.md is ignored for Copilot runs.',
      'claude-md-caveman': 'Compressed AI instructions in caveman-speak. Copilot run uses .github/copilot-instructions.md, not CLAUDE.md.',
      'llm-wiki': 'Copilot instructions + full wiki/ directory. CLAUDE.md is ignored for Copilot runs.',
    };
    return copilotDescriptions[t.id] || t.description
      .replace(/CLAUDE\\.md, /g, '')
      .replace(/, no CLAUDE\\.md/g, '')
      .replace(/no CLAUDE\\.md, /g, '')
      .replace(/CLAUDE\\.md \\/ /g, '');
  }

  function renderTechniqueDescriptions() {
    TECHNIQUES.forEach(t => {
      const desc = document.getElementById('desc-' + t.id);
      if (desc) { desc.textContent = getTechniqueDescription(t); }
    });
  }
  renderTechniqueDescriptions();

  function applyAvailability(availability) {
    TECHNIQUES.forEach(t => {
      let avail = availability[t.id];
      if (selectedAdapterId.startsWith('copilot-') && t.id === 'claude-md-full') {
        const hasCopilotInstructions = workspaceScan?.aiConfigFiles?.includes('.github/copilot-instructions.md');
        if (!hasCopilotInstructions) {
          avail = {
            available: false,
            reason: 'No Copilot instructions found',
            setupHint: 'Add .github/copilot-instructions.md for Copilot instruction-only benchmarking.',
          };
        }
      }
      const badge = document.getElementById('avail-' + t.id);
      const row = document.querySelector('[data-tid="' + t.id + '"]');
      const cb = row && row.querySelector('input[type=checkbox]');
      if (!avail || avail.available) {
        if (badge) { badge.className = 'avail-badge'; badge.textContent = ''; }
        if (row) row.classList.remove('unavailable');
        return;
      }
      if (badge) {
        badge.className = 'avail-badge avail-warn';
        badge.textContent = '⚠ ' + avail.reason;
        if (avail.setupHint) { badge.title = avail.setupHint; }
      }
      if (row) row.classList.add('unavailable');
      if (cb) cb.checked = false;
    });
  }

  // Scan workspace to check technique availability
  vscode.postMessage({ command: 'scanWorkspace' });

  const taskList = document.getElementById('taskList');
  TASKS.forEach(t => {
    const row = document.createElement('label');
    row.className = 'check-row';
    row.innerHTML = \`
      <input type="checkbox" value="\${t.id}" checked>
      <div class="check-label">
        <span class="check-name">\${t.name}</span>
        <span class="family-badge">\${t.category}</span>
      </div>\`;
    taskList.appendChild(row);
  });

  // ── Rot chips toggle ──────────────────────────────────────────────────────
  document.querySelectorAll('.rot-chip').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('active'));
  });

  // ── Result tabs ───────────────────────────────────────────────────────────
  document.querySelectorAll('.result-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.result-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.result-view').forEach(v => v.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('view-' + tab.dataset.view).classList.add('active');
    });
  });

  // ── API key save ──────────────────────────────────────────────────────────
  document.getElementById('btnSaveKey').addEventListener('click', () => {
    const key = document.getElementById('apiKeyInput').value.trim();
    if (!key) return;
    vscode.postMessage({ command: 'saveApiKey', key });
  });

  // ── Run button → show confirm modal ──────────────────────────────────────
  document.getElementById('btnRun').addEventListener('click', () => {
    const techniqueIds = [...document.querySelectorAll('#techniqueList input:checked')].map(i => i.value);
    const taskIds = [...document.querySelectorAll('#taskList input:checked')].map(i => i.value);
    const rotStates = [...document.querySelectorAll('.rot-chip.active')].map(b => b.dataset.rot);
    const runs = parseInt(document.getElementById('runsSelect').value);

    if (!techniqueIds.length || !taskIds.length || !rotStates.length) {
      showError('Select at least one technique, task, and rot state.');
      return;
    }
    hideError();

    const total = techniqueIds.length * taskIds.length * rotStates.length * runs;
    document.getElementById('modalTechniques').textContent = String(techniqueIds.length);
    document.getElementById('modalTasks').textContent = String(taskIds.length);
    document.getElementById('modalRotStates').textContent = rotStates.join(', ');
    document.getElementById('modalRuns').textContent = String(runs);
    document.getElementById('modalTotal').textContent = String(total);
    document.getElementById('confirmModal').classList.add('visible');
  });

  document.getElementById('btnModalCancel').addEventListener('click', () => {
    document.getElementById('confirmModal').classList.remove('visible');
  });

  document.getElementById('btnModalConfirm').addEventListener('click', () => {
    document.getElementById('confirmModal').classList.remove('visible');
    const techniqueIds = [...document.querySelectorAll('#techniqueList input:checked')].map(i => i.value);
    const taskIds = [...document.querySelectorAll('#taskList input:checked')].map(i => i.value);
    const rotStates = [...document.querySelectorAll('.rot-chip.active')].map(b => b.dataset.rot);
    const runs = parseInt(document.getElementById('runsSelect').value);
    setRunning(true);
    allResults = [];
    vscode.postMessage({ command: 'runBenchmark', techniqueIds, taskIds, rotStates, adapterId: selectedAdapterId, runs });
  });

  // ── Message handler ───────────────────────────────────────────────────────
  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'apiKeySaved') {
      document.getElementById('keyStatus').style.display = 'block';
      document.getElementById('apiKeyInput').value = '';
      setTimeout(() => { document.getElementById('keyStatus').style.display = 'none'; }, 3000);
      return;
    }
    if (msg.type === 'adapterStatus') {
      const el = document.getElementById('adapterStatus');
      el.textContent = msg.available ? '✓ Ready' : '✗ ' + (msg.reason || 'Not available');
      el.style.color = msg.available ? 'var(--success)' : 'var(--danger)';
      return;
    }
    if (msg.type === 'scanResult') {
      workspaceScan = msg.scan || null;
      lastAvailability = msg.availability || {};
      applyAvailability(lastAvailability);
      return;
    }
    if (msg.type === 'error') { showError(msg.message); setRunning(false); return; }
    if (msg.type === 'progress') {
      const p = msg.progress;
      allResults = p.results;
      updateProgress(p);
      if (p.status === 'done' || p.status === 'error') {
        setRunning(false);
        renderResults(allResults);
      }
    }
  });

  function setRunning(running) {
    const btnRun = document.getElementById('btnRun');
    const btnStop = document.getElementById('btnStop');
    btnRun.style.display = running ? 'none' : 'block';
    btnStop.style.display = running ? 'block' : 'none';
    btnStop.disabled = false;
    btnStop.textContent = '⏹ Stop';
    document.getElementById('progressSection').style.display = running ? 'block' : 'none';
    if (!running) {
      document.getElementById('liveOutputDetails').style.display = 'none';
      document.getElementById('liveOutputPre').textContent = '';
    }
  }

  document.getElementById('btnStop').addEventListener('click', () => {
    const btn = document.getElementById('btnStop');
    btn.disabled = true;
    btn.textContent = '⏳ Stopping…';
    vscode.postMessage({ command: 'stopBenchmark' });
  });

  function updateProgress(p) {
    const pct = p.total > 0 ? Math.round((p.completed / p.total) * 100) : 0;
    document.getElementById('progressBar').style.width = pct + '%';
    document.getElementById('progressLabel').textContent = p.completed + ' / ' + p.total + ' runs (' + pct + '%)';
    document.getElementById('progressCurrent').textContent = p.current;
    if (p.liveOutput !== undefined) {
      const details = document.getElementById('liveOutputDetails');
      const pre = document.getElementById('liveOutputPre');
      details.style.display = 'block';
      pre.textContent = p.liveOutput;
      pre.scrollTop = pre.scrollHeight;
    }
    if (p.results.length > 0) renderResults(p.results);
  }

  function showError(msg) {
    const el = document.getElementById('errorBanner');
    el.textContent = msg;
    el.style.display = 'block';
  }
  function hideError() { document.getElementById('errorBanner').style.display = 'none'; }

  // ── Render results ────────────────────────────────────────────────────────
  function fmt(n) { return n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n); }
  function fmtMs(ms) { return ms < 0 ? '—' : ms >= 1000 ? (ms/1000).toFixed(1)+'s' : ms+'ms'; }
  function fmtUsd(v) { return '$'+(v||0).toFixed(4); }

  function scorePill(val, invert) {
    const good = invert ? val <= 3 : val >= 7;
    const warn = val > 3 && val < 7;
    const cls = good ? 'score-good' : warn ? 'score-warn' : 'score-bad';
    return '<span class="score-pill ' + cls + '">' + (val != null ? val.toFixed(1) : '—') + '</span>';
  }

  function rotBadge(rot) {
    return '<span class="rot-badge rot-' + rot + '">' + rot + '</span>';
  }

  function avgOf(results, getter) {
    const vals = results.map(getter).filter(v => v != null && !isNaN(v));
    return vals.length ? vals.reduce((a,b) => a+b, 0) / vals.length : null;
  }

  function renderResults(results) {
    renderComparison(results);
    renderRot(results);
    renderRaw(results);
  }

  function renderComparison(results) {
    if (!results.length) return;
    const errFree = results.filter(r => !r.error);
    if (!errFree.length) return;

    // Group by techniqueId, average across runs and rot states (fresh only for primary)
    const freshResults = errFree.filter(r => r.rotState === 'fresh');
    const grouped = {};
    (freshResults.length ? freshResults : errFree).forEach(r => {
      if (!grouped[r.techniqueId]) grouped[r.techniqueId] = [];
      grouped[r.techniqueId].push(r);
    });

    const techName = {};
    TECHNIQUES.forEach(t => techName[t.id] = t.name);

    let html = '<div class="section-title">Technique Comparison' + (freshResults.length ? ' — fresh context' : '') + '</div><table>';
    html += '<thead><tr><th>Technique</th><th>Input Tok</th><th>Output Tok</th><th>Cache Hit</th><th>Cost/Run</th><th>Halluc ↓</th><th>Success ↑</th><th>TTFT</th></tr></thead><tbody>';

    Object.entries(grouped).sort(([a],[b]) => a.localeCompare(b)).forEach(([tid, rows]) => {
      const avgIn = avgOf(rows, r => r.tokens.inputTokens);
      const avgOut = avgOf(rows, r => r.tokens.outputTokens);
      const cacheHit = avgOf(rows, r => r.tokens.cacheReadTokens > 0 ? 100 : 0);
      const avgCost = avgOf(rows, r => r.cost.totalUsd);
      const avgHalluc = avgOf(rows.filter(r => r.quality), r => r.quality?.hallucinationScore);
      const avgSuccess = avgOf(rows.filter(r => r.quality), r => r.quality?.taskSuccessScore);
      const avgTtft = avgOf(rows, r => r.timing.ttftMs);

      html += \`<tr>
        <td class="technique-name">\${techName[tid] || tid}</td>
        <td class="mono">\${avgIn != null ? fmt(Math.round(avgIn)) : '—'}</td>
        <td class="mono">\${avgOut != null ? fmt(Math.round(avgOut)) : '—'}</td>
        <td class="mono">\${cacheHit != null ? Math.round(cacheHit)+'%' : '—'}</td>
        <td class="mono">\${avgCost != null ? fmtUsd(avgCost) : '—'}</td>
        <td>\${avgHalluc != null ? scorePill(avgHalluc, true) : '—'}</td>
        <td>\${avgSuccess != null ? scorePill(avgSuccess, false) : '—'}</td>
        <td class="mono">\${avgTtft != null ? fmtMs(Math.round(avgTtft)) : '—'}</td>
      </tr>\`;
    });

    html += '</tbody></table>';
    const tableEl = document.getElementById('comparisonTable');
    tableEl.innerHTML = html;
    tableEl.style.display = 'block';
    document.getElementById('emptyComparison').style.display = 'none';
  }

  function renderRot(results) {
    const errFree = results.filter(r => !r.error);
    if (!errFree.length) return;
    const multiRot = [...new Set(errFree.map(r => r.rotState))];
    if (multiRot.length < 2) return;

    const techName = {};
    TECHNIQUES.forEach(t => techName[t.id] = t.name);
    const ROT_ORDER = ['fresh','warm','bloated','critical'];

    // Group by techniqueId + rotState
    const byTechRot = {};
    errFree.forEach(r => {
      const key = r.techniqueId + '|' + r.rotState;
      if (!byTechRot[key]) byTechRot[key] = [];
      byTechRot[key].push(r);
    });

    const techs = [...new Set(errFree.map(r => r.techniqueId))].sort();
    const rots = ROT_ORDER.filter(r => multiRot.includes(r));

    let html = '<div class="section-title">Rot Degradation — Success Score by Context State</div><table>';
    html += '<thead><tr><th>Technique</th>' + rots.map(r => '<th>' + rotBadge(r) + '</th>').join('') + '<th>Δ worst</th></tr></thead><tbody>';

    techs.forEach(tid => {
      const scores = rots.map(rot => {
        const rows = byTechRot[tid + '|' + rot] || [];
        return avgOf(rows.filter(r => r.quality), r => r.quality?.taskSuccessScore);
      });
      const valid = scores.filter(s => s != null);
      const delta = valid.length >= 2 ? (valid[valid.length-1] - valid[0]).toFixed(1) : '—';
      const deltaColor = typeof delta === 'string' && delta !== '—' && parseFloat(delta) < -2 ? 'color:#f87171' : 'color:#34d399';

      html += '<tr><td class="technique-name">' + (techName[tid]||tid) + '</td>';
      scores.forEach(s => { html += '<td>' + (s != null ? scorePill(s, false) : '—') + '</td>'; });
      html += '<td class="mono" style="' + deltaColor + '">' + delta + '</td></tr>';
    });

    html += '</tbody></table>';
    const tableEl = document.getElementById('rotTable');
    tableEl.innerHTML = html;
    tableEl.style.display = 'block';
    document.getElementById('emptyRot').style.display = 'none';
  }

  function renderRaw(results) {
    if (!results.length) return;
    const techName = {};
    TECHNIQUES.forEach(t => techName[t.id] = t.name);
    const taskName = {};
    TASKS.forEach(t => taskName[t.id] = t.name);

    let html = '';
    results.slice().reverse().forEach(r => {
      const header = (techName[r.techniqueId]||r.techniqueId) + ' × ' + (taskName[r.taskId]||r.taskId) + ' × ' + r.rotState + ' (run ' + r.run + ')';
      const statusColor = r.error ? '#f87171' : '#34d399';
      html += \`<details style="margin-bottom:10px; background: var(--bg-surface); border: 1px solid var(--border); border-radius:8px; padding:12px 14px;">
        <summary style="cursor:pointer; font-size:12px; font-weight:500; color:var(--text-primary);">
          <span style="color:\${statusColor}; margin-right:6px;">\${r.error ? '✗' : '✓'}</span>\${header}
        </summary>
        <div style="margin-top:12px; display:grid; grid-template-columns:1fr 1fr; gap:8px; font-size:11px;">
          <div><span style="color:var(--text-secondary)">Input tokens:</span> \${fmt(r.tokens.inputTokens)}</div>
          <div><span style="color:var(--text-secondary)">Output tokens:</span> \${fmt(r.tokens.outputTokens)}</div>
          <div><span style="color:var(--text-secondary)">Cache read:</span> \${fmt(r.tokens.cacheReadTokens)}</div>
          <div><span style="color:var(--text-secondary)">Cost:</span> \${fmtUsd(r.cost.totalUsd)}</div>
          <div><span style="color:var(--text-secondary)">Wall time:</span> \${fmtMs(r.timing.wallTimeMs)}</div>
          <div><span style="color:var(--text-secondary)">TTFT:</span> \${fmtMs(r.timing.ttftMs)}</div>
          <div><span style="color:var(--text-secondary)">Context size:</span> \${fmt(r.context.tokens)} tok / \${(r.context.sizeBytes/1024).toFixed(1)}KB</div>
          <div><span style="color:var(--text-secondary)">Context files:</span> \${r.context.fileCount}</div>
          \${r.quality ? \`
          <div><span style="color:var(--text-secondary)">Hallucination:</span> \${r.quality.hallucinationScore}/10</div>
          <div><span style="color:var(--text-secondary)">Task success:</span> \${r.quality.taskSuccessScore}/10</div>
          \` : ''}
        </div>
        \${r.error ? '<div style="margin-top:10px; color:#f87171; font-size:11px;">Error: ' + r.error + '</div>' : ''}
        \${r.quality?.reasoning ? '<div style="margin-top:10px; font-size:11px; color:var(--text-secondary);">Judge: ' + r.quality.reasoning + '</div>' : ''}
        \${r.response ? '<details style="margin-top:10px;"><summary style="font-size:11px; cursor:pointer; color:var(--text-secondary);">Response</summary><pre style="margin-top:8px; font-size:11px; white-space:pre-wrap; color:var(--text-primary); line-height:1.5;">' + r.response.replace(/</g,'&lt;').slice(0,2000) + '</pre></details>' : ''}
      </details>\`;
    });

    const rawEl = document.getElementById('rawResults');
    rawEl.innerHTML = html;
    rawEl.style.display = 'block';
    document.getElementById('emptyRaw').style.display = 'none';
  }

})();
</script>
</body>
</html>`;
  }
}
