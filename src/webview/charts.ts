/**
 * Charts webview - renders interactive Chart.js visualizations.
 */
import * as vscode from 'vscode';
import { AggregatedMetrics } from '../types';
import { designTokensCss } from './designSystem';

export class ChartsProvider {
  private static currentPanel: vscode.WebviewPanel | undefined;

  static createPanel(context: vscode.ExtensionContext, metrics: AggregatedMetrics, refreshing = false): vscode.WebviewPanel {
    if (ChartsProvider.currentPanel) {
      ChartsProvider.currentPanel.webview.html = ChartsProvider.getHtml(metrics, refreshing);
      ChartsProvider.currentPanel.reveal(vscode.ViewColumn.One);
      return ChartsProvider.currentPanel;
    }
    const panel = vscode.window.createWebviewPanel(
      'aiInsights.charts', 'AI Insights Charts', vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.webview.html = ChartsProvider.getHtml(metrics, refreshing);
    panel.onDidDispose(() => { ChartsProvider.currentPanel = undefined; }, null, context.subscriptions);
    ChartsProvider.currentPanel = panel;
    return panel;
  }

  static getHtml(m: AggregatedMetrics, refreshing = false): string {
    // Filter to last 30 days for chart data
    const now = new Date();
    const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    const recentDaily = m.daily.filter(d => d.date >= cutoffStr);

    const dailyLabels = recentDaily.map(d => d.date);
    const dailyTokens = recentDaily.map(d => d.totalTokens);
    const dailySessions = recentDaily.map(d => d.sessions);
    const dailyCost = recentDaily.map(d => parseFloat(d.estimatedCost.toFixed(6)));
    const dailyCacheHitRate = recentDaily.map(d => {
      const total = d.inputTokens + d.cacheReadTokens;
      return total > 0 ? parseFloat(((d.cacheReadTokens / total) * 100).toFixed(1)) : 0;
    });
    const dailyCacheSaved = recentDaily.map(d => {
      // Approximate savings: cache reads saved ~80% vs full input price on average
      return parseFloat((d.cacheReadTokens * 0.000002 * 0.8).toFixed(6));
    });

    // Model breakdown per day
    const allModels = new Set<string>();
    for (const d of recentDaily) { Object.keys(d.models).forEach(k => allModels.add(k)); }
    const colorPalette = ['#007AFF', '#39FF14', '#FF4D4D', '#f093fb', '#00d2ff', '#ffd700', '#4ecdc4', '#ff8c94'];
    const modelColors: Record<string, string> = {};
    let ci = 0;
    for (const model of allModels) { modelColors[model] = colorPalette[ci++ % colorPalette.length]; }

    const modelDatasets = [...allModels].map(model => ({
      label: model,
      data: recentDaily.map(d => d.models[model] || 0),
      backgroundColor: modelColors[model],
    }));

    // Repository breakdown per day
    const allRepos = new Set<string>();
    for (const d of recentDaily) { Object.keys(d.repositories).forEach(r => allRepos.add(r)); }
    const repoColors: Record<string, string> = {};
    let ri = 5;
    for (const repo of allRepos) { repoColors[repo] = colorPalette[ri++ % colorPalette.length]; }

    const repoDatasets = [...allRepos].map(repo => ({
      label: repo,
      data: recentDaily.map(d => d.repositories[repo] || 0),
      backgroundColor: repoColors[repo],
    }));

    // Provider breakdown for doughnut
    const providerLabels = Object.keys(m.currentMonth.providerBreakdown);
    const providerData = Object.values(m.currentMonth.providerBreakdown);
    const providerColors = ['#007AFF', '#39FF14', '#FF4D4D'];

    // Summary stats
    const avgDaily = recentDaily.length > 0
      ? Math.round(m.currentMonth.totalTokens / recentDaily.length)
      : 0;
    const totalCost = m.currentMonth.estimatedCost;
    const cacheHitPct = Math.round(m.cache.cacheHitRate * 100);

    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Insights Charts</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;600&display=swap');
  ${designTokensCss()}
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:var(--font-primary); background:var(--bg-base); color:var(--text-primary); padding:32px; }
  .data-text { font-family:var(--font-data); }
  h1 { font-size:2em; font-weight:600; letter-spacing:-0.02em; margin-bottom:24px; padding-bottom:16px; border-bottom:1px solid var(--border); }
  .tabs { display:flex; gap:8px; margin-bottom:24px; flex-wrap:wrap; }
  .tab { background:transparent; border:1px solid var(--border); color:var(--text-primary); padding:8px 16px; border-radius:4px; cursor:pointer; transition:all 0.2s; font-weight:500; font-size:0.85em; font-family:var(--font-primary); }
  .tab.active,.tab:hover { background:var(--primary); color:white; border-color:var(--primary); box-shadow:0 0 15px var(--primary-glow); }
  .chart-container { background:var(--bg-surface); border:1px solid var(--border); border-radius:8px; padding:24px; margin-bottom:24px; }
  .chart-wrap { position:relative; height:400px; }
  .summary { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:16px; margin-bottom:32px; }
  .summary-item { background:var(--bg-surface); border:1px solid var(--border); border-radius:4px; padding:20px; text-align:center; transition:transform 0.2s; }
  .summary-item:hover { transform:translateY(-2px); box-shadow:0 4px 20px rgba(0,0,0,0.5); }
  .summary-value { font-size:2em; font-weight:500; color:var(--text-primary); margin-top:8px; }
  .summary-label { font-size:0.75em; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.05em; font-weight:500; }
  .hidden { display:none; }
  .loading-bar{position:fixed;top:0;left:0;right:0;z-index:100;height:3px;background:rgba(0,122,255,0.15);overflow:hidden;}
  .loading-bar-fill{height:100%;width:40%;background:var(--primary);border-radius:0 2px 2px 0;animation:loadslide 1.4s ease-in-out infinite;}
  @keyframes loadslide{0%{transform:translateX(-100%)}60%{transform:translateX(280%)}100%{transform:translateX(280%)}}
  .loading-banner{background:rgba(0,122,255,0.08);border-bottom:1px solid rgba(0,122,255,0.2);padding:8px 32px;font-size:0.82em;color:#6db3ff;display:flex;align-items:center;gap:8px;}
  .loading-spinner{width:12px;height:12px;border:2px solid rgba(0,122,255,0.3);border-top-color:var(--primary);border-radius:50%;animation:spin 0.7s linear infinite;flex-shrink:0;}
  @keyframes spin{to{transform:rotate(360deg)}}
</style></head>
<body>
  ${refreshing ? '<div class="loading-bar"><div class="loading-bar-fill"></div></div><div class="loading-banner"><div class="loading-spinner"></div>Refreshing charts…</div>' : ''}
  <h1>📊 Token Usage - Last 30 Days</h1>
  <div class="summary">
    <div class="summary-item">
      <div class="summary-label">Days Tracked</div>
      <div class="summary-value data-text">${recentDaily.length}</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">Total Tokens</div>
      <div class="summary-value data-text">${m.currentMonth.totalTokens >= 1_000_000 ? (m.currentMonth.totalTokens / 1_000_000).toFixed(1) + 'M' : (m.currentMonth.totalTokens / 1000).toFixed(0) + 'K'}</div>
    </div>
    <div class="summary-item">
      <div class="summary-label">Avg / Day</div>
      <div class="summary-value data-text">${avgDaily >= 1000 ? (avgDaily / 1000).toFixed(0) + 'K' : avgDaily}</div>
    </div>

    <div class="summary-item" ${m.byProvider.copilot?.cacheTokensEstimated ? `title="Blended across all providers. Includes calculated (not measured) GitHub Copilot cache estimates - see the Copilot provider wiki page."` : ''}>
      <div class="summary-label">Cache Hit Rate${m.byProvider.copilot?.cacheTokensEstimated ? ' 🧮' : ''}</div>
      <div class="summary-value data-text" style="color:${cacheHitPct >= 20 ? '#39FF14' : '#f9e2af'}">${cacheHitPct}%</div>
    </div>

  </div>

  <div class="tabs">
    <button class="tab active" onclick="showChart('total', this)">Total Tokens</button>

    <button class="tab" onclick="showChart('cache', this)">Cache Efficiency</button>
    <button class="tab" onclick="showChart('model', this)">By Model</button>
    <button class="tab" onclick="showChart('provider', this)">By Provider</button>
    <button class="tab" onclick="showChart('repository', this)">By Repository</button>
  </div>

  <div class="chart-container" id="chart-total">
    <div class="chart-wrap"><canvas id="totalChart"></canvas></div>
  </div>

  <div class="chart-container hidden" id="chart-cache">
    ${m.byProvider.copilot?.cacheTokensEstimated ? `<p style="font-size:0.8em;color:var(--text-secondary);margin-bottom:12px;">🧮 Includes calculated (not measured) GitHub Copilot cache estimates for periods without real debug-log telemetry - see the Copilot provider wiki page.</p>` : ''}
    <div class="chart-wrap"><canvas id="cacheChart"></canvas></div>
  </div>
  <div class="chart-container hidden" id="chart-model">
    <div class="chart-wrap"><canvas id="modelChart"></canvas></div>
  </div>
  <div class="chart-container hidden" id="chart-provider">
    <div class="chart-wrap"><canvas id="providerChart"></canvas></div>
  </div>
  <div class="chart-container hidden" id="chart-repository">
    <div class="chart-wrap"><canvas id="repositoryChart"></canvas></div>
  </div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script>
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.color = "#c1c6d7";

  const labels = ${JSON.stringify(dailyLabels)};
  const gridColor = 'rgba(255,255,255,0.05)';
  const tickColor = '#c1c6d7';
  const axisOpts = { ticks: { color: tickColor }, grid: { color: gridColor } };

  // Total tokens + sessions overlay
  new Chart(document.getElementById('totalChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Tokens', data: ${JSON.stringify(dailyTokens)}, backgroundColor: 'rgba(0,122,255,0.6)', yAxisID: 'y' },
        { label: 'Sessions', data: ${JSON.stringify(dailySessions)}, type: 'line', borderColor: '#FF4D4D', backgroundColor: 'rgba(255,77,77,0.1)', yAxisID: 'y1', pointRadius: 4 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y: { ...axisOpts, title: { display: true, text: 'Tokens', color: tickColor } },
        y1: { position: 'right', ...axisOpts, title: { display: true, text: 'Sessions', color: tickColor }, grid: { display: false } },
        x: { ...axisOpts, ticks: { ...axisOpts.ticks, maxRotation: 45 } }
      },
      plugins: { legend: { labels: { color: '#e5e2e1' } } }
    }
  });



