import * as vscode from 'vscode';
import pricingData from '../data/modelPricing.json';
import { AggregatedMetrics } from '../types';
import { ConnectedGitHubUser } from '../core/githubAuth';
import { navCss, navTopbarHtml, navPagebarHtml, navJs, NAV_COMMANDS, webviewAssets, WebviewAssets, costSourceBadge, costSourceLabel, escapeHtml } from './navShared';
import { modelHosting } from '../core/modelNames';
import { calibrationSnapshot } from '../core/copilotBillingCalibration';
import { designTokensCss } from './designSystem';
import { CopilotQuotaView, computeBudgetPlan } from '../core/copilotQuota';

const BUDGET_PLANNER_KEY = 'aiInsights.copilotBudgetPlanner';
interface BudgetPlannerConfig { modelMultiplier: number; reserveCredits: number; }
const DEFAULT_PLANNER_CONFIG: BudgetPlannerConfig = { modelMultiplier: 1, reserveCredits: 0 };

interface ModelEntry {
  displayName: string;
  provider: string;
  copilotOfficial: boolean;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cachedInputCostPerMillion?: number;
  cacheCreationCostPerMillion?: number;
  category: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  xai: 'xAI',
  moonshot: 'Moonshot AI',
};

const PLAN_LABELS: Record<string, string> = {
  free: 'Free', pro: 'Pro', team: 'Business', enterprise: 'Enterprise',
};

const USD_PER_AI_CREDIT = 0.01;

const ghIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:middle;opacity:0.8"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

export class PricingViewProvider {
  static readonly viewType = 'aiInsights.pricing';
  private static currentPanel: vscode.WebviewPanel | undefined;

  static createPanel(context: vscode.ExtensionContext, metrics?: AggregatedMetrics, githubUser?: ConnectedGitHubUser, copilotQuota?: CopilotQuotaView): vscode.WebviewPanel {
    const logoPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'logo.png');

