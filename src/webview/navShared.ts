import { providerIcon } from './providerIcons';

export type NavTab =
  | 'overview'
  | 'usage'
  | 'pricing'
  | 'diagnostics'
  | 'sessions'
  | 'promptHistory'
  | 'tokenCalculator'
  | 'benchmark'
  | 'claudeAccount'
  | 'repoAnalysis'
  | 'replay'
  | 'none';

interface TabDef { id: NavTab; label: string; cmd: string; loadLabel: string; }

const NAV_TABS: TabDef[] = [
  { id: 'overview', label: 'Dashboard', cmd: 'showDashboard', loadLabel: 'Loading dashboard…' },
  { id: 'sessions', label: 'Sessions', cmd: 'showSessions', loadLabel: 'Loading sessions…' },
  { id: 'promptHistory', label: 'Prompts', cmd: 'showPromptHistory', loadLabel: 'Loading prompt history…' },
  { id: 'usage', label: 'Workspaces', cmd: 'showUsageAnalysis', loadLabel: 'Loading workspace analysis…' },
  { id: 'pricing', label: 'Copilot', cmd: 'showPricing', loadLabel: 'Loading GitHub Copilot…' },
  { id: 'tokenCalculator', label: 'Calculator', cmd: 'showTokenCalculator', loadLabel: 'Loading token calculator…' },
  { id: 'benchmark', label: 'Benchmark', cmd: 'showBenchmark', loadLabel: 'Loading benchmark…' },
  { id: 'claudeAccount', label: 'Claude', cmd: 'showClaudeAccount', loadLabel: 'Loading Claude…' },
  { id: 'diagnostics', label: 'Diagnostics', cmd: 'showDiagnostics', loadLabel: 'Loading diagnostics…' },
  // { id: 'repoAnalysis', label: 'Repo Graph', cmd: 'showRepoAnalysis', loadLabel: 'Loading repo analysis…' },
];

const RIGHT_NAV_TABS = new Set<NavTab>(['pricing', 'claudeAccount']);

