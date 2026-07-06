import * as vscode from 'vscode';
import { AggregatedMetrics, RepositoryHygieneReport, FileStatus, AcceptanceMetrics } from '../types';
import { providerIcon } from './providerIcons';
import { navCss, navTopbarHtml, navPagebarHtml, navJs, NAV_COMMANDS } from './navShared';
import { designTokensCss } from './designSystem';


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

function fmt(n: number): string {
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' :
    n >= 1_000 ? (n / 1_000).toFixed(1) + 'K' : n.toString();
}

function fmtCost(n: number): string { return '$' + n.toFixed(4); }

function tip(text: string): string {
  return `<span title="${text}" style="cursor:help;color:var(--text-secondary);font-size:0.85em;margin-left:3px;vertical-align:middle;">ⓘ</span>`;
}

function buildModeTable(modeBreakdown: Record<string, number>): string {
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
    <thead><tr>
      <th>Mode</th><th style="text-align:right;">Interactions</th>
      <th style="text-align:right;">Share</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}


function buildMcpServerTable(toolCalls: Record<string, number>): string {
  const serverMap = new Map<string, number>();
  for (const [name, count] of Object.entries(toolCalls)) {
    const server = parseMcpServer(name);
    if (server) { serverMap.set(server, (serverMap.get(server) || 0) + count); }
  }
  if (serverMap.size === 0) {
    return '<tr><td colspan="3" style="color:var(--text-secondary);padding:16px;text-align:center;">No MCP servers detected</td></tr>';
  }
  return [...serverMap.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([server, count], i) => `<tr>
      <td style="color:var(--text-secondary);width:32px;">${i + 1}</td>
      <td><strong>${server}</strong></td>
      <td class="data-text" style="text-align:right;">${count.toLocaleString()}</td>
    </tr>`).join('');
}

function buildMcpChips(toolCalls: Record<string, number>): string {
  const mcpTools = Object.entries(toolCalls)
    .filter(([name]) => isMcpTool(name))
    .sort(([, a], [, b]) => b - a);
  if (mcpTools.length === 0) { return '<p style="color:var(--text-secondary);">No MCP tools detected this month.</p>'; }
  return mcpTools.map(([name, count]) =>
    `<span style="display:inline-block;background:var(--bg-surface-high);border:1px solid var(--border);border-radius:4px;padding:3px 10px;font-size:0.8em;margin:0 4px 6px 0;font-family:var(--font-data);">${name} <span style="color:var(--text-secondary);">(${count})</span></span>`
  ).join('');
}

const CONTEXT_REF_META: Record<string, { label: string; icon: string }> = {
  file: { label: '#file', icon: '📄' },
  selection: { label: '#selection', icon: '✂️' },
  codebase: { label: '#codebase', icon: '🗂️' },
  changes: { label: '#changes', icon: '📝' },
  terminalLastCommand: { label: '#terminalLastCommand', icon: '⌨️' },
  terminalSelection: { label: '#terminalSelection', icon: '⌨️' },
  problems: { label: '#problems', icon: '⚠️' },
  workspace: { label: '@workspace', icon: '🏗️' },
  terminal: { label: '@terminal', icon: '💻' },
  vscode: { label: '@vscode', icon: '🧩' },
};

