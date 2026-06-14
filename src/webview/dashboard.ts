/**
 * Dashboard webview provider - renders the main token usage dashboard.
 */
import * as vscode from 'vscode';
import { AggregatedMetrics, RepositoryHygieneReport, FileStatus, AcceptanceMetrics } from '../types';
import { ConnectedGitHubUser } from '../core/githubAuth';
import { UsageHealthScore } from '../core/usageHealthScore';
import { providerIcon } from './providerIcons';
import { navCss, navTopbarHtml, navPagebarHtml, navFilterbarHtml, navJs, NAV_COMMANDS } from './navShared';
import { designTokensCss } from './designSystem';

interface RoiConfig { hourlyRate: number; tokensPerHourSaved: number; }

const MODE_META: Record<string, { label: string; icon: string }> = {
  ask: { label: 'Ask Mode', icon: '💬' },
  edit: { label: 'Edit Mode', icon: '✏️' },
  agent: { label: 'Agent Mode', icon: '🤖' },
  plan: { label: 'Plan Mode', icon: '📋' },
  customAgent: { label: 'Custom Agent', icon: '⚡' },
  cli: { label: 'CLI', icon: '💻' },
};

function isMcpTool(name: string): boolean {
  return name.startsWith('mcp_') || name.startsWith('mcp__');
}

function parseMcpServer(toolName: string): string | null {
  if (toolName.startsWith('mcp__')) {
    const rest = toolName.slice(5);
    const idx = rest.indexOf('__');
    return idx > 0 ? rest.slice(0, idx) : rest;
  }
  if (toolName.startsWith('mcp_')) {
    const rest = toolName.slice(4);
    const idx = rest.indexOf('_');
    return idx > 0 ? rest.slice(0, idx) : rest;
  }
  return null;
}

function fileStatusIcon(s: FileStatus): string {
  if (!s.exists) { return `<span style="color:var(--stage-1);">✕</span>`; }
  if (!s.fresh) { return `<span style="color:#f9e2af;">⚠</span>`; }
  return `<span style="color:var(--stage-4);">✓</span>`;
}

function tip(text: string): string {
  return `<span title="${text}" style="cursor:help;color:var(--text-secondary);font-size:0.85em;margin-left:3px;vertical-align:middle;">ⓘ</span>`;
}

function helpStep(n: number, title: string, body: string): string {
  return `<div style="display:flex;gap:14px;margin-bottom:16px;">
    <div style="flex-shrink:0;width:22px;height:22px;border-radius:50%;background:rgba(0,122,255,0.2);border:1px solid rgba(0,122,255,0.4);color:#6db3ff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;">${n}</div>
    <div style="flex:1;padding-top:2px;">
      <div style="font-size:12px;font-weight:600;color:#e5e2e1;margin-bottom:4px;">${title}</div>
      <div style="font-size:12px;color:#8a8fa8;line-height:1.65;">${body}</div>
    </div>
  </div>`;
}

function stageFromThresholds(value: number, thresholds: [number, number, number]): number {
  if (value >= thresholds[2]) { return 4; }
  if (value >= thresholds[1]) { return 3; }
  if (value >= thresholds[0]) { return 2; }
  return 1;
}

function countMatchingTools(toolCalls: Record<string, number>, pattern: RegExp): number {
  return Object.entries(toolCalls).reduce((sum, [name, count]) =>
    pattern.test(name) ? sum + count : sum, 0);
}

function buildModeSectionHtml(modeBreakdown: Record<string, number>): string {
  const total = Object.values(modeBreakdown).reduce((s, n) => s + n, 0);
  const rows = Object.keys(MODE_META).map(key => {
    const { label, icon } = MODE_META[key];
    const count = modeBreakdown[key] || 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const bar = `<div style="background:var(--bg-base);border-radius:2px;height:4px;overflow:hidden;min-width:80px;">
      <div style="background:var(--primary);width:${pct}%;height:100%;"></div></div>`;
    return `<tr>
      <td>${icon} ${label}</td>
      <td class="data-text" style="text-align:right;">${count.toLocaleString()}</td>
      <td style="text-align:right;color:var(--text-secondary);font-size:0.85em;">${pct}%</td>
      <td style="width:120px;padding-right:16px;">${bar}</td>
    </tr>`;
  }).join('');
  return `<table>
    <thead><tr><th>Mode</th><th style="text-align:right;">Interactions</th><th style="text-align:right;">Share</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function buildMcpSectionHtml(toolCalls: Record<string, number>, fmtN: (n: number) => string): string {
  const serverMap = new Map<string, number>();
  for (const [name, count] of Object.entries(toolCalls)) {
    const server = parseMcpServer(name);
    if (server) { serverMap.set(server, (serverMap.get(server) || 0) + count); }
  }
  const mcpTools = Object.entries(toolCalls).filter(([n]) => isMcpTool(n)).sort(([, a], [, b]) => b - a);
  const chips = mcpTools.length === 0
    ? '<p style="color:var(--text-secondary);">No MCP tools detected this month.</p>'
    : mcpTools.map(([name, count]) =>
        `<span style="display:inline-block;background:var(--bg-surface-high);border:1px solid var(--border);border-radius:4px;padding:3px 10px;font-size:0.8em;margin:0 4px 6px 0;font-family:var(--font-data);">${name} <span style="color:var(--text-secondary);">(${count})</span></span>`
      ).join('');
  const totalMcp = [...serverMap.values()].reduce((s, n) => s + n, 0);
  const serverRows = serverMap.size === 0
    ? '<tr><td colspan="3" style="color:var(--text-secondary);padding:16px;text-align:center;">No MCP servers detected</td></tr>'
    : [...serverMap.entries()].sort(([, a], [, b]) => b - a).map(([server, count], i) =>
        `<tr><td style="color:var(--text-secondary);width:32px;">${i + 1}</td><td><strong>${server}</strong></td><td class="data-text" style="text-align:right;">${count.toLocaleString()}</td></tr>`
      ).join('');
  return `<div style="margin-bottom:16px;">${chips}</div>
    <p style="font-size:0.85em;color:var(--text-secondary);margin-bottom:12px;">Total MCP Calls: <strong style="color:var(--text-primary);">${fmtN(totalMcp)}</strong></p>
    <table><thead><tr><th>#</th><th>Server</th><th style="text-align:right;">Calls</th></tr></thead>
    <tbody>${serverRows}</tbody></table>`;
}

function buildAnomalySectionHtml(anomaly: AggregatedMetrics['anomaly']): string {
  let badges = '';
  if (anomaly.isSpike) {
    badges += `<div style="background:rgba(249,226,175,0.1);border:1px solid rgba(249,226,175,0.3);border-radius:4px;padding:8px 12px;margin-bottom:8px;font-size:0.85em;color:#f9e2af;">⚡ Today's spend is ${anomaly.todayZScore.toFixed(1)}σ above your 30-day average</div>`;
  }
  if (anomaly.runawaySessionsCount > 0) {
    badges += `<div style="background:rgba(255,77,77,0.08);border:1px solid rgba(255,77,77,0.25);border-radius:4px;padding:8px 12px;margin-bottom:8px;font-size:0.85em;color:#ff8a8a;">🔥 ${anomaly.runawaySessionsCount} runaway session(s) this month</div>`;
  }
  if (anomaly.burnAcceleration > 1.2) {
    badges += `<div style="background:rgba(249,226,175,0.08);border:1px solid rgba(249,226,175,0.25);border-radius:4px;padding:8px 12px;margin-bottom:8px;font-size:0.85em;color:#f9e2af;">🔺 Spend acceleration: last 7 days = ${anomaly.burnAcceleration.toFixed(1)}× the prior 7 days</div>`;
  }
  if (anomaly.consecutiveHighDays >= 3) {
    badges += `<div style="background:rgba(0,122,255,0.07);border:1px solid rgba(0,122,255,0.2);border-radius:4px;padding:8px 12px;margin-bottom:8px;font-size:0.85em;color:#6db3ff;">📈 ${anomaly.consecutiveHighDays} consecutive high-spend days</div>`;
  }
  if (!badges) { badges = '<div style="color:var(--stage-4);font-size:0.9em;">✅ No anomalies detected this month.</div>'; }
  return `${badges}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-top:16px;">
      <div class="mini-card"><div class="mini-label">Today's Z-Score ${tip('Statistical measure of how unusual today\'s spend is vs. 30-day average.')}</div><div class="mini-val data-text" style="color:${Math.abs(anomaly.todayZScore) > 2 ? '#FF4D4D' : 'var(--text-primary)'}">${anomaly.todayZScore.toFixed(2)}σ</div></div>
      <div class="mini-card"><div class="mini-label">Runaway Sessions</div><div class="mini-val data-text" style="color:${anomaly.runawaySessionsCount > 0 ? '#FF4D4D' : 'var(--stage-4)'}">${anomaly.runawaySessionsCount}</div></div>
      <div class="mini-card"><div class="mini-label">Burn Acceleration</div><div class="mini-val data-text" style="color:${anomaly.burnAcceleration > 1.2 ? '#f9e2af' : 'var(--text-primary)'}">${anomaly.burnAcceleration.toFixed(2)}×</div></div>
      <div class="mini-card"><div class="mini-label">Consecutive High Days</div><div class="mini-val data-text" style="color:${anomaly.consecutiveHighDays >= 3 ? '#f9e2af' : 'var(--text-primary)'}">${anomaly.consecutiveHighDays}</div></div>
    </div>`;
}