  // Cache efficiency
  new Chart(document.getElementById('cacheChart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Cache Hit Rate (%)',
          data: ${JSON.stringify(dailyCacheHitRate)},
          borderColor: '#39FF14',
          backgroundColor: 'rgba(57,255,20,0.08)',
          fill: true,
          yAxisID: 'y',
          pointRadius: 3,
          tension: 0.3
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y: { ...axisOpts, title: { display: true, text: 'Hit Rate (%)', color: tickColor }, min: 0, max: 100 },
        x: { ...axisOpts, ticks: { ...axisOpts.ticks, maxRotation: 45 } }
      },
      plugins: { legend: { labels: { color: '#e5e2e1' } } }
    }
  });

  // By model
  new Chart(document.getElementById('modelChart'), {
    type: 'bar',
    data: { labels, datasets: ${JSON.stringify(modelDatasets)} },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { stacked: true, ...axisOpts, ticks: { ...axisOpts.ticks, maxRotation: 45 } },
        y: { stacked: true, ...axisOpts }
      },
      plugins: { legend: { labels: { color: '#e5e2e1' } } }
    }
  });

  // By provider (doughnut)
  new Chart(document.getElementById('providerChart'), {
    type: 'doughnut',
    data: {
      labels: ${JSON.stringify(providerLabels)},
      datasets: [{ data: ${JSON.stringify(providerData)}, backgroundColor: ${JSON.stringify(providerColors)}, borderColor: '#161b22', borderWidth: 2 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#e5e2e1' } } } }
  });

  // By repository
  new Chart(document.getElementById('repositoryChart'), {
    type: 'bar',
    data: { labels, datasets: ${JSON.stringify(repoDatasets)} },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { stacked: true, ...axisOpts, ticks: { ...axisOpts.ticks, maxRotation: 45 } },
        y: { stacked: true, ...axisOpts }
      },
      plugins: { legend: { labels: { color: '#e5e2e1' } } }
    }
  });

  function showChart(type, btn) {
    document.querySelectorAll('.chart-container').forEach(c => c.classList.add('hidden'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById('chart-' + type).classList.remove('hidden');
    btn.classList.add('active');
  }
</script>
</body></html>`;
  }
}
