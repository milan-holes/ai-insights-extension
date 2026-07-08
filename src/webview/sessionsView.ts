import * as vscode from 'vscode';
import { LiveBudgetConfig, LiveSessionState, Session } from '../types';
import { PROVIDER_ICONS } from './providerIcons';
import { computeContextRotScore, computeContextRotAnalysis, ContextRotScore } from '../core/contextRot';
import { navCss, navTopbarHtml, navPagebarHtml, navJs, NAV_COMMANDS } from './navShared';
import { designTokensCss } from './designSystem';

type SessionRow = {
  id: string;
  provider: string;
  providerName: string;
  startTime: string;
  endTime: string;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalThinkingTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalToolCalls: number;
  interactions: number;
  models: string[];
  workspace: string;
  title: string;
  estimatedCostUsd: number;
  aiCredits: number;
  sourceFile: string;
  contextRot: ContextRotScore;
  fileReads: Record<string, number>;
  fileEdits: Record<string, number>;
  toolCalls: Record<string, number>;
  commandRuns: Record<string, number>;
  tags: string[];
};

export class SessionsViewProvider {
  static readonly viewType = 'aiInsights.sessionsView';
  private static currentPanel: vscode.WebviewPanel | undefined;
  /** Latest session list, kept in sync for on-demand analysis requests. */
  private static _sessions: Session[] = [];
  /** True while the analyze overlay is open — skip HTML replacement to preserve it. */
  private static _overlayOpen = false;
  /** Pending update to apply once overlay closes. */
  private static _pendingUpdate: (() => void) | null = null;
  /** Latest tags map for re-render after tag changes. */
  private static _tagsMap: Record<string, string[]> = {};
  /** Called by extension after a tag is added; extension handles persistence and triggers pushUpdate. */
  static _addTag: ((sessionId: string, tag: string) => void) | undefined;
  /** Called by extension after a tag is removed; extension handles persistence and triggers pushUpdate. */
  static _removeTag: ((sessionId: string, tag: string) => void) | undefined;

  static createPanel(
    context: vscode.ExtensionContext,
    sessions: Session[],
    liveSessions: LiveSessionState[] = [],
    budgetConfig: LiveBudgetConfig | null = null,
    refreshing = false,
    tagsMap: Record<string, string[]> = {},
  ): vscode.WebviewPanel {
    SessionsViewProvider._sessions = sessions;
    SessionsViewProvider._tagsMap = tagsMap;
    const rows = SessionsViewProvider.toRows(sessions, tagsMap);
    const logoPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'logo.png');

