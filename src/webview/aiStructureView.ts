import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { analyzeAIStructure } from '../core/aiStructureAnalyzer';
import { navCss, navTopbarHtml, navPagebarHtml, navJs, NAV_COMMANDS } from './navShared';
import { designTokensCss } from './designSystem';
import { providerIcon } from './providerIcons';

export class AIStructureViewProvider {
  static readonly viewType = 'aiInsights.aiStructure';
  private static currentPanel: vscode.WebviewPanel | undefined;

  static async createPanel(context: vscode.ExtensionContext): Promise<void> {
    if (AIStructureViewProvider.currentPanel) {
      AIStructureViewProvider.currentPanel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      AIStructureViewProvider.viewType,
      'Repository',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')],
      },
    );
    AIStructureViewProvider.currentPanel = panel;
    panel.onDidDispose(() => { AIStructureViewProvider.currentPanel = undefined; });

    const nonce = crypto.randomBytes(16).toString('hex');
    const cspSource = panel.webview.cspSource;
    const logoUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'assets', 'logo.png'),
    ).toString();

    panel.webview.html = AIStructureViewProvider.buildHTML(nonce, cspSource, logoUri);

    panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      const p = AIStructureViewProvider.currentPanel;
      if (!p) { return; }

      if (msg.command && NAV_COMMANDS[msg.command as string]) {
        vscode.commands.executeCommand(NAV_COMMANDS[msg.command as string]);
        return;
      }

      if (msg.command === 'analyze') {
        await AIStructureViewProvider.handleAnalyze(p);
        return;
      }

      if (msg.command === 'openFile') {
        await AIStructureViewProvider.handleOpenFile(String(msg.relativePath ?? ''));
        return;
      }
    });
  }

  private static async handleAnalyze(panel: vscode.WebviewPanel): Promise<void> {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) {
      panel.webview.postMessage({ type: 'error', message: 'No workspace folder open.' });
      return;
    }
    panel.webview.postMessage({ type: 'analyzing' });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    try {
      const report = await analyzeAIStructure(rootPath);
      panel.webview.postMessage({ type: 'analysisResult', report });
    } catch (err) {
      panel.webview.postMessage({ type: 'error', message: String(err) });
    }
  }

  private static async handleOpenFile(relativePath: string): Promise<void> {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath || !relativePath) { return; }
    const abs = path.join(rootPath, relativePath);
    try {
      const doc = await vscode.workspace.openTextDocument(abs);
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    } catch {
      vscode.window.showWarningMessage(`Could not open ${relativePath}`);
    }
  }

  private static buildHTML(nonce: string, cspSource: string, logoUri: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    script-src 'nonce-${nonce}';
    style-src 'unsafe-inline';
    img-src ${cspSource} data:;
    font-src ${cspSource};
  ">
  <title>Repository</title>
  <style>
    ${BASE_CSS}
    ${navCss()}
  </style>
</head>
<body>
${navTopbarHtml(logoUri, false)}
${navPagebarHtml('aiStructure', 'Repository')}

<div class="toolbar">
  <div class="toolbar-left">
    <span class="toolbar-label">AI STRUCTURE ANALYSIS</span>
  </div>
  <div class="toolbar-right">
    <button id="btnRefreshAnalysis" class="btn">↺ Re-scan</button>
  </div>
</div>

<div id="content" class="ns-content">
  <div class="loading-state">
    <div class="spinner"></div>
    <p>Scanning repository for AI configuration…</p>
  </div>
</div>

<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  window.vscode = vscode;

  const PROVIDER_ICONS = ${JSON.stringify({
    copilot: providerIcon('copilot'),
    antigravity: providerIcon('antigravity'),
    claudeCode: providerIcon('claudeCode'),
    codex: providerIcon('codex'),
  })};

  ${navJs()}

  vscode.postMessage({ command: 'analyze' });

  document.getElementById('btnRefreshAnalysis').addEventListener('click', function() {
    document.getElementById('content').innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Scanning repository for AI configuration…</p></div>';
    vscode.postMessage({ command: 'analyze' });
  });

  window.addEventListener('message', function(event) {
    const msg = event.data;
    if (msg.type === 'analyzing') {
      document.getElementById('content').innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Scanning repository for AI configuration…</p></div>';
    }
    if (msg.type === 'analysisResult') {
      renderReport(msg.report);
    }
    if (msg.type === 'error') {
      showError(msg.message);
    }
  });

  function openFile(rel) {
    vscode.postMessage({ command: 'openFile', relativePath: rel });
  }

  function renderReport(report) {
    let html = '';

    const detectedProviders = report.providers.filter(function(p) { return p.detected; });

    html += '<div class="stats-row">';
    html += statCard('Providers', detectedProviders.length + ' / ' + report.providers.length);
    html += statCard('Instructions', report.instructions.length.toString());
    html += statCard('Skills', report.skills.length.toString());
    html += statCard('Agents', report.agents.length.toString());
    html += statCard('MCP Servers', report.mcpServers.length.toString());
    html += '</div>';

    // Providers section
    html += '<div class="section">';
    html += '<div class="section-header"><span class="section-title">Providers</span></div>';
    html += '<div class="provider-grid">';
    for (const p of report.providers) {
      const icon = PROVIDER_ICONS[p.id];
      html += '<div class="provider-card ' + (p.detected ? 'detected' : 'missing') + '">';
      html += '<div class="provider-card-top">';
      html += icon ? '<span class="provider-icon">' + icon + '</span>' : '<span class="provider-icon provider-icon-fallback">' + escHtml(p.label.slice(0, 2).toUpperCase()) + '</span>';
      html += '<span class="provider-name">' + escHtml(p.label) + '</span>';
      html += '<span class="provider-status">' + (p.detected ? '✓ Ready' : '- Not set up') + '</span>';
      html += '</div>';
      if (p.signals.length > 0) {
        html += '<div class="provider-signals">' + p.signals.map(function(s) {
          return '<code class="sig-chip" data-file="' + escAttr(s) + '">' + escHtml(s) + '</code>';
        }).join('') + '</div>';
      }
      html += '</div>';
    }
    html += '</div></div>';

    // Instructions section
    html += '<div class="section">';
    html += '<div class="section-header"><span class="section-title">Instruction Files</span></div>';
    if (report.instructions.length === 0) {
      html += emptyState('No instruction files found (CLAUDE.md, .cursorrules, copilot-instructions.md, AGENTS.md, …).');
    } else {
      html += '<table class="data-table"><thead><tr><th>File</th><th>Provider(s)</th><th>Scope</th><th>Applies To</th><th>Quality</th><th>Words</th><th>Modified</th></tr></thead><tbody>';
      for (const ins of report.instructions.slice().sort(function(a, b) { return a.relativePath.localeCompare(b.relativePath); })) {
        html += '<tr>';
        html += '<td><code class="file-link" data-file="' + escAttr(ins.relativePath) + '">' + escHtml(ins.relativePath) + '</code></td>';
        html += '<td>' + ins.providers.map(providerBadge).join(' ') + '</td>';
        html += '<td>' + (ins.scope === 'scoped' ? '<span class="badge badge-scoped">Scoped</span>' : '<span class="badge badge-repowide">Repo-wide</span>') + '</td>';
        html += '<td class="mono-cell">' + (ins.appliesTo ? escHtml(ins.appliesTo) : '-') + '</td>';
        html += '<td>' + qualityBadge(ins.quality) + '</td>';
        html += '<td class="num">' + ins.wordCount + '</td>';
        html += '<td class="dim-cell">' + new Date(ins.lastModified).toLocaleDateString() + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
    }
    html += '</div>';

    // Skills section
    html += '<div class="section">';
    html += '<div class="section-header"><span class="section-title">Skills & Slash Commands</span></div>';
    if (report.skills.length === 0) {
      html += emptyState('No .claude/skills or .claude/commands found.');
    } else {
      html += '<table class="data-table"><thead><tr><th>Name</th><th>Description</th><th>Source</th><th>File</th></tr></thead><tbody>';
      for (const s of report.skills) {
        html += '<tr>';
        html += '<td><code>' + escHtml(s.name) + '</code></td>';
        html += '<td class="desc-cell">' + escHtml(s.description || '-') + '</td>';
        html += '<td>' + (s.source === 'claude-skill' ? '<span class="badge badge-repowide">Skill</span>' : '<span class="badge badge-scoped">Command</span>') + '</td>';
        html += '<td><code class="file-link" data-file="' + escAttr(s.relativePath) + '">' + escHtml(s.relativePath) + '</code></td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
    }
    html += '</div>';

    // Agents section
    html += '<div class="section">';
    html += '<div class="section-header"><span class="section-title">Custom Agents</span></div>';
    if (report.agents.length === 0) {
      html += emptyState('No .claude/agents or .github/agents found.');
    } else {
      html += '<table class="data-table"><thead><tr><th>Name</th><th>Description</th><th>Tools</th><th>File</th></tr></thead><tbody>';
      for (const a of report.agents) {
        html += '<tr>';
        html += '<td><code>' + escHtml(a.name) + '</code></td>';
        html += '<td class="desc-cell">' + escHtml(a.description || '-') + '</td>';
        html += '<td class="mono-cell">' + (a.tools && a.tools.length ? a.tools.map(escHtml).join(', ') : '-') + '</td>';
        html += '<td><code class="file-link" data-file="' + escAttr(a.relativePath) + '">' + escHtml(a.relativePath) + '</code></td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
    }
    html += '</div>';

    // MCP section
    html += '<div class="section">';
    html += '<div class="section-header"><span class="section-title">MCP Servers</span></div>';
    if (report.mcpServers.length === 0) {
      html += emptyState('No MCP servers configured (.mcp.json, .vscode/mcp.json, .claude/settings*.json).');
    } else {
      html += '<table class="data-table"><thead><tr><th>Name</th><th>Command / URL</th><th>Env Vars</th><th>Scope</th><th>Source</th></tr></thead><tbody>';
      for (const m of report.mcpServers) {
        const target = m.command
          ? m.command + (m.args && m.args.length ? ' ' + m.args.join(' ') : '')
          : (m.url || '-');
        html += '<tr>';
        html += '<td><code>' + escHtml(m.name) + '</code></td>';
        html += '<td class="mono-cell">' + escHtml(target) + '</td>';
        html += '<td class="mono-cell">' + (m.envKeys.length ? m.envKeys.join(', ') : '-') + '</td>';
        html += '<td>' + (m.scope === 'local' ? '<span class="badge badge-scoped">Local</span>' : '<span class="badge badge-repowide">Project</span>') + '</td>';
        html += '<td><code class="file-link" data-file="' + escAttr(m.sourceFile) + '">' + escHtml(m.sourceFile) + '</code></td>';
        html += '</tr>';
      }
      html += '</tbody></table>';
    }
    html += '</div>';

    document.getElementById('content').innerHTML = html;

    document.querySelectorAll('[data-file]').forEach(function(el) {
      el.addEventListener('click', function() { openFile(el.getAttribute('data-file')); });
    });
  }

  function providerBadge(id) {
    const labels = ${JSON.stringify({
      claudeCode: 'Claude Code', copilot: 'Copilot', cursor: 'Cursor', windsurf: 'Windsurf',
      cline: 'Cline', codex: 'Codex', antigravity: 'Antigravity', agentsMd: 'AGENTS.md',
    })};
    return '<span class="prov-chip">' + (PROVIDER_ICONS[id] || '') + escHtml(labels[id] || id) + '</span>';
  }

  function qualityBadge(q) {
    const colors = { stub: 'var(--stage-1)', basic: 'var(--stage-2)', good: 'var(--stage-3)', rich: 'var(--stage-4)' };
    return '<span class="quality-badge" style="color:' + (colors[q] || 'var(--text-secondary)') + '">' + escHtml(q) + '</span>';
  }

  function statCard(label, value) {
    return '<div class="stat-card"><div class="stat-value">' + value + '</div><div class="stat-label">' + label + '</div></div>';
  }

  function emptyState(msg) {
    return '<div class="empty-state">' + escHtml(msg) + '</div>';
  }

  function showError(msg) {
    document.getElementById('content').innerHTML = '<div class="error-banner">⚠ ' + escHtml(msg) + '</div>';
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function escAttr(s) {
    return String(s).replace(/"/g,'&quot;');
  }
})();
</script>
</body>
</html>`;
  }
}

const BASE_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  ${designTokensCss()}
  html, body { height: 100%; background: var(--bg-base); color: var(--text-primary); font-family: var(--font-primary); font-size: 13px; }
  body { display: flex; flex-direction: column; overflow-x: hidden; }

  .toolbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 24px; border-bottom: 1px solid var(--border);
    background: var(--bg-base); gap: 8px; flex-wrap: wrap;
  }
  .toolbar-left, .toolbar-right { display: flex; align-items: center; gap: 8px; }
  .toolbar-label { font-size: 9px; color: var(--text-secondary); letter-spacing: 1.5px; font-weight: 700; text-transform: uppercase; white-space: nowrap; }
  .btn {
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--bg-surface); border: 1px solid var(--border); border-radius: 7px;
    padding: 5px 12px; color: var(--text-secondary); cursor: pointer;
    font-size: 12px; font-weight: 500; font-family: var(--font-primary);
    height: 28px; white-space: nowrap; transition: all 0.15s ease;
  }
  .btn:hover:not(:disabled) { border-color: rgba(255,255,255,0.15); color: var(--text-primary); background: var(--bg-surface-high); }

  .ns-content { padding: 24px 28px; flex: 1; overflow-y: auto; }

  .loading-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 80px 0; }
  .spinner { width: 28px; height: 28px; border: 2px solid rgba(0,122,255,0.15); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .stat-value { font-size: 22px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .stat-label { font-size: 11px; color: var(--text-secondary); margin-top: 3px; text-transform: uppercase; letter-spacing: 0.8px; }

  .section { margin-bottom: 28px; }
  .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .section-title { font-size: 12px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 1.2px; }

  .provider-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
  .provider-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; opacity: 0.55; }
  .provider-card.detected { opacity: 1; border-color: rgba(57,255,20,0.25); }
  .provider-card-top { display: flex; align-items: center; gap: 8px; }
  .provider-icon { display: inline-flex; color: var(--text-primary); flex-shrink: 0; }
  .provider-icon-fallback { font-size: 10px; font-weight: 700; background: var(--bg-surface-high); border-radius: 4px; padding: 2px 4px; }
  .provider-name { font-size: 13px; font-weight: 600; flex: 1; }
  .provider-status { font-size: 10.5px; color: var(--text-secondary); white-space: nowrap; }
  .provider-card.detected .provider-status { color: var(--stage-4); }
  .provider-signals { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px; }
  .sig-chip { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-secondary); background: var(--bg-surface-high); border-radius: 4px; padding: 2px 6px; cursor: pointer; }
  .sig-chip:hover { color: var(--text-primary); }

  .data-table { width: 100%; border-collapse: collapse; font-size: 12px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
  .data-table th { text-align: left; padding: 8px 12px; font-size: 10px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.8px; border-bottom: 1px solid var(--border); white-space: nowrap; background: var(--bg-surface-high); }
  .data-table td { padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: top; }
  .data-table tr:last-child td { border-bottom: none; }
  .data-table tr:hover td { background: rgba(255,255,255,0.025); }
  .file-link { font-family: var(--font-mono); font-size: 11.5px; color: #60a5fa; cursor: pointer; }
  .file-link:hover { text-decoration: underline; }
  .mono-cell { font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); max-width: 280px; }
  .desc-cell { max-width: 320px; color: var(--text-primary); }
  .dim-cell { color: var(--text-secondary); white-space: nowrap; }
  .num { color: var(--text-secondary); text-align: right; }

  .prov-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; background: var(--bg-surface-high); border-radius: 4px; padding: 2px 6px; margin: 1px; white-space: nowrap; }
  .badge { display: inline-block; font-size: 10px; font-weight: 700; border-radius: 4px; padding: 2px 7px; white-space: nowrap; }
  .badge-scoped { background: rgba(255,170,0,0.12); color: #fbbf24; }
  .badge-repowide { background: rgba(96,165,250,0.12); color: #60a5fa; }
  .quality-badge { font-size: 11px; font-weight: 700; text-transform: capitalize; }

  .empty-state { padding: 20px; color: var(--text-secondary); font-size: 12.5px; background: var(--bg-surface); border: 1px dashed var(--border); border-radius: 10px; text-align: center; }
  .error-banner { background: rgba(255,60,60,0.1); border: 1px solid rgba(255,60,60,0.25); border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; color: #fc8181; font-size: 12.5px; }
`;