/** Core nav system CSS — paste into any view's <style> block. */
export function navCss(): string {
  return `
  .ns-topbar { display: flex; align-items: center; justify-content: space-between; height: 52px; padding: 0 24px; border-bottom: 1px solid var(--border); background: var(--bg-base); position: sticky; top: 0; z-index: 20; flex-shrink: 0; }
  .ns-brand { display: flex; align-items: center; gap: 10px; }
  .ns-logo-img { width: 24px; height: 24px; object-fit: contain; flex-shrink: 0; border-radius: 4px; }
  .ns-brand-name { font-size: 13.5px; font-weight: 600; color: var(--text-primary); letter-spacing: -0.1px; }
  .ns-topbar-right { display: flex; align-items: center; gap: 10px; }
  #btnRefresh { display: inline-flex; align-items: center; gap: 5px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 7px; padding: 5px 10px; color: var(--text-secondary); cursor: pointer; font-size: 12px; font-weight: 500; font-family: var(--font-primary); height: 28px; white-space: nowrap; transition: all 0.15s ease; }
  #btnRefresh:hover { border-color: rgba(255,255,255,0.15); color: var(--text-primary); }
  #btnRefresh.is-loading { opacity: 0.7; pointer-events: none; color: var(--primary); border-color: rgba(0,122,255,0.25); }
  .ns-avatar { width: 26px; height: 26px; border-radius: 50%; background: linear-gradient(135deg, #3b82f6, #8b5cf6); color: #fff; font-size: 10px; font-weight: 600; display: grid; place-items: center; letter-spacing: 0.3px; flex-shrink: 0; }
  .ns-pagebar { display: flex; align-items: flex-end; padding: 18px 24px 0; border-bottom: 1px solid var(--border); background: var(--bg-base); overflow-x: auto; scrollbar-width: none; }
  .ns-pagebar::-webkit-scrollbar { display: none; }
  .ns-pagebar-inner { width: 100%; min-width: max-content; }
  .ns-page-title { font-size: 18px; font-weight: 600; color: var(--text-primary); letter-spacing: -0.3px; margin: 0 0 12px; }
  .ns-tabs-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 28px; }
  .ns-tabs { display: flex; }
  .ns-tabs-right { position: relative; padding-left: 20px; }
  .ns-tabs-right::before { content: ''; position: absolute; left: 0; top: 7px; bottom: 11px; width: 1px; background: rgba(255,255,255,0.12); }
  .ns-tab { position: relative; display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px 11px; font-size: 12.5px; font-weight: 500; color: var(--text-secondary); background: transparent; border: none; cursor: pointer; font-family: var(--font-primary); white-space: nowrap; transition: color 0.15s ease; }
  .ns-tab:hover { color: var(--text-primary); }
  .ns-tab.ns-tab-active { color: var(--text-primary); font-weight: 600; }
  .ns-tab.ns-tab-active::after { content: ''; position: absolute; left: 8px; right: 8px; bottom: -1px; height: 2px; background: var(--stage-4, #39FF14); border-radius: 2px; box-shadow: 0 0 8px rgba(57,255,20,0.45); }
  .ns-tab.is-loading, .btn-tab.is-loading { opacity: 0.7; pointer-events: none; color: var(--primary); }
  .ns-tab.is-loading::before { content: ''; width: 10px; height: 10px; border: 2px solid rgba(0,122,255,0.25); border-top-color: currentColor; border-radius: 50%; animation: ns-spin 0.7s linear infinite; flex-shrink: 0; }
  .btn-tab.is-loading::after { content: ''; display: inline-block; width: 10px; height: 10px; border: 2px solid rgba(0,122,255,0.25); border-top-color: currentColor; border-radius: 50%; animation: ns-spin 0.7s linear infinite; margin-left: 7px; vertical-align: -1px; }
  .ns-tab-icon { display: inline-flex; align-items: center; color: currentColor; flex-shrink: 0; }
  .gh-btn.is-loading { opacity: 0.7; pointer-events: none; }
  @keyframes ns-spin { to { transform: rotate(360deg); } }
  .ns-filterbar { display: flex; align-items: center; padding: 8px 24px; border-bottom: 1px solid var(--border); background: rgba(15,18,24,0.7); gap: 6px; flex-wrap: wrap; }
  .ns-filter-label { font-size: 9px; color: rgba(193,198,215,0.38); letter-spacing: 1.8px; font-weight: 700; flex-shrink: 0; text-transform: uppercase; margin-right: 4px; }
  .ns-filter-group { display: inline-flex; align-items: center; gap: 5px; }
  .ns-filter-group-label { font-size: 9px; letter-spacing: 1.5px; color: rgba(193,198,215,0.38); font-weight: 700; white-space: nowrap; flex-shrink: 0; text-transform: uppercase; }
  .ns-filter-sep { width: 1px; height: 18px; background: rgba(255,255,255,0.08); margin: 0 10px; flex-shrink: 0; }
  .ns-content { padding: 24px 32px; }
  .prov-switcher { display: flex; gap: 4px; flex-wrap: wrap; }
  .prov-btn { display: inline-flex; align-items: center; gap: 5px; background: transparent; border: 1px solid var(--border); border-radius: 7px; padding: 4px 9px; font-size: 11.5px; font-weight: 500; font-family: var(--font-primary); color: var(--text-secondary); cursor: pointer; transition: all 0.15s ease; white-space: nowrap; height: 28px; }
  .prov-btn:hover { border-color: rgba(255,255,255,0.15); color: var(--text-primary); background: var(--bg-surface-high); }
  .prov-btn.active { background: var(--bg-surface); border-color: rgba(255,255,255,0.18); color: var(--text-primary); }
  .mode-period-btn { background: transparent; border: 1px solid var(--border); border-radius: 7px; padding: 4px 9px; font-size: 11.5px; font-weight: 500; font-family: var(--font-primary); color: var(--text-secondary); cursor: pointer; transition: all 0.15s ease; white-space: nowrap; height: 28px; }
  .mode-period-btn:hover { border-color: rgba(255,255,255,0.15); color: var(--text-primary); background: var(--bg-surface-high); }
  .mode-period-btn.active { background: var(--bg-surface); border-color: rgba(255,255,255,0.18); color: var(--text-primary); }
  `;
}

/** Topbar HTML with logo image and refresh button. */
export function navTopbarHtml(logoUri: string, showRefresh = true, loading = false, extraRight = ''): string {
  const refreshBtn = showRefresh
    ? `<button id="btnRefresh"${loading ? ' class="is-loading"' : ''}>${loading ? '⟳ Loading…' : '↺ Refresh'}</button>`
    : '';
  return `  <div class="ns-topbar">
    <div class="ns-brand">
      <img class="ns-logo-img" src="${logoUri}" alt="">
      <span class="ns-brand-name">AI Insights</span>
    </div>
    <div class="ns-topbar-right">
      ${extraRight}
      ${refreshBtn}
    </div>
  </div>`;
}