    if (SessionsViewProvider.currentPanel) {
      const logoUri = SessionsViewProvider.currentPanel.webview.asWebviewUri(logoPath).toString();
      SessionsViewProvider.currentPanel.webview.html = SessionsViewProvider.buildHtml(rows, liveSessions, budgetConfig, refreshing, logoUri);
      SessionsViewProvider.currentPanel.reveal(vscode.ViewColumn.One);
      return SessionsViewProvider.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      SessionsViewProvider.viewType,
      'AI Sessions',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')],
      }
    );
    const logoUri = panel.webview.asWebviewUri(logoPath).toString();
    panel.webview.html = SessionsViewProvider.buildHtml(rows, liveSessions, budgetConfig, refreshing, logoUri);

    panel.webview.onDidReceiveMessage(
      (message) => {
        const navCmd = NAV_COMMANDS[message.command];
        if (navCmd) { vscode.commands.executeCommand(navCmd); return; }
        if (message.command === 'refresh') {
          vscode.commands.executeCommand('aiInsights.showSessionsView');
        } else if (message.command === 'requestSessionAnalysis' && message.sessionId) {
          const sess = SessionsViewProvider._sessions.find(s => s.id === message.sessionId);
          if (sess) {
            const analysis = computeContextRotAnalysis(sess, SessionsViewProvider._sessions);
            const detail = {
              id: sess.id,
              provider: sess.provider,
              workspace: sess.workspace || '',
              interactions: sess.interactions.map(i => ({
                ts: i.timestamp instanceof Date ? i.timestamp.toISOString() : String(i.timestamp),
                model: i.model || '',
                mode: i.mode || '',
                inputTokens: i.inputTokens,
                outputTokens: i.outputTokens,
                thinkingTokens: i.thinkingTokens,
                cacheReadTokens: i.cacheReadTokens,
                cacheWriteTokens: i.cacheWriteTokens,
                cacheTokensEstimated: i.cacheTokensEstimated || false,
                toolCalls: i.toolCalls || [],
                commandRuns: i.commandRuns || [],
                fileAccesses: i.fileAccesses || [],
                promptPreview: i.promptPreview || '',
                isCompactionEvent: i.isCompactionEvent || false,
                compactionTrigger: i.compactionTrigger,
                preCompactionTokens: i.preCompactionTokens,
                postCompactionTokens: i.postCompactionTokens,
              })),
            };
            panel.webview.postMessage({ command: 'sessionAnalysis', analysis, detail });
          } else {
            panel.webview.postMessage({ command: 'sessionAnalysis', analysis: null, detail: null });
          }
        } else if (message.command === 'openSession' && message.sourceFile) {
          vscode.workspace.openTextDocument(vscode.Uri.file(message.sourceFile))
            .then(doc => vscode.window.showTextDocument(doc))
            .then(undefined, () => vscode.window.showErrorMessage(`Cannot open: ${message.sourceFile}`));
        } else if (message.command === 'replaySession' && message.sessionId) {
          vscode.commands.executeCommand('aiInsights.showSessionReplay', message.sessionId);
        } else if (message.command === 'compareSelectedSessions' && Array.isArray(message.sessionIds) && message.sessionIds.length >= 2) {
          vscode.commands.executeCommand('aiInsights.compareSessionsView', message.sessionIds);
        } else if (message.command === 'addTag' && message.sessionId && message.tag) {
          SessionsViewProvider._addTag?.(message.sessionId, String(message.tag));
        } else if (message.command === 'removeTag' && message.sessionId && message.tag) {
          SessionsViewProvider._removeTag?.(message.sessionId, String(message.tag));
        } else if (message.command === 'exportSessions' && message.csv) {
          vscode.workspace.openTextDocument({ content: message.csv, language: 'csv' })
            .then(doc => vscode.window.showTextDocument(doc, vscode.ViewColumn.Two));
        } else if (message.command === 'overlayOpened') {
          SessionsViewProvider._overlayOpen = true;
        } else if (message.command === 'overlayClosed') {
          SessionsViewProvider._overlayOpen = false;
          if (SessionsViewProvider._pendingUpdate) {
            SessionsViewProvider._pendingUpdate();
            SessionsViewProvider._pendingUpdate = null;
          }
        }
      },
      undefined,
      context.subscriptions
    );

    panel.onDidDispose(() => {
      SessionsViewProvider.currentPanel = undefined;
    }, null, context.subscriptions);

    SessionsViewProvider.currentPanel = panel;
    return panel;
  }

  /** Push updated live/session data without stealing focus from the user. */
  static pushUpdate(
    context: vscode.ExtensionContext,
    sessions: Session[],
    liveSessions: LiveSessionState[] = [],
    budgetConfig: LiveBudgetConfig | null = null,
    refreshing = false,
    tagsMap: Record<string, string[]> = {},
  ): void {
    SessionsViewProvider._sessions = sessions;
    SessionsViewProvider._tagsMap = tagsMap;
    if (!SessionsViewProvider.currentPanel) { return; }
    const doUpdate = () => {
      if (!SessionsViewProvider.currentPanel) { return; }
      const logoPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'logo.png');
      const logoUri = SessionsViewProvider.currentPanel.webview.asWebviewUri(logoPath).toString();
      const rows = SessionsViewProvider.toRows(SessionsViewProvider._sessions, SessionsViewProvider._tagsMap);
      SessionsViewProvider.currentPanel.webview.html = SessionsViewProvider.buildHtml(
        rows,
        liveSessions,
        budgetConfig,
        refreshing,
        logoUri,
      );
    };
    if (SessionsViewProvider._overlayOpen) {
      SessionsViewProvider._pendingUpdate = doUpdate;
    } else {
      doUpdate();
    }
  }

  private static toRows(sessions: Session[], tagsMap: Record<string, string[]> = {}): SessionRow[] {
    return [...sessions]
      .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime())
      .map(s => {
        const cost = s.estimatedCostUsd ?? 0;
        const fileReads: Record<string, number> = {};
        const fileEdits: Record<string, number> = {};
        const toolCalls: Record<string, number> = {};
        const commandRuns: Record<string, number> = {};
        for (const interaction of s.interactions || []) {
          for (const tool of interaction.toolCalls || []) {
            toolCalls[tool] = (toolCalls[tool] || 0) + 1;
          }
          for (const command of interaction.commandRuns || []) {
            commandRuns[command] = (commandRuns[command] || 0) + 1;
          }
          for (const access of interaction.fileAccesses || []) {
            const tool = access.tool.toLowerCase();
            const target = tool === 'edit' || tool === 'notebookedit' || tool === 'write'
              ? fileEdits
              : fileReads;
            target[access.path] = (target[access.path] || 0) + 1;
          }
        }
        return {
          id: s.id,
          provider: s.provider,
          providerName: s.providerName,
          startTime: s.startTime instanceof Date ? s.startTime.toISOString() : String(s.startTime),
          endTime: s.endTime instanceof Date ? s.endTime.toISOString() : String(s.endTime),
          totalTokens: s.totalTokens,
          totalInputTokens: s.totalInputTokens,
          totalOutputTokens: s.totalOutputTokens,
          totalThinkingTokens: s.totalThinkingTokens,
          totalCacheReadTokens: s.totalCacheReadTokens,
          totalCacheWriteTokens: s.totalCacheWriteTokens,
          totalToolCalls: (s.interactions || []).reduce((sum: number, i: any) => sum + (i.toolCalls?.length ?? 0), 0),
          interactions: (s.interactions || []).length,
          models: s.models,
          workspace: s.workspace,
          title: s.title || '',
          estimatedCostUsd: cost,
          aiCredits: Math.round(cost * 100 * 100) / 100,
          sourceFile: s.sourceFile || '',
          contextRot: computeContextRotScore(s),
          fileReads,
          fileEdits,
          toolCalls,
          commandRuns,
          tags: tagsMap[s.id] ?? [],
        };
      });
  }

  static buildHtml(
    rows: SessionRow[],
    liveSessions: LiveSessionState[] = [],
    budgetConfig: LiveBudgetConfig | null = null,
    refreshing = false,
    logoUri = '',
  ): string {
    const safe = JSON.stringify(rows).replace(/<\/script>/gi, '<\\/script>');
    const parts: string[] = [];

    parts.push('<!DOCTYPE html><html lang="en"><head>');
    parts.push('<meta charset="UTF-8">');
    parts.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
    parts.push('<title>AI Sessions</title>');
    parts.push('<style>');
    parts.push(designTokensCss());
    parts.push('*{margin:0;padding:0;box-sizing:border-box;}');
    parts.push('body{font-family:var(--font-primary);background:var(--bg-base);color:var(--text-primary);padding:0;line-height:1.6;}');
    parts.push(navCss());
    parts.push('.btn{background:transparent;border:1px solid var(--border);color:var(--text-primary);padding:8px 16px;border-radius:4px;cursor:pointer;font-size:0.85em;font-weight:500;transition:all 0.2s;}');
    parts.push('.btn:hover{background:rgba(255,255,255,0.05);}');
    parts.push('.btn-primary{background:var(--primary);color:white;border:none;box-shadow:0 0 15px var(--primary-glow);}');
    parts.push('.btn-primary:hover{background:#005bc1;}');
    parts.push('.btn.is-loading{opacity:0.7;pointer-events:none;}');
    parts.push('.btn.is-loading::after{content:"";display:inline-block;width:10px;height:10px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 0.7s linear infinite;margin-left:6px;vertical-align:middle;}');

    parts.push('.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px;}');
    parts.push('.summary-card{background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:20px;text-align:center;transition:transform 0.2s;position:relative;overflow:hidden;}');
    parts.push('.summary-card:hover{transform:translateY(-2px);border-color:rgba(0,122,255,0.3);}');
    parts.push('.summary-label{font-size:0.75em;text-transform:uppercase;color:var(--text-secondary);letter-spacing:0.05em;margin-bottom:8px;font-weight:600;}');
    parts.push('.summary-value{font-size:1.8em;font-weight:600;font-family:var(--font-data);color:var(--text-primary);}');
    parts.push('.summary-sub{font-size:0.8em;color:var(--text-secondary);margin-top:4px;opacity:0.7;}');

    parts.push('.filter-bar{display:flex;align-items:center;gap:12px;margin-bottom:20px;flex-wrap:wrap;background:var(--bg-surface);padding:12px 16px;border-radius:8px;border:1px solid var(--border);}');
    parts.push('.filter-group{display:flex;align-items:center;gap:8px;}');
    parts.push('.filter-label{font-size:0.8em;color:var(--text-secondary);white-space:nowrap;}');
    parts.push('.filter-bar select,.filter-bar input{background:var(--bg-base);border:1px solid var(--border);color:var(--text-primary);padding:7px 12px;border-radius:4px;font-size:0.85em;font-family:var(--font-primary);outline:none;}');
    parts.push('.filter-bar select:focus,.filter-bar input:focus{border-color:var(--primary);}');
    parts.push('.filter-bar input{min-width:250px;}');

    parts.push('.chart-section{background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:24px;margin-bottom:32px;display:grid;grid-template-columns:2fr 1fr;gap:24px;min-height:350px;}');
    parts.push('.chart-wrap{position:relative;height:300px;}');
    parts.push('@media(max-width:1000px){.chart-section{grid-template-columns:1fr;}}');

    parts.push('.legend{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px;font-size:0.78em;color:var(--text-secondary);}');
    parts.push('.legend-item{display:flex;align-items:center;gap:5px;}');
    parts.push('.legend-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}');

    parts.push('.section{background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;overflow-x:auto;margin-bottom:32px;}');
    parts.push('table{width:100%;min-width:1100px;border-collapse:collapse;}');
    parts.push('th{text-align:left;padding:11px 14px;background:var(--bg-surface-high);color:var(--text-secondary);font-size:0.72em;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--border);font-weight:500;white-space:nowrap;}');
    parts.push('th.sortable{cursor:pointer;user-select:none;}');
    parts.push('th.sortable:hover{color:var(--text-primary);}');
    parts.push('th.sorted{color:var(--primary);}');
    parts.push('td{padding:10px 14px;border-bottom:1px solid var(--border);font-size:0.875em;vertical-align:middle;}');
    parts.push('tr:last-child td{border-bottom:none;}');
    parts.push('tr:hover td{background:rgba(255,255,255,0.02);}');

    parts.push('.provider-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:3px;font-size:0.8em;font-weight:500;white-space:nowrap;}');
    parts.push('.p-copilot{background:rgba(0,200,100,0.1);color:#00c864;}');
    parts.push('.p-antigravity{background:rgba(240,147,251,0.1);color:#f093fb;}');
    parts.push('.p-claudeCode{background:rgba(0,122,255,0.1);color:#007AFF;}');
    parts.push('.p-codex{background:rgba(52,199,89,0.1);color:#34C759;}');
    parts.push('.ws-cell{font-family:var(--font-data);font-size:0.82em;color:var(--text-secondary);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;}');
    parts.push('.title-cell{font-size:0.82em;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;color:var(--text-secondary);}');
    parts.push('.credits-cell{font-family:var(--font-data);font-size:0.82em;white-space:nowrap;}');
    parts.push('.credits-badge{display:inline-block;padding:2px 7px;background:rgba(0,200,100,0.1);border-radius:3px;color:#00c864;font-weight:600;}');
    parts.push('.model-tag{display:inline-block;padding:1px 6px;background:var(--bg-surface-high);border-radius:3px;font-size:0.75em;color:var(--text-secondary);font-family:var(--font-data);margin:1px 2px 1px 0;}');
    parts.push('.breakdown-cell{min-width:220px;}');
    parts.push('.tok-bar{display:flex;height:6px;border-radius:3px;overflow:hidden;margin-bottom:7px;background:rgba(255,255,255,0.04);}');
    parts.push('.tok-labels{display:flex;flex-wrap:wrap;gap:6px 10px;font-family:var(--font-data);font-size:0.75em;line-height:1.4;}');
    parts.push('.tok-chip{display:inline-flex;align-items:center;gap:3px;white-space:nowrap;}');
    parts.push('.tok-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}');
    parts.push('.footer{text-align:center;padding:16px;color:var(--text-secondary);font-size:0.75em;font-style:italic;}');
    parts.push('.data-text{font-family:var(--font-data);}');
    parts.push('.btn-open{background:transparent;border:1px solid var(--border);color:var(--text-secondary);padding:3px 8px;border-radius:3px;cursor:pointer;font-size:0.78em;white-space:nowrap;transition:all 0.15s;}');
    parts.push('.btn-open:hover{border-color:var(--primary);color:var(--primary);}');
    parts.push('.row-check{width:15px;height:15px;cursor:pointer;accent-color:var(--primary);flex-shrink:0;}');
    parts.push('tr.row-selected td{background:rgba(0,122,255,0.06)!important;}');
    parts.push('.compare-bar{position:fixed;bottom:0;left:0;right:0;z-index:8000;background:var(--bg-surface-high);border-top:1px solid rgba(0,122,255,0.4);padding:12px 32px;display:none;align-items:center;gap:14px;box-shadow:0 -4px 24px rgba(0,122,255,0.14);}');
    parts.push('.compare-bar.visible{display:flex;}');
    parts.push('.compare-bar-info{flex:1;font-size:0.88em;color:var(--text-secondary);}');
    parts.push('.compare-bar-count{font-weight:700;color:var(--primary);}');
    parts.push('.btn-compare{background:var(--primary);color:#fff;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:0.88em;font-weight:600;box-shadow:0 0 16px rgba(0,122,255,0.3);transition:background 0.15s;}');
    parts.push('.btn-compare:hover{background:#005bc1;}');
    parts.push('.btn-clear-sel{background:transparent;border:1px solid var(--border);color:var(--text-secondary);padding:7px 14px;border-radius:6px;cursor:pointer;font-size:0.85em;transition:all 0.15s;}');
    parts.push('.btn-clear-sel:hover{border-color:rgba(255,255,255,0.2);color:var(--text-primary);}');
    parts.push('.tags-cell{min-width:120px;max-width:220px;}');
    parts.push('.tag-chip{display:inline-flex;align-items:center;gap:3px;padding:1px 7px;background:rgba(0,122,255,0.1);border:1px solid rgba(0,122,255,0.25);border-radius:12px;font-size:0.72em;color:var(--primary);margin:1px 2px;white-space:nowrap;}');
    parts.push('.tag-rm{background:none;border:none;color:rgba(0,122,255,0.6);cursor:pointer;padding:0 1px;font-size:0.9em;line-height:1;transition:color 0.1s;}');
    parts.push('.tag-rm:hover{color:#FF3B30;}');
    parts.push('.btn-tag-add{background:transparent;border:1px dashed rgba(255,255,255,0.15);color:var(--text-secondary);width:18px;height:18px;border-radius:50%;cursor:pointer;font-size:0.85em;line-height:16px;text-align:center;padding:0;transition:all 0.15s;vertical-align:middle;margin-left:1px;}');
    parts.push('.btn-tag-add:hover{border-color:var(--primary);color:var(--primary);}');
    parts.push('.tag-input{background:var(--bg-base);border:1px solid var(--primary);color:var(--text-primary);padding:1px 7px;border-radius:10px;font-size:0.75em;width:90px;outline:none;vertical-align:middle;margin-left:3px;}');
    parts.push('.chk-cell{width:32px;text-align:center;}');
    parts.push('.approx-price{font-family:var(--font-data);font-size:0.82em;color:var(--text-secondary);}');
    parts.push('.ctx-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:3px;font-size:0.78em;font-weight:600;white-space:nowrap;cursor:default;}');
    parts.push('.ctx-healthy{background:rgba(0,200,100,0.1);color:#00c864;}');
    parts.push('.ctx-warning{background:rgba(255,159,10,0.12);color:#FF9F0A;}');
    parts.push('.ctx-stale{background:rgba(255,59,48,0.12);color:#FF3B30;}');
    parts.push('.ctx-na{background:rgba(255,255,255,0.04);color:rgba(193,198,215,0.4);font-weight:400;}');
    parts.push('.loading-bar{position:fixed;top:0;left:0;right:0;z-index:100;height:3px;background:rgba(0,122,255,0.15);overflow:hidden;}');
    parts.push('.loading-bar-fill{height:100%;width:40%;background:var(--primary);border-radius:0 2px 2px 0;animation:loadslide 1.4s ease-in-out infinite;}');
    parts.push('@keyframes loadslide{0%{transform:translateX(-100%)}60%{transform:translateX(280%)}100%{transform:translateX(280%)}}');
    parts.push('.loading-banner{background:rgba(0,122,255,0.08);border-bottom:1px solid rgba(0,122,255,0.2);padding:8px 32px;font-size:0.82em;color:#6db3ff;display:flex;align-items:center;gap:8px;}');
    parts.push('.mini-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:14px;margin-bottom:16px;}');
    parts.push('.mini-card{background:var(--bg-surface-high);border:1px solid var(--border);border-radius:6px;padding:14px 16px;}');
    parts.push('.mini-label{font-size:0.72em;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);margin-bottom:8px;font-weight:600;}');
    parts.push('.mini-val{font-size:1.5em;font-weight:600;font-family:var(--font-data);color:var(--text-primary);}');
    parts.push('.mini-sub{font-size:0.75em;color:var(--text-secondary);margin-top:4px;}');
    parts.push('.complexity-section{background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:20px 24px;margin-bottom:24px;}');
    parts.push('.complexity-section h2{font-size:1em;font-weight:600;margin-bottom:4px;letter-spacing:-0.01em;}');
    parts.push('.complexity-section .subtitle{font-size:0.8em;color:var(--text-secondary);margin-bottom:16px;}');
    parts.push('.highest-cost-box{background:var(--bg-surface-high);border-radius:4px;padding:10px 14px;font-size:0.82em;margin-top:12px;}');
    parts.push('.activity-section{background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:20px 24px;margin-bottom:24px;}');
    parts.push('.activity-section h2{font-size:1em;font-weight:600;margin-bottom:4px;letter-spacing:0;}');
    parts.push('.activity-section .subtitle{font-size:0.8em;color:var(--text-secondary);margin-bottom:16px;}');
    parts.push('.scope-tabs{display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap;}');
    parts.push('.scope-tab{background:var(--bg-surface-high);border:1px solid var(--border);color:var(--text-secondary);border-radius:4px;padding:5px 11px;font-size:0.78em;cursor:pointer;}');
    parts.push('.scope-tab.active{border-color:var(--primary);color:var(--text-primary);background:rgba(0,122,255,0.1);}');
    parts.push('.activity-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;}');
    parts.push('.activity-card{background:var(--bg-surface-high);border:1px solid var(--border);border-radius:6px;padding:14px 16px;min-width:0;}');
    parts.push('.activity-card h3{font-size:0.78em;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);margin-bottom:10px;font-weight:600;}');
    parts.push('.activity-list{display:flex;flex-direction:column;gap:6px;}');
    parts.push('.activity-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;font-size:0.82em;}');
    parts.push('.activity-name{font-family:var(--font-data);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;}');
    parts.push('.activity-count{font-family:var(--font-data);font-size:0.85em;color:var(--text-secondary);}');
    parts.push('.activity-bar{grid-column:1 / -1;height:4px;border-radius:2px;background:rgba(255,255,255,0.05);overflow:hidden;margin-top:-2px;}');
    parts.push('.activity-fill{height:100%;background:var(--primary);border-radius:2px;}');
    parts.push('.activity-empty{font-size:0.82em;color:var(--text-secondary);padding:10px 0;}');
    parts.push('.repo-activity{margin-top:16px;overflow-x:auto;}');
    parts.push('.repo-activity table{min-width:860px;}');
    parts.push('.loading-spinner{width:12px;height:12px;border:2px solid rgba(0,122,255,0.3);border-top-color:var(--primary);border-radius:50%;animation:spin 0.7s linear infinite;flex-shrink:0;}');
    parts.push('@keyframes spin{to{transform:rotate(360deg)}}');
    parts.push('.pagination{display:flex;align-items:center;justify-content:center;gap:12px;padding:14px 16px;border-top:1px solid var(--border);}');
    parts.push('.pagination button{background:transparent;border:1px solid var(--border);color:var(--text-primary);padding:6px 14px;border-radius:4px;cursor:pointer;font-size:0.85em;transition:all 0.2s;}');
    parts.push('.pagination button:hover:not([disabled]){background:rgba(255,255,255,0.05);border-color:var(--primary);}');
    parts.push('.pagination button[disabled]{opacity:0.3;cursor:default;}');
    parts.push('.page-info{font-size:0.85em;color:var(--text-secondary);}');
    parts.push('.live-header{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap;}');
    parts.push('.live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#39FF14;box-shadow:0 0 6px rgba(57,255,20,0.6);animation:pulse-dot 1.4s ease-in-out infinite;}');
    parts.push('@keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:0.3}}');
    parts.push('.live-badge{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;background:rgba(57,255,20,0.08);border:1px solid rgba(57,255,20,0.2);border-radius:20px;font-size:0.8em;font-weight:600;color:#39FF14;}');
    parts.push('.live-updated{margin-left:auto;font-size:0.75em;color:rgba(193,198,215,0.48);}');
    parts.push('.active-sessions{margin-bottom:24px;}');
    parts.push('.active-sessions-title{font-size:1em;font-weight:600;margin-bottom:16px;}');
    parts.push('.session-card{background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:20px 24px;margin-bottom:16px;position:relative;overflow:hidden;}');
    parts.push('.session-card.is-stale{border-color:rgba(255,59,48,0.35);}');
    parts.push('.session-card.is-warn{border-color:rgba(255,159,10,0.28);}');
    parts.push('.session-card.is-ok{border-color:rgba(57,255,20,0.18);}');
    parts.push('.session-card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;}');
    parts.push('.session-card-title{font-size:0.95em;font-weight:600;display:flex;align-items:center;gap:8px;min-width:0;}');
    parts.push('.session-card-title span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}');
    parts.push('.provider-chip{font-size:0.75em;padding:2px 8px;border-radius:4px;font-weight:500;white-space:nowrap;}');
    parts.push('.metrics-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:16px;}');
    parts.push('.metric-box{background:var(--bg-surface-high);border-radius:6px;padding:12px 14px;}');
    parts.push('.metric-label{font-size:0.7em;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);font-weight:600;margin-bottom:6px;}');
    parts.push('.metric-value{font-size:1.4em;font-weight:600;font-family:var(--font-data);color:var(--text-primary);}');
    parts.push('.metric-sub{font-size:0.72em;color:var(--text-secondary);margin-top:3px;}');
    parts.push('.metric-value.warn{color:#FF9F0A;}');
    parts.push('.metric-value.crit{color:#FF3B30;}');
    parts.push('.metric-value.ok{color:#39FF14;}');
    parts.push('.burn-bar-wrap{margin-bottom:16px;}');
    parts.push('.burn-bar-label{display:flex;justify-content:space-between;gap:12px;font-size:0.78em;color:var(--text-secondary);margin-bottom:5px;flex-wrap:wrap;}');
    parts.push('.burn-bar{height:8px;background:rgba(255,255,255,0.06);border-radius:4px;overflow:hidden;}');
    parts.push('.burn-fill{height:100%;border-radius:4px;transition:width 0.4s ease;}');
    parts.push('.burn-fill.ok{background:linear-gradient(90deg,#39FF14,#00c864);}');
    parts.push('.burn-fill.warn{background:linear-gradient(90deg,#FF9F0A,#FFD60A);}');
    parts.push('.burn-fill.crit{background:linear-gradient(90deg,#FF3B30,#FF6B6B);}');
    parts.push('.alerts-list{margin-top:12px;}');
    parts.push('.alert-item{display:flex;align-items:flex-start;gap:8px;padding:8px 12px;border-radius:6px;font-size:0.83em;margin-bottom:6px;}');
    parts.push('.alert-item.warning{background:rgba(255,159,10,0.08);border:1px solid rgba(255,159,10,0.2);color:#FF9F0A;}');
    parts.push('.alert-item.error{background:rgba(255,59,48,0.08);border:1px solid rgba(255,59,48,0.2);color:#FF3B30;}');
    parts.push('.session-card-collapse{background:transparent;border:1px solid var(--border);color:var(--text-secondary);padding:2px 7px;border-radius:3px;cursor:pointer;font-size:0.78em;line-height:1.4;transition:all 0.2s;flex-shrink:0;}');
    parts.push('.session-card-collapse:hover{border-color:rgba(255,255,255,0.15);color:var(--text-primary);}');
    parts.push('.session-card.is-collapsed .session-card-collapse{color:var(--primary);}');
    parts.push('.session-card-body{transition:none;}');
    parts.push('.session-card.is-collapsed .session-card-body{display:none;}');
    parts.push('.session-card-mini{display:none;font-size:0.78em;color:var(--text-secondary);font-family:var(--font-data);gap:14px;flex-wrap:wrap;padding:2px 0;}');
    parts.push('.session-card.is-collapsed .session-card-mini{display:flex;}');

    // Analyze overlay
    parts.push('.analyze-overlay{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.72);display:none;}');
    parts.push('.analyze-panel{position:absolute;top:0;right:0;bottom:0;width:min(940px,94vw);background:var(--bg-base);border-left:1px solid var(--border);overflow-y:auto;display:flex;flex-direction:column;}');
    parts.push('.analyze-hdr{display:flex;align-items:center;gap:12px;padding:13px 22px;border-bottom:1px solid var(--border);background:var(--bg-surface-high);position:sticky;top:0;z-index:1;}');
    parts.push('.analyze-hdr-title{flex:1;font-size:0.93em;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}');
    parts.push('.analyze-close{background:transparent;border:1px solid var(--border);color:var(--text-secondary);width:26px;height:26px;border-radius:4px;cursor:pointer;font-size:1em;line-height:1;display:flex;align-items:center;justify-content:center;transition:all 0.15s;flex-shrink:0;}');
    parts.push('.analyze-close:hover{border-color:rgba(255,255,255,0.2);color:var(--text-primary);}');
    parts.push('.analyze-body{flex:1;padding:20px 24px;}');
    parts.push('.ov-score-hdr{display:flex;align-items:center;gap:14px;margin-bottom:20px;flex-wrap:wrap;}');
    parts.push('.ov-score-ring{width:64px;height:64px;flex-shrink:0;position:relative;}');
    parts.push('.ov-score-ring canvas{position:absolute;top:0;left:0;}');
    parts.push('.ov-score-ring-val{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-family:var(--font-data);font-size:1.2em;font-weight:700;}');
    parts.push('.ov-section{background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:16px 20px;margin-bottom:14px;}');
    parts.push('.ov-section-title{font-size:1em;font-weight:600;margin-bottom:3px;}');
    parts.push('.ov-section-sub{font-size:0.85em;color:var(--text-secondary);margin-bottom:12px;}');
    parts.push('.ov-chart-wrap{height:190px;position:relative;}');
    parts.push('.ov-signal-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(195px,1fr));gap:7px;}');
    parts.push('.ov-signal-card{border-radius:6px;padding:9px 11px;border:1px solid transparent;}');
    parts.push('.ov-signal-card.low{background:rgba(0,122,255,0.06);border-color:rgba(0,122,255,0.15);}');
    parts.push('.ov-signal-card.medium{background:rgba(255,159,10,0.08);border-color:rgba(255,159,10,0.2);}');
    parts.push('.ov-signal-card.high{background:rgba(255,59,48,0.08);border-color:rgba(255,59,48,0.22);}');
    parts.push('.ov-sig-msg{font-size:0.82em;font-weight:600;margin-bottom:2px;}');
    parts.push('.ov-sig-msg.low{color:var(--primary);}.ov-sig-msg.medium{color:#FF9F0A;}.ov-sig-msg.high{color:#FF3B30;}');
    parts.push('.ov-sig-detail{font-size:0.75em;color:var(--text-secondary);line-height:1.4;}');
    parts.push('.ov-ctx-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:10px;}');
    parts.push('.ov-ctx-stat{background:var(--bg-surface-high);border-radius:6px;padding:9px;text-align:center;}');
    parts.push('.ov-ctx-val{font-family:var(--font-data);font-size:1.05em;font-weight:700;margin-bottom:2px;}');
    parts.push('.ov-ctx-lbl{font-size:0.67em;color:var(--text-secondary);}');
    parts.push('.ov-ctx-bar{height:6px;border-radius:3px;background:rgba(255,255,255,0.05);overflow:hidden;display:flex;margin-bottom:6px;}');
    parts.push('.ov-ctx-legend{display:flex;gap:10px;flex-wrap:wrap;font-size:0.69em;color:var(--text-secondary);}');
    parts.push('.ov-restart-banner{display:flex;gap:8px;background:rgba(255,59,48,0.08);border:1px solid rgba(255,59,48,0.25);border-radius:7px;padding:9px 13px;margin-bottom:12px;font-size:0.82em;color:#FF3B30;}');
    parts.push('.ov-file-list{display:flex;flex-direction:column;gap:2px;}');
    parts.push('.ov-file-row{display:flex;align-items:center;gap:7px;padding:5px 9px;background:var(--bg-surface-high);border-radius:5px;min-width:0;}');
    parts.push('.ov-file-path{font-size:0.77em;font-family:var(--font-data);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;}');
    parts.push('.ov-file-badges{display:flex;gap:3px;flex-shrink:0;}');
    parts.push('.ov-fb{font-size:0.62em;padding:1px 4px;border-radius:2px;font-family:var(--font-data);}');
    parts.push('.ov-fb-read{background:rgba(0,122,255,0.12);color:#007AFF;}.ov-fb-edit{background:rgba(255,159,10,0.12);color:#FF9F0A;}.ov-fb-write{background:rgba(57,255,20,0.12);color:#39FF14;}');
    parts.push('.ov-file-summary{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:11px;}');
    parts.push('.ov-fss{background:var(--bg-surface-high);border-radius:6px;padding:7px 11px;display:flex;flex-direction:column;align-items:center;min-width:68px;}');
    parts.push('.ov-fss-val{font-family:var(--font-data);font-size:1.05em;font-weight:700;margin-bottom:1px;}');
    parts.push('.ov-fss-lbl{font-size:0.65em;color:var(--text-secondary);}');
    parts.push('.ov-itl-list{display:flex;flex-direction:column;gap:2px;}');
    parts.push('.ov-itl-row{display:flex;gap:8px;padding:6px 10px;background:var(--bg-surface-high);border-radius:6px;}');
    parts.push('.ov-itl-idx{font-family:var(--font-data);font-size:0.76em;color:var(--text-secondary);min-width:22px;padding-top:2px;flex-shrink:0;}');
    parts.push('.ov-itl-body{flex:1;min-width:0;}');
    parts.push('.ov-itl-meta{display:flex;align-items:center;gap:5px;margin-bottom:2px;flex-wrap:wrap;}');
    parts.push('.ov-itl-time{font-size:0.76em;color:var(--text-secondary);flex-shrink:0;}');
    parts.push('.ov-itl-mode{font-size:0.72em;padding:1px 4px;background:rgba(0,122,255,0.12);border-radius:3px;color:var(--primary);flex-shrink:0;}');
    parts.push('.ov-itl-prompt{font-size:0.88em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}');
    parts.push('.ov-itl-tools{display:flex;flex-wrap:wrap;gap:2px;margin-bottom:3px;}');
    parts.push('.ov-itl-tool{font-size:0.72em;padding:1px 5px;background:rgba(240,147,251,0.1);border-radius:3px;color:#f093fb;font-family:var(--font-data);}');
    parts.push('.ov-itl-tool-fname{opacity:0.7;margin-left:3px;}');
    parts.push('.ov-itl-toks{display:flex;gap:7px;flex-wrap:wrap;}');
    parts.push('.ov-tok{font-size:0.82em;font-family:var(--font-data);}');
    parts.push('.ov-tok-i{color:#007AFF;}.ov-tok-o{color:#39FF14;}.ov-tok-c{color:#FF9F0A;}.ov-tok-t{color:#f093fb;}.ov-tok-w{color:var(--text-secondary);}');
    parts.push('.ov-brief-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;}');
    parts.push('.ov-brief-box{background:var(--bg-surface-high);border-radius:6px;padding:11px 13px;}');
    parts.push('.ov-brief-lbl{font-size:0.78em;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);font-weight:600;margin-bottom:6px;}');
    parts.push('.ov-brief-text{font-size:0.9em;line-height:1.5;}');
    parts.push('.ov-brief-tag{display:inline-block;padding:1px 6px;background:rgba(0,122,255,0.1);border-radius:3px;font-size:0.85em;color:var(--primary);font-family:var(--font-data);margin:2px 1px 2px 0;}');
    parts.push('.ov-warn-tag{background:rgba(255,59,48,0.1);color:#FF3B30;}');
    parts.push('.ov-checklist{list-style:none;display:flex;flex-direction:column;gap:5px;}');
    parts.push('.ov-checklist li{display:flex;gap:7px;font-size:0.82em;line-height:1.5;}');
    parts.push('.ov-checklist li::before{content:"\\2610";flex-shrink:0;color:var(--text-secondary);}');
    parts.push('.ov-itl-skip{font-size:0.71em;color:var(--text-secondary);padding:4px 10px;text-align:center;border:1px dashed rgba(255,255,255,0.08);border-radius:5px;margin-bottom:3px;}');
    parts.push('.ov-itl-compact{display:flex;align-items:center;gap:7px;padding:5px 10px;background:rgba(255,159,10,0.07);border:1px dashed rgba(255,159,10,0.3);border-radius:6px;flex-wrap:wrap;}');
    parts.push('.ov-itl-compact-icon{font-size:1em;color:#FF9F0A;}');
    parts.push('.ov-itl-compact-label{font-size:0.82em;color:#FF9F0A;font-weight:500;}');
    parts.push('.ov-itl-compact-trig{font-size:0.72em;padding:1px 5px;background:rgba(255,159,10,0.15);border-radius:3px;color:#FF9F0A;font-family:var(--font-data);}');
    parts.push('.ov-itl-compact-saved{font-size:0.76em;color:var(--text-secondary);font-family:var(--font-data);}');
    parts.push('.ov-no-signals{font-size:0.82em;color:var(--text-secondary);padding:9px;text-align:center;}');
    parts.push('.ov-opt-list{display:flex;flex-direction:column;gap:7px;}');
    parts.push('.ov-opt-card{display:flex;align-items:flex-start;gap:12px;padding:10px 13px;background:rgba(57,255,20,0.04);border:1px solid rgba(57,255,20,0.12);border-radius:7px;}');
    parts.push('.ov-opt-savings{flex-shrink:0;text-align:center;min-width:52px;}');
    parts.push('.ov-opt-pct{font-size:1.2em;font-weight:700;color:#39FF14;font-family:var(--font-data);line-height:1;}');
    parts.push('.ov-opt-pct-lbl{font-size:0.65em;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.04em;}');
    parts.push('.ov-opt-body{flex:1;min-width:0;}');
    parts.push('.ov-opt-header{display:flex;align-items:center;gap:6px;margin-bottom:3px;}');
    parts.push('.ov-opt-badge{font-size:0.68em;padding:1px 6px;border-radius:3px;font-family:var(--font-data);font-weight:500;background:rgba(57,255,20,0.12);color:#39FF14;}');
    parts.push('.ov-opt-title{font-size:0.88em;font-weight:600;}');
    parts.push('.ov-opt-desc{font-size:0.79em;color:var(--text-secondary);margin-bottom:3px;line-height:1.4;}');
    parts.push('.ov-opt-evidence{font-size:0.75em;font-family:var(--font-data);color:rgba(255,255,255,0.35);padding:2px 6px;background:rgba(255,255,255,0.03);border-radius:3px;display:inline-block;}');
    parts.push('.ov-opt-toks{font-size:0.72em;color:var(--text-secondary);margin-top:2px;}');
    parts.push('.ov-heavy-tool{display:inline-block;margin:2px;padding:2px 7px;background:rgba(240,147,251,0.1);border-radius:3px;font-size:0.75em;color:#f093fb;font-family:var(--font-data);}');
    parts.push('.ov-fragment-list{display:flex;flex-direction:column;gap:3px;}');
    parts.push('.ov-fragment-item{font-size:0.77em;font-family:var(--font-data);padding:3px 7px;background:var(--bg-surface-high);border-radius:4px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}');
    // Tier-1/3 metric styles
    parts.push('.ov-cq-card{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:70px;background:var(--bg-surface-high);border-radius:8px;padding:8px 12px;border:1px solid var(--border);}');
    parts.push('.ov-cq-score{font-family:var(--font-data);font-size:1.35em;font-weight:700;line-height:1;}');
    parts.push('.ov-cq-label{font-size:0.62em;color:var(--text-secondary);margin-top:3px;text-transform:uppercase;letter-spacing:0.05em;}');
    parts.push('.ov-runway-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:12px;font-size:0.78em;font-family:var(--font-data);background:rgba(0,122,255,0.1);color:var(--primary);margin-left:8px;}');
    parts.push('.ov-sibling-banner{background:rgba(255,159,10,0.07);border:1px solid rgba(255,159,10,0.2);border-radius:7px;padding:9px 13px;margin-bottom:12px;font-size:0.82em;}');
    parts.push('.ov-sibling-title{color:#FF9F0A;font-weight:600;margin-bottom:4px;}');
    parts.push('.ov-sibling-list{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px;}');
    parts.push('.ov-sibling-chip{font-size:0.78em;padding:1px 7px;background:rgba(255,159,10,0.1);border-radius:3px;color:#FF9F0A;font-family:var(--font-data);}');
    parts.push('.ov-budget-wrap{display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap;}');
    parts.push('.ov-budget-chart-box{flex-shrink:0;position:relative;width:140px;height:140px;}');
    parts.push('.ov-budget-legend{display:flex;flex-direction:column;gap:7px;justify-content:center;flex:1;min-width:160px;}');
    parts.push('.ov-budget-row{display:flex;align-items:center;gap:7px;font-size:0.82em;}');
    parts.push('.ov-bdot{width:9px;height:9px;border-radius:50%;flex-shrink:0;}');
    parts.push('.ov-bval{margin-left:auto;font-family:var(--font-data);font-size:0.9em;color:var(--text-secondary);}');
    parts.push('.ov-eff-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:7px;margin-top:10px;}');
    parts.push('.ov-eff-stat{background:var(--bg-surface-high);border-radius:6px;padding:9px;text-align:center;}');
    parts.push('.ov-eff-val{font-family:var(--font-data);font-size:1em;font-weight:700;margin-bottom:2px;}');
    parts.push('.ov-eff-lbl{font-size:0.65em;color:var(--text-secondary);}');
    parts.push('</style></head><body>');

    parts.push(navTopbarHtml(logoUri, true, refreshing));
    if (refreshing) {
      parts.push('<div class="loading-bar"><div class="loading-bar-fill"></div></div>');
      parts.push('<div class="loading-banner"><div class="loading-spinner"></div>Loading sessions…</div>');
    }
    parts.push(navPagebarHtml('sessions', 'Sessions'));
    parts.push('<div class="ns-content">');
    parts.push(buildActiveSessionsWidget(liveSessions, budgetConfig));
    parts.push('<div style="display:flex;align-items:center;gap:8px;margin-bottom:20px;">');
    parts.push('  <button class="btn" id="exportBtn" style="height:32px;">&#8615; Export CSV</button>');
    parts.push('</div>');

    parts.push('<div class="summary-grid">');
    parts.push('  <div class="summary-card"><div class="summary-label">Sessions</div><div class="summary-value" id="statSessions">0</div><div class="summary-sub" id="statInteractions">0 interactions</div></div>');
    parts.push('  <div class="summary-card"><div class="summary-label">Total Tokens</div><div class="summary-value" id="statTokens">0</div><div class="summary-sub" id="statTokenAvg">0 per session</div></div>');
    parts.push('  <div class="summary-card"><div class="summary-label">Estimated Cost</div><div class="summary-value" id="statCost">$0.00</div><div class="summary-sub" id="statCredits">0 credits</div></div>');
    parts.push('  <div class="summary-card"><div class="summary-label">Workspaces</div><div class="summary-value" id="statRepos">0</div><div class="summary-sub">Active contexts</div></div>');
    parts.push('</div>');

    parts.push('<div class="filter-bar">');
    parts.push('  <div class="filter-group"><span class="filter-label">Range</span><select id="dateFilter">');
    parts.push('    <option value="30d">Last 30 Days</option>');
    parts.push('    <option value="today">Today</option>');
    parts.push('    <option value="7d">Last 7 Days</option>');
    parts.push('    <option value="lastMonth">Last Month</option>');
    parts.push('    <option value="thisMonth">This Month</option>');
    parts.push('    <option value="thisYear" selected>This Year</option>');
    parts.push('    <option value="all">All Time</option>');
    parts.push('  </select></div>');
    parts.push('  <div class="filter-group"><span class="filter-label">Provider</span><select id="providerFilter"><option value="">All</option><option value="claudeCode">Claude Code</option><option value="copilot">Copilot</option><option value="antigravity">Antigravity</option><option value="codex">Codex</option><option value="jetbrainsAI">JetBrains AI</option><option value="visualStudio">Visual Studio</option></select></div>');
    parts.push('  <div class="filter-group"><span class="filter-label">Metric</span><select id="metricType"><option value="tokens">Token Consumption</option><option value="sessions">Usage (Sessions)</option></select></div>');
    parts.push('  <div class="filter-group"><span class="filter-label">By</span><select id="breakdownType"><option value="provider">Provider</option><option value="model">Model</option><option value="workspace">Repository</option></select></div>');
    parts.push('  <input type="text" id="searchFilter" placeholder="Search sessions, models, repos..." />');
    parts.push('  <div class="filter-group"><span class="filter-label">Tag</span><select id="tagFilter"><option value="">All tags</option></select></div>');
    parts.push('</div>');

    parts.push('<div class="chart-section">');
    parts.push('  <div class="chart-wrap"><canvas id="usageChart"></canvas></div>');
    parts.push('  <div class="chart-wrap"><canvas id="distChart"></canvas></div>');
    parts.push('</div>');

    parts.push('<div class="legend">');
    parts.push('  <span class="legend-item"><span class="legend-dot" style="background:#007AFF"></span>Input</span>');
    parts.push('  <span class="legend-item"><span class="legend-dot" style="background:#39FF14"></span>Output</span>');
    parts.push('  <span class="legend-item"><span class="legend-dot" style="background:#f093fb"></span>Thinking</span>');
    parts.push('  <span class="legend-item"><span class="legend-dot" style="background:#FF9F0A"></span>Cache read</span>');
    parts.push('  <span class="legend-item"><span class="legend-dot" style="background:#FFD60A"></span>Cache write</span>');
    parts.push('</div>');

    // Session Complexity widget
    parts.push('<div class="complexity-section" id="complexityWidget">');
    parts.push('  <h2>\uD83D\uDD0D Session Complexity</h2>');
    parts.push('  <p class="subtitle">Breakdown of session depth and cost drivers &mdash; updates with active filters</p>');
    parts.push('  <div class="mini-grid">');
    parts.push('    <div class="mini-card"><div class="mini-label">Avg Session Depth</div><div class="mini-val" id="scDepth">-</div><div class="mini-sub">interactions / session</div></div>');
    parts.push('    <div class="mini-card"><div class="mini-label">Avg Duration</div><div class="mini-val" id="scDuration">-</div><div class="mini-sub">minutes / session</div></div>');
    parts.push('    <div class="mini-card"><div class="mini-label">Long Sessions &gt;30 min</div><div class="mini-val" id="scLong">-</div><div class="mini-sub" id="scLongCost"></div></div>');
    parts.push('    <div class="mini-card"><div class="mini-label">Tool-Heavy Sessions</div><div class="mini-val" id="scToolHeavy">-</div><div class="mini-sub">&gt;5 unique tools</div></div>');
    parts.push('    <div class="mini-card"><div class="mini-label">Thinking Sessions</div><div class="mini-val" id="scThinking">-</div><div class="mini-sub">extended reasoning used</div></div>');
    parts.push('    <div class="mini-card"><div class="mini-label">Multi-Model Sessions</div><div class="mini-val" id="scMultiModel">-</div><div class="mini-sub">&gt;1 model per session</div></div>');
    parts.push('  </div>');
    parts.push('  <div class="highest-cost-box" id="scHighestCost" style="display:none"></div>');
    parts.push('</div>');

    parts.push('<div class="activity-section" id="activityStats">');
    parts.push('  <h2>Activity Stats</h2>');
    parts.push('  <p class="subtitle">Most-read files, edited files, tool calls, and shell commands for the current filter.</p>');
    parts.push('  <div class="scope-tabs">');
    parts.push('    <button class="scope-tab active" data-scope="overall">Overall</button>');
    parts.push('    <button class="scope-tab" data-scope="repository">Repository</button>');
    parts.push('    <button class="scope-tab" data-scope="session">Session</button>');
    parts.push('  </div>');
    parts.push('  <div id="activityBody"></div>');
    parts.push('</div>');

    parts.push('<div class="section"><div id="tableContainer"></div></div>');
    parts.push('<div class="footer">Deep session analysis for AI-assisted development. Data updated in real-time.</div>');
    parts.push('</div><!-- /ns-content -->');

    // Compare bar — shown when 2+ sessions are selected
    parts.push('<div class="compare-bar" id="compareBar">');
    parts.push('  <span class="compare-bar-info"><span class="compare-bar-count" id="compareCount">0</span> session(s) selected</span>');
    parts.push('  <button class="btn-compare" onclick="compareSelected()">Compare Sessions</button>');
    parts.push('  <button class="btn-clear-sel" onclick="clearSelection()">Clear</button>');
    parts.push('</div>');

    // Overlay must be in the DOM before scripts execute so getElementById succeeds
    parts.push('<div class="analyze-overlay" id="analyzeOverlay">');
    parts.push('  <div class="analyze-panel">');
    parts.push('    <div class="analyze-hdr">');
    parts.push('      <span class="analyze-hdr-title" id="ovHdrTitle"></span>');
    parts.push('      <button class="analyze-close" onclick="closeAnalyzeOverlay()" title="Close">&#215;</button>');
    parts.push('    </div>');
    parts.push('    <div class="analyze-body" id="ovBody"></div>');
    parts.push('  </div>');
    parts.push('</div>');

    parts.push('<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>');
    parts.push('<script>window.__SESSIONS__=');
    parts.push(safe);
    parts.push(';</script>');

    parts.push('<script>');
    parts.push('(function(){');
    parts.push('  var vscode=acquireVsCodeApi();');
    parts.push('  window.vscode=vscode;');
    parts.push('  var lastEl=document.getElementById("lastUpdateTime");');
    parts.push('  if(lastEl){lastEl.textContent=new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});}');
    parts.push('  var ALL_SESSIONS=window.__SESSIONS__||[];');
    parts.push('  var sortKey="startTime";');
    parts.push('  var sortDir=-1;');
    parts.push('  var usageChart, distChart;');
    parts.push('  var currentFiltered=ALL_SESSIONS.slice();');
    parts.push('  var currentPage=0;');
    parts.push('  var PAGE_SIZE=50;');
    parts.push('  var activityScope="overall";');
    parts.push('  var selectedIds=new Set();');
    parts.push('  function toggleRow(idx){var s=currentFiltered[idx];if(!s)return;if(selectedIds.has(s.id))selectedIds.delete(s.id);else selectedIds.add(s.id);updateCompareBar();var tr=document.querySelector("tr[data-idx=\'"+idx+"\']");if(tr)tr.classList.toggle("row-selected",selectedIds.has(s.id));}');
    parts.push('  function updateCompareBar(){var bar=document.getElementById("compareBar");var cnt=document.getElementById("compareCount");if(bar){if(selectedIds.size>=2)bar.classList.add("visible");else bar.classList.remove("visible");}if(cnt)cnt.textContent=String(selectedIds.size);}');
    parts.push('  function clearSelection(){selectedIds.clear();updateCompareBar();document.querySelectorAll("tr.row-selected").forEach(function(r){r.classList.remove("row-selected");});document.querySelectorAll("input.row-check").forEach(function(c){c.checked=false;});}');
    parts.push('  function compareSelected(){if(selectedIds.size<2)return;vscode.postMessage({command:"compareSelectedSessions",sessionIds:Array.from(selectedIds)});}');
    parts.push('  window.toggleRow=toggleRow;window.clearSelection=clearSelection;window.compareSelected=compareSelected;');
    parts.push('  function addTagToSession(id,tag){tag=tag.trim().toLowerCase().replace(/\\s+/g,"-").slice(0,32);if(!tag)return;vscode.postMessage({command:"addTag",sessionId:id,tag:tag});var s=ALL_SESSIONS.find(function(x){return x.id===id;});if(s){if(!s.tags)s.tags=[];if(!s.tags.includes(tag)){s.tags.push(tag);rebuildTagFilter();applyFilters();}}}');
    parts.push('  function removeTagFromSession(id,tag){vscode.postMessage({command:"removeTag",sessionId:id,tag:tag});var s=ALL_SESSIONS.find(function(x){return x.id===id;});if(s){s.tags=(s.tags||[]).filter(function(t){return t!==tag;});rebuildTagFilter();applyFilters();}}');
    parts.push('  function rebuildTagFilter(){var sel=document.getElementById("tagFilter");if(!sel)return;var cur=sel.value;var tags={};ALL_SESSIONS.forEach(function(s){(s.tags||[]).forEach(function(t){tags[t]=true;});});sel.innerHTML="<option value=\\"\\">All tags</option>";Object.keys(tags).sort().forEach(function(t){var o=document.createElement("option");o.value=t;o.textContent=t;if(t===cur)o.selected=true;sel.appendChild(o);});}');
    parts.push('  Chart.defaults.font.family="var(--font-primary)";');
    parts.push('  Chart.defaults.color="#c1c6d7";');

    parts.push('  function _clr(){document.querySelectorAll(".is-loading").forEach(function(e){e.classList.remove("is-loading");});var r=document.getElementById("btnRefresh");if(r)r.textContent="\u21ba Refresh";}');
    parts.push('  var _rb=document.getElementById("btnRefresh");if(_rb){_rb.addEventListener("click",function(){_rb.classList.add("is-loading");_rb.textContent="\u27f3 Refreshing\u2026";vscode.postMessage({command:"refresh"});setTimeout(_clr,5000);});}');
    parts.push('  document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible"){_clr();}});');
    parts.push('  document.getElementById("exportBtn").onclick=function(){');
    parts.push('    var headers=["Date","Provider","Title","Workspace","Total Tokens","Input","Output","Thinking","Cache Read","Cache Write","Cost USD","Interactions","Models","Duration"];');
    parts.push('    var rows=currentFiltered.map(function(s){');
    parts.push('      return[s.startTime,s.providerName,s.title,s.workspace,s.totalTokens,s.totalInputTokens,s.totalOutputTokens,s.totalThinkingTokens,s.totalCacheReadTokens,s.totalCacheWriteTokens,s.estimatedCostUsd.toFixed(6),s.interactions,(s.models||[]).join(";"),fmtDur(s.startTime,s.endTime)].map(function(v){return\'"\'+String(v||"").replace(/"/g,\'""\')+\'"\';}).join(",");');
    parts.push('    });');
    parts.push('    var csv=[headers.join(",")].concat(rows).join("\\n");');
    parts.push('    vscode.postMessage({command:"exportSessions",csv:csv});');
    parts.push('  };');
    parts.push('  function saveState(){try{vscode.setState({df:document.getElementById("dateFilter").value,pf:document.getElementById("providerFilter").value,mt:document.getElementById("metricType").value,bt:document.getElementById("breakdownType").value,sf:document.getElementById("searchFilter").value,sk:sortKey,sd:sortDir});}catch(e){}}');
    parts.push('  (function restoreState(){try{var st=vscode.getState();if(!st)return;if(st.df)document.getElementById("dateFilter").value=st.df;if(st.pf)document.getElementById("providerFilter").value=st.pf;if(st.mt)document.getElementById("metricType").value=st.mt;if(st.bt)document.getElementById("breakdownType").value=st.bt;if(st.sf)document.getElementById("searchFilter").value=st.sf;if(st.sk)sortKey=st.sk;if(st.sd!=null)sortDir=st.sd;}catch(e){}})();');
    parts.push('  document.getElementById("providerFilter").onchange=applyFilters;');
    parts.push('  document.getElementById("dateFilter").onchange=applyFilters;');
    parts.push('  document.getElementById("metricType").onchange=applyFilters;');
    parts.push('  document.getElementById("breakdownType").onchange=applyFilters;');
    parts.push('  document.getElementById("searchFilter").oninput=applyFilters;');
    parts.push('  document.getElementById("tagFilter").onchange=applyFilters;');
    parts.push('  rebuildTagFilter();');
    // Tag interactions via event delegation on tableContainer
    parts.push('  document.getElementById("tableContainer").addEventListener("click",function(e){');
    parts.push('    var rm=e.target.closest("[data-rm-idx]");');
    parts.push('    if(rm){var idx=+rm.dataset.rmIdx;var tag=rm.dataset.rmTag;var s=currentFiltered[idx];if(s)removeTagFromSession(s.id,tag);return;}');
    parts.push('    var ab=e.target.closest("[data-add-idx]");');
    parts.push('    if(ab){var idx2=+ab.dataset.addIdx;var inp=document.getElementById("ti"+idx2);if(inp){inp.style.display="inline-block";inp.focus();}}');
    parts.push('  });');
    parts.push('  document.getElementById("tableContainer").addEventListener("keydown",function(e){');
    parts.push('    if(!e.target.classList.contains("tag-input"))return;');
    parts.push('    var idx=+e.target.dataset.idx;');
    parts.push('    if(e.key==="Enter"){var s=currentFiltered[idx];var v=e.target.value.trim();if(s&&v){addTagToSession(s.id,v);e.target.value="";e.target.style.display="none";}}');
    parts.push('    if(e.key==="Escape"){e.target.style.display="none";}');
    parts.push('  });');
    parts.push('  document.getElementById("tableContainer").addEventListener("focusout",function(e){if(e.target.classList.contains("tag-input"))setTimeout(function(){if(e.target===document.activeElement)return;e.target.style.display="none";},200);});');
    parts.push('  document.querySelectorAll(".scope-tab").forEach(function(btn){btn.addEventListener("click",function(){activityScope=btn.getAttribute("data-scope")||"overall";document.querySelectorAll(".scope-tab").forEach(function(b){b.classList.toggle("active",b===btn);});updateActivity(currentFiltered);});});');

    parts.push('  function openSession(idx){var s=currentFiltered[idx];if(s&&s.sourceFile)vscode.postMessage({command:"openSession",sourceFile:s.sourceFile});}');
    parts.push('  window.openSession=openSession;');
    parts.push('  function replaySession(idx){var s=currentFiltered[idx];if(s)vscode.postMessage({command:"replaySession",sessionId:s.id});}');
    parts.push('  window.replaySession=replaySession;');

    // ── Analyze overlay ────────────────────────────────────────────────────────
    parts.push('  var _ovChart=null,_ovRingChart=null,_budgetChart=null,_ovPending=null;');
    parts.push('  function analyzeSession(idx){');
    parts.push('    var s=currentFiltered[idx];if(!s)return;');
    parts.push('    _ovPending=s;');
    parts.push('    var ov=document.getElementById("analyzeOverlay");');
    parts.push('    var hdr=document.getElementById("ovHdrTitle");');
    parts.push('    var body=document.getElementById("ovBody");');
    parts.push('    if(!ov||!hdr||!body)return;');
    parts.push('    if(_ovChart){_ovChart.destroy();_ovChart=null;}');
    parts.push('    if(_ovRingChart){_ovRingChart.destroy();_ovRingChart=null;}');
    parts.push('    hdr.textContent=(s.title||s.id.slice(0,20))+" — Context Analysis";');
    parts.push('    body.innerHTML=\'<div style="display:flex;align-items:center;justify-content:center;height:120px;gap:10px;color:var(--text-secondary)"><span class="loading-spinner"></span>Loading analysis…</div>\';');
    parts.push('    ov.style.display="block";document.body.style.overflow="hidden";');
    parts.push('    vscode.postMessage({command:"overlayOpened"});');
    parts.push('    vscode.postMessage({command:"requestSessionAnalysis",sessionId:s.id});');
    parts.push('  }');
    parts.push('  window.analyzeSession=analyzeSession;');
    parts.push('  window.addEventListener("message",function(event){');
    parts.push('    var msg=event.data;');
    parts.push('    if(msg.command!=="sessionAnalysis"||!_ovPending)return;');
    parts.push('    var s=_ovPending;_ovPending=null;');
    parts.push('    var body=document.getElementById("ovBody");if(!body)return;');
    parts.push('    var a=msg.analysis,det=msg.detail;');
    parts.push('    body.innerHTML=buildOvHtml(a,s,det);');
    parts.push('    if(a){renderOvRing(a.score,a.label);renderOvChart(a);renderBudgetChart(a);}');
    parts.push('  });');
    parts.push('  window.closeAnalyzeOverlay=function(){');
    parts.push('    var ov=document.getElementById("analyzeOverlay");if(ov)ov.style.display="none";');
    parts.push('    document.body.style.overflow="";');
    parts.push('    if(_ovChart){_ovChart.destroy();_ovChart=null;}');
    parts.push('    if(_ovRingChart){_ovRingChart.destroy();_ovRingChart=null;}');
    parts.push('    if(_budgetChart){_budgetChart.destroy();_budgetChart=null;}');
    parts.push('    vscode.postMessage({command:"overlayClosed"});');
    parts.push('  };');
    parts.push('  document.getElementById("analyzeOverlay").addEventListener("click",function(e){if(e.target===this)window.closeAnalyzeOverlay();});');
    parts.push('  function buildOvHtml(a,s,det){');
    parts.push('    if(!a)return\'<div class="ov-no-signals">No analysis available for this session.</div>\';');
    parts.push('    var h="";');
    parts.push('    var sc=a.label==="stale"?"#FF3B30":a.label==="warning"?"#FF9F0A":"#39FF14";');
    parts.push('    h+=\'<div class="ov-score-hdr">\';');
    parts.push('    h+=\'<div class="ov-score-ring"><canvas id="ovScoreRing" width="64" height="64"></canvas><div class="ov-score-ring-val" style="color:\'+sc+\'">\'+a.score+\'</div></div>\';');
    // CQ score card
    parts.push('    var cqCol=a.contextQualityScore>=80?"#39FF14":a.contextQualityScore>=50?"#FF9F0A":"#FF3B30";');
    parts.push('    h+=\'<div class="ov-cq-card"><div class="ov-cq-score" style="color:\'+cqCol+\'">\'+a.contextQualityScore+\'</div><div class="ov-cq-label">CQ Score</div></div>\';');
    parts.push('    h+=\'<div style="flex:1;min-width:0"><div style="font-size:1em;font-weight:600;margin-bottom:4px;">\'+esc(s.title||s.id.slice(0,20))+\'</div>\';');
    parts.push('    h+=\'<div style="font-size:0.8em;color:var(--text-secondary)">\'+esc(s.provider)+\' &middot; \'+new Date(s.startTime).toLocaleString()+\' &middot; \'+a.turnsCount+\' turns &middot; \'+Math.round(a.sessionAgeMinutes)+\' min</div>\';');
    parts.push('    h+=\'<div style="margin-top:5px">\';');
    parts.push('    if(a.contextRunway!=null)h+=\'<span class="ov-runway-chip">&#9193; ~\'+a.contextRunway+\' turns left</span>\';');
    parts.push('    var growthLabel={"linear":"Linear growth","exponential":"Exponential growth","plateau":"Plateau","spike":"Context spike"};');
    parts.push('    var growthCol={"linear":"var(--text-secondary)","exponential":"#FF3B30","plateau":"#39FF14","spike":"#FF9F0A"};');
    parts.push('    h+=\'<span style="font-size:0.78em;color:\'+growthCol[a.growthCurve||"linear"]+\';margin-left:8px">\'+( growthLabel[a.growthCurve||"linear"]||"")+\'</span>\';');
    parts.push('    h+=\'</div></div></div>\';');
    parts.push('    if(a.restartRecommended)h+=\'<div class="ov-restart-banner"><strong>Restart Recommended&ensp;</strong>\'+esc(a.restartReason)+\'</div>\';');
    // Siblings banner
    parts.push('    if(a.sessionSiblings&&a.sessionSiblings.length>0){');
    parts.push('      h+=\'<div class="ov-sibling-banner"><div class="ov-sibling-title">&#9888; Groundhog-day pattern detected</div>\';');
    parts.push('      h+=\'<div style="font-size:0.85em;color:var(--text-secondary)">\'+a.sessionSiblings.length+\' similar session(s) in the same workspace within 24 h — you may be restarting the same task.</div>\';');
    parts.push('      h+=\'<div class="ov-sibling-list">\';');
    parts.push('      a.sessionSiblings.forEach(function(sib){var t=sib.title||sib.sessionId.slice(0,16);h+=\'<span class="ov-sibling-chip">\'+esc(t)+\'</span>\';});');
    parts.push('      h+=\'</div></div>\';');
    parts.push('    }');
    // Context Size
    parts.push('    h+=\'<div class="ov-section"><div class="ov-section-title">Context Size</div><div class="ov-section-sub">Accumulated tokens and cache efficiency</div>\';');
    parts.push('    if(det&&det.interactions&&det.interactions.length>0){');
    parts.push('      var ix=det.interactions;');
    parts.push('      var peakIn=Math.max.apply(null,ix.map(function(i){return i.inputTokens;}));');
    parts.push('      var lastIn=ix[ix.length-1].inputTokens;');
    parts.push('      var totCR=ix.reduce(function(s,i){return s+i.cacheReadTokens;},0);');
    parts.push('      var totCW=ix.reduce(function(s,i){return s+i.cacheWriteTokens;},0);');
    parts.push('      var hitPct=Math.round(ix.filter(function(i){return i.cacheReadTokens>0;}).length/ix.length*100);');
    parts.push('      var totIn=ix.reduce(function(s,i){return s+i.inputTokens;},0);');
    parts.push('      var totOut=ix.reduce(function(s,i){return s+i.outputTokens;},0);');
    parts.push('      var totTh=ix.reduce(function(s,i){return s+i.thinkingTokens;},0);');
    parts.push('      h+=\'<div class="ov-ctx-grid">\';');
    parts.push('      h+=\'<div class="ov-ctx-stat"><div class="ov-ctx-val">\'+fmt(peakIn)+\'</div><div class="ov-ctx-lbl">Peak context</div></div>\';');
    parts.push('      h+=\'<div class="ov-ctx-stat"><div class="ov-ctx-val">\'+fmt(lastIn)+\'</div><div class="ov-ctx-lbl">Last turn size</div></div>\';');
    parts.push('      h+=\'<div class="ov-ctx-stat"><div class="ov-ctx-val">\'+hitPct+\'%</div><div class="ov-ctx-lbl">Cache hit rate</div></div>\';');
    parts.push('      h+=\'<div class="ov-ctx-stat"><div class="ov-ctx-val">\'+fmt(totCR)+\'</div><div class="ov-ctx-lbl">From cache</div></div></div>\';');
    parts.push('      var tf=totIn+totOut+(totTh||0);');
    parts.push('      var ip=tf>0?Math.round(totIn/tf*100):50;var op=tf>0?Math.round(totOut/tf*100):50;var tp=tf>0?Math.round((totTh||0)/tf*100):0;');
    parts.push('      h+=\'<div class="ov-ctx-bar"><div style="height:100%;background:#007AFF;width:\'+ip+\'%"></div><div style="height:100%;background:#39FF14;width:\'+op+\'%"></div><div style="height:100%;background:#f093fb;width:\'+tp+\'%"></div></div>\';');
    parts.push('      h+=\'<div class="ov-ctx-legend"><span style="color:#007AFF">&#9632; Input \'+fmt(totIn)+\'</span><span style="color:#39FF14">&#9632; Output \'+fmt(totOut)+\'</span>\';');
    parts.push('      if(totTh>0)h+=\'<span style="color:#f093fb">&#9632; Thinking \'+fmt(totTh)+\'</span>\';');
    parts.push('      if(totCR>0)h+=\'<span style="color:#FF9F0A">&#9889; \'+fmt(totCR)+\' from cache</span>\';');
    parts.push('      if(totCW>0)h+=\'<span>&#9999; \'+fmt(totCW)+\' cache writes</span>\';');
    parts.push('      h+=\'</div>\';');
    parts.push('    }else{h+=\'<div class="ov-no-signals">No token data.</div>\';}');
    parts.push('    h+=\'</div>\';');
    // Context Budget Allocation
    parts.push('    h+=\'<div class="ov-section"><div class="ov-section-title">Context Budget Allocation</div><div class="ov-section-sub">How your total token spend was used — teaches which parts of the context are costly</div>\';');
    parts.push('    if(det&&det.provider==="copilot"&&det.interactions&&det.interactions.some(function(i){return i.cacheTokensEstimated;})){');
    parts.push('      h+=\'<div class="ov-section-sub" style="margin-top:-6px">🧮 Cached/fresh split below is a calculated estimate for GitHub Copilot, not measured data — see the Copilot provider wiki page.</div>\';');
    parts.push('    }');
    parts.push('    if(a.contextBudgetAllocation){');
    parts.push('      var ba=a.contextBudgetAllocation;');
    parts.push('      h+=\'<div class="ov-budget-wrap"><div class="ov-budget-chart-box"><canvas id="ovBudgetChart" width="140" height="140"></canvas></div><div class="ov-budget-legend">\';');
    parts.push('      if(ba.cachedTokens>0)h+=\'<div class="ov-budget-row"><span class="ov-bdot" style="background:#FF9F0A"></span>Cached input<span class="ov-bval">\'+ba.cachedPct+\'% · \'+fmt(ba.cachedTokens)+\'</span></div>\';');
    parts.push('      if(ba.freshInputTokens>0)h+=\'<div class="ov-budget-row"><span class="ov-bdot" style="background:#007AFF"></span>Fresh input<span class="ov-bval">\'+ba.freshInputPct+\'% · \'+fmt(ba.freshInputTokens)+\'</span></div>\';');
    parts.push('      if(ba.outputTokens>0)h+=\'<div class="ov-budget-row"><span class="ov-bdot" style="background:#39FF14"></span>Output<span class="ov-bval">\'+ba.outputPct+\'% · \'+fmt(ba.outputTokens)+\'</span></div>\';');
    parts.push('      if(ba.thinkingTokens>0)h+=\'<div class="ov-budget-row"><span class="ov-bdot" style="background:#f093fb"></span>Thinking<span class="ov-bval">\'+ba.thinkingPct+\'% · \'+fmt(ba.thinkingTokens)+\'</span></div>\';');
    parts.push('      if(ba.cacheWriteTokens>0)h+=\'<div class="ov-budget-row"><span class="ov-bdot" style="background:#FFD60A"></span>Cache writes<span class="ov-bval">\'+ba.cacheWritePct+\'% · \'+fmt(ba.cacheWriteTokens)+\'</span></div>\';');
    parts.push('      h+=\'</div></div>\';');
    // Efficiency stats row
    parts.push('      h+=\'<div class="ov-eff-grid">\';');
    parts.push('      var cqColE=a.contextQualityScore>=80?"#39FF14":a.contextQualityScore>=50?"#FF9F0A":"#FF3B30";');
    parts.push('      h+=\'<div class="ov-eff-stat"><div class="ov-eff-val" style="color:\'+cqColE+\'">\'+a.contextQualityScore+\'/100</div><div class="ov-eff-lbl">CQ Score</div></div>\';');
    parts.push('      h+=\'<div class="ov-eff-stat"><div class="ov-eff-val" style="color:#FF9F0A">\'+a.cacheEfficiencyRate+\'%</div><div class="ov-eff-lbl">Cache efficiency</div></div>\';');
    parts.push('      var limC=a.lostInMiddleRisk>60?"#FF3B30":a.lostInMiddleRisk>30?"#FF9F0A":"#39FF14";');
    parts.push('      h+=\'<div class="ov-eff-stat"><div class="ov-eff-val" style="color:\'+limC+\'">\'+a.lostInMiddleRisk+\'%</div><div class="ov-eff-lbl">Lost-in-middle</div></div>\';');
    parts.push('      if(a.thinkingEfficiencyTrend&&a.thinkingEfficiencyTrend!=="none"){var trendC={"rising":"#FF3B30","stable":"#39FF14","falling":"#007AFF"};h+=\'<div class="ov-eff-stat"><div class="ov-eff-val" style="color:\'+trendC[a.thinkingEfficiencyTrend]+\'">\'+a.thinkingEfficiencyTrend+\'</div><div class="ov-eff-lbl">Thinking trend</div></div>\';}');
    parts.push('      h+=\'</div>\';');
    parts.push('    }else{h+=\'<div class="ov-no-signals">No budget data.</div>\';}');
    parts.push('    h+=\'</div>\';');
    // Context Timeline
    parts.push('    h+=\'<div class="ov-section"><div class="ov-section-title">Context Timeline</div><div class="ov-section-sub">Input growth, output trend, and tool activity per turn</div><div class="ov-chart-wrap"><canvas id="ovTimelineChart"></canvas></div></div>\';');
    // Files in Context
    parts.push('    h+=\'<div class="ov-section"><div class="ov-section-title">Files in Context</div><div class="ov-section-sub">Files accumulated via Read, Edit, and Write tools</div>\';');
    parts.push('    if(det&&det.interactions){');
    parts.push('      var fm={};');
    parts.push('      det.interactions.forEach(function(it){(it.fileAccesses||[]).forEach(function(fa){if(!fm[fa.path])fm[fa.path]={r:0,e:0,w:0};var t=fa.tool.toLowerCase();if(t==="edit"||t==="notebookedit")fm[fa.path].e++;else if(t==="write")fm[fa.path].w++;else fm[fa.path].r++;});});');
    parts.push('      var fe=Object.keys(fm).map(function(p){return{path:p,c:fm[p]};});');
    parts.push('      if(fe.length>0){');
    parts.push('        var ws2=det.workspace||"";');
    parts.push('        function relp(fp){if(ws2&&fp.startsWith(ws2))return fp.slice(ws2.length).replace(/^\\//,"");var pts=fp.split("/");return pts.length>2?"\\u2026/"+pts.slice(-2).join("/"):fp;}');
    parts.push('        var frd=fe.filter(function(e){return e.c.r>0;}).length;var fed2=fe.filter(function(e){return e.c.e>0||e.c.w>0;}).length;');
    parts.push('        h+=\'<div class="ov-file-summary">\';');
    parts.push('        h+=\'<div class="ov-fss"><div class="ov-fss-val" style="color:#007AFF">\'+fe.length+\'</div><div class="ov-fss-lbl">unique files</div></div>\';');
    parts.push('        h+=\'<div class="ov-fss"><div class="ov-fss-val" style="color:#007AFF">\'+frd+\'</div><div class="ov-fss-lbl">read into ctx</div></div>\';');
    parts.push('        h+=\'<div class="ov-fss"><div class="ov-fss-val" style="color:#FF9F0A">\'+fed2+\'</div><div class="ov-fss-lbl">edited/written</div></div></div>\';');
    parts.push('        fe.sort(function(a,b){var ae=a.c.e+a.c.w,be=b.c.e+b.c.w;return ae!==be?be-ae:(b.c.r+be)-(a.c.r+ae);});');
    parts.push('        h+=\'<div class="ov-file-list">\';');
    parts.push('        fe.slice(0,25).forEach(function(e){');
    parts.push('          var ed=e.c.e>0||e.c.w>0;');
    parts.push('          h+=\'<div class="ov-file-row"><span style="font-size:0.74em;flex-shrink:0;color:\'+( ed?"#FF9F0A":"#007AFF")+\'">\'+( ed?"\\u270f":"\\ud83d\\udcc4")+\'</span>\';');
    parts.push('          h+=\'<span class="ov-file-path" title="\'+esc(e.path)+\'">\'+esc(relp(e.path))+\'</span><div class="ov-file-badges">\';');
    parts.push('          if(e.c.r>0)h+=\'<span class="ov-fb ov-fb-read">read \'+e.c.r+\'</span>\';');
    parts.push('          if(e.c.e>0)h+=\'<span class="ov-fb ov-fb-edit">edit \'+e.c.e+\'</span>\';');
    parts.push('          if(e.c.w>0)h+=\'<span class="ov-fb ov-fb-write">write \'+e.c.w+\'</span>\';');
    parts.push('          h+=\'</div></div>\';');
    parts.push('        });');
    parts.push('        if(fe.length>25)h+=\'<div style="font-size:0.72em;color:var(--text-secondary);padding:4px 8px">\'+( fe.length-25)+\' more files\\u2026</div>\';');
    parts.push('        h+=\'</div>\';');
    parts.push('      }else{h+=\'<div class="ov-no-signals">No file accesses recorded.</div>\';}');
    parts.push('    }else{h+=\'<div class="ov-no-signals">No interaction data.</div>\';}');
    parts.push('    h+=\'</div>\';');
    // Overload Signals
    parts.push('    h+=\'<div class="ov-section"><div class="ov-section-title">Overload Signals</div><div class="ov-section-sub">Patterns that degrade context quality</div>\';');
    parts.push('    if(a.overloadSignals&&a.overloadSignals.length){');
    parts.push('      h+=\'<div class="ov-signal-grid">\';');
    parts.push('      a.overloadSignals.forEach(function(sig){h+=\'<div class="ov-signal-card \'+sig.severity+\'"><div class="ov-sig-msg \'+sig.severity+\'">\'+esc(sig.message)+\'</div><div class="ov-sig-detail">\'+esc(sig.detail)+\'</div></div>\';});');
    parts.push('      h+=\'</div>\';');
    parts.push('    }else{h+=\'<div class="ov-no-signals">No overload signals — session looks healthy.</div>\';}');
    parts.push('    h+=\'</div>\';');
    // Context Optimization Proposals
    parts.push('    h+=\'<div class="ov-section"><div class="ov-section-title">Context Optimization</div><div class="ov-section-sub">Techniques with estimated token savings for this session</div>\';');
    parts.push('    var opts=a.optimizationProposals||[];');
    parts.push('    if(opts.length>0){');
    parts.push('      var techLabels={caveman:"caveman",file_reread:"re-reads",toon:"TOON",early_compact:"/compact",output_trim:"trim output",prompt_dedupe:"dedupe"};');
    parts.push('      h+=\'<div class="ov-opt-list">\';');
    parts.push('      opts.forEach(function(op){');
    parts.push('        h+=\'<div class="ov-opt-card">\';');
    parts.push('        h+=\'<div class="ov-opt-savings"><div class="ov-opt-pct">\'+op.savingsPct+\'%</div><div class="ov-opt-pct-lbl">saved</div></div>\';');
    parts.push('        h+=\'<div class="ov-opt-body">\';');
    parts.push('        h+=\'<div class="ov-opt-header"><span class="ov-opt-badge">\'+esc(techLabels[op.technique]||op.technique)+\'</span><span class="ov-opt-title">\'+esc(op.title)+\'</span></div>\';');
    parts.push('        h+=\'<div class="ov-opt-desc">\'+esc(op.description)+\'</div>\';');
    parts.push('        h+=\'<span class="ov-opt-evidence">\'+esc(op.evidence)+\'</span>\';');
    parts.push('        h+=\'<div class="ov-opt-toks">~\'+fmt(op.estimatedSavings)+\' tokens</div>\';');
    parts.push('        h+=\'</div></div>\';');
    parts.push('      });');
    parts.push('      h+=\'</div>\';');
    parts.push('    }else{h+=\'<div class="ov-no-signals">No optimization opportunities detected.</div>\';}');
    parts.push('    h+=\'</div>\';');
    // Interaction Timeline
    parts.push('    h+=\'<div class="ov-section"><div class="ov-section-title">Interaction Timeline</div><div class="ov-section-sub">Per-turn: prompt, tools called, and token flow</div>\';');
    parts.push('    if(det&&det.interactions&&det.interactions.length>0){');
    parts.push('      var iall=det.interactions;var sf2=iall.length>15?iall.length-15:0;');
    parts.push('      h+=\'<div class="ov-itl-list">\';');
    parts.push('      if(sf2>0)h+=\'<div class="ov-itl-skip">\\u2026 \'+sf2+\' earlier turns \\u2014 \'+iall.length+\' total</div>\';');
    parts.push('      iall.slice(sf2).forEach(function(it,li){');
    parts.push('        var ti=sf2+li;');
    parts.push('        var tt=new Date(it.ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});');
    parts.push('        if(it.isCompactionEvent){');
    parts.push('          var trig=it.compactionTrigger==="manual"?"manual":"auto";');
    parts.push('          var saved=it.preCompactionTokens&&it.postCompactionTokens?fmt(it.preCompactionTokens)+"\\u2192"+fmt(it.postCompactionTokens):"";');
    parts.push('          h+=\'<div class="ov-itl-compact"><span class="ov-itl-compact-icon">\\u21ba</span><span class="ov-itl-compact-label">Context compacted</span><span class="ov-itl-compact-trig">\'+trig+\'</span>\'+( saved?\'<span class="ov-itl-compact-saved">\'+saved+\' tokens</span>\':\'\')+\'<span class="ov-itl-time">\'+tt+\'</span></div>\';');
    parts.push('          return;');
    parts.push('        }');
    parts.push('        h+=\'<div class="ov-itl-row"><div class="ov-itl-idx">T\'+ti+\'</div><div class="ov-itl-body">\';');
    parts.push('        h+=\'<div class="ov-itl-meta"><span class="ov-itl-time">\'+tt+\'</span>\';');
    parts.push('        if(it.mode)h+=\'<span class="ov-itl-mode">\'+esc(it.mode)+\'</span>\';');
    parts.push('        if(it.promptPreview)h+=\'<span class="ov-itl-prompt">\'+esc(it.promptPreview.slice(0,100))+\'</span>\';');
    parts.push('        h+=\'</div>\';');
    parts.push('        if(it.toolCalls&&it.toolCalls.length){h+=\'<div class="ov-itl-tools">\';var faCopy=(it.fileAccesses||[]).slice();it.toolCalls.slice(0,12).forEach(function(t){var fi=-1;for(var k=0;k<faCopy.length;k++){if(faCopy[k].tool.toLowerCase()===t.toLowerCase()){fi=k;break;}}if(fi>=0){var fa=faCopy.splice(fi,1)[0];var bn=fa.path.split("/").pop()||fa.path;h+=\'<span class="ov-itl-tool">\'+esc(t)+\'<span class="ov-itl-tool-fname">\'+esc(bn)+\'</span></span>\';}else{h+=\'<span class="ov-itl-tool">\'+esc(t)+\'</span>\';}});if(it.toolCalls.length>12)h+=\'<span class="ov-itl-tool">+\'+(it.toolCalls.length-12)+\'</span>\';h+=\'</div>\';}');
    parts.push('        if(it.commandRuns&&it.commandRuns.length){h+=\'<div class="ov-itl-tools">\';it.commandRuns.slice(0,3).forEach(function(cmd){h+=\'<span class="ov-itl-tool" title="\'+esc(cmd)+\'">$\'+esc(cmd.slice(0,80))+\'</span>\';});if(it.commandRuns.length>3)h+=\'<span class="ov-itl-tool">+\'+(it.commandRuns.length-3)+\' commands</span>\';h+=\'</div>\';}');
    parts.push('        var ctxToks=it.inputTokens+(it.cacheReadTokens||0);');
    parts.push('        var cacheCalcTag=it.cacheTokensEstimated?\' <span style="opacity:.7">(calc.)</span>\':\'\';');
    parts.push('        h+=\'<div class="ov-itl-toks"><span class="ov-tok ov-tok-i" title="Total context size (new input + cache read)">\\u2191 \'+fmt(ctxToks)+\'</span><span class="ov-tok ov-tok-o" title="Output tokens">\\u2193 \'+fmt(it.outputTokens)+\'</span>\';');
    parts.push('        if(it.cacheReadTokens>0)h+=\'<span class="ov-tok ov-tok-c" title="Cache read tokens (included in context \\u2191)\'+(it.cacheTokensEstimated?\' - calculated estimate, not measured by GitHub Copilot\':\'\')+\'">\\u26a1 \'+fmt(it.cacheReadTokens)+cacheCalcTag+\'</span>\';');
    parts.push('        if(it.thinkingTokens>0)h+=\'<span class="ov-tok ov-tok-t" title="Thinking tokens">think \'+fmt(it.thinkingTokens)+\'</span>\';');
    parts.push('        if(it.cacheWriteTokens>0)h+=\'<span class="ov-tok ov-tok-w" title="Cache write tokens">\\u270d \'+fmt(it.cacheWriteTokens)+cacheCalcTag+\'</span>\';');
    parts.push('        h+=\'</div></div></div>\';');
    parts.push('      });');
    parts.push('      h+=\'</div>\';');
    parts.push('    }else{h+=\'<div class="ov-no-signals">No interaction data.</div>\';}');
    parts.push('    h+=\'</div>\';');
    // Fresh Session Brief
    parts.push('    h+=\'<div class="ov-section"><div class="ov-section-title">Fresh Session Brief</div><div class="ov-section-sub">Rehydrate a new session if you restart</div><div class="ov-brief-grid">\';');
    parts.push('    h+=\'<div class="ov-brief-box"><div class="ov-brief-lbl">Goal</div><div class="ov-brief-text">\'+esc(a.freshSessionBrief.goal||"\\u2014")+\'</div></div>\';');
    parts.push('    h+=\'<div class="ov-brief-box"><div class="ov-brief-lbl">Next Action</div><div class="ov-brief-text">\'+esc(a.freshSessionBrief.nextAction||"\\u2014")+\'</div></div>\';');
    parts.push('    h+=\'<div class="ov-brief-box"><div class="ov-brief-lbl">Write Ops</div><div class="ov-brief-text">\';');
    parts.push('    if(a.freshSessionBrief.writeOperations&&a.freshSessionBrief.writeOperations.length){a.freshSessionBrief.writeOperations.forEach(function(t){h+=\'<span class="ov-brief-tag">\'+esc(t)+\'</span>\';});}else{h+=\'<em style="color:var(--text-secondary)">None</em>\';}');
    parts.push('    h+=\'</div></div><div class="ov-brief-box"><div class="ov-brief-lbl">Warnings</div><div class="ov-brief-text">\';');
    parts.push('    if(a.freshSessionBrief.warnings&&a.freshSessionBrief.warnings.length){a.freshSessionBrief.warnings.forEach(function(w){h+=\'<span class="ov-brief-tag ov-warn-tag">\'+esc(w)+\'</span>\';});}else{h+=\'<em style="color:var(--text-secondary)">None</em>\';}');
    parts.push('    h+=\'</div></div></div></div>\';');
    // Rehydration Checklist
    parts.push('    h+=\'<div class="ov-section"><div class="ov-section-title">Rehydration Checklist</div><div class="ov-section-sub">Steps to start a fresh session with full context</div><ul class="ov-checklist">\';');
    parts.push('    (a.rehydrationChecklist||[]).forEach(function(item){h+=\'<li>\'+esc(item)+\'</li>\';});');
    parts.push('    h+=\'</ul></div>\';');
    // Patterns
    parts.push('    h+=\'<div class="ov-section"><div class="ov-section-title">Patterns</div><div class="ov-section-sub">Recurring tools and prompt fragments</div>\';');
    parts.push('    var hadPat=false;');
    parts.push('    if(a.heavyToolUsage&&a.heavyToolUsage.length){hadPat=true;h+=\'<div style="margin-bottom:9px"><div class="ov-section-sub" style="margin-bottom:5px">Heavy tool usage (3+ calls)</div>\';a.heavyToolUsage.slice(0,10).forEach(function(t){h+=\'<span class="ov-heavy-tool">\'+esc(t)+\'</span>\';});h+=\'</div>\';}');
    parts.push('    if(a.repeatedPromptFragments&&a.repeatedPromptFragments.length){hadPat=true;h+=\'<div><div class="ov-section-sub" style="margin-bottom:5px">Repeated prompt fragments</div><div class="ov-fragment-list">\';a.repeatedPromptFragments.slice(0,6).forEach(function(f){h+=\'<div class="ov-fragment-item">\'+esc(f)+\'</div>\';});h+=\'</div></div>\';}');
    parts.push('    if(!hadPat)h+=\'<div class="ov-no-signals">No repeated patterns detected.</div>\';');
    parts.push('    h+=\'</div>\';');
    parts.push('    return h;');
    parts.push('  }');
    // Chart renderers
    parts.push('  function renderOvChart(a){');
    parts.push('    var c=document.getElementById("ovTimelineChart");if(!c||!a.timeline||!a.timeline.length)return;');
    parts.push('    var lbl=a.timeline.map(function(t){return"T"+t.turnIndex;});');
    parts.push('    _ovChart=new Chart(c,{type:"bar",data:{labels:lbl,datasets:[');
    parts.push('      {label:"Input",data:a.timeline.map(function(t){return t.inputTokens;}),backgroundColor:"rgba(0,122,255,0.5)",borderColor:"#007AFF",borderWidth:1,yAxisID:"y",order:2},');
    parts.push('      {label:"Output",data:a.timeline.map(function(t){return t.outputTokens;}),backgroundColor:"rgba(57,255,20,0.5)",borderColor:"#39FF14",borderWidth:1,yAxisID:"y",order:2},');
    parts.push('      {label:"Tool calls",data:a.timeline.map(function(t){return t.toolCallCount;}),type:"line",borderColor:"#f093fb",backgroundColor:"rgba(240,147,251,0.1)",borderWidth:2,pointRadius:3,pointBackgroundColor:"#f093fb",yAxisID:"y2",tension:0.3,order:1}');
    parts.push('    ]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},plugins:{legend:{display:true,position:"top",labels:{color:"#c1c6d7",boxWidth:10,padding:10,font:{size:11}}}},scales:{y:{beginAtZero:true,position:"left",grid:{color:"rgba(255,255,255,0.04)"},ticks:{color:"#007AFF",callback:function(v){return v>=1000?(v/1000).toFixed(0)+"K":v;}}},y2:{beginAtZero:true,position:"right",grid:{display:false},ticks:{color:"#f093fb",stepSize:1}},x:{grid:{display:false},ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:20}}}}});');
    parts.push('  }');
    parts.push('  function renderOvRing(score,label){');
    parts.push('    var c=document.getElementById("ovScoreRing");if(!c)return;');
    parts.push('    var col=label==="stale"?"#FF3B30":label==="warning"?"#FF9F0A":"#39FF14";');
    parts.push('    _ovRingChart=new Chart(c,{type:"doughnut",data:{datasets:[{data:[score,10-score],backgroundColor:[col,"rgba(255,255,255,0.05)"],borderWidth:0}]},options:{responsive:false,animation:{duration:400},plugins:{legend:{display:false},tooltip:{enabled:false}},cutout:"72%"}});');
    parts.push('  }');
    parts.push('  function renderBudgetChart(a){');
    parts.push('    var c=document.getElementById("ovBudgetChart");if(!c||!a.contextBudgetAllocation)return;');
    parts.push('    var ba=a.contextBudgetAllocation;');
    parts.push('    var segs=[{v:ba.cachedTokens,c:"#FF9F0A",l:"Cached"},{v:ba.freshInputTokens,c:"#007AFF",l:"Fresh input"},{v:ba.outputTokens,c:"#39FF14",l:"Output"},{v:ba.thinkingTokens,c:"#f093fb",l:"Thinking"},{v:ba.cacheWriteTokens,c:"#FFD60A",l:"Cache writes"}].filter(function(s){return s.v>0;});');
    parts.push('    if(!segs.length)return;');
    parts.push('    _budgetChart=new Chart(c,{type:"doughnut",data:{labels:segs.map(function(s){return s.l;}),datasets:[{data:segs.map(function(s){return s.v;}),backgroundColor:segs.map(function(s){return s.c;}),borderWidth:0}]},options:{responsive:false,animation:{duration:400},plugins:{legend:{display:false},tooltip:{enabled:true,callbacks:{label:function(ctx){var s=segs[ctx.dataIndex];return s.l+": "+Math.round(s.v/1000)+"K";}}}},cutout:"60%"}});');
    parts.push('  }');
    parts.push('  function fmt(n){if(n>=1e6)return(n/1e6).toFixed(1)+"M";if(n>=1e3)return(n/1e3).toFixed(1)+"K";return String(n||0);}');
    parts.push('  function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}');
    parts.push('  function fmtDate(iso){var d=new Date(iso);var now=new Date();var today=new Date(now.getFullYear(),now.getMonth(),now.getDate());var day=new Date(d.getFullYear(),d.getMonth(),d.getDate());var diff=Math.round((today.getTime()-day.getTime())/86400000);var time=d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});if(diff===0)return"Today "+time;if(diff===1)return"Yesterday "+time;return d.toLocaleDateString([],{month:"short",day:"numeric"})+" "+time;}');
    parts.push('  function fmtDur(s,e){var ms=new Date(e).getTime()-new Date(s).getTime();if(ms<=0)return"-";var sec=Math.floor(ms/1000);if(sec<60)return sec+"s";var m=Math.floor(sec/60);if(m<60)return m+"m "+(sec%60)+"s";return Math.floor(m/60)+"h "+(m%60)+"m";}');
    parts.push(`  function badge(p,n){var icons=${JSON.stringify(PROVIDER_ICONS)};return"<span class=\\"provider-badge p-"+esc(p)+"\\">"+(icons[p]||"")+esc(n)+"</span>";}`);
    parts.push('  function breakdown(s){');
    parts.push('    var slots=[{k:"totalInputTokens",c:"#007AFF",l:"Input"},{k:"totalOutputTokens",c:"#39FF14",l:"Output"},{k:"totalThinkingTokens",c:"#f093fb",l:"Thinking"},{k:"totalCacheReadTokens",c:"#FF9F0A",l:"Cache read"},{k:"totalCacheWriteTokens",c:"#FFD60A",l:"Cache write"}];');
    parts.push('    var total=slots.reduce(function(a,sl){return a+(s[sl.k]||0);},0)||s.totalTokens||1;');
    parts.push('    var segs=slots.filter(function(sl){return s[sl.k]>0;}).map(function(sl){var p=(s[sl.k]/total*100).toFixed(1);return"<div class=\\"tok-seg\\" style=\\"width:"+p+"%;background:"+sl.c+"\\" title=\\""+sl.l+": "+(s[sl.k]||0).toLocaleString()+" ("+p+"%)\\"></div>";}).join("");');
    parts.push('    var chips=slots.filter(function(sl){return s[sl.k]>0;}).map(function(sl){var p=Math.round(s[sl.k]/total*100);return"<span class=\\"tok-chip\\"><span class=\\"tok-dot\\" style=\\"background:"+sl.c+"\\"></span>"+sl.l+" <span style=\\"color:"+sl.c+"\\">"+fmt(s[sl.k])+"</span> <span style=\\"opacity:0.5\\">("+p+"%)</span></span>";}).join("");');
    parts.push('    var tc=s.totalToolCalls>0?"<span class=\\"tok-chip\\" style=\\"color:var(--text-secondary)\\">🔧 "+s.totalToolCalls+" tool call"+(s.totalToolCalls!==1?"s":"")+"</span>":"";');
    parts.push('    return"<td class=\\"breakdown-cell\\"><div class=\\"tok-bar\\">"+(segs||"<div class=\\"tok-seg\\" style=\\"width:100%;background:rgba(255,255,255,0.08)\\"></div>")+"</div><div class=\\"tok-labels\\">"+chips+tc+"</div></td>";');
    parts.push('  }');

    parts.push('  function applyFilters(){');
    parts.push('    var pv=document.getElementById("providerFilter").value;');
    parts.push('    var dv=document.getElementById("dateFilter").value;');
    parts.push('    var sv=document.getElementById("searchFilter").value.toLowerCase().trim();');
    parts.push('    var tv=document.getElementById("tagFilter").value;');
    parts.push('    var now=new Date();');
    parts.push('    var todayStart=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();');
    parts.push('    var yearStart=new Date(now.getFullYear(),0,1).getTime();');
    parts.push('    var monthStart=new Date(now.getFullYear(),now.getMonth(),1).getTime();');
    parts.push('    var lastMonthStart=new Date(now.getFullYear(),now.getMonth()-1,1).getTime();');
    parts.push('    var lastMonthEnd=new Date(now.getFullYear(),now.getMonth(),0,23,59,59,999).getTime();');

    parts.push('    var f=ALL_SESSIONS.filter(function(s){');
    parts.push('      if(pv&&s.provider!==pv)return false;');
    parts.push('      var st=new Date(s.startTime).getTime();');
    parts.push('      if(dv==="today" && st<todayStart)return false;');
    parts.push('      if(dv==="7d" && st<(todayStart-6*86400000))return false;');
    parts.push('      if(dv==="30d" && st<(todayStart-29*86400000))return false;');
    parts.push('      if(dv==="thisMonth" && st<monthStart)return false;');
    parts.push('      if(dv==="lastMonth" && (st<lastMonthStart || st>lastMonthEnd))return false;');
    parts.push('      if(dv==="thisYear" && st<yearStart)return false;');
    parts.push('      if(sv){');
    parts.push('        var w=(s.workspace||"").toLowerCase();');
    parts.push('        var m=(s.models||[]).join(" ").toLowerCase();');
    parts.push('        var t=(s.title||"").toLowerCase();');
    parts.push('        var tg=(s.tags||[]).join(" ").toLowerCase();');
    parts.push('        if(!w.includes(sv)&&!m.includes(sv)&&!t.includes(sv)&&!tg.includes(sv))return false;');
    parts.push('      }');
    parts.push('      if(tv&&!(s.tags||[]).includes(tv))return false;');
    parts.push('      return true;');
    parts.push('    });');

    parts.push('    f.sort(function(a,b){');
    parts.push('      var va,vb;');
    parts.push('      if(sortKey==="startTime"){va=new Date(a.startTime).getTime();vb=new Date(b.startTime).getTime();}');
    parts.push('      else if(sortKey==="totalTokens"){va=a.totalTokens;vb=b.totalTokens;}');
    parts.push('      else if(sortKey==="interactions"){va=a.interactions;vb=b.interactions;}');
    parts.push('      else{va=a[sortKey];vb=b[sortKey];}');
    parts.push('      return sortDir*(va>vb?1:va<vb?-1:0);');
    parts.push('    });');

    parts.push('    currentFiltered=f;');
    parts.push('    currentPage=0;');
    parts.push('    render(f);');
    parts.push('    updateCharts(f);');
    parts.push('    updateStats(f);');
    parts.push('    updateComplexity(f);');
    parts.push('    updateActivity(f);');
    parts.push('    saveState();');
    parts.push('  }');

    parts.push('  function updateStats(sessions){');
    parts.push('    var totalTokens=0,totalCost=0,totalInteractions=0,copilotCredits=0,repos=new Set();');
    parts.push('    sessions.forEach(function(s){');
    parts.push('      totalTokens+=s.totalTokens;totalCost+=s.estimatedCostUsd;totalInteractions+=s.interactions;');
    parts.push('      if(s.provider==="copilot")copilotCredits+=s.aiCredits;');
    parts.push('      if(s.workspace)repos.add(repoName(s));');
    parts.push('    });');
    parts.push('    document.getElementById("statSessions").textContent=sessions.length;');
    parts.push('    document.getElementById("statInteractions").textContent=totalInteractions.toLocaleString()+" interactions";');
    parts.push('    document.getElementById("statTokens").textContent=fmt(totalTokens);');
    parts.push('    document.getElementById("statTokenAvg").textContent=sessions.length?fmt(Math.round(totalTokens/sessions.length))+" avg/session":"-";');
    parts.push('    document.getElementById("statCost").textContent="$"+totalCost.toFixed(2);');
    parts.push('    document.getElementById("statCredits").textContent=copilotCredits>0?Math.round(copilotCredits)+" Copilot credits":"Copilot credits N/A";');
    parts.push('    document.getElementById("statRepos").textContent=repos.size;');
    parts.push('  }');

    parts.push('  function updateComplexity(sessions){');
    parts.push('    if(!sessions.length){');
    parts.push('      ["scDepth","scDuration","scLong","scToolHeavy","scThinking","scMultiModel"].forEach(function(id){var e=document.getElementById(id);if(e)e.textContent="-";});');
    parts.push('      var hc=document.getElementById("scHighestCost");if(hc)hc.style.display="none";');
    parts.push('      return;');
    parts.push('    }');
    parts.push('    var totalDepth=0,totalDurMs=0,longCount=0,longCost=0,toolHeavy=0,thinking=0,multiModel=0,highCost=0,highSess=null;');
    parts.push('    sessions.forEach(function(s){');
    parts.push('      totalDepth+=s.interactions;');
    parts.push('      var dur=new Date(s.endTime).getTime()-new Date(s.startTime).getTime();');
    parts.push('      if(dur>0)totalDurMs+=dur;');
    parts.push('      if(dur>30*60*1000){longCount++;longCost+=s.estimatedCostUsd;}');
    parts.push('      if(s.totalToolCalls>5)toolHeavy++;');
    parts.push('      if(s.totalThinkingTokens>0)thinking++;');
    parts.push('      if((s.models||[]).length>1)multiModel++;');
    parts.push('      if(s.estimatedCostUsd>highCost){highCost=s.estimatedCostUsd;highSess=s;}');
    parts.push('    });');
    parts.push('    var n=sessions.length;');
    parts.push('    var avgDepth=(totalDepth/n).toFixed(1);');
    parts.push('    var avgDurMin=((totalDurMs/n)/60000).toFixed(1);');
    parts.push('    document.getElementById("scDepth").textContent=avgDepth;');
    parts.push('    document.getElementById("scDuration").textContent=avgDurMin+" min";');
    parts.push('    document.getElementById("scLong").textContent=longCount;');
    parts.push('    var lc=document.getElementById("scLongCost");if(lc)lc.textContent=longCount?"cost $"+longCost.toFixed(4):"";');
    parts.push('    document.getElementById("scToolHeavy").textContent=toolHeavy;');
    parts.push('    document.getElementById("scThinking").textContent=thinking;');
    parts.push('    document.getElementById("scMultiModel").textContent=multiModel;');
    parts.push('    var hcBox=document.getElementById("scHighestCost");');
    parts.push('    if(hcBox&&highSess&&highSess.estimatedCostUsd>0){');
    parts.push('      hcBox.style.display="";');
    parts.push('      hcBox.innerHTML="<strong>\u{1F4B0} Highest-Cost Session</strong> &nbsp;&middot;&nbsp; <span style=\'color:var(--text-secondary)\'>ID: "+esc(highSess.id)+"</span>&nbsp;&middot;&nbsp; <strong>$"+highSess.estimatedCostUsd.toFixed(4)+"</strong>&nbsp;&middot;&nbsp; "+fmt(highSess.totalTokens)+" tokens";');
    parts.push('    } else if(hcBox){hcBox.style.display="none";}');
    parts.push('  }');

    parts.push('  function mergeMap(target,source){Object.keys(source||{}).forEach(function(k){target[k]=(target[k]||0)+source[k];});}');
    parts.push('  function topEntries(map,limit){return Object.keys(map||{}).map(function(k){return{name:k,count:map[k]};}).sort(function(a,b){return b.count-a.count||a.name.localeCompare(b.name);}).slice(0,limit||8);}');
    parts.push('  function repoName(s){if(!s.workspace)return"Unknown";var n=s.workspace.replace(/\\\\\\\\/g,"/").split("/").pop()||s.workspace;return/^[0-9a-f]{6,10}(\\.\\.\\.)?$/i.test(n)?"Unknown":n;}');
    parts.push('  function relPath(fp,workspace){var p=String(fp||"");var ws=String(workspace||"").replace(/\\\\\\\\/g,"/");var pn=p.replace(/\\\\\\\\/g,"/");if(ws&&pn.startsWith(ws))return pn.slice(ws.length).replace(/^\\//,"");var parts=pn.split("/");return parts.length>3?".../"+parts.slice(-3).join("/"):pn;}');
    parts.push('  function renderActivityCard(title,entries,color){');
    parts.push('    var max=entries.length?entries[0].count:0;');
    parts.push('    var html="<div class=\\"activity-card\\"><h3>"+esc(title)+"</h3>";');
    parts.push('    if(!entries.length){html+="<div class=\\"activity-empty\\">No data recorded.</div></div>";return html;}');
    parts.push('    html+="<div class=\\"activity-list\\">";');
    parts.push('    entries.forEach(function(e){var pct=max?Math.max(4,Math.round(e.count/max*100)):0;html+="<div class=\\"activity-row\\"><span class=\\"activity-name\\" title=\\""+esc(e.name)+"\\">"+esc(e.label||e.name)+"</span><span class=\\"activity-count\\">"+e.count.toLocaleString()+"</span><div class=\\"activity-bar\\"><div class=\\"activity-fill\\" style=\\"width:"+pct+"%;background:"+color+"\\"></div></div></div>";});');
    parts.push('    html+="</div></div>";return html;');
    parts.push('  }');
    parts.push('  function collectActivity(sessions){');
    parts.push('    var reads={},edits={},tools={},commands={};');
    parts.push('    sessions.forEach(function(s){mergeMap(reads,s.fileReads);mergeMap(edits,s.fileEdits);mergeMap(tools,s.toolCalls);mergeMap(commands,s.commandRuns);});');
    parts.push('    return{reads:reads,edits:edits,tools:tools,commands:commands};');
    parts.push('  }');
    parts.push('  function renderOverallActivity(sessions){');
    parts.push('    var a=collectActivity(sessions);');
    parts.push('    var firstWs=sessions.length===1?sessions[0].workspace:"";');
    parts.push('    var reads=topEntries(a.reads,8).map(function(e){e.label=relPath(e.name,firstWs);return e;});');
    parts.push('    var edits=topEntries(a.edits,8).map(function(e){e.label=relPath(e.name,firstWs);return e;});');
    parts.push('    return"<div class=\\"activity-grid\\">"+renderActivityCard("Most Read Files",reads,"#007AFF")+renderActivityCard("Most Edited Files",edits,"#FF9F0A")+renderActivityCard("Most Used Tools",topEntries(a.tools,8),"#f093fb")+renderActivityCard("Commands Run",topEntries(a.commands,8),"#39FF14")+"</div>";');
    parts.push('  }');
    parts.push('  function renderRepositoryActivity(sessions){');
    parts.push('    var repos={};');
    parts.push('    sessions.forEach(function(s){var r=repoName(s);if(!repos[r])repos[r]={sessions:0,reads:{},edits:{},tools:{},commands:{},tokens:0};var x=repos[r];x.sessions++;x.tokens+=s.totalTokens;mergeMap(x.reads,s.fileReads);mergeMap(x.edits,s.fileEdits);mergeMap(x.tools,s.toolCalls);mergeMap(x.commands,s.commandRuns);});');
    parts.push('    var names=Object.keys(repos).sort(function(a,b){return repos[b].sessions-repos[a].sessions||repos[b].tokens-repos[a].tokens;});');
    parts.push('    if(!names.length)return"<div class=\\"activity-empty\\">No repositories match the current filters.</div>";');
    parts.push('    var rows=names.slice(0,12).map(function(name){var r=repos[name];var tr=topEntries(r.reads,1)[0];var te=topEntries(r.edits,1)[0];var tt=topEntries(r.tools,1)[0];var tc=topEntries(r.commands,1)[0];return"<tr><td><strong>"+esc(name)+"</strong></td><td class=\\"data-text\\" style=\\"text-align:right\\">"+r.sessions+"</td><td class=\\"data-text\\" style=\\"text-align:right\\">"+fmt(r.tokens)+"</td><td title=\\""+esc(tr?tr.name:"")+"\\">"+esc(tr?relPath(tr.name,"")+" ("+tr.count+")":"-")+"</td><td title=\\""+esc(te?te.name:"")+"\\">"+esc(te?relPath(te.name,"")+" ("+te.count+")":"-")+"</td><td>"+esc(tt?tt.name+" ("+tt.count+")":"-")+"</td><td title=\\""+esc(tc?tc.name:"")+"\\">"+esc(tc?tc.name+" ("+tc.count+")":"-")+"</td></tr>";}).join("");');
    parts.push('    return"<div class=\\"repo-activity\\"><table><thead><tr><th>Repository</th><th style=\\"text-align:right\\">Sessions</th><th style=\\"text-align:right\\">Tokens</th><th>Top Read</th><th>Top Edit</th><th>Top Tool</th><th>Top Command</th></tr></thead><tbody>"+rows+"</tbody></table></div>";');
    parts.push('  }');
    parts.push('  function renderSessionActivity(sessions){');
    parts.push('    var top=sessions.slice().sort(function(a,b){return (Object.keys(b.fileReads||{}).length+Object.keys(b.fileEdits||{}).length+Object.keys(b.commandRuns||{}).length)-(Object.keys(a.fileReads||{}).length+Object.keys(a.fileEdits||{}).length+Object.keys(a.commandRuns||{}).length);}).slice(0,10);');
    parts.push('    if(!top.length)return"<div class=\\"activity-empty\\">No sessions match the current filters.</div>";');
    parts.push('    var rows=top.map(function(s){var tr=topEntries(s.fileReads,1)[0];var te=topEntries(s.fileEdits,1)[0];var tt=topEntries(s.toolCalls,1)[0];var tc=topEntries(s.commandRuns,1)[0];var name=s.title||s.id.slice(0,18);return"<tr><td title=\\""+esc(s.id)+"\\"><strong>"+esc(name)+"</strong><br><span style=\\"color:var(--text-secondary);font-size:0.78em\\">"+esc(repoName(s))+" · "+fmtDate(s.startTime)+"</span></td><td class=\\"data-text\\" style=\\"text-align:right\\">"+s.interactions+"</td><td title=\\""+esc(tr?tr.name:"")+"\\">"+esc(tr?relPath(tr.name,s.workspace)+" ("+tr.count+")":"-")+"</td><td title=\\""+esc(te?te.name:"")+"\\">"+esc(te?relPath(te.name,s.workspace)+" ("+te.count+")":"-")+"</td><td>"+esc(tt?tt.name+" ("+tt.count+")":"-")+"</td><td title=\\""+esc(tc?tc.name:"")+"\\">"+esc(tc?tc.name+" ("+tc.count+")":"-")+"</td></tr>";}).join("");');
    parts.push('    return"<div class=\\"repo-activity\\"><table><thead><tr><th>Session</th><th style=\\"text-align:right\\">Turns</th><th>Top Read</th><th>Top Edit</th><th>Top Tool</th><th>Top Command</th></tr></thead><tbody>"+rows+"</tbody></table></div>";');
    parts.push('  }');
    parts.push('  function updateActivity(sessions){');
    parts.push('    var body=document.getElementById("activityBody");if(!body)return;');
    parts.push('    if(activityScope==="repository")body.innerHTML=renderRepositoryActivity(sessions);');
    parts.push('    else if(activityScope==="session")body.innerHTML=renderSessionActivity(sessions);');
    parts.push('    else body.innerHTML=renderOverallActivity(sessions);');
    parts.push('  }');

    parts.push('  function updateCharts(sessions){');
    parts.push('    var metric=document.getElementById("metricType").value;');
    parts.push('    var breakdown=document.getElementById("breakdownType").value;');
    parts.push('    var daily={}, dailySessions={}, dist={};');

    parts.push('    sessions.forEach(function(s){');
    parts.push('      var d=s.startTime.split("T")[0];');
    parts.push('      var val=(metric==="tokens")?s.totalTokens:1;');
    parts.push('      daily[d]=(daily[d]||0)+val;');
    parts.push('      dailySessions[d]=(dailySessions[d]||0)+1;');

    parts.push('      var key="Unknown";');
    parts.push('      if(breakdown==="model")key=(s.models&&s.models.length)?s.models[0]:"Unknown";');
    parts.push('      else if(breakdown==="workspace")key=repoName(s);');
    parts.push('      else key=s.providerName||s.provider;');
    parts.push('      dist[key]=(dist[key]||0)+val;');
    parts.push('    });');

    parts.push('    var sortedDates=Object.keys(daily).sort();');
    parts.push('    var ctx1=document.getElementById("usageChart");if(usageChart)usageChart.destroy();');
    parts.push('    var ds1={type:"bar",label:metric==="tokens"?"Tokens":"Sessions",data:sortedDates.map(d=>daily[d]),backgroundColor:"rgba(0,122,255,0.5)",borderColor:"#007AFF",borderWidth:1,yAxisID:"y"};');
    parts.push('    var ds2={type:"line",label:"Sessions",data:sortedDates.map(d=>dailySessions[d]||0),borderColor:"#39FF14",backgroundColor:"rgba(57,255,20,0.08)",borderWidth:2,pointRadius:3,pointBackgroundColor:"#39FF14",tension:0.3,yAxisID:"y2"};');
    parts.push('    var showDual=metric==="tokens";');
    parts.push('    var chartScales={y:{beginAtZero:true,grid:{color:"rgba(255,255,255,0.05)"},ticks:{color:"#007AFF",callback:function(v){return fmt(v);}},position:"left"},x:{grid:{display:false}}};');
    parts.push('    if(showDual)chartScales.y2={beginAtZero:true,grid:{display:false},ticks:{color:"#39FF14",stepSize:1},position:"right"};');
    parts.push('    usageChart=new Chart(ctx1,{type:"bar",data:{labels:sortedDates,datasets:showDual?[ds1,ds2]:[ds1]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:"index",intersect:false},plugins:{legend:{display:showDual,labels:{color:"#c1c6d7",font:{size:11},boxWidth:12,padding:12}},title:{display:true,text:"Daily "+(metric==="tokens"?"Token Consumption":"Usage"),color:"#e5e2e1"}},scales:chartScales}});');

    parts.push('    var distLabels=Object.keys(dist).sort((a,b)=>dist[b]-dist[a]);');
    parts.push('    var colors=["#007AFF","#39FF14","#f093fb","#FF9F0A","#FFD60A","#00c864","#FF3B30","#5856D6","#FF9500"];');
    parts.push('    var ctx2=document.getElementById("distChart");if(distChart)distChart.destroy();');
    parts.push('    distChart=new Chart(ctx2,{type:"doughnut",data:{labels:distLabels,datasets:[{data:distLabels.map(l=>dist[l]),backgroundColor:distLabels.map((_,i)=>colors[i%colors.length]),borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:"right",labels:{boxWidth:12,color:"#c1c6d7",padding:8,font:{size:11}}},title:{display:true,text:"By "+breakdown.charAt(0).toUpperCase()+breakdown.slice(1),color:"#e5e2e1"}},cutout:"65%"}});');
    parts.push('  }');

    parts.push('  function costCell(s){');
    parts.push('    if(s.provider==="copilot"){');
    parts.push('      return "<td class=\\"credits-cell\\"><span class=\\"credits-badge\\">"+s.aiCredits.toFixed(2)+" cr</span><br><span style=\\"opacity:0.5;font-size:0.9em\\">$"+s.estimatedCostUsd.toFixed(4)+"</span></td>";');
    parts.push('    }');
    parts.push('    return "<td class=\\"credits-cell\\"><span class=\\"approx-price\\">~$"+s.estimatedCostUsd.toFixed(4)+"</span></td>";');
    parts.push('  }');

    parts.push('  function contextHealthCell(s){');
    parts.push('    var cr=s.contextRot;');
    parts.push('    if(!cr)return"<td><span class=\\"ctx-badge ctx-na\\">—</span></td>";');
    parts.push('    var icons={"healthy":"●","warning":"●","stale":"●"};');
    parts.push('    var labels={"healthy":"Healthy","warning":"Warn","stale":"Stale"};');
    parts.push('    var ageStr=cr.sessionAgeMinutes<60?Math.round(cr.sessionAgeMinutes)+"m":Math.floor(cr.sessionAgeMinutes/60)+"h"+(Math.round(cr.sessionAgeMinutes%60)>0?Math.round(cr.sessionAgeMinutes%60)+"m":"");');
    parts.push('    var growthNote=cr.turnsCount<6?" (limited: <6 turns)":"";');
    parts.push('    var runwayStr=cr.contextRunway!=null?"\\nRunway: ~"+cr.contextRunway+" turns":"";');
    parts.push('    var tip="Score: "+cr.score+"/10  CQ: "+cr.contextQualityScore+"/100\\nCache: "+cr.cacheEfficiencyRate+"%\\nTurns: "+cr.turnsCount+"\\nAge: "+ageStr+runwayStr+"\\nInput bloat: "+cr.inputBloatFactor.toFixed(1)+"x"+growthNote+"\\nOutput trend: "+cr.outputDeclineFactor.toFixed(2)+"x"+growthNote;');
    parts.push('    return"<td><span class=\\"ctx-badge ctx-"+cr.label+"\\" title=\\""+tip.replace(/"/g,\'&quot;\').replace(/\\n/g,\'&#10;\')+"\\">" +icons[cr.label]+" "+labels[cr.label]+"</span></td>";');
    parts.push('  }');
    parts.push('  function render(sessions){');
    parts.push('    if(sessions.length===0){document.getElementById("tableContainer").innerHTML="<div class=\\"empty-state\\">No sessions match current filters.</div>";return;}');
    parts.push('    var totalPages=Math.max(1,Math.ceil(sessions.length/PAGE_SIZE));');
    parts.push('    if(currentPage>=totalPages)currentPage=totalPages-1;');
    parts.push('    var pageStart=currentPage*PAGE_SIZE;');
    parts.push('    var pageSessions=sessions.slice(pageStart,pageStart+PAGE_SIZE);');
    parts.push('    var arrow=k=>sortKey===k?(sortDir===-1?" ↓":" ↑"):"";');
    parts.push('    var thc=k=>"sortable"+(sortKey===k?" sorted":"");');
    parts.push('    var rows=pageSessions.map(function(s,relIdx){');
    parts.push('      var idx=pageStart+relIdx;');
    parts.push('      var repo=s.workspace?(s.workspace.replace(/\\\\\\\\/g,"/").split("/").pop()||s.workspace):"-";');
    parts.push('      var mods=(s.models||[]).map(m=>"<span class=\\"model-tag\\">"+esc(m)+"</span>").join("")||"-";');
    parts.push('      var titleCell=s.title?"<span class=\\"title-cell\\" title=\\""+esc(s.title)+"\\">" +esc(s.title)+"</span>":"<span style=\\"opacity:0.3\\">-</span>";');
    parts.push('      var openBtn=s.sourceFile?"<button class=\\"btn-open\\" onclick=\\"openSession("+idx+")\\">Open</button>":"";');
    parts.push('      var replayBtn=s.interactions>0?"<button class=\\"btn-open\\" onclick=\\"replaySession("+idx+")\\" title=\\"Replay session timeline\\">Replay</button>":"";');
    parts.push('      var analyzeBtn="<button class=\\"btn-open\\" onclick=\\"analyzeSession("+idx+")\\" title=\\"Context Workbench\\">Analyze</button>";');
    parts.push('      var chkHtml="<td class=\\"chk-cell\\"><input type=\\"checkbox\\" class=\\"row-check\\" data-idx=\\""+idx+"\\" "+(selectedIds.has(s.id)?"checked":"")+" onchange=\\"toggleRow("+idx+")\\" title=\\"Select for comparison\\"></td>";');
    parts.push('      var tagChips=(s.tags||[]).map(function(tg){return"<span class=\\"tag-chip\\">"+esc(tg)+"<button class=\\"tag-rm\\" data-rm-idx=\\""+idx+"\\" data-rm-tag=\\""+esc(tg)+"\\" title=\\"Remove tag\\">&#215;</button></span>";}).join("");');
    parts.push('      var tagCell="<td class=\\"tags-cell\\">"+tagChips+"<button class=\\"btn-tag-add\\" data-add-idx=\\""+idx+"\\" title=\\"Add tag\\">+</button><input class=\\"tag-input\\" id=\\"ti"+idx+"\\" data-idx=\\""+idx+"\\" placeholder=\\"tag…\\" style=\\"display:none\\"></td>";');
    parts.push('      return "<tr data-idx=\\""+idx+"\\">"+chkHtml+"<td class=\\"data-text\\">"+fmtDate(s.startTime)+"</td><td>"+badge(s.provider,s.providerName)+"</td><td>"+titleCell+"</td><td><span class=\\"ws-cell\\" title=\\""+esc(s.workspace||"")+"\\">"+ esc(repo)+"</span></td><td class=\\"data-text\\" style=\\"font-weight:600\\">"+fmt(s.totalTokens)+"</td>"+breakdown(s)+costCell(s)+contextHealthCell(s)+"<td class=\\"data-text\\">"+s.interactions+"</td><td>"+mods+"</td><td class=\\"data-text\\" style=\\"color:var(--text-secondary)\\">"+fmtDur(s.startTime,s.endTime)+"</td>"+tagCell+"<td style=\\"white-space:nowrap\\">"+analyzeBtn+" "+replayBtn+" "+openBtn+"</td></tr>";');
    parts.push('    }).join("");');
    parts.push('    var pgHtml=totalPages>1?"<div class=\\"pagination\\"><button onclick=\\"goToPage("+(currentPage-1)+")\\" "+(currentPage===0?"disabled":"")+">&#8592; Prev</button><span class=\\"page-info\\">Page "+(currentPage+1)+" of "+totalPages+" &middot; "+sessions.length+" sessions</span><button onclick=\\"goToPage("+(currentPage+1)+")\\" "+(currentPage>=totalPages-1?"disabled":"")+">Next &#8594;</button></div>":"";');
    parts.push('    var ctxHint="Context Health \\u24d8";');
    parts.push('    var ctxTip="Score 0\\u201310 from 5 signals:\\n\\u2022 Turn count  (>40 turns \\u2192 +1, >80 \\u2192 +2)\\n\\u2022 Session age  (>60 min \\u2192 +1, >120 min \\u2192 +2)\\n\\u2022 Input bloat  last-third vs first-third avg input (>1.5\\u00d7 \\u2192 +1, >2\\u00d7 \\u2192 +2, >4\\u00d7 \\u2192 +3)\\n\\u2022 Output decline  last-third vs first-third avg output (<0.65\\u00d7 \\u2192 +1, <0.4\\u00d7 \\u2192 +2)\\n\\u2022 Total input size  (>80K \\u2192 +1, >200K \\u2192 +2)\\n\\nGrowth signals require \\u22656 turns to activate.\\n\\n\\u25cf 0\\u20133 Healthy  \\u25cf 4\\u20136 Warn  \\u25cf 7\\u201310 Stale";');
    parts.push('    document.getElementById("tableContainer").innerHTML="<table><thead><tr><th class=\\"chk-cell\\" title=\\"Select for comparison\\"></th><th class=\\""+thc("startTime")+"\\" onclick=\\"sortBy(\'startTime\')\\">Date"+arrow("startTime")+"</th><th>Provider</th><th>Session</th><th>Workspace</th><th class=\\""+thc("totalTokens")+"\\" onclick=\\"sortBy(\'totalTokens\')\\">Tokens"+arrow("totalTokens")+"</th><th>Breakdown</th><th>Cost</th><th style=\\"cursor:help\\" title=\\""+ctxTip.replace(/"/g,\'&quot;\').replace(/\\n/g,\'&#10;\')+"\\">" +ctxHint+"</th><th class=\\""+thc("interactions")+"\\" onclick=\\"sortBy(\'interactions\')\\">Interactions"+arrow("interactions")+"</th><th>Models</th><th>Duration</th><th>Tags</th><th></th></tr></thead><tbody>"+rows+"</tbody></table>"+pgHtml;');
    parts.push('  }');

    parts.push('  function sortBy(k){sortDir=sortKey===k?-sortDir:-1;sortKey=k;currentPage=0;applyFilters();}');
    parts.push('  function goToPage(p){currentPage=p;render(currentFiltered);}');
    parts.push('  window.sortBy=sortBy;');
    parts.push('  window.goToPage=goToPage;');
    parts.push('  applyFilters();');
    parts.push('})();');
    parts.push(navJs());
    parts.push('</script>');
    parts.push('</body></html>');

    return parts.join('');
  }
}

