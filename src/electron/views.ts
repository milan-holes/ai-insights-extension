import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dialog, shell } from 'electron';
import packageJSON from '../../package.json';
import { StandaloneInsightsService, StandaloneRefreshResult } from '../standalone/service';
import { DashboardProvider } from '../webview/dashboard';
import { SessionsViewProvider } from '../webview/sessionsView';
import { UsageAnalysisProvider } from '../webview/usageAnalysis';
import { PricingViewProvider } from '../webview/pricingView';
import { PromptHistoryViewProvider } from '../webview/promptHistoryView';
import { ReplayViewProvider } from '../webview/replayView';
import { SessionCompareProvider } from '../webview/sessionCompareView';
import { TokenCalculatorProvider } from '../webview/tokenCalculator';
import { ChartsProvider } from '../webview/charts';
import { AIStructureViewProvider } from '../webview/aiStructureView';
import { RepoAnalysisViewProvider } from '../webview/repoAnalysisView';
import { ClaudeAccountViewProvider } from '../webview/claudeAccountView';
import { BenchmarkViewProvider } from '../webview/benchmarkView';
import { PromptHistoryStore } from '../core/promptHistory';
import { computeUsageHealthScore } from '../core/usageHealthScore';
import { buildHygieneReports } from '../core/repositoryHygiene';
import type { ConnectedGitHubUser } from '../core/githubAuth';
import { fetchCopilotQuota, buildQuotaView, QuotaHistoryStore, findPremiumQuota, computeQuotaStats, CopilotQuotaView } from '../core/copilotQuota';
import { fetchClaudeRateLimitHeaders, readClaudeOAuthAccessToken, ClaudeRateLimitSnapshot } from '../core/claudeQuota';
import { configureViewHost, desktopContext, DesktopPanel, disposeAllPanels, receiveViewMessage, setWorkspaceRoot, workspace } from './viewHost';
import { isExcludedDesktopCommand } from './viewPolicy';

export class DesktopViews {
  private result?: StandaloneRefreshResult;
  private refreshPromise?: Promise<StandaloneRefreshResult>;
  private context: any;
  private currentCommand = 'aiInsights.showDashboard';
  private currentArgs: any[] = [];
  private tags: Record<string, string[]> = {};
  private dismissed = new Set<string>();
  private snoozed: Record<string, number> = {};
  private githubUser?: ConnectedGitHubUser;
  private copilotQuota?: CopilotQuotaView;
  private claudeQuota?: ClaudeRateLimitSnapshot;
  private lastClaudeFetch = 0;
  private lastCopilotFetch = 0;
  private quotaHistory: QuotaHistoryStore;
  private timer: NodeJS.Timeout;

  constructor(private service: StandaloneInsightsService, private storageDir: string,
    render: (panel: DesktopPanel) => void, post: (message: unknown) => void) {
    configureViewHost({ render, post, storageDir,
      command: (command, ...args) => this.command(command, ...args),
      getConfig: () => service.getConfig(), saveConfig: config => { service.saveConfig(config); },
    });
    const properties = packageJSON.contributes.configuration.properties;
    const supported = Object.fromEntries(Object.entries(properties).filter(([key]) => workspace.getConfiguration().get(key) !== undefined));
    this.context = desktopContext(__dirname, { ...packageJSON, contributes: { configuration: { properties: supported } } });
    this.tags = this.context.globalState.get('tags', {});
    this.dismissed = new Set(this.context.globalState.get('dismissedInsights', []));
    this.snoozed = this.context.globalState.get('snoozedInsights', {});
    this.githubUser = this.context.globalState.get('githubUser');
    this.quotaHistory = new QuotaHistoryStore(this.context.globalState);
    this.timer = setInterval(() => { void this.command('aiInsights.refresh').catch(error => console.error('[electron] Refresh failed:', error)); }, 5 * 60 * 1000);
    const root = this.context.globalState.get('workspaceRoot');
    if (root && fs.existsSync(root)) { setWorkspaceRoot(root); }
    SessionsViewProvider._addTag = (id, tag) => { void this.saveTag(id, tag, true); };
    SessionsViewProvider._removeTag = (id, tag) => { void this.saveTag(id, tag, false); };
  }