function buildContextRefTable(engagement: AggregatedMetrics['contextEngagement']): string {
  const entries = Object.entries(engagement.byType).sort(([, a], [, b]) => b - a);
  if (entries.length === 0) {
    return '<p style="color:var(--text-secondary);">No explicit context references (#file, @workspace, ...) detected this month.</p>';
  }
  const rows = entries.map(([type, count]) => {
    const meta = CONTEXT_REF_META[type] || { label: type, icon: '🔖' };
    const pct = engagement.totalRefs > 0 ? Math.round((count / engagement.totalRefs) * 100) : 0;
    const bar = `<div style="background:var(--bg-base);border-radius:2px;height:4px;overflow:hidden;min-width:80px;">
      <div style="background:var(--primary);width:${pct}%;height:100%;"></div></div>`;
    return `<tr>
      <td>${meta.icon} ${meta.label}</td>
      <td class="data-text" style="text-align:right;">${count.toLocaleString()}</td>
      <td style="text-align:right;color:var(--text-secondary);font-size:0.85em;">${pct}%</td>
      <td style="width:120px;padding-right:16px;">${bar}</td>
    </tr>`;
  }).join('');
  return `<table>
    <thead><tr>
      <th>Reference</th><th style="text-align:right;">Count</th>
      <th style="text-align:right;">Share</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function buildHygieneTable(reports: RepositoryHygieneReport[]): string {
  if (reports.length === 0) { return '<p style="color:var(--text-secondary);">No repository data from this month.</p>'; }
  const missingAll = reports.filter(r =>
    !r.files.instructions.exists && !r.files.agentSetup.exists &&
    !r.files.mcpConfig.exists && !r.files.skillFiles.exists && !r.files.customAgents.exists
  ).length;
  const banner = missingAll > 0
    ? `<div style="background:rgba(249,226,175,0.08);border:1px solid rgba(249,226,175,0.25);border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:0.85em;color:#f9e2af;">⚠️ ${missingAll} workspace(s) have no AI configuration files.</div>`
    : `<div style="background:rgba(57,255,20,0.06);border:1px solid rgba(57,255,20,0.2);border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:0.85em;color:var(--stage-4);">✅ All active workspaces have AI configuration files.</div>`;
  const rows = reports.map(r => {
    const pathNote = r.repoPath ? '' : ' <span style="color:#f9e2af;font-size:0.8em;">⚠ path unknown</span>';
    return `<tr>
      <td>${r.name}${pathNote}</td>
      <td class="data-text" style="text-align:right;">${r.sessions}</td>
      <td style="text-align:center;">${fileStatusIcon(r.files.instructions)}</td>
      <td style="text-align:center;">${fileStatusIcon(r.files.agentSetup)}</td>
      <td style="text-align:center;">${fileStatusIcon(r.files.mcpConfig)}</td>
      <td style="text-align:center;">${fileStatusIcon(r.files.skillFiles)}</td>
      <td style="text-align:center;">${fileStatusIcon(r.files.customAgents)}</td>
    </tr>`;
  }).join('');
  return `${banner}
  <table>
    <thead><tr>
      <th>Workspace</th><th style="text-align:right;">Sessions</th>
      <th style="text-align:center;" title="CLAUDE.md / copilot-instructions.md / .cursorrules">📄 Instructions</th>
      <th style="text-align:center;" title=".claude/settings.json">⚙️ Agent Setup</th>
      <th style="text-align:center;" title="mcpServers in settings or .mcp.json">🔌 MCP Config</th>
      <th style="text-align:center;" title=".claude/commands/">🧠 Skills</th>
      <th style="text-align:center;" title="AGENTS.md or .claude/agents/">🤖 Agents</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="font-size:0.75em;color:var(--text-secondary);margin-top:8px;">
    <span style="color:var(--stage-4);">✓</span> Fresh &nbsp;·&nbsp;
    <span style="color:#f9e2af;">⚠</span> Stale &nbsp;·&nbsp;
    <span style="color:var(--stage-1);">✕</span> Missing
  </p>`;
}

function buildInstructionQualitySection(reports: RepositoryHygieneReport[]): string {
  const withFiles = reports.filter(r => r.instructionQuality.length > 0);
  if (withFiles.length === 0) {
    return '<p style="color:var(--text-secondary);">No instruction files found in any workspace.</p>';
  }

  const qualityColor = (q: string) =>
    q === 'rich' ? 'var(--stage-4)' :
      q === 'good' ? '#a6e3a1' :
        q === 'basic' ? '#f9e2af' : 'var(--stage-1)';

  const qualityLabel = (q: string) =>
    q === 'rich' ? 'Rich' : q === 'good' ? 'Good' : q === 'basic' ? 'Basic' : 'Stub';

  const rows = withFiles.flatMap(r =>
    r.instructionQuality.map((iq, i) => `<tr>
      ${i === 0
        ? `<td rowspan="${r.instructionQuality.length}" style="vertical-align:top;font-weight:600;">${r.name}</td>`
        : ''}
      <td style="font-family:var(--font-data);font-size:0.85em;">${iq.file}</td>
      <td class="data-text" style="text-align:right;">${iq.wordCount.toLocaleString()}</td>
      <td style="text-align:center;">${iq.hasSections ? '<span style="color:var(--stage-4);">✓</span>' : '<span style="color:var(--stage-1);">✕</span>'}</td>
      <td style="text-align:center;">
        <span style="color:${qualityColor(iq.quality)};font-weight:600;">${qualityLabel(iq.quality)}</span>
      </td>
    </tr>`)
  ).join('');

  return `<table>
    <thead><tr>
      <th>Workspace</th>
      <th>File</th>
      <th style="text-align:right;">Words</th>
      <th style="text-align:center;" title="Has markdown section headers">Structured</th>
      <th style="text-align:center;">Quality</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="font-size:0.75em;color:var(--text-secondary);margin-top:8px;">
    <span style="color:var(--stage-4);">Rich</span> ≥500w &nbsp;·&nbsp;
    <span style="color:#a6e3a1;">Good</span> 200–499w &nbsp;·&nbsp;
    <span style="color:#f9e2af;">Basic</span> 50–199w &nbsp;·&nbsp;
    <span style="color:var(--stage-1);">Stub</span> &lt;50w
  </p>`;
}

function buildHygieneScoreTable(reports: RepositoryHygieneReport[]): string {
  if (reports.length === 0) { return '<p style="color:var(--text-secondary);">No repositories to analyze.</p>'; }
  const rows = reports.map(r => {
    const scoreColor = r.score === null ? 'var(--text-secondary)'
      : r.score >= 80 ? 'var(--stage-4)' : r.score >= 40 ? '#f9e2af' : 'var(--stage-1)';
    const scoreDisplay = r.score !== null ? `${r.score}/100` : '-';
    const pathDisplay = r.repoPath
      ? `<span style="font-size:0.8em;color:var(--text-secondary);font-family:var(--font-data);">${r.repoPath}</span>`
      : `<span style="font-size:0.8em;color:var(--text-secondary);">Path unresolved</span>`;
    return `<tr>
      <td><div style="font-weight:600;">${r.name}</div>${pathDisplay}</td>
      <td class="data-text" style="text-align:right;">${r.sessions}</td>
      <td class="data-text" style="text-align:right;">${r.interactions}</td>
      <td class="data-text" style="text-align:right;font-weight:600;color:${scoreColor};">${scoreDisplay}</td>
    </tr>`;
  }).join('');
  return `<table>
    <thead><tr>
      <th>Repository</th><th style="text-align:right;">Sessions</th>
      <th style="text-align:right;">Interactions</th><th style="text-align:right;">Score</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function buildCostIntelligenceTab(m: AggregatedMetrics, roiConfig: RoiConfig): string {
  const roi = m.roi;
  const sc = m.sessionComplexity;
  const anomaly = m.anomaly;

  // Anomaly section
  let anomalyBadges = '';
  if (anomaly.isSpike) {
    anomalyBadges += `<div style="background:rgba(249,226,175,0.1);border:1px solid rgba(249,226,175,0.3);border-radius:4px;padding:8px 12px;margin-bottom:8px;font-size:0.85em;color:#f9e2af;">
      ⚡ Today's spend is ${anomaly.todayZScore.toFixed(1)}σ above your 30-day average (potential spike)</div>`;
  }
  if (anomaly.runawaySessionsCount > 0) {
    anomalyBadges += `<div style="background:rgba(255,77,77,0.08);border:1px solid rgba(255,77,77,0.25);border-radius:4px;padding:8px 12px;margin-bottom:8px;font-size:0.85em;color:#ff8a8a;">
      🔥 ${anomaly.runawaySessionsCount} runaway session(s) this month (exceeded token/cost threshold)</div>`;
  }
  if (anomaly.burnAcceleration > 1.2) {
    anomalyBadges += `<div style="background:rgba(249,226,175,0.08);border:1px solid rgba(249,226,175,0.25);border-radius:4px;padding:8px 12px;margin-bottom:8px;font-size:0.85em;color:#f9e2af;">
      🔺 Spend acceleration: last 7 days = ${anomaly.burnAcceleration.toFixed(1)}× the prior 7 days</div>`;
  }
  if (anomaly.consecutiveHighDays >= 3) {
    anomalyBadges += `<div style="background:rgba(0,122,255,0.07);border:1px solid rgba(0,122,255,0.2);border-radius:4px;padding:8px 12px;margin-bottom:8px;font-size:0.85em;color:#6db3ff;">
      📈 ${anomaly.consecutiveHighDays} consecutive high-spend days</div>`;
  }
  if (!anomalyBadges) {
    anomalyBadges = '<div style="color:var(--stage-4);font-size:0.9em;">✅ No anomalies detected this month.</div>';
  }

  // Provider ROI comparison
  const providerRoiRows = Object.entries(roi.providerCostPer1KOutput)
    .sort(([, a], [, b]) => a - b)
    .map(([id, costPer1K]) => {
      const label = id === 'copilot' ? 'Copilot' :
        id === 'antigravity' ? 'Antigravity' :
          id === 'claudeCode' ? 'Claude Code' : 'Codex';
      const name = `${providerIcon(id)} ${label}`;
      const p = m.byProvider[id as keyof typeof m.byProvider];
      const isBest = id === roi.mostEfficientProvider;
      return `<tr ${isBest ? 'style="background:rgba(57,255,20,0.04);"' : ''}>
        <td>${name} ${isBest ? '<span style="font-size:0.75em;color:var(--stage-4);margin-left:4px;">★ best</span>' : ''}</td>
        <td class="data-text" style="text-align:right;">${fmtCost(p.estimatedCost)}</td>
        <td class="data-text" style="text-align:right;">${fmt(p.outputTokens)}</td>
        <td class="data-text" style="text-align:right;">$${costPer1K.toFixed(4)}</td>
      </tr>`;
    }).join('');

  // Session complexity stats
  const highestCostSess = sc.highestCostSession;

  return `
  <!-- Developer Impact ───────────────────────────────────── -->
  <div class="section">
    <h2>⏱ Developer Impact (This Month)</h2>
    <p class="subtitle">Estimated value generated by AI assistance - based on configurable heuristics
      (<code>aiInsights.roi.developerHourlyRate</code> · <code>aiInsights.roi.outputTokensPerHourSaved</code>)</p>
    ${(() => {
      const hoursSaved = m.currentMonth.outputTokens / roiConfig.tokensPerHourSaved;
      const valueGenerated = hoursSaved * roiConfig.hourlyRate;
      const aiCost = m.currentMonth.estimatedCost;
      const roiMult = aiCost > 0 ? (valueGenerated / aiCost) : 0;
      const roiColor = roiMult >= 10 ? 'var(--stage-4)' : roiMult >= 3 ? '#f9e2af' : 'var(--stage-1)';
      const fmtH = (h: number) => h < 1 ? `${Math.round(h * 60)}min` : `${h.toFixed(1)}h`;
      return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:20px;">
      <div class="mini-card">
        <div class="mini-label">Hours Saved ${tip('Estimated developer hours saved = output tokens ÷ tokensPerHourSaved setting. Adjust the setting to match your workflow.')}</div>
        <div class="mini-val data-text" style="color:var(--stage-4);">~${fmtH(hoursSaved)}</div>
      </div>
      <div class="mini-card">
        <div class="mini-label">Value Generated ${tip('Estimated dollar value of time saved = hours saved × configured hourly rate (aiInsights.roi.developerHourlyRate).')}</div>
        <div class="mini-val data-text" style="color:var(--stage-4);">~$${valueGenerated.toFixed(0)}</div>
      </div>
      <div class="mini-card">
        <div class="mini-label">AI Spend ${tip('Actual estimated cost of all AI usage this month across all providers.')}</div>
        <div class="mini-val data-text">${fmtCost(aiCost)}</div>
      </div>
      <div class="mini-card">
        <div class="mini-label">ROI Multiplier ${tip('Value generated ÷ AI spend. Shows how many dollars of developer value you get per dollar of AI cost.')}</div>
        <div class="mini-val data-text" style="color:${roiColor};">${roiMult > 0 ? `~${roiMult.toFixed(0)}×` : '-'}</div>
      </div>
    </div>
    <p style="font-size:0.78em;color:var(--text-secondary);line-height:1.5;">
      Calculation: <strong style="color:var(--text-primary);">${m.currentMonth.outputTokens.toLocaleString()}</strong> output tokens
      ÷ <strong style="color:var(--text-primary);">${roiConfig.tokensPerHourSaved.toLocaleString()}</strong> tok/hr
      = <strong style="color:var(--text-primary);">${fmtH(hoursSaved)}</strong> saved
      × <strong style="color:var(--text-primary);">$${roiConfig.hourlyRate}/hr</strong>
      = <strong style="color:var(--text-primary);">~$${valueGenerated.toFixed(0)}</strong> value.
      Adjust both settings to match your actual rate and productivity.
    </p>`;
    })()}
  </div>

  <!-- ROI & Efficiency ───────────────────────────────────── -->
  <div class="section">
    <h2>📈 Cost Efficiency (This Month)</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
      <div>
        <h3 style="margin-bottom:12px;">Cost Efficiency</h3>
        <table>
          <tbody>
            <tr><td>Output tokens per $1 ${tip('How many output tokens you get for each dollar spent. Higher = more cost-efficient model usage.')}</td><td class="data-text" style="text-align:right;">${roi.outputTokensPerDollar > 0 ? Math.round(roi.outputTokensPerDollar).toLocaleString() : '-'}</td></tr>
            <tr><td>Cost per session ${tip('Average estimated cost per AI session this month.')}</td><td class="data-text" style="text-align:right;">${fmtCost(roi.costPerSession)}</td></tr>
            <tr><td>Cost per interaction ${tip('Average estimated cost per individual AI interaction (one prompt + response pair).')}</td><td class="data-text" style="text-align:right;">${fmtCost(roi.costPerInteraction)}</td></tr>
            <tr><td>Input efficiency (out/in) ${tip('Ratio of output tokens to input tokens. Higher means the model generates more content per token you send.')}</td><td class="data-text" style="text-align:right;">${roi.inputEfficiencyRatio.toFixed(2)}×</td></tr>
            <tr><td>Thinking overhead ${tip('Percentage of total tokens spent on model reasoning/thinking. High values indicate heavy use of extended thinking mode.')}</td><td class="data-text" style="text-align:right;">${roi.thinkingOverheadPct.toFixed(1)}%</td></tr>
          </tbody>
        </table>
      </div>
      <div>
        <h3 style="margin-bottom:12px;">Provider Cost per 1K Output Tokens</h3>
        ${providerRoiRows
      ? `<table>
              <thead><tr><th>Provider</th><th style="text-align:right;">Total Cost</th><th style="text-align:right;">Output Tokens</th><th style="text-align:right;">$/1K output</th></tr></thead>
              <tbody>${providerRoiRows}</tbody>
             </table>`
      : '<p style="color:var(--text-secondary);">Insufficient data for comparison.</p>'
    }
      </div>
    </div>
  </div>

  <!-- Anomaly & Risk ─────────────────────────────────────── -->
  <div class="section">
    <h2>🔔 Anomaly &amp; Risk Detection</h2>
    <p class="subtitle">Automatic detection of unusual spend patterns, runaway sessions, and budget risk</p>
    ${anomalyBadges}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-top:16px;">
      <div class="mini-card">
        <div class="mini-label">Today's Z-Score ${tip('Statistical measure of how unusual today\'s spend is vs. your 30-day average. >2σ = notable spike, >3σ = strong anomaly.')}</div>
        <div class="mini-val data-text" style="color:${Math.abs(anomaly.todayZScore) > 2 ? '#FF4D4D' : 'var(--text-primary)'}">${anomaly.todayZScore.toFixed(2)}σ</div>
      </div>
      <div class="mini-card">
        <div class="mini-label">Runaway Sessions ${tip('Sessions that exceeded a high token or cost threshold - indicating potentially uncontrolled AI usage.')}</div>
        <div class="mini-val data-text" style="color:${anomaly.runawaySessionsCount > 0 ? '#FF4D4D' : 'var(--stage-4)'}">${anomaly.runawaySessionsCount}</div>
      </div>
      <div class="mini-card">
        <div class="mini-label">Burn Acceleration ${tip('Ratio of last 7 days spend vs. the prior 7 days. >1.2× = accelerating spend trend.')}</div>
        <div class="mini-val data-text" style="color:${anomaly.burnAcceleration > 1.2 ? '#f9e2af' : 'var(--text-primary)'}">${anomaly.burnAcceleration.toFixed(2)}×</div>
      </div>
      <div class="mini-card">
        <div class="mini-label">Consecutive High Days ${tip('Number of consecutive days with above-average spending.')}</div>
        <div class="mini-val data-text" style="color:${anomaly.consecutiveHighDays >= 3 ? '#f9e2af' : 'var(--text-primary)'}">${anomaly.consecutiveHighDays}</div>
      </div>
    </div>
  </div>

  <!-- Session Complexity ─────────────────────────────────── -->
  <div class="section">
    <h2>🔍 Session Complexity</h2>
    <p class="subtitle">Breakdown of session depth and cost drivers</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:20px;">
      <div class="mini-card">
        <div class="mini-label">Avg Session Depth ${tip('Average number of back-and-forth interactions per session.')}</div>
        <div class="mini-val data-text">${sc.avgSessionDepth.toFixed(1)} interactions</div>
      </div>
      <div class="mini-card">
        <div class="mini-label">Avg Session Duration ${tip('Average elapsed time per session in minutes.')}</div>
        <div class="mini-val data-text">${sc.avgSessionDurationMin.toFixed(1)} min</div>
      </div>
      <div class="mini-card">
        <div class="mini-label">Long Sessions (&gt;30 min) ${tip('Count of sessions lasting more than 30 minutes - these tend to be more expensive.')}</div>
        <div class="mini-val data-text">${sc.longSessionsCount}</div>
        <div style="font-size:0.75em;color:var(--text-secondary);">cost ${fmtCost(sc.longSessionsCost)}</div>
      </div>
      <div class="mini-card">
        <div class="mini-label">Tool-Heavy Sessions ${tip('Sessions that invoked more than 5 unique tools - typically agent or autonomous tasks.')}</div>
        <div class="mini-val data-text">${sc.toolHeavyCount}</div>
        <div style="font-size:0.75em;color:var(--text-secondary);">&gt;5 unique tools</div>
      </div>
      <div class="mini-card">
        <div class="mini-label">Thinking Sessions ${tip('Sessions where the model used extended reasoning/thinking tokens.')}</div>
        <div class="mini-val data-text">${sc.thinkingSessionsCount}</div>
      </div>
      <div class="mini-card">
        <div class="mini-label">Multi-Model Sessions ${tip('Sessions that used more than one AI model during the same conversation.')}</div>
        <div class="mini-val data-text">${sc.multiModelSessionsCount}</div>
      </div>
    </div>
    ${highestCostSess ? `
    <h3>Highest-Cost Session (All-time)</h3>
    <div style="background:var(--bg-surface-high);border-radius:4px;padding:12px;margin-top:8px;font-size:0.85em;">
      <span class="data-text" style="color:var(--text-secondary);">ID: ${highestCostSess.id}</span>
      &nbsp;·&nbsp; <strong>${fmtCost(highestCostSess.cost)}</strong>
      &nbsp;·&nbsp; ${fmt(highestCostSess.tokens)} tokens
    </div>` : ''}
  </div>

  `;
}

function buildAcceptanceSection(a: AcceptanceMetrics): string {
  const pct = Math.round(a.acceptanceRate * 100);
  const rateColor = pct >= 30 ? 'var(--stage-4)' : pct >= 10 ? '#f9e2af' : 'var(--stage-1)';
  const rateLabel = pct >= 30 ? 'Good' : pct >= 10 ? 'Fair' : a.triggered === 0 ? 'No data yet' : 'Low';
  const sinceStr = a.since.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return `
  <div class="section">
    <h2>🎯 Suggestion Acceptance Rate <span style="font-size:0.7em;font-weight:400;color:var(--text-secondary);">live · resets on reload</span></h2>
    <p class="subtitle">Quality proxy: how often AI ghost-text suggestions are accepted vs. triggered.
      High acceptance ≈ model is suggesting relevant completions. Tracking since ${sinceStr}.</p>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:20px;">
      <div class="mini-card">
        <div class="mini-label">Acceptance Rate ${tip('Percentage of AI inline completions you accepted vs. total ghost-text shown. ≥30% = good; <10% = model or context may need tuning.')}</div>
        <div class="mini-val data-text" style="font-size:2em;color:${rateColor};">${a.triggered === 0 ? '-' : pct + '%'}</div>
        <div style="font-size:0.75em;color:${rateColor};margin-top:4px;">${rateLabel}</div>
      </div>
      <div class="mini-card">
        <div class="mini-label">Completions Accepted ${tip('Count of inline completions explicitly accepted via Tab/Enter. Tracked via the onDidAcceptCompletionItem VS Code event.')}</div>
        <div class="mini-val data-text">${a.accepted.toLocaleString()}</div>
        <div style="font-size:0.75em;color:var(--text-secondary);margin-top:4px;">onDidAcceptCompletionItem</div>
      </div>
      <div class="mini-card">
        <div class="mini-label">Ghost-text Triggers ${tip('Approximate count of how many times ghost text was displayed - measured as debounced calls to the inline-completion provider. Used as denominator for acceptance rate.')}</div>
        <div class="mini-val data-text">${a.triggered.toLocaleString()}</div>
        <div style="font-size:0.75em;color:var(--text-secondary);margin-top:4px;">debounced proxy for "shown"</div>
      </div>
    </div>

    ${a.triggered > 0 ? `
    <div style="background:var(--bg-surface-high);border-radius:4px;padding:12px;margin-bottom:12px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:0.85em;color:var(--text-secondary);min-width:80px;">Acceptance</span>
        <div style="flex:1;background:var(--bg-base);border-radius:4px;height:6px;overflow:hidden;">
          <div style="background:${rateColor};width:${Math.min(100, pct)}%;height:100%;"></div>
        </div>
        <span class="data-text" style="font-size:0.85em;min-width:40px;">${pct}%</span>
      </div>
    </div>` : ''}

    <p style="font-size:0.78em;color:var(--text-secondary);line-height:1.5;">
      <strong style="color:var(--text-primary);">How it works:</strong>
      "Accepted" counts popup-completion acceptances (<code>onDidAcceptCompletionItem</code>).
      "Triggers" counts debounced calls to the inline-completion provider - a close proxy for how
      many times ghost text was shown. ≥30% = good signal quality; &lt;10% = model or context may need tuning.
    </p>
  </div>`;
}

interface RoiConfig { hourlyRate: number; tokensPerHourSaved: number; }

function getHtml(m: AggregatedMetrics, reports: RepositoryHygieneReport[], _acceptance: AcceptanceMetrics, _roiConfig: RoiConfig, refreshing = false, logoUri = ''): string {
  const knownReports = reports.filter(r => r.repoPath && r.repoPath !== 'Path unresolved');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Insights - Workspace Analysis</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;600&display=swap');
  ${designTokensCss()}
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:var(--font-primary); background:var(--bg-base); color:var(--text-primary); padding:0; line-height:1.6; }
  .data-text { font-family:var(--font-data); }
  ${navCss()}
  .btn { background:transparent; border:1px solid var(--border); color:var(--text-primary); padding:8px 16px; border-radius:4px; cursor:pointer; font-size:0.85em; font-weight:500; transition:all 0.2s; }
  .btn:hover { background:rgba(255,255,255,0.05); }
  .btn.is-loading { opacity:0.7; pointer-events:none; }
  .btn.is-loading::after { content:""; display:inline-block; width:10px; height:10px; border:2px solid rgba(255,255,255,0.3); border-top-color:white; border-radius:50%; animation:spin 0.7s linear infinite; margin-left:6px; vertical-align:middle; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:16px; margin-bottom:32px; }
  .card { background:var(--bg-surface); border:1px solid var(--border); border-radius:4px; padding:20px; transition:transform 0.2s; }
  .card:hover { transform:translateY(-2px); box-shadow:0 4px 20px rgba(0,0,0,0.5); }
  .card-label { font-size:0.75em; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px; font-weight:500; }
  .card-value { font-size:2em; font-weight:500; color:var(--text-primary); margin:4px 0; }
  .section { background:var(--bg-surface); border:1px solid var(--border); border-radius:8px; padding:24px; margin-bottom:24px; }
  .section h2 { font-size:1.15em; margin-bottom:8px; font-weight:600; }
  .section h3 { font-size:0.78em; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-secondary); margin:20px 0 10px; font-weight:600; }
  .subtitle { font-size:0.85em; color:var(--text-secondary); margin-bottom:18px; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; padding:11px 14px; background:var(--bg-surface-high); color:var(--text-secondary); font-size:0.72em; text-transform:uppercase; letter-spacing:0.05em; border-bottom:1px solid var(--border); font-weight:500; }
  td { padding:11px 14px; border-bottom:1px solid var(--border); font-size:0.88em; }
  tr:last-child td { border-bottom:none; }
  tr:hover td { background:rgba(255,255,255,0.02); }
  .mini-card { background:var(--bg-surface-high); border-radius:4px; padding:14px; }
  .mini-label { font-size:0.72em; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px; font-weight:500; }
  .mini-val { font-size:1.3em; font-weight:600; color:var(--text-primary); }
  .loading-bar{position:fixed;top:0;left:0;right:0;z-index:100;height:3px;background:rgba(0,122,255,0.15);overflow:hidden;}
  .loading-bar-fill{height:100%;width:40%;background:var(--primary);border-radius:0 2px 2px 0;animation:loadslide 1.4s ease-in-out infinite;}
  @keyframes loadslide{0%{transform:translateX(-100%)}60%{transform:translateX(280%)}100%{transform:translateX(280%)}}
  .loading-banner{background:rgba(0,122,255,0.08);border-bottom:1px solid rgba(0,122,255,0.2);padding:8px 32px;font-size:0.82em;color:#6db3ff;display:flex;align-items:center;gap:8px;}
  .loading-spinner{width:12px;height:12px;border:2px solid rgba(0,122,255,0.3);border-top-color:var(--primary);border-radius:50%;animation:spin 0.7s linear infinite;flex-shrink:0;}
  @keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
  ${navTopbarHtml(logoUri, true, refreshing)}
  ${refreshing ? '<div class="loading-bar"><div class="loading-bar-fill"></div></div><div class="loading-banner"><div class="loading-spinner"></div>Loading workspace analysis…</div>' : ''}
  ${navPagebarHtml('usage', 'Workspace Analysis')}
<div class="ns-content">
  <div class="section">
    <h2>⚙️ AI Configuration Files</h2>
    <p class="subtitle">Workspaces with AI tool activity this month - configuration file presence</p>
    ${buildHygieneTable(knownReports)}
  </div>
  <div class="section">
    <h2>📝 Instruction Content Quality</h2>
    <p class="subtitle">Word count and structure of each AI instruction file found (CLAUDE.md, copilot-instructions.md, AGENTS.md, .cursorrules, .clinerules)</p>
    ${buildInstructionQualitySection(knownReports)}
  </div>
  <div class="section">
    <h2>🔍 Repository Hygiene Analysis</h2>
    <p class="subtitle">Configuration completeness score per repository (5 categories × 20 pts - fresh=20, stale=10, missing=0)</p>
    ${buildHygieneScoreTable(knownReports)}
  </div>
  <div class="section">
    <h2>🔗 Context Anchoring</h2>
    <p class="subtitle">Explicit context references (#file, @workspace, ...) used in prompts - ${Math.round(m.contextEngagement.refRate * 100)}% of interactions with prompt text anchor context this way</p>
    <div class="cards" style="margin-bottom:16px;">
      <div class="mini-card"><div class="mini-label">Total References</div><div class="mini-val data-text">${m.contextEngagement.totalRefs.toLocaleString()}</div></div>
      <div class="mini-card"><div class="mini-label">Anchoring Rate</div><div class="mini-val data-text">${Math.round(m.contextEngagement.refRate * 100)}%</div></div>
      <div class="mini-card"><div class="mini-label">Interactions Anchored</div><div class="mini-val data-text">${m.contextEngagement.interactionsWithRefs.toLocaleString()}</div></div>
    </div>
    ${buildContextRefTable(m.contextEngagement)}
  </div>
</div><!-- /ns-content -->

<script>
  window.vsc = acquireVsCodeApi();
  window.vscode = window.vsc;
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      document.querySelectorAll('.is-loading').forEach(function(el) { el.classList.remove('is-loading'); });
      var r = document.getElementById('btnRefresh'); if (r) r.textContent = '↺ Refresh';
    }
  });
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
  ${navJs()}
</script>
</body>
</html>`;
}

