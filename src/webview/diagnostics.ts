/**
 * Settings / diagnostics report generator.
 */
import * as vscode from 'vscode';
import * as os from 'os';
import { DiagnosticReport, ProviderId } from '../types';
import { BaseProvider } from '../providers/base';
import { CacheManager } from '../core/cacheManager';
import { designTokensCss } from './designSystem';
import { navCss, navTopbarHtml, navPagebarHtml, navJs, NAV_COMMANDS } from './navShared';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface ConfigPropertySchema {
  type?: string;
  default?: unknown;
  description?: string;
  markdownDescription?: string;
  enum?: string[];
  enumDescriptions?: string[];
}

export class DiagnosticsProvider {
  static readonly viewType = 'aiInsights.diagnostics';
  private static currentPanel: vscode.WebviewPanel | undefined;

  static buildSettingsList(context: vscode.ExtensionContext): DiagnosticReport['settings'] {
    const properties = (context.extension.packageJSON?.contributes?.configuration?.properties ?? {}) as Record<string, ConfigPropertySchema>;
    const config = vscode.workspace.getConfiguration();
    return Object.entries(properties).map(([key, schema]) => ({
      key,
      type: schema.type ?? 'string',
      value: config.get(key, schema.default),
      default: schema.default,
      description: schema.description ?? schema.markdownDescription ?? '',
      enum: schema.enum,
      enumDescriptions: schema.enumDescriptions,
    }));
  }