/** Page bar with title and tab row. activeTab determines which tab gets the active underline. */
export function navPagebarHtml(activeTab: NavTab, title: string): string {
  const tabLabel = (t: TabDef) => {
    const icon = t.id === 'pricing'
      ? providerIcon('copilot')
      : t.id === 'claudeAccount'
        ? providerIcon('claudeCode')
        : '';
    return `${icon ? `<span class="ns-tab-icon">${icon}</span>` : ''}${t.label}`;
  };
  const renderTab = (t: TabDef) => {
    if (t.id === activeTab) {
      return `<button class="ns-tab ns-tab-active" data-nav="${t.cmd}" data-label="${t.loadLabel}">${tabLabel(t)}</button>`;
    }
    return `<button class="ns-tab" data-nav="${t.cmd}" data-label="${t.loadLabel}">${tabLabel(t)}</button>`;
  };
  const mainTabs = NAV_TABS.filter(t => !RIGHT_NAV_TABS.has(t.id)).map(renderTab).join('');
  const rightTabs = NAV_TABS.filter(t => RIGHT_NAV_TABS.has(t.id)).map(renderTab).join('');

  return `  <div class="ns-pagebar">
    <div class="ns-pagebar-inner">
      <h1 class="ns-page-title">${title}</h1>
      <div class="ns-tabs-row">
        <div class="ns-tabs">${mainTabs}</div>
        <div class="ns-tabs ns-tabs-right">${rightTabs}</div>
      </div>
    </div>
  </div>`;
}

/** Filter bar with provider chips and period chips (Dashboard only). */
export function navFilterbarHtml(): string {
  return `  <div class="ns-filterbar">
    <span class="ns-filter-label"></span>
    <div class="ns-filter-group">
      <span class="ns-filter-group-label">PROVIDER</span>
      <div class="prov-switcher" id="provSwitcher">
        <button class="prov-btn active" data-prov="overall">Overall</button>
        <button class="prov-btn" data-prov="copilot">${providerIcon('copilot')} Copilot</button>
        <button class="prov-btn" data-prov="claudeCode">${providerIcon('claudeCode')} Claude</button>
        <button class="prov-btn" data-prov="codex">${providerIcon('codex')} Codex</button>
        <button class="prov-btn" data-prov="antigravity">${providerIcon('antigravity')} Antigravity</button>
      </div>
    </div>
    <div class="ns-filter-sep"></div>
    <div class="ns-filter-group">
      <span class="ns-filter-group-label">PERIOD</span>
      <button class="mode-period-btn" data-period="today">Today</button>
      <button class="mode-period-btn" data-period="yesterday">Yesterday</button>
      <button class="mode-period-btn active" data-period="currentMonth">This Month</button>
      <button class="mode-period-btn" data-period="lastMonth">Last Month</button>
      <button class="mode-period-btn" data-period="thisYear">This Year</button>
      <button class="mode-period-btn" data-period="allTime">Overall</button>
    </div>
  </div>`;
}

/**
 * Nav JS for non-dashboard views.
 * Requires window.vscode to be set (acquireVsCodeApi result) before this runs.
 */
export function navJs(): string {
  return `
    (function() {
      document.querySelectorAll('[data-nav]').forEach(function(btn) {
        btn._origLabel = btn.innerHTML;
        btn.addEventListener('click', function() {
          var cmd = btn.getAttribute('data-nav');
          btn.classList.add('is-loading');
          if (window.vscode) { window.vscode.postMessage({ command: cmd }); }
          setTimeout(function() {
            btn.classList.remove('is-loading');
            if (btn._origLabel) { btn.innerHTML = btn._origLabel; }
          }, 2000);
        });
      });
    })();
  `;
}

/** All nav-related vscode commands that each panel's onDidReceiveMessage should handle. */
export const NAV_COMMANDS: Record<string, string> = {
  showDashboard: 'aiInsights.showDashboard',
  showUsageAnalysis: 'aiInsights.showUsageAnalysis',
  showPricing: 'aiInsights.showPricing',
  showDiagnostics: 'aiInsights.showDiagnostics',
  showSessions: 'aiInsights.showSessions',
  showSessionsView: 'aiInsights.showSessions',
  showPromptHistory: 'aiInsights.showPromptHistory',
  showTokenCalculator: 'aiInsights.showTokenCalculator',
  showBenchmark: 'aiInsights.showBenchmark',
  showClaudeAccount: 'aiInsights.showClaudeAccount',
  showRepoAnalysis: 'aiInsights.showRepoAnalysis',
  showSessionReplay: 'aiInsights.showSessionReplay',
};