  async refresh(): Promise<StandaloneRefreshResult> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.service.refresh().then(result => { this.result = result; return result; })
        .finally(() => { this.refreshPromise = undefined; });
    }
    return this.refreshPromise;
  }

  async message(message: Record<string, any>): Promise<void> {
    if (isExcludedDesktopCommand(message.command)) { return; }
    if (message.command === 'desktopWorkspace') { await this.chooseWorkspace(); return; }
    if (message.command === 'desktopNavigate' && typeof message.target === 'string') {
      await this.command(message.target); return;
    }
    await receiveViewMessage(message);
  }

  private async chooseWorkspace(): Promise<void> {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Open Repository' });
    if (result.canceled || !result.filePaths[0]) { return; }
    setWorkspaceRoot(result.filePaths[0]);
    await this.context.globalState.update('workspaceRoot', result.filePaths[0]);
    disposeAllPanels();
    await this.command(this.currentCommand, ...this.currentArgs);
  }

  async command(command: string, ...args: any[]): Promise<unknown> {
    if (isExcludedDesktopCommand(command)) { return; }
    if (command === 'vscode.openFolder') { return shell.openPath(args[0].fsPath); }
    if (command === 'aiInsights.refresh') {
      await this.refresh();
      await this.command(this.currentCommand, ...this.currentArgs);
      return;
    }
    if (command === 'aiInsights.dismissInsight' || command === 'aiInsights.snoozeInsight') {
      if (command.endsWith('dismissInsight')) {
        this.dismissed.add(String(args[0]));
        await this.context.globalState.update('dismissedInsights', [...this.dismissed]);
      } else {
        this.snoozed[String(args[0])] = Date.now() + 24 * 60 * 60 * 1000;
        await this.context.globalState.update('snoozedInsights', this.snoozed);
      }
      return this.command(this.currentCommand, ...this.currentArgs);
    }
    if (command === 'aiInsights.connectGitHub') {
      try {
        const token = await this.githubToken();
        const response = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'AI-Insights' }, signal: AbortSignal.timeout(10000) });
        if (!response.ok) { throw new Error(`GitHub returned ${response.status}`); }
        const user = await response.json() as { login: string };
        this.githubUser = { login: user.login, planName: 'GitHub', monthlyBudgetUsd: this.service.getConfig().copilotPlanBudget };
        await this.context.globalState.update('githubUser', this.githubUser);
        this.lastCopilotFetch = 0;
        return this.command(this.currentCommand, ...this.currentArgs);
      } catch {
        throw new Error('Sign in with GitHub CLI (gh auth login), then connect again. No editor extension is needed.');
      }
    }
    if (command === 'aiInsights.disconnectGitHub') {
      this.githubUser = undefined; this.copilotQuota = undefined;
      await this.context.globalState.update('githubUser', null);
      return this.command(this.currentCommand, ...this.currentArgs);
    }
    if (command === 'aiInsights.enableCopilotRealCacheData') {
      await dialog.showMessageBox({ message: 'Enable github.copilot.chat.agentDebugLog.fileLogging.enabled in your editor settings to record real cache data.', type: 'info' }); return;
    }
    const known = new Set(['showDashboard', 'showSessions', 'showSessionsView', 'showUsageAnalysis', 'showPricing',
      'showPromptHistory', 'showSessionReplay', 'compareSessionsView', 'showTokenCalculator',
      'showCharts', 'showAIStructure', 'showRepoAnalysis', 'showClaudeAccount', 'showBenchmark']);
    const view = command.replace(/^aiInsights\./, '');
    if (!known.has(view)) { throw new Error(`Unsupported desktop action: ${command}`); }
    this.currentCommand = command; this.currentArgs = args;
    const result = this.result ?? await this.refresh();
    if (view === 'showPricing' || view === 'showDashboard') { await this.refreshCopilotQuota(); }
    if (view === 'showClaudeAccount') { await this.refreshClaudeQuota(); }
    const m = result.metrics;
    const ctx = this.context;
    const reports = buildHygieneReports(result.sessions, workspace.workspaceFolders);
    const acceptance = { triggered: 0, accepted: 0, acceptanceRate: 0, since: new Date() };
    switch (view) {
      case 'showDashboard':
        DashboardProvider.createPanel(ctx, m, this.githubUser, false, reports, undefined, undefined,
          computeUsageHealthScore(m, result.sessions), undefined,
          result.insights.filter(i => !this.dismissed.has(i.id) && !(this.snoozed[i.id] > Date.now())), this.copilotQuota);
        break;
      case 'showSessions': case 'showSessionsView': SessionsViewProvider.createPanel(ctx, result.sessions, [], null, false, this.tags); break;
      case 'showUsageAnalysis': UsageAnalysisProvider.createPanel(ctx, m, reports, acceptance); break;
      case 'showPricing': PricingViewProvider.createPanel(ctx, m, this.githubUser, this.copilotQuota); break;
      case 'showPromptHistory': {
        const history = new PromptHistoryStore(); history.update(result.sessions);
        PromptHistoryViewProvider.createPanel(ctx, history.getAll()); break;
      }
      case 'showSessionReplay': {
        const session = result.sessions.find(s => s.id === args[0]);
        if (session) { ReplayViewProvider.createPanel(ctx, session); } break;
      }
      case 'compareSessionsView': SessionCompareProvider.createPanel(ctx, result.sessions.filter(s => args[0]?.includes(s.id))); break;
      case 'showTokenCalculator': TokenCalculatorProvider.createPanel(ctx); break;
      case 'showCharts': ChartsProvider.createPanel(ctx, m); break;
      case 'showAIStructure': await AIStructureViewProvider.createPanel(ctx); break;
      case 'showRepoAnalysis': await RepoAnalysisViewProvider.createPanel(ctx); break;
      case 'showClaudeAccount': await ClaudeAccountViewProvider.createPanel(ctx, m, result.sessions, this.claudeQuota); break;
      case 'showBenchmark': await BenchmarkViewProvider.createPanel(ctx); break;
    }
  }
  private async saveTag(id: string, tag: string, add: boolean): Promise<void> {
    const values = new Set(this.tags[id] ?? []);
    if (add) { values.add(tag); } else { values.delete(tag); }
    this.tags[id] = [...values];
    await this.context.globalState.update('tags', this.tags);
  }
  private async githubToken(): Promise<string> {
    const result = await promisify(execFile)('gh', ['auth', 'token'], { timeout: 10000 });
    return result.stdout.trim();
  }
  private async refreshCopilotQuota(): Promise<void> {
    if (!this.githubUser || Date.now() - this.lastCopilotFetch < 5 * 60 * 1000) { return; }
    this.lastCopilotFetch = Date.now();
    try {
      const data = await fetchCopilotQuota(await this.githubToken());
      if (!data) { return; }
      this.quotaHistory.setAccount(this.githubUser.login);
      const premium = findPremiumQuota(data);
      if (premium) { const stats = computeQuotaStats(premium); this.quotaHistory.add(stats.remaining, stats.entitlement); }
      this.copilotQuota = buildQuotaView(data);
      this.githubUser.planName = data.copilot_plan;
    } catch { /* Keep local usage available when authentication expires. */ }
  }
  private async refreshClaudeQuota(): Promise<void> {
    if (!this.service.getConfig().providers.claudeCode.readLiveQuota) { this.claudeQuota = undefined; return; }
    if (!this.result?.sessions.some(s => s.provider === 'claudeCode') || Date.now() - this.lastClaudeFetch < 5 * 60 * 1000) { return; }
    this.lastClaudeFetch = Date.now();
    const token = readClaudeOAuthAccessToken();
    if (token) { this.claudeQuota = (await fetchClaudeRateLimitHeaders(token)) ?? undefined; }
  }
  stop(): void { clearInterval(this.timer); disposeAllPanels(); }
}