  static async generateReport(
    context: vscode.ExtensionContext,
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
      extensionVersion: context.extension.packageJSON?.version ?? '0.0.0',
      vscodeVersion: vscode.version,
      platform: `${os.platform()} ${os.arch()} ${os.release()}`,
      nodeVersion: process.version,
      providers: providerReports,
      cacheStats: cacheManager.getStats(),
      aggregatedStats: { totalSessions, totalTokens, dateRange: 'last 30 days' },
      settings: DiagnosticsProvider.buildSettingsList(context),
      timestamp: new Date().toISOString(),
    };
  }

  static createPanel(context: vscode.ExtensionContext, report: DiagnosticReport, refreshing = false): vscode.WebviewPanel {
    const logoPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'logo.png');

    if (DiagnosticsProvider.currentPanel) {
      const logoUri = DiagnosticsProvider.currentPanel.webview.asWebviewUri(logoPath).toString();
      DiagnosticsProvider.currentPanel.webview.html = DiagnosticsProvider.getHtml(report, refreshing, logoUri);
      DiagnosticsProvider.currentPanel.reveal(vscode.ViewColumn.One);
      return DiagnosticsProvider.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      DiagnosticsProvider.viewType, 'AI Insights - Settings', vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')] }
    );
    const logoUri = panel.webview.asWebviewUri(logoPath).toString();
    panel.webview.html = DiagnosticsProvider.getHtml(report, refreshing, logoUri);

    panel.webview.onDidReceiveMessage(async msg => {
      const cmd = NAV_COMMANDS[msg.command];
      if (cmd) { vscode.commands.executeCommand(cmd); return; }
      if (msg.command === 'refresh') {
        vscode.commands.executeCommand('aiInsights.refresh').then(() => {
          vscode.commands.executeCommand('aiInsights.showDiagnostics');
        });
        return;
      }
      if (msg.command === 'updateSetting') {
        const config = vscode.workspace.getConfiguration();
        await config.update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
        vscode.commands.executeCommand('aiInsights.showDiagnostics');
      }
    }, undefined, context.subscriptions);

    DiagnosticsProvider.currentPanel = panel;
    panel.onDidDispose(() => {
      DiagnosticsProvider.currentPanel = undefined;
    }, null, context.subscriptions);

    return panel;
  }

  static renderSettingControl(s: DiagnosticReport['settings'][number]): string {
    const key = escapeHtml(s.key);
    if (s.type === 'boolean') {
      return `<input type="checkbox" class="setting-input" data-key="${key}" data-type="boolean" ${s.value ? 'checked' : ''}>`;
    }
    if (s.enum && s.enum.length) {
      const opts = s.enum.map(v => `<option value="${escapeHtml(v)}" ${v === s.value ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
      return `<select class="setting-input" data-key="${key}" data-type="string">${opts}</select>`;
    }
    if (s.type === 'number') {
      return `<input type="number" step="any" class="setting-input" data-key="${key}" data-type="number" value="${escapeHtml(String(s.value ?? 0))}">`;
    }
    if (s.type === 'array' || s.type === 'object') {
      return `<input type="text" class="setting-input" data-key="${key}" data-type="json" value="${escapeHtml(JSON.stringify(s.value))}">`;
    }
    return `<input type="text" class="setting-input" data-key="${key}" data-type="string" value="${escapeHtml(String(s.value ?? ''))}">`;
  }

  static getHtml(r: DiagnosticReport, refreshing = false, logoUri = ''): string {
    const providerRows = r.providers.map(p => `<tr>
      <td class="data-text">${p.id}</td><td>${p.enabled ? '✅' : '❌'}</td>
      <td class="data-text">${p.sessionFilesFound}</td><td class="data-text">${p.sessionDirs.join('<br>')}</td>
    </tr>`).join('');

    const settingsRows = r.settings.map(s => {
      const modified = JSON.stringify(s.value) !== JSON.stringify(s.default);
      return `<tr>
      <td class="data-text">${escapeHtml(s.key)}${modified ? ' <span class="badge-modified">modified</span>' : ''}</td>
      <td>${DiagnosticsProvider.renderSettingControl(s)}</td>
      <td class="settings-desc">${escapeHtml(s.description)}</td>
    </tr>`;
    }).join('');

    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Insights - Settings</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@500;600&display=swap');

  ${designTokensCss()}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--font-primary); background: var(--bg-base); color: var(--text-primary); padding: 0; line-height: 1.6; }
  .data-text { font-family: var(--font-data); }
  ${navCss()}
  .ns-content { padding: 24px 32px 48px; }
  h2 { font-size: 1.2em; font-weight: 600; margin: 32px 0 16px; }
  h2:first-child { margin-top: 0; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th { background: var(--bg-surface-high); padding: 12px 16px; text-align: left; font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid var(--border); font-weight: 500; color: var(--text-secondary); }
  td { padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 0.9em; vertical-align: middle; }
  tr:hover td { background: rgba(255, 255, 255, 0.02); }
  .info { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .info div { background: var(--bg-surface); padding: 20px; border-radius: 4px; border: 1px solid var(--border); }
  .label { color: var(--text-secondary); font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 500; display: block; margin-bottom: 8px; }
  .subtitle { font-size: 0.85em; color: var(--text-secondary); margin-bottom: 16px; }
  .settings-desc { color: var(--text-secondary); font-size: 0.82em; }
  .badge-modified { display: inline-block; background: rgba(0,122,255,0.15); color: #6db3ff; font-size: 0.7em; padding: 2px 6px; border-radius: 3px; margin-left: 6px; font-weight: 500; vertical-align: middle; }
  .setting-input { background: var(--bg-surface-high); border: 1px solid var(--border); color: var(--text-primary); border-radius: 4px; padding: 6px 10px; font-size: 0.85em; font-family: var(--font-data); min-width: 180px; }
  .setting-input:focus { outline: none; border-color: var(--primary); }
  input.setting-input[type="checkbox"] { min-width: 0; width: 16px; height: 16px; cursor: pointer; }
  select.setting-input { cursor: pointer; }
  .loading-banner { background: rgba(0,122,255,0.08); border-bottom: 1px solid rgba(0,122,255,0.2); padding: 8px 32px; font-size: 0.82em; color: #6db3ff; }
</style></head><body>
  ${navTopbarHtml(logoUri, true, refreshing)}
  ${refreshing ? '<div class="loading-banner">Refreshing…</div>' : ''}
  ${navPagebarHtml('diagnostics', 'Settings')}
<div class="ns-content">
  <div class="info">
    <div><span class="label">Extension</span><span class="data-text">AI Insights v${escapeHtml(r.extensionVersion)}</span></div>
    <div><span class="label">VS Code</span><span class="data-text">${escapeHtml(r.vscodeVersion)}</span></div>
    <div><span class="label">Platform</span><span class="data-text">${escapeHtml(r.platform)}</span></div>
    <div><span class="label">Node</span><span class="data-text">${escapeHtml(r.nodeVersion)}</span></div>
  </div>
  <h2>⚙️ All Extension Settings</h2>
  <p class="subtitle">Every AI Insights setting with its current value. Changes are saved immediately to your user settings.</p>
  <table><thead><tr><th>Setting</th><th>Value</th><th>Description</th></tr></thead>
  <tbody>${settingsRows}</tbody></table>
  <h2>📊 Aggregated Stats</h2>
  <div class="info">
    <div><span class="label">Total Sessions</span><span class="data-text">${r.aggregatedStats.totalSessions}</span></div>
    <div><span class="label">Total Tokens</span><span class="data-text">${r.aggregatedStats.totalTokens.toLocaleString()}</span></div>
    <div><span class="label">Cache Entries</span><span class="data-text">${r.cacheStats.entries}</span></div>
    <div><span class="label">Generated</span><span class="data-text">${escapeHtml(r.timestamp)}</span></div>
  </div>
  <h2>📦 Providers</h2>
  <table><thead><tr><th>Provider</th><th>Enabled</th><th>Files Found</th><th>Directories</th></tr></thead>
  <tbody>${providerRows}</tbody></table>
</div><!-- /ns-content -->
<script>
  window.vscode = acquireVsCodeApi();
  ${navJs()}
  (function() {
    var rb = document.getElementById('btnRefresh');
    if (rb) {
      rb.addEventListener('click', function() {
        rb.classList.add('is-loading'); rb.textContent = '⟳ Refreshing…';
        window.vscode.postMessage({ command: 'refresh' });
        setTimeout(function() { rb.classList.remove('is-loading'); rb.textContent = '↺ Refresh'; }, 5000);
      });
    }
  })();
  (function() {
    document.querySelectorAll('.setting-input').forEach(function(el) {
      el.addEventListener('change', function() {
        var key = el.getAttribute('data-key');
        var type = el.getAttribute('data-type');
        var value;
        if (type === 'boolean') { value = el.checked; }
        else if (type === 'number') {
          value = parseFloat(el.value);
          if (isNaN(value)) { return; }
        } else if (type === 'json') {
          try { value = JSON.parse(el.value); } catch (e) { el.style.borderColor = '#f38ba8'; return; }
          el.style.borderColor = '';
        } else { value = el.value; }
        window.vscode.postMessage({ command: 'updateSetting', key: key, value: value });
      });
    });
  })();
</script>
</body></html>`;
  }
}
