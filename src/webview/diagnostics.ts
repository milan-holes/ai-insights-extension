/**
 * Diagnostics report generator.
 */
import * as vscode from 'vscode';
import * as os from 'os';
import { DiagnosticReport, ProviderId } from '../types';
import { BaseProvider } from '../providers/base';
import { CacheManager } from '../core/cacheManager';
import { designTokensCss } from './designSystem';

export class DiagnosticsProvider {
  static async generateReport(
    providers: BaseProvider[],
    cacheManager: CacheManager,
    totalSessions: number,
    totalTokens: number,
  ): Promise<DiagnosticReport> {
    const providerReports = [];
    for (const p of providers) {
      const config = vscode.workspace.getConfiguration('aiInsights');
      const enabled = config.get<boolean>(`providers.${p.id}.enabled`, true);
      let sessionFilesFound = 0;
      try { sessionFilesFound = (await p.discoverSessionFiles()).length; } catch { /* */ }
      providerReports.push({
        id: p.id as ProviderId, enabled, sessionFilesFound,
        sessionDirs: p.getSessionDirectories(),
      });
    }
    return {
      extensionVersion: '0.1.0',
      vscodeVersion: vscode.version,
      platform: `${os.platform()} ${os.arch()} ${os.release()}`,
      nodeVersion: process.version,
      providers: providerReports,
      cacheStats: cacheManager.getStats(),
      aggregatedStats: { totalSessions, totalTokens, dateRange: 'last 30 days' },
      timestamp: new Date().toISOString(),
    };
  }

  static createPanel(report: DiagnosticReport): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      'aiInsights.diagnostics', 'AI Insights Diagnostics', vscode.ViewColumn.One,
      { enableScripts: true }
    );
    panel.webview.html = DiagnosticsProvider.getHtml(report);
    return panel;
  }

  static getHtml(r: DiagnosticReport): string {
    const providerRows = r.providers.map(p => `<tr>
      <td class="data-text">${p.id}</td><td>${p.enabled ? '✅' : '❌'}</td>
      <td class="data-text">${p.sessionFilesFound}</td><td class="data-text">${p.sessionDirs.join('<br>')}</td>
    </tr>`).join('');

    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Insights Diagnostics</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@500;600&display=swap');
  
  ${designTokensCss()}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--font-primary); background: var(--bg-base); color: var(--text-primary); padding: 32px; line-height: 1.6; }
  .data-text { font-family: var(--font-data); }
  h1 { font-size: 2em; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 32px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
  h2 { font-size: 1.2em; font-weight: 600; margin: 32px 0 16px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th { background: var(--bg-surface-high); padding: 12px 16px; text-align: left; font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid var(--border); font-weight: 500; color: var(--text-secondary); }
  td { padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 0.9em; }
  tr:hover td { background: rgba(255, 255, 255, 0.02); }
  .info { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .info div { background: var(--bg-surface); padding: 20px; border-radius: 4px; border: 1px solid var(--border); }
  .label { color: var(--text-secondary); font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; display: block; margin-bottom: 8px; }
  pre { background: var(--bg-surface); padding: 24px; border-radius: 4px; border: 1px solid var(--border); overflow-x: auto; font-size: 0.85em; font-family: 'JetBrains Mono', monospace; color: var(--text-secondary); }
  .btn { background: transparent; border: 1px solid var(--border); color: var(--text-primary); padding: 8px 16px; border-radius: 4px; cursor: pointer; transition: all 0.2s; font-weight: 500; font-size: 0.85em; }
  .btn-primary { background: var(--primary); color: white; border: none; box-shadow: 0 0 15px var(--primary-glow); }
  .btn:hover { background: rgba(255, 255, 255, 0.05); }
  .btn-primary:hover { background: #005bc1; }
</style></head><body>
<h1>🔍 Diagnostic Report</h1>
<div class="info">
  <div><span class="label">Extension</span><span class="data-text">AI Insights v${r.extensionVersion}</span></div>
  <div><span class="label">VS Code</span><span class="data-text">${r.vscodeVersion}</span></div>
  <div><span class="label">Platform</span><span class="data-text">${r.platform}</span></div>
  <div><span class="label">Node</span><span class="data-text">${r.nodeVersion}</span></div>
</div>
<h2>📦 Providers</h2>
<table><thead><tr><th>Provider</th><th>Enabled</th><th>Files Found</th><th>Directories</th></tr></thead>
<tbody>${providerRows}</tbody></table>
<h2>📊 Aggregated Stats</h2>
<div class="info">
  <div><span class="label">Total Sessions</span><span class="data-text">${r.aggregatedStats.totalSessions}</span></div>
  <div><span class="label">Total Tokens</span><span class="data-text">${r.aggregatedStats.totalTokens.toLocaleString()}</span></div>
  <div><span class="label">Cache Entries</span><span class="data-text">${r.cacheStats.entries}</span></div>
  <div><span class="label">Generated</span><span class="data-text">${r.timestamp}</span></div>
</div>
<h2>📋 Full Report (JSON)</h2>
<div style="margin-bottom: 16px;">
  <button class="btn btn-primary" onclick="navigator.clipboard.writeText(document.getElementById('json').textContent)">📋 Copy to Clipboard</button>
</div>
<pre id="json">${JSON.stringify(r, null, 2)}</pre>
</body></html>`;
  }
}