function buildSessionComplexityHtml(sc: AggregatedMetrics['sessionComplexity'], fmtC: (n: number) => string): string {
  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;">
    <div class="mini-card"><div class="mini-label">Avg Session Depth</div><div class="mini-val data-text">${sc.avgSessionDepth.toFixed(1)} interactions</div></div>
    <div class="mini-card"><div class="mini-label">Avg Session Duration</div><div class="mini-val data-text">${sc.avgSessionDurationMin.toFixed(1)} min</div></div>
    <div class="mini-card"><div class="mini-label">Long Sessions (&gt;30 min)</div><div class="mini-val data-text">${sc.longSessionsCount}</div><div style="font-size:0.75em;color:var(--text-secondary);">cost ${fmtC(sc.longSessionsCost)}</div></div>
    <div class="mini-card"><div class="mini-label">Tool-Heavy Sessions</div><div class="mini-val data-text">${sc.toolHeavyCount}</div><div style="font-size:0.75em;color:var(--text-secondary);">&gt;5 unique tools</div></div>
    <div class="mini-card"><div class="mini-label">Thinking Sessions</div><div class="mini-val data-text">${sc.thinkingSessionsCount}</div></div>
    <div class="mini-card"><div class="mini-label">Multi-Model Sessions</div><div class="mini-val data-text">${sc.multiModelSessionsCount}</div></div>
  </div>`;
}

function buildWorkspaceHealthHtml(reports: RepositoryHygieneReport[]): string {
  const filtered = reports.filter(r => r.repoPath);
  if (filtered.length === 0) {
    return '<p style="color:var(--text-secondary);">No workspaces with resolved paths found this month.</p>';
  }
  const missingAll = filtered.filter(r =>
    !r.files.instructions.exists && !r.files.agentSetup.exists &&
    !r.files.mcpConfig.exists && !r.files.skillFiles.exists && !r.files.customAgents.exists
  ).length;
  const banner = missingAll > 0
    ? `<div style="background:rgba(249,226,175,0.08);border:1px solid rgba(249,226,175,0.25);border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:0.85em;color:#f9e2af;">⚠️ ${missingAll} workspace(s) have no AI configuration files.</div>`
    : `<div style="background:rgba(57,255,20,0.06);border:1px solid rgba(57,255,20,0.2);border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:0.85em;color:var(--stage-4);">✅ All active workspaces have AI configuration files.</div>`;
  const rows = filtered.map(r => `<tr>
    <td><div style="font-weight:600;">${r.name}</div><span style="font-size:0.8em;color:var(--text-secondary);font-family:var(--font-data);">${r.repoPath}</span></td>
    <td class="data-text" style="text-align:right;">${r.sessions}</td>
    <td style="text-align:center;">${fileStatusIcon(r.files.instructions)}</td>
    <td style="text-align:center;">${fileStatusIcon(r.files.agentSetup)}</td>
    <td style="text-align:center;">${fileStatusIcon(r.files.mcpConfig)}</td>
    <td style="text-align:center;">${fileStatusIcon(r.files.skillFiles)}</td>
    <td style="text-align:center;">${fileStatusIcon(r.files.customAgents)}</td>
    <td class="data-text" style="text-align:right;font-weight:600;color:${r.score === null ? 'var(--text-secondary)' : r.score >= 80 ? 'var(--stage-4)' : r.score >= 40 ? '#f9e2af' : 'var(--stage-1)'};">${r.score !== null ? r.score + '/100' : '-'}</td>
  </tr>`).join('');
  return `${banner}
  <table>
    <thead><tr>
      <th>Workspace</th><th style="text-align:right;">Sessions</th>
      <th style="text-align:center;" title="CLAUDE.md / copilot-instructions.md">📄 Instructions</th>
      <th style="text-align:center;" title=".claude/settings.json">⚙️ Agent Setup</th>
      <th style="text-align:center;" title="mcpServers">🔌 MCP Config</th>
      <th style="text-align:center;" title=".claude/commands/">🧠 Skills</th>
      <th style="text-align:center;" title="AGENTS.md">🤖 Agents</th>
      <th style="text-align:right;">Score</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="font-size:0.75em;color:var(--text-secondary);margin-top:8px;">
    <span style="color:var(--stage-4);">✓</span> Fresh &nbsp;·&nbsp;
    <span style="color:#f9e2af;">⚠</span> Stale &nbsp;·&nbsp;
    <span style="color:var(--stage-1);">✕</span> Missing
  </p>`;
}

export interface ShareInfo {
  localUrl: string;
  lanUrls: string[];
  warning: string | null;
  qrDataUrl?: string;
}

export class DashboardProvider {
  static readonly viewType = 'aiInsights.dashboard';
  private static currentPanel: vscode.WebviewPanel | undefined;

  static postSharingInfo(info: ShareInfo | null): void {
    DashboardProvider.currentPanel?.webview.postMessage(
      info ? { type: 'sharingStarted', ...info } : { type: 'sharingStopped' },
    );
  }

  static postSharingError(error: string): void {
    DashboardProvider.currentPanel?.webview.postMessage({ type: 'sharingError', error });
  }

  static createPanel(context: vscode.ExtensionContext, metrics: AggregatedMetrics, githubUser?: ConnectedGitHubUser, refreshing = false, reports: RepositoryHygieneReport[] = [], roiConfig: RoiConfig = { hourlyRate: 75, tokensPerHourSaved: 3000 }, acceptance?: AcceptanceMetrics, healthScore?: UsageHealthScore): vscode.WebviewPanel {
    const logoPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'logo.png');

    if (DashboardProvider.currentPanel) {
      const logoUri = DashboardProvider.currentPanel.webview.asWebviewUri(logoPath).toString();
      DashboardProvider.currentPanel.webview.html = DashboardProvider.getHtml(metrics, githubUser, refreshing, reports, roiConfig, logoUri, acceptance, healthScore);
      DashboardProvider.currentPanel.reveal(vscode.ViewColumn.One);
      return DashboardProvider.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      DashboardProvider.viewType,
      'AI Insights Dashboard',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')],
      },
    );
    const logoUri = panel.webview.asWebviewUri(logoPath).toString();
    panel.webview.html = DashboardProvider.getHtml(metrics, githubUser, refreshing, reports, roiConfig, logoUri, acceptance, healthScore);

    panel.webview.onDidReceiveMessage(
      (message) => {
        // Route shared nav commands via NAV_COMMANDS first
        const navCmd = NAV_COMMANDS[message.command];
        if (navCmd) { vscode.commands.executeCommand(navCmd); return; }

        switch (message.command) {
          case 'refresh':
            vscode.commands.executeCommand('aiInsights.refresh').then(() => {
              vscode.commands.executeCommand('aiInsights.showDashboard');
            });
            break;
          case 'connectGitHub': vscode.commands.executeCommand('aiInsights.connectGitHub'); break;
          case 'disconnectGitHub': vscode.commands.executeCommand('aiInsights.disconnectGitHub'); break;
          case 'startSharing': vscode.commands.executeCommand('aiInsights.startSharing'); break;
          case 'stopSharing': vscode.commands.executeCommand('aiInsights.stopSharing'); break;
        }
      },
      undefined,
      context.subscriptions,
    );

    panel.onDidDispose(() => { DashboardProvider.currentPanel = undefined; }, null, context.subscriptions);
    DashboardProvider.currentPanel = panel;
    return panel;
  }

  static showLoadingPanel(context: vscode.ExtensionContext): void {
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><style>
      body{background:#0f1218;color:#e5e2e1;font-family:system-ui,sans-serif;margin:0;}
      .loading-bar{position:fixed;top:0;left:0;right:0;z-index:100;height:3px;background:rgba(0,122,255,0.15);overflow:hidden;}
      .loading-bar-fill{height:100%;width:40%;background:#007AFF;border-radius:0 2px 2px 0;animation:loadslide 1.4s ease-in-out infinite;}
      @keyframes loadslide{0%{transform:translateX(-100%)}60%{transform:translateX(280%)}100%{transform:translateX(280%)}}
      .loading-banner{background:rgba(0,122,255,0.08);border-bottom:1px solid rgba(0,122,255,0.2);padding:8px 32px;font-size:0.82em;color:#6db3ff;display:flex;align-items:center;gap:8px;}
      .loading-spinner{width:12px;height:12px;border:2px solid rgba(0,122,255,0.3);border-top-color:#007AFF;border-radius:50%;animation:spin 0.7s linear infinite;flex-shrink:0;}
      @keyframes spin{to{transform:rotate(360deg)}}
    </style></head><body>
    <div class="loading-bar"><div class="loading-bar-fill"></div></div>
    <div class="loading-banner"><div class="loading-spinner"></div>Loading AI Insights data…</div>
    </body></html>`;
    if (DashboardProvider.currentPanel) {
      DashboardProvider.currentPanel.webview.html = html;
      DashboardProvider.currentPanel.reveal(vscode.ViewColumn.One);
    } else {
      const panel = vscode.window.createWebviewPanel(
        DashboardProvider.viewType, 'AI Insights Dashboard',
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')],
        },
      );
      panel.webview.html = html;
      panel.onDidDispose(() => { DashboardProvider.currentPanel = undefined; }, null, context.subscriptions);
      DashboardProvider.currentPanel = panel;
    }
  }

  static getHtml(m: AggregatedMetrics, githubUser?: ConnectedGitHubUser, refreshing = false, reports: RepositoryHygieneReport[] = [], roiConfig: RoiConfig = { hourlyRate: 75, tokensPerHourSaved: 3000 }, logoUri = '', acceptance?: AcceptanceMetrics, healthScore?: UsageHealthScore): string {
    const fmt = (n: number) => n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' :
      n >= 1_000 ? (n / 1_000).toFixed(1) + 'K' : n.toString();
    const fmtCost = (n: number) => '$' + n.toFixed(4);
    const fmtCost2 = (n: number) => '$' + n.toFixed(2);
    const fmtCredits = (usd: number) => (usd / 0.01).toFixed(2);
    const fmtDiff = (current: number, previous: number): string => {
      if (previous === 0) { return current > 0 ? '<span style="color:#39FF14;font-size:0.75em;font-weight:600">new ↑</span>' : ''; }
      const pct = ((current - previous) / previous) * 100;
      const up = pct >= 0;
      const color = up ? '#39FF14' : '#FF6B6B';
      return `<span style="color:${color};font-size:0.75em;font-weight:600">${up ? '↑' : '↓'} ${Math.abs(pct).toFixed(0)}%</span>`;
    };
    const copilotMonth = m.currentMonthByProvider.copilot;
    const copilotLastMonth = m.lastMonthByProvider.copilot;

    // ── Copilot budget widget ─────────────────────────────────────────────
    const b = m.budget;
    const budgetPct = Math.min(200, b.budgetUtilizationPct);
    const budgetBarColor = budgetPct >= 95 ? '#FF4D4D' : budgetPct >= 80 ? '#f9e2af' : '#39FF14';
    const projOverage = b.projectedMonthEnd > b.planBudget;
    const overageAmt = b.projectedMonthEnd - b.planBudget;
    const exhaustedText = b.daysUntilExhausted !== null ? `${Math.round(b.daysUntilExhausted)} days` : '∞ days';
    const planLabel = b.planBudget === 10 ? 'Copilot Pro ($10)' :
      b.planBudget === 19 ? 'Copilot Business ($19)' :
        b.planBudget === 39 ? 'Copilot Pro+ / Enterprise ($39)' :
          `Custom ($${b.planBudget.toFixed(2)})`;
    const copilotBudgetSection = `
    <div id="section-copilot-budget" class="section" style="display:none;">
      <h2>💳 GitHub Copilot Budget Health &amp; Forecast</h2>
      <p style="font-size:0.85em;color:var(--text-secondary);margin:-12px 0 18px">Copilot plan: ${planLabel} · ${b.daysElapsed} of ${b.daysInMonth} days elapsed</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:20px;">
        <div class="mini-card"><div class="mini-label">Copilot MTD Spend</div><div class="mini-val data-text">${fmtCost(b.mtdSpend)}</div></div>
        <div class="mini-card"><div class="mini-label">Budget Left</div><div class="mini-val data-text" style="color:${budgetBarColor}">${fmtCost(b.creditsRemaining)}</div></div>
        <div class="mini-card"><div class="mini-label">Hourly Burn Rate</div><div class="mini-val data-text">${fmtCost(b.hourlyBurnRate)}/hr</div></div>
        <div class="mini-card"><div class="mini-label">Daily Burn Rate</div><div class="mini-val data-text">${fmtCost(b.dailyBurnRate)}/day</div></div>
        <div class="mini-card"><div class="mini-label">Days Until Exhausted</div><div class="mini-val data-text">${exhaustedText}</div></div>
        <div class="mini-card"><div class="mini-label">Projected Month-End</div><div class="mini-val data-text" style="color:${projOverage ? '#FF4D4D' : '#39FF14'}">${fmtCost(b.projectedMonthEnd)}</div></div>
        <div class="mini-card"><div class="mini-label">Overage Risk</div><div class="mini-val data-text" style="color:${budgetBarColor}">${Math.min(200, Math.round(b.overageRiskScore))}%</div></div>
      </div>
      ${projOverage ? `<div style="background:rgba(255,77,77,0.08);border:1px solid rgba(255,77,77,0.25);border-radius:6px;padding:10px 14px;font-size:0.85em;color:#ff8a8a;margin-bottom:16px;">🚨 On current trajectory, you'll overspend by ${fmtCost(overageAmt)} this month.</div>` : ''}
      <div style="font-size:0.8em;color:var(--text-secondary);margin-bottom:8px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em">Projected vs. Plan</div>
      <div style="background:var(--bg-surface-high);border-radius:4px;padding:12px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <span style="font-size:0.85em;color:var(--text-secondary);min-width:80px;">MTD Spend</span>
          <div style="flex:1;background:var(--bg-base);border-radius:4px;height:6px;overflow:hidden;"><div style="background:${budgetBarColor};width:${Math.min(100, budgetPct)}%;height:100%;"></div></div>
          <span class="data-text" style="font-size:0.85em;min-width:40px;text-align:right;">${Math.round(budgetPct)}%</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:0.85em;color:var(--text-secondary);min-width:80px;">Projected</span>
          <div style="flex:1;background:var(--bg-base);border-radius:4px;height:6px;overflow:hidden;"><div style="background:${projOverage ? '#FF4D4D' : '#007AFF'};width:${Math.min(100, b.overageRiskScore)}%;height:100%;"></div></div>
          <span class="data-text" style="font-size:0.85em;min-width:40px;text-align:right;">${Math.min(200, Math.round(b.overageRiskScore))}%</span>
        </div>
      </div>
    </div>`;

    // ── Copilot cache efficiency widget ───────────────────────────────────
    const ch = m.cache;
    const cacheHitColor = ch.cacheHitRate >= 0.3 ? '#39FF14' : ch.cacheHitRate >= 0.1 ? '#f9e2af' : 'var(--text-secondary)';
    const copilotCacheSection = `
    <div id="section-copilot-cache" class="section" style="display:none;">
      <h2>⚡ GitHub Copilot Cache Efficiency</h2>
      <p style="font-size:0.85em;color:var(--text-secondary);margin:-12px 0 18px">Copilot cached input is priced separately from fresh input in GitHub's model pricing table</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:16px;">
        <div class="mini-card"><div class="mini-label">Cache Hit Rate</div><div class="mini-val data-text" style="color:${cacheHitColor}">${Math.round(ch.cacheHitRate * 100)}%</div></div>
        <div class="mini-card"><div class="mini-label">Cache Savings (MTD)</div><div class="mini-val data-text" style="color:#39FF14">${fmtCost(ch.cacheSavingsUsd)}</div></div>
        <div class="mini-card"><div class="mini-label">Cache Read Tokens</div><div class="mini-val data-text">${fmt(ch.totalCacheReadTokens)}</div></div>
        <div class="mini-card"><div class="mini-label">Cache Write Tokens</div><div class="mini-val data-text">${fmt(ch.totalCacheWriteTokens)}</div></div>
        <div class="mini-card"><div class="mini-label">Read/Write Ratio</div><div class="mini-val data-text">${ch.cacheWriteReadRatio.toFixed(1)}×</div></div>
      </div>
      ${ch.cacheHitRate < 0.1 && ch.totalCacheWriteTokens === 0 ? `<p style="font-size:0.85em;color:var(--text-secondary);">ℹ️ No cache data detected. Prompt caching is available for Claude and GPT-4o - see provider docs to enable it.</p>` : ''}
    </div>`;

    // ── Cache efficiency card ──────────────────────────────────────────────
    const cacheHitPct = Math.round(m.cache.cacheHitRate * 100);
    const cacheBarColor = cacheHitPct >= 30 ? '#39FF14' : cacheHitPct >= 10 ? '#f9e2af' : 'rgba(255,255,255,0.15)';
    const cacheCards = `
      <div class="card" style="border-top: 2px solid ${cacheBarColor};">
        <div class="card-label">Cache Hit Rate</div>
        <div class="card-value data-text" style="color:${cacheBarColor}">${cacheHitPct}%</div>
        <div class="card-sub">${fmt(m.cache.totalCacheReadTokens)} cached reads</div>
      </div>`;

    // ── Provider rows ─────────────────────────────────────────────────────────
    const providerRows = Object.entries(m.byProvider).map(([id, p]) => {
      const label = id === 'copilot' ? 'GitHub Copilot' :
        id === 'antigravity' ? 'Antigravity' :
          id === 'claudeCode' ? 'Claude Code' : 'Codex';
      const name = `${providerIcon(id)} ${label}`;
      const cHit = (p.cacheReadTokens > 0 || p.cacheWriteTokens > 0)
        ? Math.round((p.cacheReadTokens / (p.inputTokens + p.cacheReadTokens)) * 100) + '%'
        : '-';
      return `<tr>
        <td class="data-text">${name}</td>
        <td class="data-text">${fmt(p.totalTokens)}</td>
        <td class="data-text">${p.sessions}</td>
        <td class="data-text">${p.interactions}</td>
        <td class="data-text">${cHit}</td>
      </tr>`;
    }).join('');

    // ── Per-provider card sets (for switcher) ─────────────────────────────────
    type ProvKey = 'copilot' | 'claudeCode' | 'codex' | 'antigravity';
    const buildProvCards = (id: ProvKey) => {
      const tod = m.todayByProvider[id];
      const mon = m.currentMonthByProvider[id];
      const lmo = m.lastMonthByProvider[id];
      return `
        ${id === 'copilot' ? `<div class="card" style="border-top:2px solid var(--text-secondary)">
          <div class="card-label">AI Credits This Month</div>
          <div class="card-value data-text">${fmtCredits(mon.estimatedCost)}</div>
          <div class="card-sub">${fmtCost2(mon.estimatedCost)} spend</div>
          <div class="card-sub" style="margin-top:6px">vs last month ${fmtDiff(mon.estimatedCost, lmo.estimatedCost)}</div>
        </div>` : ''}
        <div class="card">
          <div class="card-label">Tokens Today</div>
          <div class="card-value data-text">${fmt(tod.totalTokens)}</div>
          <div class="card-sub">${tod.sessions} sessions · ${tod.interactions} interactions</div>
        </div>
        <div class="card">
          <div class="card-label">This Month</div>
          <div class="card-value data-text">${fmt(mon.totalTokens)}</div>
          <div class="card-sub">${mon.sessions} sessions</div>
          <div class="card-sub" style="margin-top:6px">vs last month ${fmtDiff(mon.totalTokens, lmo.totalTokens)}</div>
        </div>
        <div class="card">
          <div class="card-label">Last Month</div>
          <div class="card-value data-text">${fmt(lmo.totalTokens)}</div>
          <div class="card-sub">${lmo.sessions} sessions</div>
        </div>`;
    };

    // ── Per-provider daily chart data ─────────────────────────────────────────
    const dailyByProvDate: Record<string, Record<string, { tokens: number; cost: number }>> = {
      overall: {}, copilot: {}, claudeCode: {}, codex: {}, antigravity: {},
    };
    for (const d of m.daily) {
      if (!dailyByProvDate.overall[d.date]) { dailyByProvDate.overall[d.date] = { tokens: 0, cost: 0 }; }
      dailyByProvDate.overall[d.date].tokens += d.totalTokens;
      dailyByProvDate.overall[d.date].cost += d.estimatedCost;
      const pk = d.provider as string;
      if (dailyByProvDate[pk]) {
        if (!dailyByProvDate[pk][d.date]) { dailyByProvDate[pk][d.date] = { tokens: 0, cost: 0 }; }
        dailyByProvDate[pk][d.date].tokens += d.totalTokens;
        dailyByProvDate[pk][d.date].cost += d.estimatedCost;
      }
    }
    const allDates = Object.keys(dailyByProvDate.overall).sort().slice(-30);
    const allChartData: Record<string, { labels: string[]; tokens: number[]; costs: number[] }> = {};
    for (const pid of ['overall', 'copilot', 'claudeCode', 'codex', 'antigravity']) {
      const pd = dailyByProvDate[pid] || {};
      allChartData[pid] = {
        labels: allDates,
        tokens: allDates.map(d => pd[d]?.tokens || 0),
        costs: allDates.map(d => pd[d]?.cost || 0),
      };
    }
    const allChartDataJson = JSON.stringify(allChartData);

    // ── Per-provider period data for dynamic table updates ────────────────────
    const providerIds = ['copilot', 'claudeCode', 'codex', 'antigravity', 'jetbrainsAI', 'visualStudio'] as const;
    const slicePeriod = (p: import('../types').ProviderMetrics) => ({
      totalTokens: p.totalTokens,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      thinkingTokens: p.thinkingTokens,
      cacheReadTokens: p.cacheReadTokens,
      sessions: p.sessions,
      avgTokensPerSession: Math.round(p.averageTokensPerSession),
      avgInteractionsPerSession: p.averageInteractionsPerSession,
    });
    const allPeriodData: Record<string, object> = {
      overall: {
        today: slicePeriod(m.today),
        yesterday: slicePeriod(m.yesterday),
        currentMonth: slicePeriod(m.currentMonth),
        lastMonth: slicePeriod(m.lastMonth),
        thisYear: slicePeriod(m.thisYear),
        allTime: slicePeriod(m.allTime),
        projectedYear: slicePeriod(m.projectedYear),
      },
    };
    for (const pid of providerIds) {
      allPeriodData[pid] = {
        today: slicePeriod(m.todayByProvider[pid]),
        yesterday: slicePeriod(m.yesterdayByProvider[pid]),
        currentMonth: slicePeriod(m.currentMonthByProvider[pid]),
        lastMonth: slicePeriod(m.lastMonthByProvider[pid]),
        thisYear: null,
        allTime: null,
        projectedYear: null,
      };
    }
    const allPeriodDataJson = JSON.stringify(allPeriodData);

    // ── Interaction mode data for the dashboard period widget ─────────────────
    const allModeData: Record<string, Record<string, number>> = {
      today: m.today.modeBreakdown,
      yesterday: m.yesterday.modeBreakdown,
      currentMonth: m.currentMonth.modeBreakdown,
      lastMonth: m.lastMonth.modeBreakdown,
      thisYear: m.thisYear.modeBreakdown,
      allTime: m.allTime.modeBreakdown,
    };
    const allModeDataJson = JSON.stringify(allModeData);

    // ── Interaction summary data per period (sessions, interactions, tokens) ───
    const allPeriodSummary: Record<string, { sessions: number; interactions: number; totalTokens: number }> = {
      today:        { sessions: m.today.sessions,        interactions: m.today.interactions,        totalTokens: m.today.totalTokens },
      yesterday:    { sessions: m.yesterday.sessions,    interactions: m.yesterday.interactions,    totalTokens: m.yesterday.totalTokens },
      currentMonth: { sessions: m.currentMonth.sessions, interactions: m.currentMonth.interactions, totalTokens: m.currentMonth.totalTokens },
      lastMonth:    { sessions: m.lastMonth.sessions,    interactions: m.lastMonth.interactions,    totalTokens: m.lastMonth.totalTokens },
      thisYear:     { sessions: m.thisYear.sessions,     interactions: m.thisYear.interactions,     totalTokens: m.thisYear.totalTokens },
      allTime:      { sessions: m.allTime.sessions,      interactions: m.allTime.interactions,      totalTokens: m.allTime.totalTokens },
    };
    const allPeriodSummaryJson = JSON.stringify(allPeriodSummary);

    // ── Per-provider repo data for dynamic table updates ──────────────────────
    const buildRepoItems = (pm: import('../types').ProviderMetrics) => ({
      totalCost: pm.estimatedCost,
      items: Object.entries(pm.costByRepository)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 8)
        .map(([repo, cost]) => ({ repo, tokens: pm.repositories[repo] || 0, cost })),
    });
    // Keyed by provider (for provider switcher)
    const allRepoData: Record<string, object> = { overall: buildRepoItems(m.currentMonth) };
    for (const pid of providerIds) {
      allRepoData[pid] = buildRepoItems(m.currentMonthByProvider[pid]);
    }
    const allRepoDataJson = JSON.stringify(allRepoData);
    // Keyed by period (for global period selector)
    const allPeriodRepoData: Record<string, object> = {
      today:        buildRepoItems(m.today),
      yesterday:    buildRepoItems(m.yesterday),
      currentMonth: buildRepoItems(m.currentMonth),
      lastMonth:    buildRepoItems(m.lastMonth),
      thisYear:     buildRepoItems(m.thisYear),
      allTime:      buildRepoItems(m.allTime),
    };
    const allPeriodRepoDataJson = JSON.stringify(allPeriodRepoData);

    // ── Developer Impact per period ───────────────────────────────────────────
    const calcDevImpact = (pm: import('../types').ProviderMetrics) => {
      const hoursSaved = pm.outputTokens / roiConfig.tokensPerHourSaved;
      const valueGenerated = hoursSaved * roiConfig.hourlyRate;
      const aiCost = pm.estimatedCost;
      const roiMult = aiCost > 0 ? valueGenerated / aiCost : 0;
      return { hoursSaved, valueGenerated, aiCost, roiMult };
    };
    const allPeriodDevImpact: Record<string, object> = {
      today:        calcDevImpact(m.today),
      yesterday:    calcDevImpact(m.yesterday),
      currentMonth: calcDevImpact(m.currentMonth),
      lastMonth:    calcDevImpact(m.lastMonth),
      thisYear:     calcDevImpact(m.thisYear),
      allTime:      calcDevImpact(m.allTime),
    };
    const allPeriodDevImpactJson = JSON.stringify(allPeriodDevImpact);

    // ── Per-period provider breakdown for provider table ─────────────────────
    const byPeriodAndProvider = (byProv: Record<string, import('../types').ProviderMetrics>) =>
      providerIds.reduce((acc, pid) => {
        const p = byProv[pid];
        const cacheHitPct = p.inputTokens > 0 ? Math.round((p.cacheReadTokens / p.inputTokens) * 100) : 0;
        acc[pid] = { totalTokens: p.totalTokens, sessions: p.sessions, interactions: p.interactions, cacheHitPct };
        return acc;
      }, {} as Record<string, object>);
    const allPeriodProviderData: Record<string, object> = {
      today:        byPeriodAndProvider(m.todayByProvider),
      yesterday:    byPeriodAndProvider(m.yesterdayByProvider),
      currentMonth: byPeriodAndProvider(m.currentMonthByProvider),
      lastMonth:    byPeriodAndProvider(m.lastMonthByProvider),
      thisYear:     byPeriodAndProvider(m.thisYearByProvider),
      allTime:      byPeriodAndProvider(m.allTimeByProvider),
    };
    const allPeriodProviderDataJson = JSON.stringify(allPeriodProviderData);

    // ── MCP tool data per period ──────────────────────────────────────────────
    const isMcpTool = (name: string) => name.startsWith('mcp_') || name.startsWith('mcp__');
    const parseMcpServer = (toolName: string): string | null => {
      if (toolName.startsWith('mcp__')) {
        const rest = toolName.slice(5); const idx = rest.indexOf('__');
        return idx > 0 ? rest.slice(0, idx) : rest;
      }
      if (toolName.startsWith('mcp_')) {
        const rest = toolName.slice(4); const idx = rest.indexOf('_');
        return idx > 0 ? rest.slice(0, idx) : rest;
      }
      return null;
    };
    const buildMcpPeriodData = (pm: import('../types').ProviderMetrics) => {
      const serverMap: Record<string, number> = {};
      let total = 0;
      for (const [name, count] of Object.entries(pm.toolCalls || {})) {
        if (!isMcpTool(name)) { continue; }
        total += count;
        const server = parseMcpServer(name) || name;
        serverMap[server] = (serverMap[server] || 0) + count;
      }
      const servers = Object.entries(serverMap).sort(([, a], [, b]) => b - a);
      return { total, servers };
    };
    const allPeriodMcpData: Record<string, object> = {
      today:        buildMcpPeriodData(m.today),
      yesterday:    buildMcpPeriodData(m.yesterday),
      currentMonth: buildMcpPeriodData(m.currentMonth),
      lastMonth:    buildMcpPeriodData(m.lastMonth),
      thisYear:     buildMcpPeriodData(m.thisYear),
      allTime:      buildMcpPeriodData(m.allTime),
    };
    const allPeriodMcpDataJson = JSON.stringify(allPeriodMcpData);

    // ── Provider cost per 1K output ────────────────────────────────────────────
    const providerCostData = Object.entries(m.roi.providerCostPer1KOutput)
      .filter(([, v]) => v > 0)
      .sort(([, a], [, b]) => a - b)
      .map(([id, costPer1K]) => {
        const p = m.byProvider[id as keyof typeof m.byProvider];
        return { id, costPer1K, totalCost: p?.estimatedCost ?? 0, outputTokens: p?.outputTokens ?? 0 };
      });
    const providerCostDataJson = JSON.stringify(providerCostData);

    // ── Anomaly badge HTML (pre-rendered server-side) ──────────────────────────
    const anomaly = m.anomaly;
    let anomalyBadgesHtml = '';
    if (anomaly.isSpike) { anomalyBadgesHtml += `<div style="background:rgba(249,226,175,0.1);border:1px solid rgba(249,226,175,0.3);border-radius:4px;padding:8px 12px;margin-bottom:8px;font-size:0.85em;color:#f9e2af;">⚡ Today's spend is ${anomaly.todayZScore.toFixed(1)}σ above your 30-day average (potential spike)</div>`; }
    if (anomaly.runawaySessionsCount > 0) { anomalyBadgesHtml += `<div style="background:rgba(255,77,77,0.08);border:1px solid rgba(255,77,77,0.25);border-radius:4px;padding:8px 12px;margin-bottom:8px;font-size:0.85em;color:#ff8a8a;">🔥 ${anomaly.runawaySessionsCount} runaway session(s) this month</div>`; }
    if (anomaly.burnAcceleration > 1.2) { anomalyBadgesHtml += `<div style="background:rgba(249,226,175,0.08);border:1px solid rgba(249,226,175,0.25);border-radius:4px;padding:8px 12px;margin-bottom:8px;font-size:0.85em;color:#f9e2af;">🔺 Spend acceleration: last 7 days = ${anomaly.burnAcceleration.toFixed(1)}× the prior 7 days</div>`; }
    if (anomaly.consecutiveHighDays >= 3) { anomalyBadgesHtml += `<div style="background:rgba(0,122,255,0.07);border:1px solid rgba(0,122,255,0.2);border-radius:4px;padding:8px 12px;margin-bottom:8px;font-size:0.85em;color:#6db3ff;">📈 ${anomaly.consecutiveHighDays} consecutive high-spend days</div>`; }
    if (!anomalyBadgesHtml) { anomalyBadgesHtml = '<div style="color:var(--stage-4);font-size:0.9em;">✅ No anomalies detected this month.</div>'; }

    // ── Repo cost rows (initial render – overall) ──────────────────────────────
    const repoRows = Object.entries(m.currentMonth.costByRepository)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)
      .map(([repo, cost]) => {
        const tokens = m.currentMonth.repositories[repo] || 0;
        const pct = m.currentMonth.estimatedCost > 0
          ? Math.round((cost / m.currentMonth.estimatedCost) * 100) : 0;
        return `<tr>
          <td class="data-text">${repo}</td>
          <td class="data-text">${fmt(tokens)}</td>
          <td class="data-text">${fmtCost(cost)}</td>
          <td style="width:100px;padding-right:12px;">
            <div style="background:rgba(255,255,255,0.08);border-radius:2px;height:4px;overflow:hidden;">
              <div style="background:#007AFF;width:${pct}%;height:100%;"></div>
            </div>
            <span style="font-size:0.75em;color:var(--text-secondary);">${pct}%</span>
          </td>
        </tr>`;
      }).join('');

    // ── ROI section ──────────────────────────────────────────────────────────
    const roi = m.roi;
    const roiRows = `
      <tr><td>Input efficiency ratio</td><td class="data-text">${roi.inputEfficiencyRatio.toFixed(2)}× (output / input)</td></tr>
      <tr><td>Thinking token overhead</td><td class="data-text">${roi.thinkingOverheadPct.toFixed(1)}%</td></tr>`;

    // ── Fluency scoring ──────────────────────────────────────────────────────
    const getStageColor = (stage: number) => {
      switch (stage) {
        case 1: return 'var(--stage-1)';
        case 2: return 'var(--stage-2)';
        case 3: return 'var(--stage-3)';
        case 4: return 'var(--stage-4)';
        default: return 'var(--text-secondary)';
      }
    };
    const getStageBar = (stage: number) => '█'.repeat(stage) + '░'.repeat(4 - stage);

    const month = m.currentMonth;
    const interactions = month.interactions;
    const sessions = month.sessions;
    const avgExchanges = month.averageInteractionsPerSession;
    const fluencyCacheHitPct = month.inputTokens > 0
      ? Math.round((month.cacheReadTokens / month.inputTokens) * 100)
      : 0;
    const toolCalls = month.toolCalls || {};
    const totalToolCalls = Object.values(toolCalls).reduce((s, n) => s + n, 0);
    const numTools = Object.keys(toolCalls).length;
    const numRepos = Object.keys(month.repositories || {}).filter(k => k !== 'Unknown').length;
    const numModels = Object.keys(month.modelBreakdown || {}).length;
    const modes = month.modeBreakdown || {};
    const agentTurns = (modes.agent || 0) + (modes.customAgent || 0) + (modes.cli || 0);
    const agentToolCalls = countMatchingTools(toolCalls, /(^task$|agent|subagent|delegate|handoff|worker)/i);
    const agentProviderTokens = (month.providerBreakdown['Claude Code'] || 0) +
      (month.providerBreakdown['Codex'] || 0);
    const nowForFluency = new Date();
    const activeDays = new Set(m.daily
      .filter(d => {
        const day = new Date(`${d.date}T00:00:00`);
        return d.totalTokens > 0 &&
          day.getFullYear() === nowForFluency.getFullYear() &&
          day.getMonth() === nowForFluency.getMonth();
      })
      .map(d => d.date)).size;

    const peStage = Math.max(
      stageFromThresholds(interactions, [5, 30, 100]),
      avgExchanges >= 5 && interactions >= 30 ? 4 : avgExchanges >= 3 && interactions >= 15 ? 3 : 1,
    );

    const contextVolumeStage = stageFromThresholds(month.inputTokens, [10_000, 50_000, 200_000]);
    const cacheReuseStage = stageFromThresholds(fluencyCacheHitPct, [10, 25, 50]);
    const ceStage = Math.max(contextVolumeStage, cacheReuseStage);

    const agStage = Math.max(
      stageFromThresholds(agentTurns, [1, 10, 30]),
      stageFromThresholds(agentToolCalls, [1, 3, 10]),
      stageFromThresholds(agentProviderTokens, [1, 10_000, 50_000]),
    );

    const tuStage = Math.max(
      stageFromThresholds(numTools, [1, 3, 6]),
      stageFromThresholds(totalToolCalls, [3, 20, 75]),
    );

    const cuStage = Math.max(
      stageFromThresholds(numRepos, [1, 2, 3]),
      stageFromThresholds(numModels, [2, 3, 5]),
    );

    const wiStage = Math.max(
      stageFromThresholds(sessions, [3, 10, 20]),
      stageFromThresholds(activeDays, [2, 5, 12]),
    );

    const stages = [peStage, ceStage, agStage, tuStage, cuStage, wiStage].sort((a, b) => a - b);
    const overallStage = Math.round((stages[2] + stages[3]) / 2) || 1;
    const overallLabels: Record<number, string> = {
      1: 'Stage 1: AI Skeptic',
      2: 'Stage 2: AI Explorer',
      3: 'Stage 3: AI Collaborator',
      4: 'Stage 4: AI Strategist',
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Insights Dashboard</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@500;600&display=swap');
  ${designTokensCss()}
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--font-primary); background: var(--bg-base); color: var(--text-primary); padding: 0; line-height: 1.6; }
  .data-text { font-family: var(--font-data); }
  /* ── Navigation system ──────────────────────────────────────── */
  ${navCss()}

  /* Budget widget */
  .budget-widget { background: var(--bg-surface); border: 1px solid; border-radius: 8px; padding: 16px 20px; margin-bottom: 24px; }
  .budget-header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; }
  .budget-title { font-weight: 600; font-size: 1em; }
  .budget-amount { font-size: 1.05em; margin-left: auto; }
  .budget-pct { font-size: 1em; font-weight: 700; }
  .budget-track { background: var(--bg-base); border-radius: 4px; height: 8px; overflow: hidden; margin-bottom: 8px; }
  .budget-fill { height: 100%; border-radius: 4px; transition: width 0.5s ease; }
  .budget-footer { display: flex; justify-content: space-between; font-size: 0.8em; color: var(--text-secondary); }
  .budget-team { margin-top: 8px; font-size: 0.8em; color: var(--text-secondary); border-top: 1px solid var(--border); padding-top: 8px; }

  /* Alerts */
  .github-connect { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 6px; font-size: 0.85em; margin-bottom: 8px; background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: var(--text-secondary); }
  .github-connect.connected { border-color: rgba(57,255,20,0.3); background: rgba(57,255,20,0.04); color: var(--text-primary); }
  .gh-btn { padding: 4px 12px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-surface); color: var(--text-primary); cursor: pointer; font-size: 0.82em; white-space: nowrap; }
  .gh-btn:hover { border-color: #39FF14; color: #39FF14; }
  .gh-btn-danger:hover { border-color: #ff6b6b; color: #ff6b6b; }
  .gh-credits-bar { margin-top: 8px; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.1); overflow: hidden; }
  .gh-credits-bar-fill { height: 100%; border-radius: 2px; background: #39FF14; transition: width 0.3s; }
  .alert { padding: 10px 14px; border-radius: 6px; font-size: 0.85em; margin-bottom: 8px; }
  .alert-crit { background: rgba(255,77,77,0.1); border: 1px solid rgba(255,77,77,0.35); color: #ff8a8a; }
  .alert-warn { background: rgba(249,226,175,0.08); border: 1px solid rgba(249,226,175,0.3); color: #f9e2af; }
  .alert-info { background: rgba(0,122,255,0.07); border: 1px solid rgba(0,122,255,0.25); color: #6db3ff; }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 4px; padding: 20px; transition: transform 0.2s; }
  .card:hover { transform: translateY(-2px); box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
  .card-label { font-size: 0.75em; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; font-weight: 500; }
  .card-value { font-size: 2em; font-weight: 500; color: var(--text-primary); margin: 4px 0; }
  .card-sub { font-size: 0.75em; color: var(--text-secondary); }
  .section { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px; padding: 24px; margin-bottom: 28px; }
  .section h2 { font-size: 1.15em; margin-bottom: 20px; font-weight: 600; }
  .mini-card { background:var(--bg-surface-high); border-radius:4px; padding:14px; }
  .mini-label { font-size:0.72em; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px; font-weight:500; }
  .mini-val { font-size:1.3em; font-weight:600; color:var(--text-primary); }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 11px 14px; background: var(--bg-surface-high); color: var(--text-secondary); font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid var(--border); font-weight: 500; }
  td { padding: 11px 14px; border-bottom: 1px solid var(--border); font-size: 0.88em; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(255,255,255,0.02); }
  .footer { text-align: center; padding: 16px; color: var(--text-secondary); font-size: 0.75em; font-style: italic; }
  .score-card { background: var(--bg-surface-high); padding: 20px; border-radius: 4px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .score-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }
  .sub-score-card { background: var(--bg-surface-high); padding: 14px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.02); }
  .loading-bar{position:fixed;top:0;left:0;right:0;z-index:100;height:3px;background:rgba(0,122,255,0.15);overflow:hidden;}
  .loading-bar-fill{height:100%;width:40%;background:var(--primary);border-radius:0 2px 2px 0;animation:loadslide 1.4s ease-in-out infinite;}
  @keyframes loadslide{0%{transform:translateX(-100%)}60%{transform:translateX(280%)}100%{transform:translateX(280%)}}
  .loading-banner{background:rgba(0,122,255,0.08);border-bottom:1px solid rgba(0,122,255,0.2);padding:8px 32px;font-size:0.82em;color:#6db3ff;display:flex;align-items:center;gap:8px;}
  .loading-spinner{width:12px;height:12px;border:2px solid rgba(0,122,255,0.3);border-top-color:var(--primary);border-radius:50%;animation:spin 0.7s linear infinite;flex-shrink:0;}
  @keyframes spin{to{transform:rotate(360deg)}}
  .copilot-pill { position: fixed; bottom: 24px; right: 24px; background: var(--bg-surface); border: 1px solid rgba(57,255,20,0.35); border-radius: 20px; padding: 8px 16px; font-size: 0.82em; font-weight: 600; font-family: var(--font-primary); color: #39FF14; cursor: pointer; display: flex; align-items: center; gap: 8px; box-shadow: 0 2px 16px rgba(57,255,20,0.15); transition: all 0.18s ease; z-index: 50; }
  .copilot-pill:hover { box-shadow: 0 2px 24px rgba(57,255,20,0.3); transform: translateY(-1px); }
</style>
</head>
<body>
  <div id="navOverlay" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(14,14,14,0.88);z-index:500;justify-content:center;align-items:center;flex-direction:column;gap:14px;backdrop-filter:blur(2px);">
    <div style="width:36px;height:36px;border:3px solid rgba(0,122,255,0.25);border-top-color:#007AFF;border-radius:50%;animation:spin 0.8s linear infinite;"></div>
    <div id="navOverlayText" style="color:#6db3ff;font-size:13px;font-weight:500;letter-spacing:0.2px;"></div>
  </div>
  ${navTopbarHtml(logoUri, true, refreshing, '<button id="btnShare" style="display:inline-flex;align-items:center;gap:5px;background:var(--bg-surface);border:1px solid var(--border);border-radius:7px;padding:5px 10px;color:var(--text-secondary);cursor:pointer;font-size:12px;font-weight:500;font-family:var(--font-primary);height:28px;white-space:nowrap;transition:all 0.15s ease;">⬆ Share</button>')}
  ${refreshing ? '<div class="loading-bar"><div class="loading-bar-fill"></div></div><div class="loading-banner"><div class="loading-spinner"></div>Refreshing dashboard…</div>' : ''}
  ${navPagebarHtml('overview', 'Dashboard')}
  ${navFilterbarHtml()}

  <!-- ── Share info panel (shown when sharing is active) ─────── -->
  <div id="sharePanel" style="display:none;background:rgba(0,122,255,0.07);border-bottom:1px solid rgba(0,122,255,0.2);padding:14px 32px;">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;">
      <div style="flex:1;min-width:260px;">
        <div style="font-size:12px;font-weight:600;color:#6db3ff;margin-bottom:10px;letter-spacing:0.04em;text-transform:uppercase;">⬆ Sharing Active — expires in 30 min</div>
        <div id="shareUrlRows" style="display:flex;flex-direction:column;gap:7px;"></div>
        <div id="shareWarning" style="display:none;margin-top:10px;font-size:11.5px;color:#f9e2af;background:rgba(249,226,175,0.07);border:1px solid rgba(249,226,175,0.2);border-radius:5px;padding:8px 12px;line-height:1.55;"></div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0;align-items:flex-start;">
        <button id="btnShowQr" style="display:none;padding:5px 12px;border-radius:6px;border:1px solid rgba(0,122,255,0.35);background:rgba(0,122,255,0.1);color:#6db3ff;cursor:pointer;font-size:12px;font-weight:500;height:28px;white-space:nowrap;">⬛ QR Code</button>
        <button id="btnShareHelp" style="padding:5px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:rgba(255,255,255,0.04);color:#8a8fa8;cursor:pointer;font-size:12px;font-weight:500;height:28px;white-space:nowrap;">? Help</button>
        <button id="btnStopSharing" style="padding:5px 12px;border-radius:6px;border:1px solid rgba(255,77,77,0.35);background:rgba(255,77,77,0.1);color:#ff8a8a;cursor:pointer;font-size:12px;font-weight:500;height:28px;white-space:nowrap;">✕ Stop Sharing</button>
      </div>
    </div>
  </div>

  <!-- ── QR code modal ──────────────────────────────────────────── -->
  <div id="qrModal" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.7);align-items:center;justify-content:center;">
    <div style="background:#1a1919;border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:28px 32px;text-align:center;max-width:320px;width:90%;">
      <div style="font-size:13px;font-weight:600;color:#e5e2e1;margin-bottom:4px;">Scan to open on your device</div>
      <div id="qrUrlLabel" style="font-size:11px;color:#8a8fa8;margin-bottom:18px;word-break:break-all;"></div>
      <img id="qrImage" src="" alt="QR Code" style="width:200px;height:200px;border-radius:8px;display:block;margin:0 auto 18px;" />
      <button id="btnCloseQr" style="padding:6px 20px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.06);color:#e5e2e1;cursor:pointer;font-size:12px;">Close</button>
    </div>
  </div>

  <!-- ── Share help modal ─────────────────────────────────────── -->
  <div id="shareHelpModal" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.75);align-items:flex-start;justify-content:center;overflow-y:auto;padding:40px 16px;">
    <div style="background:#1a1919;border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:28px 32px;max-width:580px;width:100%;margin:auto;position:relative;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
        <div style="font-size:15px;font-weight:700;color:#e5e2e1;">How to share with another device</div>
        <button id="btnCloseShareHelp" style="background:none;border:none;color:#8a8fa8;cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;">✕</button>
      </div>

      <!-- Scenario tabs -->
      <div style="display:flex;gap:6px;margin-bottom:20px;flex-wrap:wrap;">
        <button class="help-tab active" data-tab="normal" style="padding:4px 12px;border-radius:5px;border:1px solid rgba(0,122,255,0.4);background:rgba(0,122,255,0.15);color:#6db3ff;cursor:pointer;font-size:12px;font-weight:500;">Normal / macOS / Linux</button>
        <button class="help-tab" data-tab="wsl" style="padding:4px 12px;border-radius:5px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:#8a8fa8;cursor:pointer;font-size:12px;font-weight:500;">WSL (Windows)</button>
        <button class="help-tab" data-tab="ssh" style="padding:4px 12px;border-radius:5px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.04);color:#8a8fa8;cursor:pointer;font-size:12px;font-weight:500;">SSH Remote</button>
      </div>

      <!-- Normal tab -->
      <div class="help-pane" id="help-tab-normal">
        ${helpStep(1, 'Find your LAN IP', `
          <b>macOS:</b> System Settings → Network → Wi-Fi → IP Address<br>
          <b>Linux:</b> run <code>ip route get 1 | awk '{print $7; exit}'</code><br>
          <b>Windows (native):</b> run <code>ipconfig</code> → look for <em>IPv4 Address</em> under Wi-Fi
        `)}
        ${helpStep(2, 'Set the host in settings', `
          Open VS Code settings and set <code>aiInsights.shareHost</code> to the IP from step 1 (e.g. <code>192.168.1.42</code>).
          Then click Share again — the generated URL will use that IP.
        `)}
        ${helpStep(3, 'Open the firewall port', `
          <b>macOS:</b> System Settings → Network → Firewall → allow incoming on the share port, or temporarily turn off the firewall.<br>
          <b>Linux:</b> <code>sudo ufw allow &lt;PORT&gt;/tcp</code>
        `)}
        ${helpStep(4, 'Scan the QR code', `
          Click <b>⬛ QR Code</b> — scan it with your phone. Both devices must be on the same Wi-Fi network.
        `)}
      </div>

      <!-- WSL tab -->
      <div class="help-pane" id="help-tab-wsl" style="display:none;">
        ${helpStep(1, 'Fix the share port', `
          Set <code>aiInsights.sharePort</code> to a fixed number, e.g. <code>57312</code>. This lets you configure a permanent Windows firewall rule without re-running the command every session.
        `)}
        ${helpStep(2, 'Find your WSL internal IP', `
          In your WSL terminal:<br>
          <code>hostname -I | awk '{print $1}'</code><br>
          You'll get something like <code>172.26.x.x</code>. This changes on each WSL restart.
        `)}
        ${helpStep(3, 'Find your Windows LAN IP', `
          In PowerShell on Windows:<br>
          <code>ipconfig | findstr "IPv4"</code><br>
          Use the IP under <em>Wireless LAN adapter Wi-Fi</em>, e.g. <code>192.168.1.42</code>.
        `)}
        ${helpStep(4, 'Forward the port (PowerShell Admin)', `
          Replace <code>WSL_IP</code> and <code>PORT</code> with your values:<br>
          <code>netsh interface portproxy add v4tov4 listenport=PORT listenaddress=0.0.0.0 connectport=PORT connectaddress=WSL_IP</code><br>
          <code>New-NetFirewallRule -DisplayName "AI Insights Share" -Direction Inbound -LocalPort PORT -Protocol TCP -Action Allow</code><br><br>
          <b>Shortcut:</b> click <b>Copy Windows Command</b> in the share bar — it fills in your current WSL IP and port automatically.
        `)}
        ${helpStep(5, 'Set the host and scan', `
          Set <code>aiInsights.shareHost</code> to your Windows LAN IP (<code>192.168.1.42</code>). Click <b>⬛ QR Code</b> and scan from your phone.
        `)}
        <div style="margin-top:14px;padding:10px 14px;background:rgba(249,226,175,0.06);border:1px solid rgba(249,226,175,0.18);border-radius:6px;font-size:11.5px;color:#f9e2af;line-height:1.6;">
          <b>Note:</b> WSL IP changes on every WSL restart. Re-run step 4 (or click <b>Copy Windows Command</b> again) whenever it changes.
          With a fixed <code>aiInsights.sharePort</code> the firewall rule is permanent — only the <code>netsh portproxy</code> line needs to be re-run.
        </div>
      </div>

      <!-- SSH Remote tab -->
      <div class="help-pane" id="help-tab-ssh" style="display:none;">
        ${helpStep(1, 'The server runs on the remote machine', `
          When VS Code is connected via SSH, the share server listens on the <em>remote</em> host, not your laptop. Your phone must be able to reach that host directly.
        `)}
        ${helpStep(2, 'Option A — remote host is on your LAN', `
          Find the remote host IP (<code>hostname -I | awk '{print $1}'</code> on the remote). Set <code>aiInsights.shareHost</code> to that IP. Open the firewall port on the remote (<code>sudo ufw allow &lt;PORT&gt;/tcp</code>). Scan the QR code.
        `)}
        ${helpStep(3, 'Option B — remote host is behind NAT / cloud VM', `
          Forward the port through your SSH tunnel. In a local terminal:<br>
          <code>ssh -L 0.0.0.0:PORT:localhost:PORT user@remote-host</code><br>
          Then set <code>aiInsights.shareHost</code> to your <em>laptop's</em> LAN IP and open that port in your laptop firewall. The QR code will then work on your phone.
        `)}
        ${helpStep(4, 'Scan', `
          Click <b>⬛ QR Code</b> and scan. Make sure your phone and the reachable host are on the same network (or the port is publicly exposed).
        `)}
      </div>

    </div>
  </div>

  <!-- ── Content area ──────────────────────────────────────────── -->
  <div class="ns-content">

  <!-- ── Developer Impact ──────────────────────────────────────── -->
  ${(() => {
    const hoursSaved = m.currentMonth.outputTokens / roiConfig.tokensPerHourSaved;
    const valueGenerated = hoursSaved * roiConfig.hourlyRate;
    const aiCost = m.currentMonth.estimatedCost;
    const roiMult = aiCost > 0 ? valueGenerated / aiCost : 0;
    const roiColor = roiMult >= 10 ? 'var(--stage-4)' : roiMult >= 3 ? '#f9e2af' : 'var(--stage-1)';
    const fmtH = (h: number) => h < 1 ? `${Math.round(h * 60)}min` : `${h.toFixed(1)}h`;
    return `<div class="section" style="margin-bottom:24px;">
      <h2 id="devImpactTitle">⏱ Developer Impact - This Month</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;">
        <div class="mini-card"><div class="mini-label">Hours Saved</div><div class="mini-val data-text" id="diHours" style="color:var(--stage-4);">~${fmtH(hoursSaved)}</div></div>
        <div class="mini-card"><div class="mini-label">Value Generated</div><div class="mini-val data-text" id="diValue" style="color:var(--stage-4);">~$${valueGenerated.toFixed(0)}</div></div>
        <div class="mini-card"><div class="mini-label">AI Spend</div><div class="mini-val data-text" id="diCost">${fmtCost(aiCost)}</div></div>
        <div class="mini-card"><div class="mini-label">ROI Multiplier</div><div class="mini-val data-text" id="diRoi" style="color:${roiColor};">${roiMult > 0 ? `~${roiMult.toFixed(0)}×` : '-'}</div></div>
      </div>
    </div>`;
  })()}

  ${healthScore ? (() => {
    const hs = healthScore;
    const compRows = hs.components.map(c => {
      const barPct = c.maxPoints > 0 ? Math.round((c.points / c.maxPoints) * 100) : 0;
      const barColor = barPct >= 80 ? '#39FF14' : barPct >= 50 ? '#f9e2af' : '#f38ba8';
      const scoreText = c.score < 0 ? '-' : `${c.score}/100`;
      return `<tr>
        <td style="font-size:0.85em;">${c.label}</td>
        <td class="data-text" style="text-align:right;font-size:0.82em;color:var(--text-secondary);">${scoreText}</td>
        <td class="data-text" style="text-align:right;font-size:0.85em;font-weight:600;">${c.points}/${c.maxPoints}</td>
        <td style="width:80px;padding-right:8px;">
          <div style="background:rgba(255,255,255,0.08);border-radius:2px;height:4px;overflow:hidden;">
            <div style="background:${barColor};width:${barPct}%;height:100%;"></div>
          </div>
        </td>
        <td style="font-size:0.78em;color:var(--text-secondary);">${c.detail}</td>
      </tr>`;
    }).join('');
    const recItems = hs.topRecommendations.map(r => `<li style="margin-bottom:5px;">${r}</li>`).join('');
    return `<div class="section" style="border-top:3px solid ${hs.gradeColor};margin-bottom:20px;">
      <div style="display:flex;align-items:center;gap:20px;margin-bottom:16px;">
        <div style="text-align:center;min-width:64px;">
          <div style="font-size:3em;font-weight:800;line-height:1;color:${hs.gradeColor};">${hs.grade}</div>
          <div style="font-size:0.72em;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-secondary);margin-top:2px;">AI Health</div>
        </div>
        <div style="flex:1;">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
            <div style="font-size:1.15em;font-weight:600;">Usage Health Score &nbsp;<span class="data-text" style="color:${hs.gradeColor};">${hs.overall}/100</span></div>
          </div>
          <div style="background:rgba(255,255,255,0.06);border-radius:4px;height:8px;overflow:hidden;max-width:320px;">
            <div style="background:${hs.gradeColor};width:${hs.overall}%;height:100%;border-radius:4px;transition:width 0.4s ease;"></div>
          </div>
        </div>
        <div style="min-width:200px;">
          <table style="width:100%;">${compRows}</table>
        </div>
      </div>
      ${recItems ? `<div style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px;">
        <div style="font-size:0.75em;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-secondary);font-weight:600;margin-bottom:8px;">Recommendations</div>
        <ul style="list-style:none;padding:0;margin:0;font-size:0.85em;color:var(--text-secondary);">${recItems}</ul>
      </div>` : ''}
    </div>`;
  })() : ''}

  <div id="cards-overall" class="cards">
    <div class="card" style="border-top: 2px solid var(--primary);">
      <div class="card-label" id="card1-label">Tokens - This Month</div>
      <div class="card-value data-text" id="card1-value">${fmt(m.currentMonth.totalTokens)}</div>
      <div class="card-sub" id="card1-sub">${m.currentMonth.sessions} sessions · ${m.currentMonth.interactions} interactions</div>
      <div class="card-sub" style="margin-top:6px" id="card1-diff">vs last month ${fmtDiff(m.currentMonth.totalTokens, m.lastMonth.totalTokens)}</div>
    </div>
    <div class="card">
      <div class="card-label" id="card2-label">Sessions - This Month</div>
      <div class="card-value data-text" id="card2-value">${m.currentMonth.sessions}</div>
      <div class="card-sub" id="card2-diff">vs last month ${fmtDiff(m.currentMonth.sessions, m.lastMonth.sessions)}</div>
    </div>
    <div class="card">
      <div class="card-label" id="card3-label">Interactions - This Month</div>
      <div class="card-value data-text" id="card3-value">${m.currentMonth.interactions}</div>
      <div class="card-sub" id="card3-diff">vs last month ${fmtDiff(m.currentMonth.interactions, m.lastMonth.interactions)}</div>
    </div>
    ${cacheCards}
  </div>
  <div id="cards-copilot" class="cards" style="display:none">${buildProvCards('copilot')}</div>
  ${copilotBudgetSection}
  ${copilotCacheSection}
  <div id="cards-claudeCode" class="cards" style="display:none">${buildProvCards('claudeCode')}</div>
  <div id="cards-codex" class="cards" style="display:none">${buildProvCards('codex')}</div>
  <div id="cards-antigravity" class="cards" style="display:none">${buildProvCards('antigravity')}</div>

  <!-- ── Daily usage chart ─────────────────────────────────────────── -->
  <div class="section">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
      <h2 style="margin:0">📈 Daily Token Usage - Last 30 Days</h2>
      <div style="display:flex;gap:8px">
        <button class="btn-tab" data-nav="showSessions" data-label="Loading sessions…" style="background:rgba(255,255,255,0.06);color:var(--text-secondary);border:1px solid rgba(255,255,255,0.1);border-radius:6px;padding:6px 14px">📋 Sessions</button>
        <button class="btn-tab" data-nav="showPromptHistory" data-label="Loading prompt history…" style="background:rgba(0,122,255,0.12);color:#007AFF;border:1px solid rgba(0,122,255,0.25);border-radius:6px;padding:6px 14px">⚡ Prompt History</button>
      </div>
    </div>
    <div style="position:relative;height:240px"><canvas id="dashChart"></canvas></div>
  </div>

  <!-- ── Fluency Score ─────────────────────────────────────────────── -->
  <div class="section" style="display:hidden;">
    <h2>🎯 Developer Fluency Score (This Month)</h2>
    <div class="score-card" style="border-left: 4px solid ${getStageColor(overallStage)}">
      <div>
        <div style="font-size: 1.1em; font-weight: 600; margin-bottom: 6px;">Overall: ${overallLabels[overallStage]}</div>
        <div style="font-size: 0.85em; color: var(--text-secondary);">Based on prompt depth, context reuse, agent activity, tool usage, customization, and workflow cadence</div>
      </div>
      <div style="text-align: right;">
        <div style="font-size: 1.8em; font-weight: 500; color: ${getStageColor(overallStage)}; letter-spacing: 2px;" class="data-text">${getStageBar(overallStage)}</div>
      </div>
    </div>
    <div class="score-grid">
      ${[
        ['💬 Prompt Engineering', peStage, `${fmt(interactions)} interactions · ${avgExchanges.toFixed(1)} avg/session`],
        ['📎 Context Engineering', ceStage, `${fmt(month.inputTokens)} input ctx · ${fluencyCacheHitPct}% cache hit`],
        ['🤖 Agentic Usage', agStage, `${agentTurns} agent/CLI turns · ${agentToolCalls} agent tool calls · ${fmt(agentProviderTokens)} agent tokens`],
        ['🔧 Tool Usage', tuStage, `${fmt(totalToolCalls)} calls · ${numTools} unique tools`],
        ['⚙️ Customization', cuStage, `${numModels} models · ${numRepos} repos`],
        ['🔄 Workflow Integration', wiStage, `${sessions} sessions · ${activeDays} active days`],
      ].map(([label, stage, detail]) => `
        <div class="sub-score-card">
          <div style="font-weight: 600; margin-bottom: 6px;">${label}</div>
          <div style="color: ${getStageColor(stage as number)}; margin: 6px 0; letter-spacing: 1px;" class="data-text">${getStageBar(stage as number)} Stage ${stage}/4</div>
          <div style="font-size: 0.82em; color: var(--text-secondary);">${detail}</div>
        </div>`).join('')}
    </div>
  </div>

  <!-- ── Token Breakdown ──────────────────────────────────────────────────── -->
  <div class="section">
    <h2 id="tokenTableTitle">📊 Token Breakdown - This Month</h2>
    <table>
      <thead>
        <tr><th>Metric</th><th id="tokenColA">📆 This Month</th><th id="tokenColB">📅 Last Month</th></tr>
      </thead>
      <tbody id="periodTbody"></tbody>
    </table>
  </div>

  <!-- ── Interaction Modes widget ─────────────────────────────────── -->
  <div class="section">
    <h2>🎯 Interaction Modes</h2>
    <p style="font-size:0.82em;color:var(--text-secondary);margin:-14px 0 18px">How you use AI tools - Ask (chat), Edit (code edits), Agent (autonomous), CLI</p>
    <table>
      <thead><tr>
        <th>Mode</th>
        <th style="text-align:right">Interactions</th>
        <th style="text-align:right">Share</th>
        <th></th>
      </tr></thead>
      <tbody id="modeWidgetTbody"><!-- filled by JS --></tbody>
    </table>
  </div>

  <!-- ── Provider breakdown ─────────────────────────────────────────── -->
  <div class="section" id="section-providers">
    <h2 id="providerTableTitle">🤖 Usage by Provider - This Month</h2>
    <table>
      <thead><tr><th>Provider</th><th>Tokens</th><th>Sessions</th><th>Interactions</th><th>Cache Hit</th></tr></thead>
      <tbody id="providerTbody"></tbody>
    </table>
  </div>


  <!-- ── Provider Cost per 1K Output ─────────────────────────────── -->
  <div class="section" id="section-provider-cost">
    <h2>💸 Provider Cost per 1K Output Tokens</h2>
    <p style="font-size:0.82em;color:var(--text-secondary);margin:-14px 0 16px">Efficiency comparison - lower $/1K = more output value per dollar spent</p>
    <table>
      <thead><tr><th>Provider</th><th style="text-align:right">Total Cost</th><th style="text-align:right">Output Tokens</th><th style="text-align:right">$/1K Output</th></tr></thead>
      <tbody id="provCostTbody"></tbody>
    </table>
  </div>

  <!-- ── Anomaly & Risk Detection ──────────────────────────────────── -->
  <div class="section" id="section-anomaly">
    <h2>🔔 Anomaly &amp; Risk Detection</h2>
    <p style="font-size:0.82em;color:var(--text-secondary);margin:-14px 0 16px">Automatic detection of unusual spend patterns, runaway sessions, and budget risk</p>
    <div id="anomalyBadges"></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-top:16px;">
      <div class="mini-card"><div class="mini-label">Today's Z-Score</div><div class="mini-val data-text" id="anomalyZScore" style="color:${Math.abs(m.anomaly.todayZScore) > 2 ? '#FF4D4D' : 'var(--text-primary)'};">${m.anomaly.todayZScore.toFixed(2)}σ</div></div>
      <div class="mini-card"><div class="mini-label">Runaway Sessions</div><div class="mini-val data-text" style="color:${m.anomaly.runawaySessionsCount > 0 ? '#FF4D4D' : 'var(--stage-4)'};">${m.anomaly.runawaySessionsCount}</div></div>
      <div class="mini-card"><div class="mini-label">Burn Acceleration</div><div class="mini-val data-text" style="color:${m.anomaly.burnAcceleration > 1.2 ? '#f9e2af' : 'var(--text-primary)'};">${m.anomaly.burnAcceleration.toFixed(2)}×</div></div>
      <div class="mini-card"><div class="mini-label">Consecutive High Days</div><div class="mini-val data-text" style="color:${m.anomaly.consecutiveHighDays >= 3 ? '#f9e2af' : 'var(--text-primary)'};">${m.anomaly.consecutiveHighDays}</div></div>
    </div>
  </div>

  <!-- ── Copilot: Suggestion Acceptance Rate ────────────────────── -->
  <div id="section-copilot-acceptance" class="section" style="display:none;">
    <h2>🎯 Suggestion Acceptance Rate <span style="font-size:0.7em;font-weight:400;color:var(--text-secondary);">live · resets on reload</span></h2>
    <p style="font-size:0.82em;color:var(--text-secondary);margin:-14px 0 16px">Quality proxy: how often Copilot ghost-text is accepted vs. triggered.</p>
    ${(() => {
      const a = acceptance ?? { triggered: 0, accepted: 0, acceptanceRate: 0, since: new Date() };
      const pct = Math.round(a.acceptanceRate * 100);
      const col = pct >= 30 ? 'var(--stage-4)' : pct >= 10 ? '#f9e2af' : 'var(--stage-1)';
      const lbl = pct >= 30 ? 'Good' : pct >= 10 ? 'Fair' : a.triggered === 0 ? 'No data yet' : 'Low';
      return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:16px;">
      <div class="mini-card"><div class="mini-label">Acceptance Rate</div><div class="mini-val data-text" style="font-size:1.6em;color:${col};">${a.triggered === 0 ? '-' : pct + '%'}</div><div style="font-size:0.75em;color:${col};margin-top:4px;">${lbl}</div></div>
      <div class="mini-card"><div class="mini-label">Completions Accepted</div><div class="mini-val data-text">${a.accepted.toLocaleString()}</div></div>
      <div class="mini-card"><div class="mini-label">Ghost-text Triggers</div><div class="mini-val data-text">${a.triggered.toLocaleString()}</div></div>
    </div>
    ${a.triggered > 0 ? `<div style="background:var(--bg-surface-high);border-radius:4px;padding:12px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:0.85em;color:var(--text-secondary);min-width:80px;">Acceptance</span>
        <div style="flex:1;background:var(--bg-base);border-radius:4px;height:6px;overflow:hidden;"><div style="background:${col};width:${Math.min(100, pct)}%;height:100%;"></div></div>
        <span class="data-text" style="font-size:0.85em;min-width:36px;">${pct}%</span>
      </div></div>` : ''}`;
    })()}
  </div>

  <!-- ── MCP Tools ───────────────────────────────────────────────────── -->
  <div class="section">
    <h2 id="mcpTitle">🔌 MCP Tools - This Month</h2>
    <p style="font-size:0.82em;color:var(--text-secondary);margin:-14px 0 16px">Model Context Protocol server calls</p>
    <div style="margin-bottom:6px;font-size:0.82em;color:var(--text-secondary)" id="mcpTotal"></div>
    <table>
      <thead><tr><th>#</th><th>Server</th><th style="text-align:right">Calls</th><th></th></tr></thead>
      <tbody id="mcpTbody"></tbody>
    </table>
  </div>

  <!-- ── Repository cost ───────────────────────────────────────────── -->
  <div class="section">
    <h2 id="repoSectionTitle">📁 Usage by Repository (This Month)</h2>
    <table>
      <thead><tr><th>Repository</th><th>Tokens</th><th>Cost</th><th>Share</th></tr></thead>
      <tbody id="repoTbody">${repoRows || '<tr><td colspan="4" style="color:var(--text-secondary)">No repository data</td></tr>'}</tbody>
    </table>
  </div>

  ${githubUser ? '<button class="copilot-pill" onclick="window.vscode.postMessage({command:\'showPricing\'})">🐙 ' + fmtCredits(copilotMonth.estimatedCost) + ' credits · ' + githubUser.login + '</button>' : ''}
  <div class="footer">AI Insights · Token usage is tracked locally. ${githubUser ? '1 GitHub Copilot AI credit = $0.01 USD.' : 'Connect GitHub Copilot to see budget tracking.'}</div>
  </div><!-- /ns-content -->
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <script>
    if (typeof window.vscode === 'undefined') {
      window.vscode = acquireVsCodeApi();
    }

    var allPeriodData = ${allPeriodDataJson};
    var allRepoData = ${allRepoDataJson};
    var allPeriodRepoData = ${allPeriodRepoDataJson};
    var allModeData = ${allModeDataJson};
    var allPeriodSummary = ${allPeriodSummaryJson};
    var allPeriodDevImpact = ${allPeriodDevImpactJson};
    var allPeriodProviderData = ${allPeriodProviderDataJson};
    var allPeriodMcpData = ${allPeriodMcpDataJson};
    var providerCostData = ${providerCostDataJson};
    var _currentPeriod = 'currentMonth';
    var _currentProv = 'overall';

    // ── Anomaly badges (pre-rendered) ─────────────────────────────────────────
    (function() {
      var el = document.getElementById('anomalyBadges');
      if (el) { el.innerHTML = ${JSON.stringify(anomalyBadgesHtml)}; }
    })();

    // ── Provider cost per 1K output table ────────────────────────────────────
    (function() {
      var tbody = document.getElementById('provCostTbody');
      if (!tbody || !providerCostData.length) { return; }
      var NAMES = { copilot: 'GitHub Copilot', claudeCode: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };
      var bestId = providerCostData[0] ? providerCostData[0].id : '';
      tbody.innerHTML = providerCostData.map(function(d) {
        var name = NAMES[d.id] || d.id;
        var isBest = d.id === bestId;
        return '<tr' + (isBest ? ' style="background:rgba(57,255,20,0.04)"' : '') + '>'
          + '<td>' + name + (isBest ? ' <span style="font-size:0.75em;color:var(--stage-4)">★ best</span>' : '') + '</td>'
          + '<td class="data-text" style="text-align:right">$' + d.totalCost.toFixed(4) + '</td>'
          + '<td class="data-text" style="text-align:right">' + fmtN(d.outputTokens) + '</td>'
          + '<td class="data-text" style="text-align:right">$' + d.costPer1K.toFixed(4) + '</td>'
          + '</tr>';
      }).join('');
    })();

    function fmtN(n) {
      return n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n);
    }
    function fmtC(n) { return '$'+n.toFixed(4); }


    function updateWidgets(prov) {
      _currentProv = prov;
      // All period-aware widgets are owned by the global period selector.
      // Re-render them for the current period whenever provider changes.
      if (typeof window._setGlobalPeriod === 'function') {
        window._setGlobalPeriod(_currentPeriod);
      }
    }


    /* ── Navigation loading feedback ─────────────────────── */
    (function() {
      function clearAllLoading() {
        document.querySelectorAll('.is-loading').forEach(function(el) {
          el.classList.remove('is-loading');
        });
        var refreshBtn = document.getElementById('btnRefresh');
        if (refreshBtn) refreshBtn.textContent = '↺ Refresh';
        document.querySelectorAll('[data-nav]').forEach(function(btn) {
          if (btn._origLabel) btn.innerHTML = btn._origLabel;
        });
        var overlay = document.getElementById('navOverlay');
        if (overlay) { overlay.style.display = 'none'; }
      }

      // Tab navigation buttons
      document.querySelectorAll('[data-nav]').forEach(function(btn) {
        btn._origLabel = btn.innerHTML;
        btn.addEventListener('click', function() {
          btn.classList.add('is-loading');
          var overlay = document.getElementById('navOverlay');
          var overlayText = document.getElementById('navOverlayText');
          if (overlay && overlayText) {
            overlayText.textContent = btn.getAttribute('data-label') || 'Loading…';
            overlay.style.display = 'flex';
          }
          window.vscode.postMessage({ command: btn.getAttribute('data-nav') });
          setTimeout(clearAllLoading, 4000);
        });
      });

      // Refresh button
      var refreshBtn = document.getElementById('btnRefresh');
      if (refreshBtn) {
        refreshBtn.addEventListener('click', function() {
          refreshBtn.classList.add('is-loading');
          refreshBtn.textContent = '⟳ Refreshing…';
          window.vscode.postMessage({ command: 'refresh' });
          setTimeout(clearAllLoading, 5000);
        });
      }

      // Share button
      var shareBtn = document.getElementById('btnShare');
      if (shareBtn) {
        shareBtn.addEventListener('click', function() {
          shareBtn.textContent = '⬆ Starting…';
          shareBtn.style.opacity = '0.6';
          shareBtn.style.pointerEvents = 'none';
          // Show connecting state immediately so the user knows the click registered
          var sp = document.getElementById('sharePanel');
          var sr = document.getElementById('shareUrlRows');
          if (sp && sr) {
            sr.innerHTML = '<span style="font-size:12px;color:var(--text-secondary);">Starting local server…</span>';
            sp.style.display = 'block';
          }
          window.vscode.postMessage({ command: 'startSharing' });
          // Restore button after timeout regardless of outcome
          setTimeout(function() {
            shareBtn.textContent = '⬆ Share';
            shareBtn.style.opacity = '';
            shareBtn.style.pointerEvents = '';
          }, 8000);
        });
      }

      // Reset on visibility change (backup)
      document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible') { clearAllLoading(); }
      });
    })();
    var dashChart = null;
    try { (function() {
      if (typeof Chart === 'undefined') { throw new Error('Chart.js not loaded'); }
      var allData = ${allChartDataJson};
      Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
      Chart.defaults.color = '#c1c6d7';

      function buildChart(data) {
        if (dashChart) { dashChart.destroy(); dashChart = null; }
        if (!data || !data.labels.length) { return; }
        dashChart = new Chart(document.getElementById('dashChart'), {
          type: 'bar',
          data: {
            labels: data.labels,
            datasets: [
              {
                type: 'bar',
                label: 'Tokens',
                data: data.tokens,
                backgroundColor: 'rgba(0,122,255,0.45)',
                borderColor: '#007AFF',
                borderWidth: 1,
                yAxisID: 'y',
              },
              {
                type: 'line',
                label: 'Cost (USD)',
                data: data.costs,
                borderColor: '#39FF14',
                backgroundColor: 'rgba(57,255,20,0.06)',
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: '#39FF14',
                tension: 0.3,
                fill: true,
                yAxisID: 'y2',
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { labels: { color: '#c1c6d7', font: { size: 11 }, boxWidth: 12, padding: 12 } },
              tooltip: {
                callbacks: {
                  label: function(ctx) {
                    if (ctx.datasetIndex === 0) {
                      var v = ctx.parsed.y;
                      return ' Tokens: ' + (v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(1)+'K' : v);
                    }
                    return ' Cost: $' + ctx.parsed.y.toFixed(4);
                  },
                },
              },
            },
            scales: {
              x: { grid: { display: false }, ticks: { maxRotation: 45, font: { size: 10 } } },
              y: {
                beginAtZero: true,
                position: 'left',
                grid: { color: 'rgba(255,255,255,0.05)' },
                ticks: { color: '#007AFF', callback: function(v) { return v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(1)+'K' : v; } },
              },
              y2: {
                beginAtZero: true,
                position: 'right',
                grid: { display: false },
                ticks: { color: '#39FF14', callback: function(v) { return '$' + Number(v).toFixed(3); } },
              },
            },
          },
        });
      }

      buildChart(allData.overall);

      // Provider switcher logic
      var provBtns = document.querySelectorAll('.prov-btn');
      var sectionProviders = document.getElementById('section-providers');
      var provIds = ['overall', 'copilot', 'claudeCode', 'codex', 'antigravity'];
      provBtns.forEach(function(btn) {
        btn.addEventListener('click', function() {
          var prov = btn.getAttribute('data-prov');
          provBtns.forEach(function(b) { b.classList.remove('active'); });
          btn.classList.add('active');
          provIds.forEach(function(id) {
            var el = document.getElementById('cards-' + id);
            if (el) { el.style.display = id === prov ? '' : 'none'; }
          });
          var copilotOnly = ['section-copilot-budget', 'section-copilot-cache', 'section-copilot-acceptance'];
          copilotOnly.forEach(function(id) {
            var el = document.getElementById(id);
            if (el) { el.style.display = prov === 'copilot' ? '' : 'none'; }
          });
          if (sectionProviders) {
            sectionProviders.style.display = prov === 'overall' ? '' : 'none';
          }
          var sectionProvCost = document.getElementById('section-provider-cost');
          if (sectionProvCost) { sectionProvCost.style.display = prov === 'overall' ? '' : 'none'; }
          buildChart(allData[prov] || allData.overall);
          updateWidgets(prov);
        });
      });
    })(); } catch(e) { console.error('[AI Insights] Chart.js failed to load:', e); }

    // ── Global period selector ─────────────────────────────────────────────
    (function() {
      var MODE_META = {
        ask:         { label: 'Ask Mode',     icon: '\ud83d\udcac' },
        edit:        { label: 'Edit Mode',    icon: '\u270f\ufe0f' },
        agent:       { label: 'Agent Mode',   icon: '\ud83e\udd16' },
        plan:        { label: 'Plan Mode',    icon: '\ud83d\udccb' },
        customAgent: { label: 'Custom Agent', icon: '\u26a1' },
        cli:         { label: 'CLI',          icon: '\ud83d\udcbb' },
      };

      var PERIOD_LABELS = {
        today:        'Today',
        yesterday:    'Yesterday',
        currentMonth: 'This Month',
        lastMonth:    'Last Month',
        thisYear:     'This Year',
        allTime:      'Overall',
      };
      var CMP_PERIOD = {
        today:        'yesterday',
        yesterday:    null,
        currentMonth: 'lastMonth',
        lastMonth:    null,
        thisYear:     null,
        allTime:      null,
      };

      function fmtN2(n) {
        return n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : String(n);
      }
      function fmtDiff2(cur, prev) {
        if (!prev && prev !== 0) { return ''; }
        if (prev === 0) { return cur > 0 ? '<span style="color:#39FF14">new \u2191</span>' : ''; }
        var pct = (cur - prev) / prev * 100;
        var up = pct >= 0;
        return '<span style="color:'+(up?'#39FF14':'#FF6B6B')+'">'+(up?'\u2191':'\u2193')+' '+Math.abs(pct).toFixed(0)+'%</span>';
      }

      // ── Main summary cards (overall provider only) ──────────────────────
      function updateMainCards(period) {
        var ps = allPeriodSummary[period] || {};
        var cmpKey = CMP_PERIOD[period];
        var prev = cmpKey ? (allPeriodSummary[cmpKey] || {}) : null;
        var pd = (allPeriodData.overall || {})[period] || {};
        var label = PERIOD_LABELS[period] || period;
        var cmpLabel = cmpKey ? ('vs ' + PERIOD_LABELS[cmpKey]) : '';

        // Card 1: Tokens
        var c1V = document.getElementById('card1-value');
        var c1L = document.getElementById('card1-label');
        var c1S = document.getElementById('card1-sub');
        var c1D = document.getElementById('card1-diff');
        if (c1V) c1V.textContent = fmtN2(ps.totalTokens || 0);
        if (c1L) c1L.textContent = 'Tokens \u2014 ' + label;
        if (c1S) c1S.textContent = (ps.sessions||0)+' sessions \u00b7 '+(ps.interactions||0)+' interactions';
        if (c1D && prev) { c1D.innerHTML = cmpLabel ? cmpLabel+' '+fmtDiff2(ps.totalTokens||0, prev.totalTokens||0) : ''; }
        else if (c1D) { c1D.innerHTML = ''; }

        // Card 2: Sessions
        var c2V = document.getElementById('card2-value');
        var c2L = document.getElementById('card2-label');
        var c2D = document.getElementById('card2-diff');
        if (c2V) c2V.textContent = ps.sessions || 0;
        if (c2L) c2L.textContent = 'Sessions \u2014 ' + label;
        if (c2D && prev) { c2D.innerHTML = cmpLabel ? cmpLabel+' '+fmtDiff2(ps.sessions||0, prev.sessions||0) : ''; }
        else if (c2D) { c2D.innerHTML = ''; }

        // Card 3: Interactions
        var c3V = document.getElementById('card3-value');
        var c3L = document.getElementById('card3-label');
        var c3D = document.getElementById('card3-diff');
        if (c3V) c3V.textContent = ps.interactions || 0;
        if (c3L) c3L.textContent = 'Interactions \u2014 ' + label;
        if (c3D && prev) { c3D.innerHTML = cmpLabel ? cmpLabel+' '+fmtDiff2(ps.interactions||0, prev.interactions||0) : ''; }
        else if (c3D) { c3D.innerHTML = ''; }
      }

      // ── Token breakdown table ────────────────────────────────────────────
      function updateTokenTable(period) {
        var pd = (allPeriodData.overall || {})[period] || {};
        var cmpKey = CMP_PERIOD[period];
        var cpd = cmpKey ? ((allPeriodData.overall || {})[cmpKey] || {}) : null;
        var label = PERIOD_LABELS[period] || period;
        var cmpLabel = cmpKey ? PERIOD_LABELS[cmpKey] : '';

        var titleEl = document.getElementById('tokenTableTitle');
        var colA = document.getElementById('tokenColA');
        var colB = document.getElementById('tokenColB');
        if (titleEl) { titleEl.textContent = '\ud83d\udcca Token Breakdown \u2014 '+label; }
        if (colA) { colA.textContent = label; }
        if (colB) { colB.textContent = cmpLabel || 'Comparison'; colB.style.opacity = cpd ? '' : '0.4'; }

        var tbody = document.getElementById('periodTbody');
        if (!tbody) { return; }
        function row(icon, name, val, cmpVal) {
          var cmpCell = cpd
            ? '<td class="data-text">'+fmtN2(cmpVal || 0)+'</td>'
            : '<td style="color:var(--text-secondary)">-</td>';
          return '<tr><td>'+icon+' '+name+'</td><td class="data-text">'+fmtN2(val || 0)+'</td>'+cmpCell+'</tr>';
        }
        function rowRaw(icon, name, val, cmpVal) {
          var cmpCell = cpd
            ? '<td class="data-text">'+(cmpVal || 0)+'</td>'
            : '<td style="color:var(--text-secondary)">-</td>';
          return '<tr><td>'+icon+' '+name+'</td><td class="data-text">'+(val || 0)+'</td>'+cmpCell+'</tr>';
        }
        var cp = cpd || {};
        tbody.innerHTML = [
          row('\ud83d\udd35','Tokens (total)',       pd.totalTokens,                  cp.totalTokens),
          row('\ud83d\udce5','Input tokens',          pd.inputTokens,                  cp.inputTokens),
          row('\ud83d\udce4','Output tokens',         pd.outputTokens,                 cp.outputTokens),
          row('\ud83e\udde0','Thinking tokens',       pd.thinkingTokens,               cp.thinkingTokens),
          row('\u26a1','Cache read tokens',           pd.cacheReadTokens,              cp.cacheReadTokens),
          rowRaw('\ud83d\udccb','Sessions',           pd.sessions,                     cp.sessions),
          row('\ud83d\udcac','Avg tokens/session',    pd.avgTokensPerSession,          cp.avgTokensPerSession),
          rowRaw('\ud83d\udd04','Avg interactions/session', pd.avgInteractionsPerSession, cp.avgInteractionsPerSession),
        ].join('');
      }

      // ── Interaction modes table ──────────────────────────────────────────
      function updateModeTable(period) {
        var breakdown = allModeData[period] || {};
        var total = Object.values(breakdown).reduce(function(s,n){ return s+n; }, 0);
        var tbody = document.getElementById('modeWidgetTbody');
        if (!tbody) { return; }
        tbody.innerHTML = Object.keys(MODE_META).map(function(key) {
          var meta = MODE_META[key];
          var count = breakdown[key] || 0;
          var pct = total > 0 ? Math.round((count/total)*100) : 0;
          return '<tr>'
            +'<td>'+meta.icon+' '+meta.label+'</td>'
            +'<td class="data-text" style="text-align:right">'+count.toLocaleString()+'</td>'
            +'<td style="text-align:right;color:var(--text-secondary);font-size:0.85em">'+pct+'%</td>'
            +'<td style="width:120px;padding-right:16px"><div style="background:var(--bg-base);border-radius:2px;height:4px;overflow:hidden;min-width:80px"><div style="background:var(--primary);width:'+pct+'%;height:100%"></div></div></td>'
            +'</tr>';
        }).join('');
      }

      // ── Repo table ───────────────────────────────────────────────────────
      function updateRepoTable(period) {
        var rd = allPeriodRepoData[period] || allPeriodRepoData.currentMonth || {};
        var repoTbody = document.getElementById('repoTbody');
        var repoTitle = document.getElementById('repoSectionTitle');
        var label = PERIOD_LABELS[period] || period;
        if (repoTitle) { repoTitle.textContent = '\ud83d\udcc1 Usage by Repository \u2014 ' + label; }
        if (!repoTbody) { return; }
        if (!rd.items || !rd.items.length) {
          repoTbody.innerHTML = '<tr><td colspan="4" style="color:var(--text-secondary)">No repository data</td></tr>';
        } else {
          repoTbody.innerHTML = rd.items.map(function(item) {
            var pct = rd.totalCost > 0 ? Math.round((item.cost/rd.totalCost)*100) : 0;
            return '<tr><td class="data-text">'+item.repo+'</td><td class="data-text">'+fmtN(item.tokens)+'</td><td class="data-text">'+fmtC(item.cost)+'</td>'
              +'<td style="width:100px;padding-right:12px"><div style="background:rgba(255,255,255,0.08);border-radius:2px;height:4px;overflow:hidden"><div style="background:#007AFF;width:'+pct+'%;height:100%"></div></div><span style="font-size:0.75em;color:var(--text-secondary)">'+pct+'%</span></td></tr>';
          }).join('');
        }
      }

      // ── Developer Impact ──────────────────────────────────────────────────
      var PROV_NAMES = { copilot: 'GitHub Copilot', claudeCode: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };
      function updateDevImpact(period) {
        var di = allPeriodDevImpact[period] || {};
        var label = PERIOD_LABELS[period] || period;
        var h = di.hoursSaved || 0;
        var hStr = h < 1 ? Math.round(h * 60) + 'min' : h.toFixed(1) + 'h';
        var roiColor = di.roiMult >= 10 ? 'var(--stage-4)' : di.roiMult >= 3 ? '#f9e2af' : 'var(--stage-1)';
        var titleEl = document.getElementById('devImpactTitle');
        var diHours = document.getElementById('diHours');
        var diValue = document.getElementById('diValue');
        var diCost  = document.getElementById('diCost');
        var diRoi   = document.getElementById('diRoi');
        if (titleEl) { titleEl.textContent = '\u23f1 Developer Impact \u2014 ' + label; }
        if (diHours) { diHours.textContent = '~' + hStr; }
        if (diValue) { diValue.textContent = '~$' + (di.valueGenerated || 0).toFixed(0); }
        if (diCost)  { diCost.textContent  = '$' + (di.aiCost || 0).toFixed(4); }
        if (diRoi)   { diRoi.style.color = roiColor; diRoi.textContent = di.roiMult > 0 ? '~' + (di.roiMult).toFixed(0) + '\u00d7' : '-'; }
      }

      // ── Provider table ────────────────────────────────────────────────────
      function updateProviderTable(period) {
        var pd = allPeriodProviderData[period] || {};
        var label = PERIOD_LABELS[period] || period;
        var titleEl = document.getElementById('providerTableTitle');
        var tbody = document.getElementById('providerTbody');
        if (titleEl) { titleEl.textContent = '\ud83e\udd16 Usage by Provider \u2014 ' + label; }
        if (!tbody) { return; }
        var provOrder = ['copilot', 'claudeCode', 'codex', 'antigravity'];
        tbody.innerHTML = provOrder.map(function(pid) {
          var p = pd[pid] || { totalTokens:0, sessions:0, interactions:0, cacheHitPct:0 };
          var name = PROV_NAMES[pid] || pid;
          return '<tr><td>' + name + '</td>'
            + '<td class="data-text">' + fmtN(p.totalTokens) + '</td>'
            + '<td class="data-text">' + p.sessions + '</td>'
            + '<td class="data-text">' + p.interactions + '</td>'
            + '<td class="data-text">' + p.cacheHitPct + '%</td></tr>';
        }).join('');
      }

      // ── MCP table ─────────────────────────────────────────────────────────
      function updateMcpTable(period) {
        var md = allPeriodMcpData[period] || { total: 0, servers: [] };
        var label = PERIOD_LABELS[period] || period;
        var titleEl = document.getElementById('mcpTitle');
        var totalEl = document.getElementById('mcpTotal');
        var tbody = document.getElementById('mcpTbody');
        if (titleEl) { titleEl.textContent = '\ud83d\udd0c MCP Tools \u2014 ' + label; }
        if (totalEl) { totalEl.textContent = 'Total MCP calls: ' + (md.total || 0).toLocaleString(); }
        if (!tbody) { return; }
        if (!md.servers || !md.servers.length) {
          tbody.innerHTML = '<tr><td colspan="4" style="color:var(--text-secondary);text-align:center;padding:16px">No MCP servers detected</td></tr>';
          return;
        }
        var maxCalls = md.servers[0] ? md.servers[0][1] : 1;
        tbody.innerHTML = md.servers.map(function(entry, i) {
          var server = entry[0]; var count = entry[1];
          var pct = maxCalls > 0 ? Math.round((count / maxCalls) * 100) : 0;
          return '<tr>'
            + '<td style="color:var(--text-secondary);width:32px">' + (i+1) + '</td>'
            + '<td><strong>' + server + '</strong></td>'
            + '<td class="data-text" style="text-align:right">' + count.toLocaleString() + '</td>'
            + '<td style="width:100px;padding-right:12px"><div style="background:rgba(255,255,255,0.08);border-radius:2px;height:4px;overflow:hidden"><div style="background:#39FF14;width:'+pct+'%;height:100%"></div></div></td>'
            + '</tr>';
        }).join('');
      }

      // ── Master: apply all widgets for a period ───────────────────────────
      function setGlobalPeriod(period) {
        _currentPeriod = period;
        updateMainCards(period);
        updateDevImpact(period);
        updateProviderTable(period);
        updateMcpTable(period);
        updateTokenTable(period);
        updateModeTable(period);
        updateRepoTable(period);
      }
      // Expose so the provider switcher can trigger a re-render
      window._setGlobalPeriod = setGlobalPeriod;

      // Initial render
      setGlobalPeriod('currentMonth');

      // Wire global period buttons
      document.querySelectorAll('.mode-period-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          document.querySelectorAll('.mode-period-btn').forEach(function(b){ b.classList.remove('active'); });
          btn.classList.add('active');
          setGlobalPeriod(btn.getAttribute('data-period'));
        });
      });
    })();

    /* ── Share panel ─────────────────────────────────────────── */
    (function() {
      var sharePanel = document.getElementById('sharePanel');
      var shareUrlRows = document.getElementById('shareUrlRows');
      var shareWarning = document.getElementById('shareWarning');
      var stopBtn = document.getElementById('btnStopSharing');
      var qrBtn = document.getElementById('btnShowQr');
      var qrModal = document.getElementById('qrModal');
      var qrImage = document.getElementById('qrImage');
      var qrUrlLabel = document.getElementById('qrUrlLabel');
      var closeQrBtn = document.getElementById('btnCloseQr');
      var helpBtn = document.getElementById('btnShareHelp');
      var helpModal = document.getElementById('shareHelpModal');
      var closeHelpBtn = document.getElementById('btnCloseShareHelp');
      var currentQrDataUrl = null;
      var currentQrUrl = null;

      if (stopBtn) {
        stopBtn.addEventListener('click', function() {
          window.vscode.postMessage({ command: 'stopSharing' });
          if (sharePanel) { sharePanel.style.display = 'none'; }
          if (qrModal) { qrModal.style.display = 'none'; }
          if (helpModal) { helpModal.style.display = 'none'; }
        });
      }

      if (helpBtn) {
        helpBtn.addEventListener('click', function() {
          if (helpModal) { helpModal.style.display = 'flex'; }
        });
      }
      if (closeHelpBtn) {
        closeHelpBtn.addEventListener('click', function() {
          if (helpModal) { helpModal.style.display = 'none'; }
        });
      }
      if (helpModal) {
        helpModal.addEventListener('click', function(e) {
          if (e.target === helpModal) { helpModal.style.display = 'none'; }
        });
      }
      document.querySelectorAll('.help-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
          var target = tab.getAttribute('data-tab');
          document.querySelectorAll('.help-tab').forEach(function(t) {
            var active = t.getAttribute('data-tab') === target;
            t.style.background = active ? 'rgba(0,122,255,0.15)' : 'rgba(255,255,255,0.04)';
            t.style.borderColor = active ? 'rgba(0,122,255,0.4)' : 'rgba(255,255,255,0.1)';
            t.style.color = active ? '#6db3ff' : '#8a8fa8';
          });
          document.querySelectorAll('.help-pane').forEach(function(pane) {
            pane.style.display = pane.id === 'help-tab-' + target ? 'block' : 'none';
          });
        });
      });

      if (qrBtn) {
        qrBtn.addEventListener('click', function() {
          if (!currentQrDataUrl || !qrModal) { return; }
          if (qrImage) { qrImage.src = currentQrDataUrl; }
          if (qrUrlLabel) { qrUrlLabel.textContent = currentQrUrl || ''; }
          qrModal.style.display = 'flex';
        });
      }

      if (closeQrBtn) {
        closeQrBtn.addEventListener('click', function() {
          if (qrModal) { qrModal.style.display = 'none'; }
        });
      }

      if (qrModal) {
        qrModal.addEventListener('click', function(e) {
          if (e.target === qrModal) { qrModal.style.display = 'none'; }
        });
      }

      function makeUrlRow(label, url) {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;';
        var labelEl = document.createElement('span');
        labelEl.style.cssText = 'font-size:11px;color:var(--text-secondary);min-width:110px;flex-shrink:0;';
        labelEl.textContent = label;
        var codeEl = document.createElement('code');
        codeEl.style.cssText = 'flex:1;font-size:12px;color:#e5e2e1;background:rgba(255,255,255,0.06);padding:3px 8px;border-radius:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        codeEl.textContent = url;
        var copyBtn = document.createElement('button');
        copyBtn.style.cssText = 'flex-shrink:0;padding:3px 9px;border-radius:4px;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-secondary);cursor:pointer;font-size:11px;';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', function() {
          navigator.clipboard.writeText(url).then(function() {
            copyBtn.textContent = '✓';
            setTimeout(function() { copyBtn.textContent = 'Copy'; }, 1500);
          });
        });
        row.appendChild(labelEl);
        row.appendChild(codeEl);
        row.appendChild(copyBtn);
        return row;
      }

      window.addEventListener('message', function(event) {
        var msg = event.data;
        if (!sharePanel || !shareUrlRows) { return; }
        if (msg.type !== 'sharingStarted' && msg.type !== 'sharingStopped' && msg.type !== 'sharingError') { return; }

        if (msg.type === 'sharingStarted') {
          shareUrlRows.innerHTML = '';
          shareUrlRows.appendChild(makeUrlRow('This computer:', msg.localUrl));
          (msg.lanUrls || []).forEach(function(url, i) {
            shareUrlRows.appendChild(makeUrlRow(i === 0 ? 'On your network:' : 'Alt. LAN URL:', url));
          });
          if (msg.warning && shareWarning) {
            shareWarning.textContent = msg.warning;
            shareWarning.style.display = 'block';
          } else if (shareWarning) {
            shareWarning.style.display = 'none';
          }
          if (msg.qrDataUrl && qrBtn) {
            currentQrDataUrl = msg.qrDataUrl;
            currentQrUrl = (msg.lanUrls && msg.lanUrls[0]) || msg.localUrl;
            qrBtn.style.display = 'inline-flex';
          } else if (qrBtn) {
            qrBtn.style.display = 'none';
          }
          sharePanel.style.display = 'block';
        }

        if (msg.type === 'sharingError') {
          shareUrlRows.innerHTML = '<span style="font-size:12px;color:#ff8a8a;">⚠ ' + (msg.error || 'Unknown error') + '</span>';
          if (qrBtn) { qrBtn.style.display = 'none'; }
          sharePanel.style.display = 'block';
        }

        if (msg.type === 'sharingStopped') {
          sharePanel.style.display = 'none';
          if (qrModal) { qrModal.style.display = 'none'; }
          if (qrBtn) { qrBtn.style.display = 'none'; }
          currentQrDataUrl = null;
        }
      });
    })();
  </script>
</body>
</html>`;
  }
}