    if (PricingViewProvider.currentPanel) {
      const logoUri = PricingViewProvider.currentPanel.webview.asWebviewUri(logoPath).toString();
      PricingViewProvider.currentPanel.webview.html = PricingViewProvider.getHtml(
        context, metrics, githubUser, logoUri, copilotQuota,
        webviewAssets(PricingViewProvider.currentPanel.webview, context.extensionUri));
      PricingViewProvider.currentPanel.reveal(vscode.ViewColumn.One);
      return PricingViewProvider.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      PricingViewProvider.viewType,
      'AI Insights - GitHub Copilot',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')],
      },
    );
    const logoUri = panel.webview.asWebviewUri(logoPath).toString();
    panel.webview.html = PricingViewProvider.getHtml(context, metrics, githubUser, logoUri, copilotQuota,
      webviewAssets(panel.webview, context.extensionUri));

    panel.webview.onDidReceiveMessage(
      async (message) => {
        const navCmd = NAV_COMMANDS[message.command];
        if (navCmd) { vscode.commands.executeCommand(navCmd); return; }
        switch (message.command) {
          case 'connectGitHub': vscode.commands.executeCommand('aiInsights.connectGitHub'); break;
          case 'disconnectGitHub': vscode.commands.executeCommand('aiInsights.disconnectGitHub'); break;
          case 'enableCopilotRealCacheData': vscode.commands.executeCommand('aiInsights.enableCopilotRealCacheData'); break;
          case 'setPlannerConfig': {
            const clampNum = (v: unknown, lo: number, hi: number, def: number) => {
              const n = Number(v);
              return isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, n)) : def;
            };
            const cfg: BudgetPlannerConfig = {
              modelMultiplier: clampNum(message.modelMultiplier, 0.01, 20, DEFAULT_PLANNER_CONFIG.modelMultiplier),
              reserveCredits: Math.max(0, Number(message.reserveCredits) || 0),
            };
            await context.globalState.update(BUDGET_PLANNER_KEY, cfg);
            panel.webview.html = PricingViewProvider.getHtml(context, metrics, githubUser, logoUri, copilotQuota,
      webviewAssets(panel.webview, context.extensionUri));
            break;
          }
        }
      },
      undefined,
      context.subscriptions,
    );

    panel.onDidDispose(() => { PricingViewProvider.currentPanel = undefined; }, null, context.subscriptions);
    PricingViewProvider.currentPanel = panel;
    return panel;
  }

  static getHtml(context: vscode.ExtensionContext, metrics: AggregatedMetrics | undefined, githubUser: ConnectedGitHubUser | undefined, logoUri: string, copilotQuota: CopilotQuotaView | undefined, assets: WebviewAssets): string {
    const pricing = pricingData.pricing as Record<string, ModelEntry>;
    const lastUpdated = pricingData.metadata.lastUpdated;

    const providerOrder = ['openai', 'anthropic', 'google', 'xai', 'moonshot'];
    const byProvider: Record<string, Array<[string, ModelEntry]>> = {};
    for (const [id, model] of Object.entries(pricing)) {
      if (!byProvider[model.provider]) { byProvider[model.provider] = []; }
      byProvider[model.provider].push([id, model]);
    }

    const creditsPerMInput = (m: ModelEntry) => (m.inputCostPerMillion / USD_PER_AI_CREDIT).toFixed(0);
    const creditsPerMOutput = (m: ModelEntry) => (m.outputCostPerMillion / USD_PER_AI_CREDIT).toFixed(0);
    const fmtRate = (n: number | undefined) => n !== undefined ? `$${n.toFixed(3)}` : '-';

    const providerSections = providerOrder
      .filter(p => byProvider[p]?.length)
      .map(provId => {
        const label = PROVIDER_LABELS[provId] ?? provId;
        const entries = byProvider[provId].sort((a, b) => {
          if (a[1].copilotOfficial !== b[1].copilotOfficial) { return a[1].copilotOfficial ? -1 : 1; }
          return a[1].inputCostPerMillion - b[1].inputCostPerMillion;
        });
        const rows = entries.map(([id, m]) => {
          const badge = m.copilotOfficial
            ? `<span class="badge badge-official">✓ Official</span>`
            : `<span class="badge badge-other">other</span>`;
          const hasCacheWrite = m.cacheCreationCostPerMillion !== undefined;
          return `<tr class="${m.copilotOfficial ? 'row-official' : 'row-other'}">
            <td>
              <div class="model-name data-text">${m.displayName}</div>
              <div class="model-id">${id}</div>
            </td>
            <td>${badge}</td>
            <td class="data-text num">${fmtRate(m.inputCostPerMillion)}</td>
            <td class="data-text num">${fmtRate(m.cachedInputCostPerMillion)}</td>
            <td class="data-text num">${hasCacheWrite ? fmtRate(m.cacheCreationCostPerMillion) : '-'}</td>
            <td class="data-text num">${fmtRate(m.outputCostPerMillion)}</td>
            <td class="data-text num credits">${creditsPerMInput(m)}</td>
            <td class="data-text num credits">${creditsPerMOutput(m)}</td>
            <td><span class="cat cat-${m.category.toLowerCase()}">${m.category}</span></td>
          </tr>`;
        }).join('');
        return `
          <div class="section">
            <h2 class="provider-heading">${label}</h2>
            <table>
              <thead>
                <tr>
                  <th>Model</th><th>Status</th>
                  <th class="num">Input<br><span class="sub">$/1M tokens</span></th>
                  <th class="num">Cached input<br><span class="sub">$/1M tokens</span></th>
                  <th class="num">Cache write<br><span class="sub">$/1M tokens</span></th>
                  <th class="num">Output<br><span class="sub">$/1M tokens</span></th>
                  <th class="num">Input<br><span class="sub">credits/1M</span></th>
                  <th class="num">Output<br><span class="sub">credits/1M</span></th>
                  <th>Tier</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
      }).join('');

    const officialCount = Object.values(pricing).filter(m => m.copilotOfficial).length;

    // ── Copilot usage section ──────────────────────────────────────────────────
    let copilotUsageHtml = '';
    if (metrics) {
      const fmt = (n: number) => n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' :
        n >= 1_000 ? (n / 1_000).toFixed(1) + 'K' : n.toString();
      const fmtCost = (n: number) => '$' + n.toFixed(4);
      const fmtCost2 = (n: number) => '$' + n.toFixed(2);
      const fmtCredits = (usd: number) => (usd / 0.01).toFixed(2);
      const fmtDiff = (current: number, previous: number): string => {
        if (previous === 0) { return current > 0 ? '<span style="color:#39FF14;font-size:0.75em;font-weight:600">new ↑</span>' : ''; }
        const pct = ((current - previous) / previous) * 100;
        const up = pct >= 0;
        return `<span style="color:${up ? '#39FF14' : '#FF6B6B'};font-size:0.75em;font-weight:600">${up ? '↑' : '↓'} ${Math.abs(pct).toFixed(0)}%</span>`;
      };

      const copilotMonth = metrics.currentMonthByProvider.copilot;
      const copilotLastMonth = metrics.lastMonthByProvider.copilot;
      const budgetPct = Math.min(100, metrics.budget.budgetUtilizationPct);
      const copilotChatExtensionInstalled = !!vscode.extensions.getExtension('github.copilot-chat');
      const copilotDebugLoggingEnabled = vscode.workspace.getConfiguration('github.copilot.chat').get<boolean>('agentDebugLog.fileLogging.enabled', false);
      const copilotHasUsage = copilotMonth.totalTokens > 0 || copilotLastMonth.totalTokens > 0;
      const enableRealCacheDataButton = (copilotChatExtensionInstalled && !copilotDebugLoggingEnabled && copilotHasUsage)
        ? `<button class="btn-tab" data-post="enableCopilotRealCacheData" style="background:rgba(57,255,20,0.1);color:#39FF14;border:1px solid rgba(57,255,20,0.3);border-radius:6px;padding:6px 14px;margin-top:8px;cursor:pointer;">✅ Enable Real Cache Data</button>`
        : '';

      // Budget connect widget
      let budgetWidget: string;
      if (githubUser) {
        const planLabel = PLAN_LABELS[githubUser.planName] ?? githubUser.planName;
        const planBudgetCredits = githubUser.monthlyBudgetUsd / 0.01;
        const usedCredits = copilotMonth.estimatedCost / 0.01;
        const remainingCredits = Math.max(0, planBudgetCredits - usedCredits);
        const usedPct = planBudgetCredits > 0 ? Math.min(100, (usedCredits / planBudgetCredits) * 100) : 0;
        const barColor = usedPct >= 95 ? '#ff6b6b' : usedPct >= 80 ? '#f9e2af' : '#39FF14';
        const hourlyRate = metrics.budget.hourlyBurnRate;
        const hoursUntilExhausted = hourlyRate > 0 && remainingCredits > 0
          ? (remainingCredits * USD_PER_AI_CREDIT) / hourlyRate
          : null;
        const exhaustedStr = hoursUntilExhausted !== null
          ? hoursUntilExhausted < 24
            ? `~${hoursUntilExhausted.toFixed(1)}h until limit`
            : `~${(hoursUntilExhausted / 24).toFixed(1)}d until limit`
          : '';
        const creditsLine = githubUser.monthlyBudgetUsd > 0
          ? `<div style="margin-top:6px;font-size:0.8em;color:var(--text-secondary)">
               <span style="color:var(--text-primary);font-weight:500">${remainingCredits.toFixed(0)} credits remaining</span>
               &nbsp;of ${planBudgetCredits.toFixed(0)} &middot; ${usedCredits.toFixed(0)} used (${usedPct.toFixed(1)}%)
               ${exhaustedStr ? `&middot; <span style="color:${barColor};">${exhaustedStr}</span>` : ''}
             </div>
             <div style="margin-top:4px;font-size:0.78em;color:var(--text-secondary);">
               Burn: <span class="data-text" style="color:var(--text-primary);">$${(hourlyRate * 100).toFixed(4)}/hr</span>
               &nbsp;&middot;&nbsp;$${metrics.budget.dailyBurnRate.toFixed(4)}/day
               &nbsp;&middot;&nbsp;Projected month-end: <span style="color:${metrics.budget.projectedMonthEnd > githubUser.monthlyBudgetUsd ? '#ff6b6b' : '#39FF14'};">$${metrics.budget.projectedMonthEnd.toFixed(2)}</span>
             </div>
             <div class="gh-credits-bar" style="margin-top:6px">
               <div class="gh-credits-bar-fill" style="width:${usedPct.toFixed(1)}%;background:${barColor}"></div>
             </div>` : '';
        budgetWidget = `<div class="github-connect connected">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px">
              ${ghIconSvg}
              <span>Connected as <strong>@${githubUser.login}</strong> &middot; GitHub ${planLabel} &middot; $${githubUser.monthlyBudgetUsd}/month</span>
              <div style="margin-left:auto;display:flex;gap:6px;flex-shrink:0">
                <button class="gh-btn" data-post="connectGitHub">Reconnect</button>
                <button class="gh-btn gh-btn-danger" data-post="disconnectGitHub">Disconnect</button>
              </div>
            </div>
            ${creditsLine}
          </div>
        </div>`;
      } else {
        budgetWidget = `<div class="github-connect">
          ${ghIconSvg}
          <span>Connect GitHub to auto-detect your Copilot plan and set the budget.</span>
          <button class="gh-btn" style="margin-left:auto" data-post="connectGitHub">Connect GitHub</button>
        </div>`;
      }

      const b = metrics.budget;
      const fmtBurnRate = (usd: number) => usd < 0.0001 ? `$${(usd * 100).toFixed(4)}¢` : `$${usd.toFixed(4)}`;

      let alertBanner = '';
      if (budgetPct >= 95) {
        alertBanner = `<div class="alert alert-crit">🚨 Budget critical: ${Math.round(budgetPct)}% used · ${fmtBurnRate(b.hourlyBurnRate)}/hr burn · ${b.daysUntilExhausted !== null ? `${Math.round(b.daysUntilExhausted)} days until exhausted` : 'no exhaustion projected'}. Overage may apply.</div>`;
      } else if (budgetPct >= 80) {
        alertBanner = `<div class="alert alert-info">⚠️ Budget warning: ${Math.round(budgetPct)}% of monthly AI Credits used · ${fmtBurnRate(b.hourlyBurnRate)}/hr · ${b.daysUntilExhausted !== null ? `${Math.round(b.daysUntilExhausted)} days remaining` : ''}.</div>`;
      } else if (budgetPct >= 50) {
        alertBanner = `<div class="alert alert-ok">ℹ️ Halfway: ${Math.round(budgetPct)}% of monthly AI Credits used · ${fmtBurnRate(b.hourlyBurnRate)}/hr burn rate.</div>`;
      }

      // Model usage table
      const copilotModelRows = Object.entries(copilotMonth.modelUsage)
        .filter(([, u]) => u.totalTokens > 0)
        .sort(([, a], [, b]) => b.totalCost - a.totalCost)
        .map(([model, u]) => {
          // Local and unpriced own-key models cost nothing here: show a dash, not "$0.00",
          // so they don't read as free Copilot usage.
          const free = u.pricingSource === 'local' || u.pricingSource === 'unpriced';
          const pricingStr = u.pricingSource === 'official'
            ? `$${u.inputCostPerMillion?.toFixed(3)} / $${u.cachedInputCostPerMillion?.toFixed(3)} / $${u.outputCostPerMillion?.toFixed(3)}`
            : u.pricingSource === 'local' ? 'local - not billed'
            : u.pricingSource === 'unpriced' ? 'own key - rate unknown'
            : 'fallback';
          const costCell = (usd: number) => free ? '–' : fmtCost(usd);
          const hostingTag = u.pricingSource === 'local' ? '<span class="model-tag" title="Runs on your machine - not billed by GitHub">Local</span>'
            : modelHosting(model) === 'byok' ? '<span class="model-tag" title="Served on your own API key - not billed by GitHub">Own key</span>'
            : '';
          return `<tr>
            <td class="data-text">${escapeHtml(model)}${hostingTag}</td>
            <td class="data-text">${fmt(u.uncachedInputTokens)}</td>
            <td class="data-text">${fmt(u.cacheReadTokens)}</td>
            <td class="data-text">${fmt(u.outputTokens)}</td>
            <td class="data-text">${pricingStr}</td>
            <td class="data-text">${costCell(u.inputCost)}</td>
            <td class="data-text">${costCell(u.cachedInputCost)}</td>
            <td class="data-text">${costCell(u.outputCost)}</td>
            <td class="data-text">${free ? '–' : fmtCredits(u.totalCost)}</td>
            <td class="data-text">${costCell(u.totalCost)}</td>
          </tr>`;
        }).join('');

      // Cost summary
      const r = (fn: (u: { uncachedInputTokens: number; inputCost: number; cachedInputCost: number; outputCost: number; cacheWriteCost: number }) => number, src: typeof copilotMonth.modelUsage) =>
        Object.values(src).reduce((s, u) => s + fn(u), 0);
      const cmIn = r(u => u.uncachedInputTokens, copilotMonth.modelUsage);
      const cmInC = r(u => u.inputCost, copilotMonth.modelUsage);
      const cmCachedC = r(u => u.cachedInputCost, copilotMonth.modelUsage);
      const cmOutC = r(u => u.outputCost, copilotMonth.modelUsage);
      const cmWriteC = r(u => u.cacheWriteCost, copilotMonth.modelUsage);
      const lmIn = r(u => u.uncachedInputTokens, copilotLastMonth.modelUsage);
      const lmInC = r(u => u.inputCost, copilotLastMonth.modelUsage);
      const lmCachedC = r(u => u.cachedInputCost, copilotLastMonth.modelUsage);
      const lmOutC = r(u => u.outputCost, copilotLastMonth.modelUsage);
      const lmWriteC = r(u => u.cacheWriteCost, copilotLastMonth.modelUsage);
      const hasCacheWrite = copilotMonth.cacheWriteTokens > 0 || copilotLastMonth.cacheWriteTokens > 0;

      const summaryRows = `
        <tr><td>Input tokens</td>
          <td class="data-text">${fmt(cmIn)}</td><td class="data-text">${fmtCost(cmInC)}</td>
          <td class="data-text" style="color:var(--text-secondary)">${fmt(lmIn)}</td><td class="data-text" style="color:var(--text-secondary)">${fmtCost(lmInC)}</td>
        </tr>
        <tr><td>Cached input tokens${copilotMonth.cacheReadTokens > 0 && copilotMonth.cacheTokensEstimated ? ' <span style="opacity:.7;font-size:0.85em" title="Calculated estimate, not measured by GitHub Copilot">(calc.)</span>' : ''}</td>
          <td class="data-text">${fmt(copilotMonth.cacheReadTokens)}</td><td class="data-text">${fmtCost(cmCachedC)}</td>
          <td class="data-text" style="color:var(--text-secondary)">${fmt(copilotLastMonth.cacheReadTokens)}</td><td class="data-text" style="color:var(--text-secondary)">${fmtCost(lmCachedC)}</td>
        </tr>
        <tr><td>Output tokens</td>
          <td class="data-text">${fmt(copilotMonth.outputTokens)}</td><td class="data-text">${fmtCost(cmOutC)}</td>
          <td class="data-text" style="color:var(--text-secondary)">${fmt(copilotLastMonth.outputTokens)}</td><td class="data-text" style="color:var(--text-secondary)">${fmtCost(lmOutC)}</td>
        </tr>
        ${hasCacheWrite ? `<tr><td>Cache write tokens</td>
          <td class="data-text">${fmt(copilotMonth.cacheWriteTokens)}</td><td class="data-text">${fmtCost(cmWriteC)}</td>
          <td class="data-text" style="color:var(--text-secondary)">${fmt(copilotLastMonth.cacheWriteTokens)}</td><td class="data-text" style="color:var(--text-secondary)">${fmtCost(lmWriteC)}</td>
        </tr>` : ''}
        <tr><td><strong>Total GitHub AI Credits</strong> ${costSourceBadge(copilotMonth.costSource)}</td>
          <td class="data-text">${fmt(copilotMonth.totalTokens)}</td>
          <td class="data-text"><strong>${fmtCredits(copilotMonth.estimatedCost)} credits / ${fmtCost2(copilotMonth.estimatedCost)}</strong></td>
          <td class="data-text" style="color:var(--text-secondary)">${fmt(copilotLastMonth.totalTokens)}</td>
          <td class="data-text" style="color:var(--text-secondary)">${fmtCredits(copilotLastMonth.estimatedCost)} credits / ${fmtCost2(copilotLastMonth.estimatedCost)}</td>
        </tr>`;

      // Cost provenance: how much of this month's figure is GitHub's own billed number
      // rather than our estimate, and what the billed requests taught us about the rates.
      const calibration = calibrationSnapshot();
      const billedShare = copilotMonth.estimatedCost > 0
        ? (copilotMonth.billedCost / copilotMonth.estimatedCost)
        : 0;
      const costAccuracyHtml = `
        <details class="section" style="margin-bottom:24px;">
          <summary style="cursor:pointer;font-weight:600;">${costSourceBadge(copilotMonth.costSource)} Where this cost number comes from - ${costSourceLabel(copilotMonth.costSource)}</summary>
          <div style="font-size:0.9em;color:var(--text-secondary);line-height:1.6;margin-top:10px;">
            <p>Copilot records its <strong>own billed cost</strong> for each request as
            <code>copilotUsageNanoAiu</code> in its debug log (1 AIU = 1 AI credit = $0.01).
            Where that is present we report it verbatim; where it is not, we estimate from
            the published per-token rates.</p>
            <p><strong>${(billedShare * 100).toFixed(0)}%</strong> of this month's figure
            (${fmtCost2(copilotMonth.billedCost)} of ${fmtCost2(copilotMonth.estimatedCost)})
            is GitHub's own billed number. The rest is estimated - usually because those
            sessions have no debug log, or predate the field.</p>
            <p>Two things make the estimate differ from the bill, both corrected here:
            Copilot bills every <em>non-cached</em> input token at the <strong>cache-creation</strong>
            rate (1.25x input for Anthropic models), and its per-token rates are not always the
            published ones. The second is measured, not assumed - each billed request is
            compared against what we would have predicted:</p>
            ${calibration.length > 0 ? `
            <table class="data-table" style="margin-top:10px;">
              <thead><tr><th>Model</th><th>Billed requests seen</th><th>Rate factor</th><th>Spread</th></tr></thead>
              <tbody>
                ${calibration.map(c => `<tr>
                  <td>${c.model}</td>
                  <td class="data-text">${c.samples}</td>
                  <td class="data-text">${c.factor.toFixed(4)}x</td>
                  <td class="data-text">${c.spread < 0.0001 ? 'exact' : '±' + (c.spread * 100).toFixed(2) + '%'}</td>
                </tr>`).join('')}
              </tbody>
            </table>
            <p style="margin-top:10px;">A factor of <code>1.0000x</code> means the published rates
            match the bill. A <strong>spread of "exact"</strong> means every billed request for that
            model agreed on the same factor, so it is a rate difference rather than noise.</p>
            ` : `<p>No billed requests have been read yet, so no factor has been measured and
            none is assumed. Enable Copilot's
            <code>github.copilot.chat.agentDebugLog.fileLogging.enabled</code> setting to let
            this calibrate itself.</p>`}
          </div>
        </details>`;

      // Real quota + budget planner — copilotQuota is the real GitHub-reported remaining/entitlement,
      // distinct from the token-derived estimate above (see copilotQuota.md gap notes).
      let quotaAndPlannerHtml = '';
      if (copilotQuota) {
        const plannerCfg = context.globalState.get<BudgetPlannerConfig>(BUDGET_PLANNER_KEY, DEFAULT_PLANNER_CONFIG);
        const plan = computeBudgetPlan(copilotQuota, plannerCfg.modelMultiplier, plannerCfg.reserveCredits);
        const quotaBarColor = copilotQuota.isOverQuota ? '#f38ba8' : copilotQuota.percentRemaining < 20 ? '#f9e2af' : '#39FF14';
        const multiplierChip = (v: number, label: string) =>
          `<button class="gh-btn" style="${Math.abs(plannerCfg.modelMultiplier - v) < 0.001 ? 'border-color:var(--primary);color:var(--primary);' : ''}" data-multiplier="${v}">${label}</button>`;

        quotaAndPlannerHtml = `
        <div class="section" style="margin-bottom:24px;">
          <h2>🐙 Real Quota &amp; Budget Planner</h2>
          <div class="cards" style="margin-bottom:16px;">
            <div class="card" style="border-top:2px solid ${quotaBarColor}">
              <div class="card-label">Copilot Quota Remaining</div>
              <div class="card-value data-text">${copilotQuota.unlimited ? 'Unlimited' : `${fmt(copilotQuota.remaining)}/${fmt(copilotQuota.entitlement)}`}</div>
              <div class="card-sub">${copilotQuota.unlimited ? copilotQuota.planLabel : (copilotQuota.isOverQuota ? `Over by ${fmt(copilotQuota.overageAmount)}` : `${copilotQuota.percentRemaining}% left`)} · resets ${copilotQuota.resetDays}d ${copilotQuota.resetHours}h</div>
              ${copilotQuota.daysUntilExhaustion !== null ? `<div class="card-sub" style="margin-top:6px">~${copilotQuota.daysUntilExhaustion}d until exhausted at current pace</div>` : ''}
            </div>
          </div>
          ${copilotQuota.unlimited ? '<p style="font-size:0.85em;color:var(--text-secondary);">Your plan has unlimited premium requests — nothing to plan against.</p>' : `
          <p style="font-size:0.85em;color:var(--text-secondary);margin:0 0 12px;">How many requests/day you can make without running out before reset, at a given per-request cost multiplier (cheaper models cost less quota per request) and an optional reserve to leave untouched.</p>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;">
            <span style="font-size:0.85em;color:var(--text-secondary);">Model cost:</span>
            ${multiplierChip(0.33, '0.33×')}${multiplierChip(1, '1×')}${multiplierChip(3, '3×')}
            <input type="number" id="plannerMultiplier" min="0.01" max="20" step="0.01" value="${plannerCfg.modelMultiplier}" style="width:64px;background:var(--bg-surface-high);border:1px solid var(--border);border-radius:5px;padding:5px 8px;color:var(--text-primary);">
            <span style="font-size:0.85em;color:var(--text-secondary);margin-left:10px;">Reserve:</span>
            <input type="number" id="plannerReserve" min="0" step="1" value="${plannerCfg.reserveCredits}" style="width:80px;background:var(--bg-surface-high);border:1px solid var(--border);border-radius:5px;padding:5px 8px;color:var(--text-primary);">
            <button class="gh-btn" data-action="savePlannerConfig">Update</button>
          </div>
          ${plan ? `
          <div class="cards">
            <div class="card"><div class="card-label">Sustainable / day</div><div class="card-value data-text">${plan.sustainableDailyRequests}</div><div class="card-sub">requests</div></div>
            <div class="card"><div class="card-label">Sustainable / week</div><div class="card-value data-text">${plan.sustainableWeeklyRequests}</div><div class="card-sub">requests</div></div>
            <div class="card"><div class="card-label">Days remaining</div><div class="card-value data-text">${plan.daysRemaining}</div><div class="card-sub">until reset</div></div>
          </div>` : '<p style="font-size:0.85em;color:var(--text-secondary);">No budget to plan against right now.</p>'}
          `}
        </div>`;
      }

      copilotUsageHtml = `
        ${budgetWidget}
        ${alertBanner}
        ${costAccuracyHtml}
        ${quotaAndPlannerHtml}

        <div class="cards" style="margin-bottom:28px;">
          <div class="card" style="border-top:2px solid var(--text-secondary)">
            <div class="card-label">AI Credits This Month ${costSourceBadge(copilotMonth.costSource)}</div>
            <div class="card-value data-text">${fmtCredits(copilotMonth.estimatedCost)}</div>
            <div class="card-sub">${fmtCost2(copilotMonth.estimatedCost)} spend · ${costSourceLabel(copilotMonth.costSource)}</div>
            <div class="card-sub" style="margin-top:6px">vs last month ${fmtDiff(copilotMonth.estimatedCost, copilotLastMonth.estimatedCost)}</div>
          </div>
          <div class="card">
            <div class="card-label">Tokens This Month</div>
            <div class="card-value data-text">${fmt(copilotMonth.totalTokens)}</div>
            <div class="card-sub">${copilotMonth.sessions} sessions · ${copilotMonth.interactions} interactions</div>
          </div>
          <div class="card">
            <div class="card-label">Last Month</div>
            <div class="card-value data-text">${fmt(copilotLastMonth.totalTokens)}</div>
            <div class="card-sub">${copilotLastMonth.sessions} sessions · ${fmtCost2(copilotLastMonth.estimatedCost)}</div>
          </div>
        </div>

        <div class="section" style="margin-bottom:24px;">
          <h2>🏷️ Usage by Model (This Month)</h2>
          ${copilotMonth.cacheReadTokens > 0 && copilotMonth.cacheTokensEstimated ? `<p style="font-size:0.85em;color:var(--text-secondary);margin:-8px 0 14px">🧮 "Cached input" is a calculated estimate, not measured by GitHub Copilot - details below.</p>` : ''}
          <table>
            <thead><tr>
              <th>Model</th><th>Input</th><th title="${copilotMonth.cacheReadTokens > 0 && copilotMonth.cacheTokensEstimated ? 'Calculated estimate, not measured by GitHub Copilot' : ''}">Cached input${copilotMonth.cacheReadTokens > 0 && copilotMonth.cacheTokensEstimated ? ' (calc.)' : ''}</th><th>Output</th>
              <th>Official $/1M in/cached/out</th>
              <th>Input USD</th><th>Cached USD</th><th>Output USD</th><th>AI Credits</th><th>Total USD</th>
            </tr></thead>
            <tbody>${copilotModelRows || '<tr><td colspan="10" style="color:var(--text-secondary)">No GitHub Copilot model data yet</td></tr>'}</tbody>
          </table>
        </div>

        <div class="section" style="margin-bottom:24px;">
          <h2>💳 AI Credits Summary</h2>
          <table>
            <thead><tr>
              <th>Category</th>
              <th>Tokens (This Month)</th><th>Cost (This Month)</th>
              <th style="color:var(--text-secondary)">Tokens (Last Month)</th><th style="color:var(--text-secondary)">Cost (Last Month)</th>
            </tr></thead>
            <tbody>${summaryRows}</tbody>
          </table>
        </div>

        <details class="section" style="margin-bottom:24px;" ${copilotMonth.cacheTokensEstimated ? 'open' : ''}>
          <summary style="cursor:pointer;font-weight:600;">${copilotMonth.cacheTokensEstimated ? '🧮 How are Cache Read / Cache Write tokens calculated?' : '✅ Cache Read / Cache Write tokens are measured, not calculated'}</summary>
          <div style="font-size:0.85em;color:var(--text-secondary);line-height:1.6;margin-top:12px;">
            ${copilotMonth.cacheTokensEstimated ? `
            <p><strong>Why they're not real data (for this period):</strong> by default, GitHub Copilot never writes a cache-read/cache-write breakdown to its local session files (only <code>promptTokens</code>/<code>outputTokens</code> are ever present there, no cache split) or to the Copilot CLI's session event log (its schema defines cache fields, but that specific event type is marked "ephemeral" by GitHub and is never written to disk). Turning on Copilot's own <code>github.copilot.chat.agentDebugLog.fileLogging.enabled</code> setting does write real per-call cache counts to local debug-log files, which AI Insights reads automatically when present - but this period had at least one session with no matching debug log (the setting was off, or predates enabling it), so its cache numbers had to be estimated instead.</p>
            <p><strong>How the estimate works:</strong> since real per-turn <code>promptTokens</code> totals <em>are</em> available, we estimate the cache split by comparing consecutive turns in the same session:</p>
            <ul style="margin:6px 0 6px 18px;padding:0;">
              <li><strong>Cache read</strong> = the smaller of (this turn's total prompt tokens) and (the previous turn's total prompt tokens + its output tokens) - i.e. we assume the entire previous turn, including the model's own reply, gets reused from cache as this turn's context grows.</li>
              <li><strong>Cache write</strong> = whatever's left above that (the "fresh" growth this turn). This isn't an independent guess - it follows from the cache-read assumption above, since the next turn's cache-read estimate only makes sense if this turn's new content actually got cached.</li>
            </ul>
            <p><strong>Where it resets to zero:</strong> if prompt tokens shrink from one turn to the next, or the model changes mid-session, that turn is treated as 100% fresh with no cache reuse assumed - a shrink or model switch usually means compaction happened or the request is unrelated to what came before, not genuine cache reuse.</p>
            <p><strong>Confidence:</strong> the cache-read estimate is reasonably grounded in how prompt caching actually works. The cache-write split is rougher - real Copilot sessions might add a large chunk of content (e.g. one big tool result) without it actually being marked for caching, which this method can't distinguish from genuinely-cached growth.</p>
            <p><strong>Turn it off, change how it's applied, or switch to real data:</strong> set <code>aiInsights.providers.copilot.cacheEstimation.enabled</code> to <code>false</code> to disable estimation entirely (cache tokens will show as 0). <code>aiInsights.providers.copilot.cacheEstimation.convention</code> controls whether the estimate is folded into the existing input-token total (<code>inclusive</code>, the default - keeps cost figures on this page accurate) or shown as additional tokens on top of a reduced input figure (<code>exclusive</code> - matches how Claude Code's real cache data is shown elsewhere in this extension, but can understate cost). Or enable real telemetry below - new sessions will then report measured cache numbers instead.</p>
            ${enableRealCacheDataButton}
            ` : `
            <p>Every Copilot session counted this period had a matching <code>debug-logs/{sessionId}/main.jsonl</code> telemetry file, so cache-read/write numbers above are GitHub's own reported <code>cachedTokens</code> counts, not a heuristic. This requires the opt-in <code>github.copilot.chat.agentDebugLog.fileLogging.enabled</code> setting to have been on before each session started - see the Copilot provider wiki page for what that involves.</p>
            ${(copilotChatExtensionInstalled && !copilotDebugLoggingEnabled) ? `<p style="margin-top:8px;">⚠️ That setting is <strong>currently off</strong> though - the sessions above were logged while it was still on. New Copilot sessions from now on will fall back to calculated estimates unless you turn it back on.</p>${enableRealCacheDataButton}` : ''}
            `}
          </div>
        </details>

        <div style="border-top:1px solid var(--border);margin:8px 0 28px;"></div>
        <p style="font-size:0.8em;color:var(--text-secondary);margin-bottom:20px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">📊 Model Pricing Reference</p>
      `;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${assets.csp}
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Insights - GitHub Copilot</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@500;600&display=swap');
  ${designTokensCss()}
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:var(--font-primary); background:var(--bg-base); color:var(--text-primary); padding:0; line-height:1.6; }
  .data-text { font-family:var(--font-data); }
  .model-tag { display:inline-block; margin-left:4px; padding:1px 6px; background:var(--bg-surface-high); border-radius:3px; font-size:0.78em; color:var(--text-secondary); }
  ${navCss()}
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:16px; }
  .card { background:var(--bg-surface); border:1px solid var(--border); border-radius:4px; padding:20px; transition:transform 0.2s; }
  .card:hover { transform:translateY(-2px); box-shadow:0 4px 20px rgba(0,0,0,0.5); }
  .card-label { font-size:0.75em; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:8px; font-weight:500; }
  .card-value { font-size:2em; font-weight:500; color:var(--text-primary); margin:4px 0; }
  .card-sub { font-size:0.75em; color:var(--text-secondary); }
  .github-connect { display:flex; align-items:center; gap:12px; padding:10px 14px; border-radius:6px; font-size:0.85em; margin-bottom:12px; background:rgba(255,255,255,0.04); border:1px solid var(--border); color:var(--text-secondary); }
  .github-connect.connected { border-color:rgba(57,255,20,0.3); background:rgba(57,255,20,0.04); color:var(--text-primary); }
  .gh-btn { padding:4px 12px; border-radius:4px; border:1px solid var(--border); background:var(--bg-surface); color:var(--text-primary); cursor:pointer; font-size:0.82em; white-space:nowrap; }
  .gh-btn:hover { border-color:#39FF14; color:#39FF14; }
  .gh-btn-danger:hover { border-color:#ff6b6b; color:#ff6b6b; }
  .gh-credits-bar { height:4px; border-radius:2px; background:rgba(255,255,255,0.1); overflow:hidden; }
  .gh-credits-bar-fill { height:100%; border-radius:2px; background:#39FF14; transition:width 0.3s; }
  .alert { padding:10px 14px; border-radius:6px; font-size:0.85em; margin-bottom:10px; }
  .alert-crit { background:rgba(255,77,77,0.1); border:1px solid rgba(255,77,77,0.35); color:#ff8a8a; }
  .alert-info { background:rgba(0,122,255,0.07); border:1px solid rgba(0,122,255,0.25); color:#6db3ff; }
  .alert-ok { background:rgba(249,226,175,0.07); border:1px solid rgba(249,226,175,0.25); color:#f9e2af; }
  .info-bar { background:rgba(0,122,255,0.07); border:1px solid rgba(0,122,255,0.2); border-radius:8px; padding:14px 18px; margin-bottom:24px; display:flex; gap:32px; flex-wrap:wrap; align-items:center; }
  .info-item { font-size:0.88em; color:var(--text-secondary); }
  .info-item strong { color:var(--text-primary); }
  .info-item a { color:var(--primary); text-decoration:none; }
  .info-item a:hover { text-decoration:underline; }
  .section { background:var(--bg-surface); border:1px solid var(--border); border-radius:8px; padding:24px; margin-bottom:24px; }
  .section h2 { font-size:1.1em; font-weight:600; margin-bottom:16px; }
  .provider-heading { font-size:0.75em; font-weight:600; margin-bottom:16px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.08em; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:left; padding:10px 12px; background:var(--bg-surface-high); color:var(--text-secondary); font-size:0.72em; text-transform:uppercase; letter-spacing:0.05em; border-bottom:1px solid var(--border); font-weight:500; }
  th.num { text-align:right; }
  td { padding:10px 12px; border-bottom:1px solid var(--border); font-size:0.88em; vertical-align:middle; }
  td.num { text-align:right; }
  tr:last-child td { border-bottom:none; }
  tr.row-official:hover td { background:rgba(57,255,20,0.03); }
  tr.row-other { opacity:0.6; }
  tr.row-other:hover td { background:rgba(255,255,255,0.015); opacity:1; }
  .sub { font-size:0.85em; font-weight:400; text-transform:none; letter-spacing:0; }
  .model-name { font-weight:500; font-size:0.9em; }
  .model-id { font-size:0.75em; color:var(--text-secondary); margin-top:2px; font-family:var(--font-data); }
  .badge { font-size:0.72em; padding:2px 7px; border-radius:10px; font-weight:600; white-space:nowrap; }
  .badge-official { background:rgba(57,255,20,0.12); color:#39FF14; border:1px solid rgba(57,255,20,0.3); }
  .badge-other { background:rgba(255,255,255,0.05); color:var(--text-secondary); border:1px solid rgba(255,255,255,0.08); }
  .credits { color:#f9e2af; }
  .cat { font-size:0.72em; padding:2px 7px; border-radius:10px; font-weight:500; }
  .cat-powerful { background:rgba(255,77,77,0.12); color:#ff8a8a; }
  .cat-versatile { background:rgba(0,122,255,0.12); color:#6db3ff; }
  .cat-lightweight { background:rgba(57,255,20,0.10); color:#77dd77; }
  .cat-legacy { background:rgba(255,255,255,0.05); color:var(--text-secondary); }
  .formula-box { background:var(--bg-surface); border:1px solid var(--border); border-radius:8px; padding:20px 24px; margin-bottom:24px; }
  .formula-box h2 { font-size:1em; font-weight:600; margin-bottom:14px; }
  .formula { font-family:var(--font-data); font-size:0.88em; background:var(--bg-surface-high); padding:12px 16px; border-radius:4px; color:#f9e2af; margin-bottom:10px; white-space:pre; }
  .formula-note { font-size:0.82em; color:var(--text-secondary); }
  .footer { text-align:center; padding:16px; color:var(--text-secondary); font-size:0.75em; font-style:italic; }
</style>
</head>
<body>
  ${navTopbarHtml(logoUri, false)}
  ${navPagebarHtml('pricing', 'GitHub Copilot')}
  <div class="ns-content">

  ${copilotUsageHtml}

  <div class="info-bar">
    <div class="info-item"><strong>1 AI credit</strong> = $0.01 USD</div>
    <div class="info-item"><strong>${officialCount} models</strong> officially listed in Copilot billing docs</div>
    <div class="info-item">Source: <a href="https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing">GitHub Copilot Models &amp; Pricing</a></div>
    <div class="info-item">Last updated: <strong>${lastUpdated}</strong></div>
  </div>

  <div class="formula-box">
    <h2>💡 Credit Calculation</h2>
    <div class="formula">credits = (input_tokens × input_$/1M  +  cache_read_tokens × cached_$/1M
           +  cache_write_tokens × write_$/1M  +  output_tokens × output_$/1M)  /  1,000,000  /  $0.01</div>
    <div class="formula-note">Code completions remain unlimited on paid Copilot plans and do not consume AI credits.</div>
  </div>

  ${providerSections}

  <div class="footer">Pricing from official GitHub Copilot billing documentation. Models marked "Official" are listed at docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing.</div>
  </div><!-- /ns-content -->

  <script nonce="${assets.nonce}">
    const vsc = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null;
    if (typeof window.vscode === 'undefined' && vsc) { window.vscode = vsc; }

    document.addEventListener('click', function(ev) {
      const el = ev.target.closest('[data-post],[data-multiplier],[data-action]');
      if (!el) { return; }
      const post = el.getAttribute('data-post');
      if (post && window.vscode) { window.vscode.postMessage({ command: post }); return; }
      const mult = el.getAttribute('data-multiplier');
      if (mult !== null) { setMultiplier(Number(mult)); return; }
      if (el.getAttribute('data-action') === 'savePlannerConfig') { savePlannerConfig(); }
    });

    function setMultiplier(v) {
      const el = document.getElementById('plannerMultiplier');
      if (el) { el.value = v; }
      savePlannerConfig();
    }
    function savePlannerConfig() {
      const m = document.getElementById('plannerMultiplier');
      const r = document.getElementById('plannerReserve');
      if (!vsc) { return; }
      vsc.postMessage({
        command: 'setPlannerConfig',
        modelMultiplier: m ? m.value : 1,
        reserveCredits: r ? r.value : 0,
      });
    }

    ${navJs()}
  </script>
</body>
</html>`;
  }
}