export class UsageAnalysisProvider {
  static readonly viewType = 'aiInsights.usageAnalysis';
  private static currentPanel: vscode.WebviewPanel | undefined;

  static createPanel(
    context: vscode.ExtensionContext,
    metrics: AggregatedMetrics,
    reports: RepositoryHygieneReport[],
    acceptance: AcceptanceMetrics,
    roiConfig: RoiConfig = { hourlyRate: 75, tokensPerHourSaved: 3000 },
    refreshing = false,
  ): void {
    const logoPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'logo.png');

    if (UsageAnalysisProvider.currentPanel) {
      const logoUri = UsageAnalysisProvider.currentPanel.webview.asWebviewUri(logoPath).toString();
      UsageAnalysisProvider.currentPanel.webview.html = getHtml(metrics, reports, acceptance, roiConfig, refreshing, logoUri);
      UsageAnalysisProvider.currentPanel.reveal(vscode.ViewColumn.One);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      UsageAnalysisProvider.viewType,
      'AI Insights - Workspace Analysis',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')],
      },
    );
    const logoUri = panel.webview.asWebviewUri(logoPath).toString();
    panel.webview.html = getHtml(metrics, reports, acceptance, roiConfig, refreshing, logoUri);

    panel.webview.onDidReceiveMessage(msg => {
      const cmd = NAV_COMMANDS[msg.command];
      if (cmd) { vscode.commands.executeCommand(cmd); return; }
      if (msg.command === 'refresh') {
        vscode.commands.executeCommand('aiInsights.refresh').then(() => {
          vscode.commands.executeCommand('aiInsights.showUsageAnalysis');
        });
      }
    }, undefined, context.subscriptions);

    panel.onDidDispose(() => {
      UsageAnalysisProvider.currentPanel = undefined;
    }, null, context.subscriptions);

    UsageAnalysisProvider.currentPanel = panel;
  }
}