function buildActiveSessionsWidget(liveSessions: LiveSessionState[], budgetConfig: LiveBudgetConfig | null): string {
  const parts: string[] = [];
  parts.push('<div class="active-sessions">');
  parts.push('<div class="live-header">');
  if (liveSessions.length > 0) {
    parts.push(`<span class="live-badge"><span class="live-dot"></span>${liveSessions.length} active session${liveSessions.length > 1 ? 's' : ''}</span>`);
  } else {
    parts.push('<span style="font-size:0.85em;color:var(--text-secondary);">No active sessions detected</span>');
  }
  parts.push('<span class="live-updated">Updated every 30 s &middot; <span id="lastUpdateTime">just now</span></span>');
  parts.push('</div>');

  if (liveSessions.length > 0) {
    parts.push('<div class="active-sessions-title">Active Sessions</div>');
    for (const session of liveSessions) {
      parts.push(buildLiveSessionCard(session, budgetConfig));
    }
  }

  parts.push('</div>');
  return parts.join('');
}

function buildLiveSessionCard(sess: LiveSessionState, budget: LiveBudgetConfig | null): string {
  const hasAlerts = sess.alerts.length > 0;
  const hasError = sess.alerts.some(a => a.severity === 'error');
  const cardClass = hasError ? 'is-stale' : hasAlerts ? 'is-warn' : 'is-ok';

  const burnClass = sess.recentBurnRatePerMin > 6000
    ? 'crit'
    : sess.recentBurnRatePerMin > 2000
      ? 'warn'
      : 'ok';
  const exhaustClass = sess.projectedExhaustionMinutes !== null
    ? (sess.projectedExhaustionMinutes <= 15 ? 'crit' : sess.projectedExhaustionMinutes <= 60 ? 'warn' : 'ok')
    : '';
  const budgetPct = sess.budgetUsedPct;
  const fillClass = budgetPct === null ? 'ok' : budgetPct >= 90 ? 'crit' : budgetPct >= 70 ? 'warn' : 'ok';
  const fillWidth = budgetPct !== null ? Math.min(100, budgetPct).toFixed(1) : '0';

  const miniSummary = `${formatLiveNumber(sess.currentTokens)} tokens · ${formatLiveNumber(sess.recentBurnRatePerMin)}/min · ${formatLiveMinutes(sess.elapsedMinutes)}`;

  let html = `<div class="session-card ${cardClass} is-collapsed">`;
  html += '<div class="session-card-header">';
  html += `<div class="session-card-title"><span class="live-dot"></span><span>${escapeHtml(sess.sessionTitle || sess.sessionId)}</span><span class="provider-chip p-${sess.provider}">${escapeHtml(sess.provider)}</span></div>`;
  html += `<div style="display:flex;align-items:center;gap:10px;margin-left:auto;">`;
  html += `<span style="font-size:0.78em;color:var(--text-secondary);font-family:var(--font-data)">started ${new Date(sess.sessionStartTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;
  html += `<button class="session-card-collapse" onclick="this.closest('.session-card').classList.toggle('is-collapsed')" title="Collapse / expand">&#8897;</button>`;
  html += '</div>';
  html += '</div>';

  // One-line summary shown when collapsed
  html += `<div class="session-card-mini"><span>${escapeHtml(miniSummary)}</span></div>`;

  html += '<div class="session-card-body">';
  html += '<div class="metrics-grid">';
  html += liveMetric('Tokens Used', formatLiveNumber(sess.currentTokens), `${formatLiveNumber(sess.currentInputTokens)} in · ${formatLiveNumber(sess.currentOutputTokens)} out`);
  html += liveMetric('Elapsed', formatLiveMinutes(sess.elapsedMinutes), '');
  html += liveMetric('Burn Rate', `${formatLiveNumber(sess.recentBurnRatePerMin)}/min`, 'tokens per minute', burnClass);
  if (sess.projectedExhaustionMinutes !== null) {
    html += liveMetric(
      'Budget Exhaustion',
      sess.projectedExhaustionMinutes <= 0 ? 'Now' : formatLiveMinutes(sess.projectedExhaustionMinutes),
      'at current burn rate',
      exhaustClass,
    );
  }
  if (sess.budgetWindowResetTime) {
    const resetIn = (new Date(sess.budgetWindowResetTime).getTime() - Date.now()) / 60000;
    html += liveMetric('Reset In', formatLiveMinutes(Math.max(0, resetIn)), 'budget window reset', resetIn < 30 ? 'warn' : '');
  }
  html += '</div>';

  if (budget?.limitTokens && budgetPct !== null) {
    html += '<div class="burn-bar-wrap">';
    html += `<div class="burn-bar-label"><span>Budget used: ${budgetPct.toFixed(1)}%</span><span>${formatLiveNumber(sess.budgetWindowUsedTokens)} / ${formatLiveNumber(budget.limitTokens)} tokens</span></div>`;
    html += `<div class="burn-bar"><div class="burn-fill ${fillClass}" style="width:${fillWidth}%"></div></div>`;
    html += '</div>';
  }

  if (sess.alerts.length > 0) {
    html += '<div class="alerts-list">';
    for (const alert of sess.alerts) {
      const dotColor = alert.severity === 'error' ? '#FF3B30' : '#FF9F0A';
      html += `<div class="alert-item ${alert.severity}"><span style="color:${dotColor};font-size:1em;line-height:1;">●</span><span>${escapeHtml(alert.message)}</span></div>`;
    }
    html += '</div>';
  }

  html += '</div>'; // .session-card-body
  html += '</div>';
  return html;
}

function liveMetric(label: string, value: string, sub: string, cls = ''): string {
  return `<div class="metric-box"><div class="metric-label">${label}</div><div class="metric-value${cls ? ' ' + cls : ''}">${value}</div>${sub ? `<div class="metric-sub">${sub}</div>` : ''}</div>`;
}

function formatLiveNumber(n: number): string {
  if (n >= 1_000_000) { return (n / 1_000_000).toFixed(2) + 'M'; }
  if (n >= 1_000) { return (n / 1_000).toFixed(1) + 'K'; }
  return n.toFixed(0);
}

function formatLiveMinutes(m: number): string {
  if (m < 1) { return '<1 min'; }
  if (m < 60) { return `${Math.round(m)} min`; }
  return `${Math.floor(m / 60)}h ${Math.round(m % 60)}m`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
