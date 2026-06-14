import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { analyzeRepo, ModuleInfo } from '../core/repoAnalyzer';
import { navCss, navTopbarHtml, navPagebarHtml, navJs, NAV_COMMANDS } from './navShared';
import { designTokensCss } from './designSystem';

const ANTHROPIC_KEY_SECRET = 'aiInsights.benchmarkApiKey';

export class RepoAnalysisViewProvider {
  static readonly viewType = 'aiInsights.repoAnalysis';
  private static currentPanel: vscode.WebviewPanel | undefined;

  static async createPanel(context: vscode.ExtensionContext): Promise<void> {
    if (RepoAnalysisViewProvider.currentPanel) {
      RepoAnalysisViewProvider.currentPanel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      RepoAnalysisViewProvider.viewType,
      'Repo Analysis',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')],
      },
    );
    RepoAnalysisViewProvider.currentPanel = panel;
    panel.onDidDispose(() => { RepoAnalysisViewProvider.currentPanel = undefined; });

    const nonce = crypto.randomBytes(16).toString('hex');
    const cspSource = panel.webview.cspSource;
    const logoUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'assets', 'logo.png'),
    ).toString();

    const hasAnthropicKey = !!(await context.secrets.get(ANTHROPIC_KEY_SECRET));
    panel.webview.html = RepoAnalysisViewProvider.buildHTML(nonce, cspSource, logoUri, hasAnthropicKey);

    panel.webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
      const p = RepoAnalysisViewProvider.currentPanel;
      if (!p) { return; }

      if (msg.command && NAV_COMMANDS[msg.command as string]) {
        vscode.commands.executeCommand(NAV_COMMANDS[msg.command as string]);
        return;
      }

      if (msg.command === 'analyze') {
        await RepoAnalysisViewProvider.handleAnalyze(p);
        return;
      }

      if (msg.command === 'getModels') {
        await RepoAnalysisViewProvider.handleGetModels(p, context);
        return;
      }

      if (msg.command === 'enrich') {
        await RepoAnalysisViewProvider.handleEnrich(
          p, context,
          String(msg.provider ?? ''),
          msg.modules as ModuleInfo[],
        );
        return;
      }

      if (msg.command === 'saveAnthropicKey') {
        await context.secrets.store(ANTHROPIC_KEY_SECRET, String(msg.key ?? ''));
        p.webview.postMessage({ type: 'apiKeySaved' });
        return;
      }

      if (msg.command === 'export') {
        await RepoAnalysisViewProvider.handleExport(msg.markdown as string);
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
    // Yield one event-loop turn so the 'analyzing' message is delivered before the
    // synchronous analysis blocks the extension host thread.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    try {
      const graph = await analyzeRepo(rootPath);
      const { handoffMarkdown: _unused, ...graphPayload } = graph;
      panel.webview.postMessage({ type: 'analysisResult', graph: graphPayload });
    } catch (err) {
      panel.webview.postMessage({ type: 'error', message: String(err) });
    }
  }

  private static async handleGetModels(panel: vscode.WebviewPanel, context: vscode.ExtensionContext): Promise<void> {
    const vscodeLmModels: { id: string; name: string; vendor: string; family: string }[] = [];
    try {
      const models = await vscode.lm.selectChatModels();
      for (const m of models) {
        vscodeLmModels.push({ id: m.id, name: m.name, vendor: m.vendor, family: m.family });
      }
    } catch {
      // vscode.lm not available or no models
    }
    const hasAnthropicKey = !!(await context.secrets.get(ANTHROPIC_KEY_SECRET));
    panel.webview.postMessage({ type: 'models', vscodeLmModels, hasAnthropicKey });
  }

  private static async handleEnrich(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    provider: string,
    modules: ModuleInfo[],
  ): Promise<void> {
    const descriptions: Record<string, string> = {};

    try {
      if (provider === 'claude') {
        const apiKey = await context.secrets.get(ANTHROPIC_KEY_SECRET);
        if (!apiKey) {
          panel.webview.postMessage({ type: 'error', message: 'No Anthropic API key stored. Enter it in the panel.' });
          return;
        }
        Object.assign(descriptions, await enrichWithClaude(modules, apiKey));
      } else {
        // vscode.lm model — provider is the model id
        const [model] = await vscode.lm.selectChatModels(
          provider === 'vscode-lm' ? {} : { id: provider },
        );
        if (!model) {
          panel.webview.postMessage({ type: 'error', message: 'Selected language model is not available.' });
          return;
        }
        Object.assign(descriptions, await enrichWithVscodeLm(modules, model));
      }

      panel.webview.postMessage({ type: 'enrichmentResult', descriptions });
    } catch (err) {
      panel.webview.postMessage({ type: 'error', message: `Enrichment failed: ${err}` });
    }
  }

  private static async handleExport(markdown: string): Promise<void> {
    const rootPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!rootPath) { return; }
    const outPath = path.join(rootPath, 'agent-handoff.md');
    fs.writeFileSync(outPath, markdown, 'utf8');
    const doc = await vscode.workspace.openTextDocument(outPath);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
    vscode.window.showInformationMessage(`Agent handoff exported to ${outPath}`);
  }

  private static buildHTML(nonce: string, cspSource: string, logoUri: string, _hasAnthropicKey: boolean): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;
    style-src 'unsafe-inline';
    img-src ${cspSource} data:;
    font-src ${cspSource};
    connect-src https://api.anthropic.com;
  ">
  <title>Repo Analysis</title>
  <style>
    ${BASE_CSS}
    ${navCss()}
  </style>
</head>
<body>
${navTopbarHtml(logoUri, false)}
${navPagebarHtml('repoAnalysis', 'Repo Analysis')}

<div class="toolbar">
  <div class="toolbar-left">
    <span class="toolbar-label">AI ENRICHMENT</span>
    <select id="providerSelect" class="sel">
      <option value="">Static only</option>
    </select>
    <button id="btnEnrich" class="btn btn-primary" disabled>Enrich with AI</button>
  </div>
  <div class="toolbar-right">
    <button id="btnRefreshAnalysis" class="btn">↺ Re-analyze</button>
    <button id="btnExport" class="btn btn-export" disabled>⬇ Export handoff.md</button>
  </div>
</div>

<div id="apiKeyRow" class="api-key-row" style="display:none">
  <span class="toolbar-label">ANTHROPIC KEY</span>
  <input id="apiKeyInput" type="password" class="key-input" placeholder="sk-ant-…">
  <button id="btnSaveKey" class="btn">Save Key</button>
</div>

<div id="content" class="ns-content">
  <div class="loading-state">
    <div class="spinner"></div>
    <p>Analyzing repository…</p>
  </div>
</div>

<script async nonce="${nonce}" src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();
  window.vscode = vscode;

  let currentGraph = null;
  let mermaidReady = false;
  let enrichedModel = null;

  // Try to init mermaid; it loads async from CDN
  function tryInitMermaid() {
    if (typeof mermaid !== 'undefined') {
      mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
      mermaidReady = true;
      return true;
    }
    return false;
  }
  // Poll for mermaid load
  let mermaidPollId = setInterval(function() {
    if (tryInitMermaid()) { clearInterval(mermaidPollId); }
  }, 100);

  ${navJs()}

  // Webview is ready — request models list and kick off the analysis.
  // (Initiated from here, not the extension, so no message is sent before
  // this listener exists; VS Code drops messages posted to a loading webview.)
  vscode.postMessage({ command: 'getModels' });
  vscode.postMessage({ command: 'analyze' });

  document.getElementById('btnRefreshAnalysis').addEventListener('click', function() {
    document.getElementById('content').innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Analyzing repository…</p></div>';
    document.getElementById('btnExport').disabled = true;
    document.getElementById('btnEnrich').disabled = true;
    currentGraph = null;
    vscode.postMessage({ command: 'analyze' });
  });

  document.getElementById('btnEnrich').addEventListener('click', function() {
    if (!currentGraph) { return; }
    const provider = document.getElementById('providerSelect').value;
    if (!provider) { return; }
    this.disabled = true;
    this.textContent = '⟳ Enriching…';
    vscode.postMessage({ command: 'enrich', provider: provider, modules: currentGraph.modules });
  });

  document.getElementById('btnExport').addEventListener('click', function() {
    if (!currentGraph) { return; }
    const md = buildHandoffMarkdown(currentGraph);
    vscode.postMessage({ command: 'export', markdown: md });
  });

  document.getElementById('providerSelect').addEventListener('change', function() {
    const val = this.value;
    document.getElementById('btnEnrich').disabled = !val || !currentGraph;
    document.getElementById('apiKeyRow').style.display = val === 'claude' ? 'flex' : 'none';
  });

  document.getElementById('btnSaveKey').addEventListener('click', function() {
    const key = document.getElementById('apiKeyInput').value.trim();
    if (key) { vscode.postMessage({ command: 'saveAnthropicKey', key }); }
  });

  window.addEventListener('message', function(event) {
    const msg = event.data;

    if (msg.type === 'analyzing') {
      document.getElementById('content').innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Analyzing repository…</p></div>';
    }

    if (msg.type === 'analysisResult') {
      currentGraph = msg.graph;
      renderAnalysis(msg.graph);
      document.getElementById('btnExport').disabled = false;
      const provider = document.getElementById('providerSelect').value;
      document.getElementById('btnEnrich').disabled = !provider;
    }

    if (msg.type === 'models') {
      const sel = document.getElementById('providerSelect');
      // Clear & rebuild
      sel.innerHTML = '<option value="">Static only</option>';
      if (msg.vscodeLmModels && msg.vscodeLmModels.length > 0) {
        const grp = document.createElement('optgroup');
        grp.label = 'VS Code Language Models';
        for (const m of msg.vscodeLmModels) {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name + ' (' + m.vendor + ')';
          grp.appendChild(opt);
        }
        sel.appendChild(grp);
      }
      const grp2 = document.createElement('optgroup');
      grp2.label = 'Anthropic';
      const claudeOpt = document.createElement('option');
      claudeOpt.value = 'claude';
      claudeOpt.textContent = 'Claude (Anthropic API)' + (msg.hasAnthropicKey ? ' ✓' : ' — key required');
      grp2.appendChild(claudeOpt);
      sel.appendChild(grp2);
    }

    if (msg.type === 'enrichmentResult') {
      if (currentGraph) {
        for (const [p, desc] of Object.entries(msg.descriptions)) {
          const mod = currentGraph.modules.find(function(m) { return m.relativePath === p; });
          if (mod) { mod.description = desc; }
        }
        const sel = document.getElementById('providerSelect');
        const selectedVal = sel.value;
        const selectedText = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : selectedVal;
        enrichedModel = {
          name: selectedText.replace(/ ✓$/, '').replace(/ — key required$/, ''),
          provider: selectedVal === 'claude' ? 'Anthropic' : 'VS Code LM',
        };
        renderAnalysis(currentGraph);
        document.getElementById('btnEnrich').disabled = false;
        document.getElementById('btnEnrich').textContent = 'Enrich with AI';
      }
    }

    if (msg.type === 'apiKeySaved') {
      const opt = document.querySelector('option[value="claude"]');
      if (opt) { opt.textContent = 'Claude (Anthropic API) ✓'; }
    }

    if (msg.type === 'error') {
      showError(msg.message);
      document.getElementById('btnEnrich').disabled = false;
      document.getElementById('btnEnrich').textContent = 'Enrich with AI';
    }
  });

  function renderAnalysis(graph) {
    const folderMap = {};
    for (const m of graph.modules) {
      if (!folderMap[m.folder]) { folderMap[m.folder] = []; }
      folderMap[m.folder].push(m);
    }

    const totalFiles = graph.modules.length;
    const totalLoc = graph.modules.reduce(function(s, m) { return s + m.linesOfCode; }, 0);
    const folders = Object.keys(folderMap).sort();

    let html = '';

    // Summary cards
    html += '<div class="stats-row">';
    html += statCard('Files', totalFiles.toString());
    html += statCard('Lines', fmtNum(totalLoc));
    html += statCard('Folders', folders.length.toString());
    html += statCard('Generated', new Date(graph.generatedAt).toLocaleTimeString());
    html += '</div>';
    if (graph.truncated) {
      html += '<div class="warn-banner">⚠ Large project — showing first 800 source files. Skipped files are excluded from the graph.</div>';
    }

    // Graph section
    html += '<div class="section">';
    html += '<div class="section-header"><span class="section-title">Dependency Graph</span>';
    html += '<button class="btn btn-sm" id="btnCopyMermaid">Copy Mermaid</button></div>';
    html += '<div class="graph-wrap">';
    html += '<div class="mermaid" id="mermaidGraph">' + escHtml(graph.mermaidDiagram) + '</div>';
    html += '</div>';
    html += '<div id="mermaidFallback" style="display:none">';
    html += '<pre class="code-block">' + escHtml(graph.mermaidDiagram) + '</pre>';
    html += '<p class="hint">Mermaid CDN unavailable — copy the source above into any Mermaid renderer.</p>';
    html += '</div>';
    html += '</div>';

    // Module table per folder
    html += '<div class="section">';
    html += '<div class="section-header"><span class="section-title">Module Map</span></div>';

    for (const folder of folders) {
      const mods = folderMap[folder];
      html += '<div class="folder-group">';
      html += '<div class="folder-label">' + folder.charAt(0).toUpperCase() + folder.slice(1) + '</div>';
      html += '<table class="mod-table">';
      html += '<thead><tr><th>File</th><th>Lang</th><th>LOC</th><th>Exports</th><th>Imports</th><th>Description</th></tr></thead><tbody>';
      for (const m of mods) {
        const top5 = m.exports.slice(0, 5);
        const exStr = top5.join(', ') + (m.exports.length > 5 ? ' +' + (m.exports.length - 5) : '');
        const deps = m.resolvedImports.map(function(d) { return basename(d); }).join(', ');
        const desc = m.description ? '<span class="desc-text">' + escHtml(m.description) + '</span>' : '<span style="color:var(--text-secondary)">—</span>';
        html += '<tr>';
        html += '<td class="file-cell"><code>' + basename(m.relativePath) + '</code></td>';
        html += '<td class="lang-cell">' + langBadge(m.language) + '</td>';
        html += '<td class="num">' + m.linesOfCode + '</td>';
        html += '<td class="exports-cell" title="' + escAttr(m.exports.join(', ')) + '">' + (exStr || '—') + '</td>';
        html += '<td class="deps-cell">' + (deps || '—') + '</td>';
        html += '<td class="desc-cell">' + desc + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table></div>';
    }
    html += '</div>';

    document.getElementById('content').innerHTML = html;

    var copyBtn = document.getElementById('btnCopyMermaid');
    if (copyBtn) {
      copyBtn.addEventListener('click', function() {
        if (currentGraph) { navigator.clipboard.writeText(currentGraph.mermaidDiagram); }
      });
    }

    // Render mermaid after DOM update
    setTimeout(function() {
      if (typeof mermaid !== 'undefined') {
        mermaid.run({ nodes: [document.getElementById('mermaidGraph')] }).catch(function() {
          document.getElementById('mermaidGraph').style.display = 'none';
          document.getElementById('mermaidFallback').style.display = 'block';
        });
      } else {
        document.getElementById('mermaidGraph').style.display = 'none';
        document.getElementById('mermaidFallback').style.display = 'block';
      }
    }, 50);
  }

  function buildHandoffMarkdown(graph) {
    const byFolder = {};
    for (const m of graph.modules) {
      if (!byFolder[m.folder]) { byFolder[m.folder] = []; }
      byFolder[m.folder].push(m);
    }

    const lines = [
      '# Repository Agent Handoff',
      '',
      '> **Generated:** ' + new Date().toISOString(),
      '> **Root:** \`' + graph.rootPath + '\`',
      '> This document gives an AI agent full context to navigate and modify this codebase.',
    ];

    if (enrichedModel) {
      lines.push('> **AI Enrichment:** ' + enrichedModel.name + ' (' + enrichedModel.provider + ')');
    }

    lines.push('', '## Architecture Diagram', '', '\`\`\`mermaid', graph.mermaidDiagram, '\`\`\`', '', '## Module Map', '');

    const folders = Object.keys(byFolder).sort();
    for (const folder of folders) {
      const mods = byFolder[folder];
      lines.push('### ' + folder.charAt(0).toUpperCase() + folder.slice(1));
      lines.push('');
      lines.push('| File | Lang | LOC | Key Exports | Description |');
      lines.push('|------|------|-----|-------------|-------------|');
      for (const m of mods) {
        const top5 = m.exports.slice(0, 5);
        const exStr = top5.join(', ') + (m.exports.length > 5 ? ' +' + (m.exports.length - 5) : '');
        const desc = m.description ? m.description.replace(/\|/g, '\\|') : '—';
        const name = m.relativePath.split('/').pop();
        const lang = LANG_LABELS[m.language] || (m.language || '—');
        lines.push('| \`' + name + '\` | ' + lang + ' | ' + m.linesOfCode + ' | ' + (exStr || '—') + ' | ' + desc + ' |');
      }
      lines.push('');
    }

    const heavyDeps = graph.modules
      .filter(function(m) { return m.resolvedImports.length >= 3; })
      .sort(function(a, b) { return b.resolvedImports.length - a.resolvedImports.length; })
      .slice(0, 12);

    if (heavyDeps.length > 0) {
      lines.push('## Key Dependencies', '', '| Module | Imports From |', '|--------|-------------|');
      for (const m of heavyDeps) {
        const deps = m.resolvedImports.map(function(d) { return '\`' + d.split('/').pop().replace(/\.ts$/, '') + '\`'; }).join(', ');
        const name = m.relativePath.split('/').pop().replace(/\.ts$/, '');
        lines.push('| \`' + name + '\` | ' + deps + ' |');
      }
      lines.push('');
    }

    if (enrichedModel) {
      const enrichedCount = graph.modules.filter(function(m) { return m.description; }).length;
      lines.push('## AI Enrichment', '', '| Field | Value |', '|-------|-------|');
      lines.push('| Model | ' + enrichedModel.name + ' |');
      lines.push('| Provider | ' + enrichedModel.provider + ' |');
      lines.push('| Modules enriched | ' + enrichedCount + ' / ' + graph.modules.length + ' |');
      lines.push('');
    }

    return lines.join('\n');
  }

  function showError(msg) {
    const el = document.getElementById('content');
    el.innerHTML = '<div class="error-banner">⚠ ' + escHtml(msg) + '</div>';
  }

  function statCard(label, value) {
    return '<div class="stat-card"><div class="stat-value">' + value + '</div><div class="stat-label">' + label + '</div></div>';
  }

  function fmtNum(n) {
    if (n >= 1000) { return (n / 1000).toFixed(1) + 'K'; }
    return n.toString();
  }

  function basename(p) { return p.split('/').pop(); }

  const LANG_COLORS = {
    typescript: { bg: 'rgba(49,120,198,0.2)', color: '#60a5fa', text: 'TS' },
    javascript: { bg: 'rgba(240,219,79,0.12)', color: '#fbbf24', text: 'JS' },
    vue: { bg: 'rgba(65,184,131,0.15)', color: '#4ade80', text: 'Vue' },
    php: { bg: 'rgba(139,92,246,0.15)', color: '#a78bfa', text: 'PHP' },
    python: { bg: 'rgba(255,163,0,0.12)', color: '#fb923c', text: 'Py' },
    csharp: { bg: 'rgba(178,0,255,0.1)', color: '#c084fc', text: 'C#' },
    vbnet: { bg: 'rgba(0,100,255,0.1)', color: '#818cf8', text: 'VB' },
    fsharp: { bg: 'rgba(0,200,200,0.1)', color: '#67e8f9', text: 'F#' },
  };
  const LANG_LABELS = { typescript:'TS', javascript:'JS', vue:'Vue', php:'PHP', python:'Py', csharp:'C#', vbnet:'VB', fsharp:'F#' };

  function langBadge(lang) {
    const info = LANG_COLORS[lang] || { bg: 'rgba(255,255,255,0.05)', color: '#94a3b8', text: lang || '?' };
    return '<span class="lang-badge" style="background:' + info.bg + ';color:' + info.color + '">' + escHtml(info.text) + '</span>';
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

async function enrichWithVscodeLm(
  modules: ModuleInfo[],
  model: vscode.LanguageModelChat,
): Promise<Record<string, string>> {
  const descriptions: Record<string, string> = {};
  const list = modules
    .map(m => `${m.relativePath} | exports: ${m.exports.slice(0, 5).join(', ') || 'none'} | imports: ${m.resolvedImports.slice(0, 4).map(d => path.basename(d, '.ts')).join(', ') || 'none'}`)
    .join('\n');

  const prompt = `You are a code analyst. For each TypeScript module listed below, write one concise sentence (max 15 words) describing its responsibility. Reply in the exact format: <relative-path>: <description>\n\n${list}`;

  const cts = new vscode.CancellationTokenSource();
  const response = await model.sendRequest(
    [vscode.LanguageModelChatMessage.User(prompt)],
    {},
    cts.token,
  );

  let text = '';
  for await (const part of response.stream) {
    if (part instanceof vscode.LanguageModelTextPart) { text += part.value; }
  }

  for (const line of text.split('\n')) {
    const sep = line.indexOf(': ');
    if (sep > 0) {
      const key = line.slice(0, sep).trim();
      const desc = line.slice(sep + 2).trim();
      if (key && desc) { descriptions[key] = desc; }
    }
  }
  return descriptions;
}

async function enrichWithClaude(
  modules: ModuleInfo[],
  apiKey: string,
): Promise<Record<string, string>> {
  const descriptions: Record<string, string> = {};
  const list = modules
    .map(m => `${m.relativePath} | exports: ${m.exports.slice(0, 5).join(', ') || 'none'} | imports: ${m.resolvedImports.slice(0, 4).map(d => path.basename(d, '.ts')).join(', ') || 'none'}`)
    .join('\n');

  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `For each TypeScript module below, write one concise sentence (max 15 words) describing its responsibility. Reply in the exact format: <relative-path>: <description>\n\n${list}`,
    }],
  };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) { throw new Error(`Anthropic API error: ${res.status}`); }
  const data = await res.json() as { content: Array<{ type: string; text: string }> };
  const text = data.content?.[0]?.text ?? '';

  for (const line of text.split('\n')) {
    const sep = line.indexOf(': ');
    if (sep > 0) {
      const key = line.slice(0, sep).trim();
      const desc = line.slice(sep + 2).trim();
      if (key && desc) { descriptions[key] = desc; }
    }
  }
  return descriptions;
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
  .sel {
    background: var(--bg-surface); border: 1px solid var(--border); border-radius: 7px;
    color: var(--text-primary); padding: 4px 8px; font-size: 12px; font-family: var(--font-primary);
    cursor: pointer; height: 28px; min-width: 200px;
  }
  .sel:focus { outline: none; border-color: rgba(0,122,255,0.4); }
  .btn {
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--bg-surface); border: 1px solid var(--border); border-radius: 7px;
    padding: 5px 12px; color: var(--text-secondary); cursor: pointer;
    font-size: 12px; font-weight: 500; font-family: var(--font-primary);
    height: 28px; white-space: nowrap; transition: all 0.15s ease;
  }
  .btn:hover:not(:disabled) { border-color: rgba(255,255,255,0.15); color: var(--text-primary); background: var(--bg-surface-high); }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-primary { background: rgba(0,122,255,0.15); border-color: rgba(0,122,255,0.3); color: #60a5fa; }
  .btn-primary:hover:not(:disabled) { background: rgba(0,122,255,0.25); border-color: rgba(0,122,255,0.5); color: #93c5fd; }
  .btn-export { background: rgba(57,255,20,0.08); border-color: rgba(57,255,20,0.2); color: var(--stage-4); }
  .btn-export:hover:not(:disabled) { background: rgba(57,255,20,0.14); }
  .btn-sm { height: 22px; padding: 2px 8px; font-size: 11px; }

  .api-key-row {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 24px; border-bottom: 1px solid var(--border);
    background: rgba(255,193,7,0.04);
  }
  .key-input {
    background: var(--bg-surface); border: 1px solid var(--border); border-radius: 7px;
    color: var(--text-primary); padding: 4px 8px; font-size: 12px;
    font-family: var(--font-mono); height: 28px; flex: 1; max-width: 400px;
  }
  .key-input:focus { outline: none; border-color: rgba(0,122,255,0.4); }

  .ns-content { padding: 24px 28px; flex: 1; overflow-y: auto; }

  .loading-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 80px 0; }
  .spinner { width: 28px; height: 28px; border: 2px solid rgba(0,122,255,0.15); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .stat-value { font-size: 22px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .stat-label { font-size: 11px; color: var(--text-secondary); margin-top: 3px; text-transform: uppercase; letter-spacing: 0.8px; }
  .warn-banner { background: rgba(255,170,0,0.1); border: 1px solid rgba(255,170,0,0.3); border-radius: 8px; padding: 8px 12px; font-size: 12px; color: #ffaa00; margin-bottom: 16px; }

  .section { margin-bottom: 28px; }
  .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .section-title { font-size: 12px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 1.2px; }

  .graph-wrap { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; overflow: auto; min-height: 200px; }
  .mermaid { max-width: 100%; }
  .code-block { background: var(--bg-surface-high); border-radius: 6px; padding: 12px; font-family: var(--font-mono); font-size: 12px; white-space: pre; overflow-x: auto; color: var(--text-secondary); }
  .hint { font-size: 11px; color: var(--text-secondary); margin-top: 8px; }

  .folder-group { margin-bottom: 20px; }
  .folder-label { font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; padding-left: 2px; }

  .mod-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .mod-table th { text-align: left; padding: 7px 10px; font-size: 10px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
  .mod-table td { padding: 7px 10px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: top; }
  .mod-table tr:last-child td { border-bottom: none; }
  .mod-table tr:hover td { background: rgba(255,255,255,0.025); }
  .file-cell code { font-family: var(--font-mono); font-size: 11.5px; color: #60a5fa; }
  .lang-cell { width: 40px; }
  .lang-badge { display: inline-block; font-size: 9px; font-weight: 800; letter-spacing: 0.4px; border-radius: 3px; padding: 1px 5px; text-transform: uppercase; white-space: nowrap; }
  .num { color: var(--text-secondary); text-align: right; width: 48px; }
  .exports-cell { font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); max-width: 200px; }
  .deps-cell { font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); max-width: 180px; }
  .desc-cell { max-width: 280px; }
  .desc-text { color: var(--text-primary); font-size: 12px; }

  .error-banner { background: rgba(255,60,60,0.1); border: 1px solid rgba(255,60,60,0.25); border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; color: #fc8181; font-size: 12.5px; }
`;
