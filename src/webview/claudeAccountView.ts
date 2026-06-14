import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { AggregatedMetrics, Session } from '../types';
import { navCss, navTopbarHtml, navPagebarHtml, navJs, NAV_COMMANDS } from './navShared';
import { designTokensCss } from './designSystem';

const PLAN_STATE_KEY    = 'aiInsights.claudePlan';
const WINDOW_CONFIG_KEY = 'aiInsights.windowConfig';

interface WindowConfig {
  /** "HH:MM" (24-h) when the current session resets, as shown on claude.ai. Empty = auto-estimate. */
  sessionResetTime: string;
  /** Day of week for weekly reset: 0=Sun … 6=Sat (default 5 = Fri). */
  weeklyResetDay: number;
  /** Hour of day for weekly reset, 0–23 (default 11). */
  weeklyResetHour: number;
}

const DEFAULT_WINDOW_CONFIG: WindowConfig = { sessionResetTime: '', weeklyResetDay: 5, weeklyResetHour: 11 };

type ClaudePlan = 'free' | 'pro' | 'max5x' | 'max20x' | 'api';

const PLAN_LABELS: Record<ClaudePlan, string> = {
  free:   'Free',
  pro:    'Claude Pro',
  max5x:  'Claude Max (5×)',
  max20x: 'Claude Max (20×)',
  api:    'API / Developer',
};

const PLAN_COLOR: Record<ClaudePlan, string> = {
  free:   '#888',
  pro:    '#e8621a',
  max5x:  '#7c3aed',
  max20x: '#0ea5e9',
  api:    '#39FF14',
};

interface WindowStats {
  tokens: number;
  outputTokens: number;
  interactions: number;
  /** Oldest interaction timestamp inside the window (null = no activity). */
  oldestTs: Date | null;
  /** When the window resets: oldestTs + windowDurationMs (null if no activity). */
  resetsAt: Date | null;
}

/** Compute token usage over a rolling time window for Claude Code sessions only. */
function calcWindow(sessions: Session[], windowMs: number): WindowStats {
  const cutoff = new Date(Date.now() - windowMs);
  let tokens = 0, outputTokens = 0, interactions = 0;
  let oldestTs: Date | null = null;

  for (const s of sessions) {
    if (s.provider !== 'claudeCode') { continue; }
    for (const ix of s.interactions) {
      if (ix.isCompactionEvent) { continue; }
      const ts = ix.timestamp instanceof Date ? ix.timestamp : new Date(ix.timestamp);
      if (ts >= cutoff) {
        tokens      += ix.totalTokens;
        outputTokens += ix.outputTokens;
        interactions++;
        if (!oldestTs || ts < oldestTs) { oldestTs = ts; }
      }
    }
  }

  const resetsAt = oldestTs ? new Date(oldestTs.getTime() + windowMs) : null;
  return { tokens, outputTokens, interactions, oldestTs, resetsAt };
}

/** Format a future Date as "in Xh Ym" or "in Xm" or "soon". */
function fmtCountdown(d: Date | null): string {
  if (!d) { return '—'; }
  const ms = d.getTime() - Date.now();
  if (ms <= 0) { return 'any moment'; }
  const totalMin = Math.round(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) { return `in ${h}h ${m}m`; }
  return `in ${m}m`;
}

/**
 * Build the session reset countdown label.
 * If the user set a manual time (HH:MM), use that; otherwise fall back to
 * the auto-estimate derived from the oldest in-window interaction.
 */
function buildSessionResetLabel(sessionResetTime: string, win: WindowStats): string {
  if (sessionResetTime) {
    const [hStr, mStr] = sessionResetTime.split(':');
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr ?? '0', 10);
    if (isFinite(h) && isFinite(m)) {
      const resetDate = new Date();
      resetDate.setHours(h, m, 0, 0);
      if (resetDate > new Date()) { return fmtCountdown(resetDate); }
      return 'passed — update ⚙';
    }
  }
  if (win.resetsAt && win.resetsAt > new Date()) { return `~${fmtCountdown(win.resetsAt)}`; }
  return win.interactions > 0 ? '~reset' : '—';
}

/** Next occurrence of weekday (0=Sun…6=Sat) at hour:00, strictly after now. */
function nextWeeklyReset(weekday: number, hour: number): Date {
  const now = new Date();
  const d   = new Date(now);
  d.setHours(hour, 0, 0, 0);
  let dayDiff = (weekday - d.getDay() + 7) % 7;
  if (dayDiff === 0 && d <= now) { dayDiff = 7; }
  d.setDate(d.getDate() + dayDiff);
  return d;
}

export class ClaudeAccountViewProvider {
  static readonly viewType = 'aiInsights.claudeAccount';
  private static currentPanel: vscode.WebviewPanel | undefined;

  static async createPanel(
    context: vscode.ExtensionContext,
    metrics: AggregatedMetrics | undefined,
    sessions: Session[],
  ): Promise<void> {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const plan = context.globalState.get<ClaudePlan>(PLAN_STATE_KEY, 'pro');

    if (this.currentPanel) {
      this.currentPanel.reveal(column);
      this.currentPanel.webview.html = this.getHtml(this.currentPanel.webview, context, metrics, plan, sessions);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      this.viewType,
      'Claude',
      column,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')],
        retainContextWhenHidden: true,
      },
    );
    this.currentPanel = panel;
    panel.webview.html = this.getHtml(panel.webview, context, metrics, plan, sessions);
    panel.onDidDispose(() => { this.currentPanel = undefined; }, null, context.subscriptions);

    panel.webview.onDidReceiveMessage(async (msg) => {
      const navCmd = NAV_COMMANDS[msg.command];
      if (navCmd) { vscode.commands.executeCommand(navCmd); return; }

      switch (msg.command) {
        case 'setPlan': {
          const newPlan = msg.plan as ClaudePlan;
          await context.globalState.update(PLAN_STATE_KEY, newPlan);
          panel.webview.html = this.getHtml(panel.webview, context, metrics, newPlan, sessions);
          break;
        }
        case 'saveWindowConfig': {
          // clampNum avoids the `0 || fallback` pitfall for valid-but-falsy values
          const clampNum = (v: unknown, lo: number, hi: number, def: number) => {
            const n = Number(v);
            return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
          };
          const rawTime = (msg.sessionResetTime ?? '').toString().trim();
          const cfg: WindowConfig = {
            sessionResetTime: /^\d{1,2}:\d{2}$/.test(rawTime) ? rawTime : DEFAULT_WINDOW_CONFIG.sessionResetTime,
            weeklyResetDay:   clampNum(msg.weeklyResetDay,  0,  6, DEFAULT_WINDOW_CONFIG.weeklyResetDay),
            weeklyResetHour:  clampNum(msg.weeklyResetHour, 0, 23, DEFAULT_WINDOW_CONFIG.weeklyResetHour),
          };
          await context.globalState.update(WINDOW_CONFIG_KEY, cfg);

          // Recalculate and push targeted update — no full page re-render.
          const sessionMs  = 5 * 60 * 60 * 1000; // always 5 h for token count window
          const newSession = calcWindow(sessions, sessionMs);
          const newWeekly  = calcWindow(sessions, 7 * 24 * 60 * 60 * 1000);
          const newWeeklyResetsAt = nextWeeklyReset(cfg.weeklyResetDay, cfg.weeklyResetHour);

          const sessResetLbl = buildSessionResetLabel(cfg.sessionResetTime, newSession);
          const weeklyResetLbl = newWeeklyResetsAt.toLocaleDateString('default', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

          try {
            panel.webview.postMessage({
              type: 'windowConfigSaved',
              config: cfg,
              session: {
                tokens:       newSession.tokens,
                outputTokens: newSession.outputTokens,
                interactions: newSession.interactions,
                hasActivity:  newSession.interactions > 0,
                resetLabel:   sessResetLbl,
              },
              weekly: {
                tokens:       newWeekly.tokens,
                outputTokens: newWeekly.outputTokens,
                interactions: newWeekly.interactions,
                resetLabel:   weeklyResetLbl,
              },
            });
          } catch { /* panel disposed */ }
          break;
        }
        case 'refresh':
          vscode.commands.executeCommand('aiInsights.refresh');
          break;
      }
    }, null, context.subscriptions);
  }

  static async pushMetrics(context: vscode.ExtensionContext, metrics: AggregatedMetrics, sessions: Session[]): Promise<void> {
    if (!this.currentPanel) { return; }
    const plan = context.globalState.get<ClaudePlan>(PLAN_STATE_KEY, 'pro');
    this.currentPanel.webview.html = this.getHtml(this.currentPanel.webview, context, metrics, plan, sessions);
  }

  // ─── HTML ─────────────────────────────────────────────────────────────────

  static getHtml(
    webview: vscode.Webview,
    context: vscode.ExtensionContext,
    metrics: AggregatedMetrics | undefined,
    plan: ClaudePlan,
    sessions: Session[],
  ): string {
    const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'assets', 'logo.png'));
    const nonce   = crypto.randomBytes(16).toString('hex');

    const claudeMonth = metrics?.currentMonthByProvider?.claudeCode;
    const claudeToday = metrics?.todayByProvider?.claudeCode;

    const fmt = (n: number) => {
      if (n >= 1_000_000) { return (n / 1_000_000).toFixed(2) + 'M'; }
      if (n >= 1_000)     { return (n / 1_000).toFixed(1) + 'K'; }
      return n.toLocaleString();
    };
    const fmtCost = (n: number) => `$${n.toFixed(n < 0.01 ? 6 : 4)}`;

    // ── Usage windows ──────────────────────────────────────────────────────
    const winCfg = context.globalState.get<WindowConfig>(WINDOW_CONFIG_KEY, DEFAULT_WINDOW_CONFIG);
    const win5h  = calcWindow(sessions, 5 * 60 * 60 * 1000);
    const win7d  = calcWindow(sessions, 7 * 24 * 60 * 60 * 1000);
    const weeklyResetsAt   = nextWeeklyReset(winCfg.weeklyResetDay, winCfg.weeklyResetHour);
    const sessionResetLabel = buildSessionResetLabel(winCfg.sessionResetTime, win5h);
    const weeklyResetLabel  = weeklyResetsAt.toLocaleDateString('default', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const sessionCardLabel  = winCfg.sessionResetTime ? 'Current session' : 'Session window (last 5 h)';
    const sessionIsManual   = !!winCfg.sessionResetTime;
    const sessionResetPassed = sessionIsManual && sessionResetLabel === 'passed — update ⚙';

    // Billing period info (calendar month)
    const now      = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const daysTotal  = monthEnd.getDate();
    const daysDone   = now.getDate() - 1;
    const daysLeft   = daysTotal - now.getDate() + 1;
    const monthPct   = Math.round((daysDone / daysTotal) * 100);
    const monthLabel = now.toLocaleString('default', { month: 'long', year: 'numeric' });
    const resetLabel = monthEnd.toLocaleDateString('default', { month: 'short', day: 'numeric' });
    const startLabel = monthStart.toLocaleDateString('default', { month: 'short', day: 'numeric' });

    const planColor = PLAN_COLOR[plan];
    const planLabel = PLAN_LABELS[plan];
    // Plan selector chips
    const planChips = (Object.keys(PLAN_LABELS) as ClaudePlan[]).map(p =>
      `<button class="plan-chip${plan === p ? ' active' : ''}" data-plan="${p}" style="${plan === p ? `border-color:${PLAN_COLOR[p]};color:${PLAN_COLOR[p]};background:${PLAN_COLOR[p]}18;` : ''}"
        >${PLAN_LABELS[p]}</button>`
    ).join('');

    // Model breakdown rows
    const modelRows = buildModelRows(claudeMonth?.modelUsage, fmt);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Claude</title>
  <style nonce="${nonce}">
    ${navCss()}
    ${designTokensCss()}
    /* Claude brand accent — deliberate override of the shared --primary */
    :root { --primary: #e8621a; --primary-hover: #c95210; --primary-glow: rgba(232,98,26,.2); }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: var(--font-primary); background: var(--bg-base); color: var(--text-primary); min-height: 100vh; display: flex; flex-direction: column; font-size: 13px; }

    /* sections */
    .section { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 16px; }
    .section-hd { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
    .section-title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
    .section-badge { font-size: 10px; font-weight: 600; letter-spacing: 0.8px; text-transform: uppercase; border-radius: 4px; padding: 2px 7px; background: rgba(57,255,20,0.1); color: var(--stage-4); }
    .section-badge.dim { background: rgba(255,255,255,0.05); color: var(--text-secondary); }

    /* plan chips */
    .plan-chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .plan-chip { background: transparent; border: 1px solid var(--border); border-radius: 20px; padding: 5px 14px; font-size: 12px; font-weight: 500; font-family: var(--font-primary); color: var(--text-secondary); cursor: pointer; transition: all 0.15s; white-space: nowrap; }
    .plan-chip:hover { border-color: rgba(255,255,255,0.2); color: var(--text-primary); }
    .plan-chip.active { font-weight: 600; }

    /* billing period */
    .billing-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
    .billing-month { font-size: 14px; font-weight: 600; color: var(--text-primary); }
    .billing-meta { font-size: 11.5px; color: var(--text-secondary); }
    .billing-bar-wrap { height: 6px; background: var(--bg-surface-high); border-radius: 3px; overflow: hidden; margin-bottom: 8px; }
    .billing-bar { height: 100%; border-radius: 3px; background: var(--primary); }
    .billing-footer { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-secondary); }

    /* stat cards */
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(155px, 1fr)); gap: 12px; }
    .stat-card { background: var(--bg-surface-high); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
    .stat-label { font-size: 10.5px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.7px; font-weight: 600; margin-bottom: 6px; }
    .stat-value { font-family: var(--font-data); font-size: 20px; font-weight: 600; color: var(--text-primary); margin-bottom: 2px; }
    .stat-sub { font-size: 11.5px; color: var(--text-secondary); }

    /* table */
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 8px 12px; background: var(--bg-surface-high); color: var(--text-secondary); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.6px; font-weight: 600; border-bottom: 1px solid var(--border); }
    td { padding: 9px 12px; border-bottom: 1px solid var(--border); font-size: 12.5px; color: var(--text-primary); }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255,255,255,0.02); }
    .data-text { font-family: var(--font-data); font-size: 12px; }

    /* usage window cards */
    .win-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    @media (max-width: 520px) { .win-grid { grid-template-columns: 1fr; } }
    .win-card { background: var(--bg-surface-high); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; }
    .win-label { font-size: 10.5px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.7px; font-weight: 600; }
    .win-tokens { font-family: var(--font-data); font-size: 22px; font-weight: 600; color: var(--text-primary); }
    .win-sub { font-size: 11.5px; color: var(--text-secondary); }
    .win-reset { display: inline-flex; align-items: center; gap: 5px; margin-top: 4px; font-size: 11px; font-weight: 600; color: var(--primary); background: rgba(232,98,26,0.1); border-radius: 4px; padding: 2px 8px; align-self: flex-start; }
    .win-reset.ok { color: var(--stage-4); background: rgba(57,255,20,0.08); }
    .win-footer { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-top: 12px; }
    .win-note { font-size: 11px; color: var(--text-secondary); line-height: 1.5; flex: 1; }
    .cfg-toggle { background: transparent; border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-size: 11.5px; color: var(--text-secondary); font-family: var(--font-primary); cursor: pointer; white-space: nowrap; flex-shrink: 0; transition: all 0.15s; }
    .cfg-toggle:hover { border-color: rgba(255,255,255,0.18); color: var(--text-primary); }
    .cfg-gear-btn { background: transparent; border: 1px solid var(--border); border-radius: 5px; padding: 2px 7px; font-size: 14px; line-height: 1.4; color: var(--text-secondary); cursor: pointer; margin-left: auto; transition: all 0.15s; flex-shrink: 0; }
    .cfg-gear-btn:hover { border-color: rgba(255,255,255,0.25); color: var(--text-primary); }
    .cfg-time { width: 110px; }
    .cfg-form { background: var(--bg-base); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-top: 14px; display: flex; flex-direction: column; gap: 14px; }
    .cfg-form.is-hidden { display: none; }
    .cfg-row { display: flex; flex-direction: column; gap: 5px; }
    .cfg-row-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .cfg-label { font-size: 12px; font-weight: 600; color: var(--text-primary); white-space: nowrap; }
    .cfg-ctrl { display: flex; align-items: center; gap: 6px; }
    .cfg-input { background: var(--bg-surface-high); border: 1px solid var(--border); border-radius: 5px; padding: 5px 8px; color: var(--text-primary); font-family: var(--font-data); font-size: 12.5px; width: 64px; outline: none; transition: border-color 0.15s; -moz-appearance: textfield; }
    .cfg-input:focus { border-color: var(--primary); }
    .cfg-input::-webkit-inner-spin-button, .cfg-input::-webkit-outer-spin-button { -webkit-appearance: none; }
    .cfg-select { background: var(--bg-surface-high); border: 1px solid var(--border); border-radius: 5px; padding: 5px 8px; color: var(--text-primary); font-family: var(--font-primary); font-size: 12.5px; outline: none; cursor: pointer; }
    .cfg-unit { font-size: 11.5px; color: var(--text-secondary); }
    .cfg-hint { font-size: 11px; color: var(--text-secondary); line-height: 1.5; }
    .cfg-hint strong { color: var(--text-primary); }
    .btn-cfg-save { background: var(--primary); border: none; border-radius: 6px; padding: 7px 18px; color: #fff; font-size: 12.5px; font-weight: 600; font-family: var(--font-primary); cursor: pointer; align-self: flex-start; transition: opacity 0.15s; }
    .btn-cfg-save:hover { opacity: 0.85; }

  </style>
</head>
<body>
  ${navTopbarHtml(logoUri.toString(), true)}
  ${navPagebarHtml('claudeAccount', 'Claude')}

  <div class="ns-content">

    <!-- Plan selector -->
    <div class="section">
      <div class="section-hd">
        <span class="section-title">Plan</span>
        <span class="section-badge" style="background:${planColor}18;color:${planColor};">${planLabel}</span>
      </div>
      <div class="plan-chips">${planChips}</div>
    </div>

    <!-- Billing period -->
    <div class="section">
      <div class="section-hd">
        <span class="section-title">Billing Period</span>
      </div>
      <div class="billing-row">
        <span class="billing-month">${monthLabel}</span>
        <span class="billing-meta">${daysLeft} day${daysLeft !== 1 ? 's' : ''} remaining</span>
      </div>
      <div class="billing-bar-wrap">
        <div class="billing-bar" style="width:${monthPct}%;background:${planColor};"></div>
      </div>
      <div class="billing-footer">
        <span>Started ${startLabel}</span>
        <span>Resets ${resetLabel}</span>
      </div>
    </div>

    <!-- Usage windows -->
    <div class="section">
      <div class="section-hd">
        <span class="section-title">Usage Limits</span>
        <span class="section-badge dim">session files</span>
        <button class="cfg-gear-btn" id="cfgToggleBtn" title="Configure reset times">&#9881;</button>
      </div>

      <!-- Configure form — hidden until gear is clicked -->
      <div id="cfgForm" class="cfg-form is-hidden">
        <div class="cfg-row">
          <div class="cfg-row-top">
            <label class="cfg-label" for="cfgSessionReset">Session resets at</label>
            <div class="cfg-ctrl">
              <input type="text" id="cfgSessionReset" class="cfg-input cfg-time" placeholder="HH:MM" maxlength="5" value="${winCfg.sessionResetTime}" spellcheck="false" autocomplete="off">
            </div>
          </div>
          <p class="cfg-hint">24-hour time shown on <strong>claude.ai &rarr; Limits</strong> next to "Current session". E.g. "Resets in 34 min" + it&apos;s 3:11&nbsp;PM &rarr; enter <strong>15:45</strong>.</p>
        </div>
        <div class="cfg-row">
          <div class="cfg-row-top">
            <label class="cfg-label" for="cfgWeekHour">Weekly reset</label>
            <div class="cfg-ctrl">
              <select id="cfgWeekDay" class="cfg-select">
                ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d, i) =>
                  `<option value="${i}"${i === winCfg.weeklyResetDay ? ' selected' : ''}>${d}</option>`
                ).join('')}
              </select>
              <input type="number" id="cfgWeekHour" class="cfg-input" min="0" max="23" value="${winCfg.weeklyResetHour}">
              <span class="cfg-unit">:00</span>
            </div>
          </div>
          <p class="cfg-hint">Day and hour from <strong>claude.ai &rarr; Settings &rarr; Limits</strong> (e.g. "Resets Fri 11:00 AM")</p>
        </div>
        <button class="btn-cfg-save" id="btnCfgSave">Save</button>
      </div>

      <div class="win-grid">
        <div class="win-card" id="winCardSession">
          <div class="win-label" id="winSessionLabel">${sessionCardLabel}</div>
          <div class="win-tokens" id="winSessionTokens">${fmt(win5h.tokens)}</div>
          <div class="win-sub" id="winSessionSub">${fmt(win5h.outputTokens)} output &middot; ${win5h.interactions} prompt${win5h.interactions !== 1 ? 's' : ''}</div>
          <div class="win-reset${sessionIsManual && !sessionResetPassed ? ' ok' : ''}" id="winSessionReset">&#9679; ${win5h.interactions === 0 && !sessionIsManual ? 'no activity' : 'Resets ' + sessionResetLabel}</div>
        </div>
        <div class="win-card" id="winCardWeekly">
          <div class="win-label">Weekly window &mdash; last 7 d</div>
          <div class="win-tokens" id="winWeeklyTokens">${fmt(win7d.tokens)}</div>
          <div class="win-sub" id="winWeeklySub">${fmt(win7d.outputTokens)} output &middot; ${win7d.interactions} prompt${win7d.interactions !== 1 ? 's' : ''}</div>
          <div class="win-reset" id="winWeeklyReset">&#9679; Resets ${weeklyResetLabel}</div>
        </div>
      </div>

      <p class="win-note">&#9432;&nbsp; Limits are not publicly documented — these show local Claude Code token usage, not a % of your quota.${sessionIsManual ? '' : ' Session reset is auto-estimated from local interactions.'}</p>
    </div>

    <!-- Usage stats -->
    <div class="section">
      <div class="section-hd">
        <span class="section-title">Usage &mdash; Claude Code</span>
        <span class="section-badge dim">local session files</span>
      </div>
      <div class="stat-grid">
        ${statCard('Today', fmt(claudeToday?.totalTokens ?? 0) + ' tokens', fmtCost(claudeToday?.estimatedCost ?? 0))}
        ${statCard('This Month', fmt(claudeMonth?.totalTokens ?? 0) + ' tokens', fmtCost(claudeMonth?.estimatedCost ?? 0))}
        ${statCard('Cache Hit Rate', Math.round((metrics?.cache?.cacheHitRate ?? 0) * 100) + '%', fmtCost(claudeMonth?.cacheSavingsUsd ?? 0) + ' saved')}
        ${statCard('Sessions (Month)', (claudeMonth?.sessions ?? 0).toLocaleString(), (claudeMonth?.interactions ?? 0).toLocaleString() + ' prompts')}
      </div>
    </div>

    <!-- Token breakdown -->
    ${claudeMonth && (claudeMonth.inputTokens + claudeMonth.outputTokens) > 0 ? `
    <div class="section">
      <div class="section-hd">
        <span class="section-title">Token Breakdown &mdash; This Month</span>
      </div>
      <div class="stat-grid">
        ${statCard('Input', fmt(claudeMonth.inputTokens), 'uncached input')}
        ${statCard('Output', fmt(claudeMonth.outputTokens), '')}
        ${statCard('Cache Read', fmt(claudeMonth.cacheReadTokens), 'served from cache')}
        ${statCard('Cache Write', fmt(claudeMonth.cacheWriteTokens), 'written to cache')}
        ${claudeMonth.thinkingTokens > 0 ? statCard('Thinking', fmt(claudeMonth.thinkingTokens), 'extended thinking') : ''}
      </div>
    </div>` : ''}

    <!-- Model breakdown -->
    ${modelRows ? `
    <div class="section">
      <div class="section-hd">
        <span class="section-title">Model Breakdown &mdash; This Month</span>
      </div>
      <table>
        <thead><tr>
          <th>Model</th>
          <th style="text-align:right;">Total</th>
          <th style="text-align:right;">Input</th>
          <th style="text-align:right;">Output</th>
          <th style="text-align:right;">Cost</th>
        </tr></thead>
        <tbody>${modelRows}</tbody>
      </table>
    </div>` : ''}

  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    window.vscode = vscode;

    function selectPlan(plan) {
      vscode.postMessage({ command: 'setPlan', plan });
    }

    function fmtN(n) {
      if (n >= 1e6) { return (n / 1e6).toFixed(2) + 'M'; }
      if (n >= 1e3) { return (n / 1e3).toFixed(1) + 'K'; }
      return n.toLocaleString();
    }

    function toggleCfg() {
      const form = document.getElementById('cfgForm');
      const btn  = document.getElementById('cfgToggleBtn');
      if (!form) { return; }
      const willOpen = form.classList.contains('is-hidden');
      form.classList.toggle('is-hidden', !willOpen);
      if (btn) { btn.textContent = willOpen ? '✕ Close' : '⚙ Configure'; }
    }

    function saveCfg() {
      const resetEl = document.getElementById('cfgSessionReset');
      const dayEl   = document.getElementById('cfgWeekDay');
      const hourEl  = document.getElementById('cfgWeekHour');
      const btn     = document.getElementById('btnCfgSave');
      if (!resetEl || !dayEl || !hourEl) { return; }
      vscode.postMessage({
        command: 'saveWindowConfig',
        sessionResetTime: resetEl.value,
        weeklyResetDay:   parseInt(dayEl.value, 10),
        weeklyResetHour:  parseInt(hourEl.value, 10),
      });
      if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }
    }

    document.querySelectorAll('[data-plan]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        selectPlan(btn.getAttribute('data-plan'));
      });
    });

    var cfgToggleBtn = document.getElementById('cfgToggleBtn');
    if (cfgToggleBtn) {
      cfgToggleBtn.addEventListener('click', toggleCfg);
    }

    var cfgSaveBtn = document.getElementById('btnCfgSave');
    if (cfgSaveBtn) {
      cfgSaveBtn.addEventListener('click', saveCfg);
    }

    function applyWindowUpdate(msg) {
      const s = msg.session;
      const w = msg.weekly;
      const c = msg.config;

      // Session card
      var sl = document.getElementById('winSessionLabel');
      var st = document.getElementById('winSessionTokens');
      var ss = document.getElementById('winSessionSub');
      var sr = document.getElementById('winSessionReset');
      if (sl) { sl.textContent = c.sessionResetTime ? 'Current session' : 'Session window (last 5 h)'; }
      if (st) { st.textContent = fmtN(s.tokens); }
      if (ss) { ss.textContent = fmtN(s.outputTokens) + ' output · ' + s.interactions + ' prompt' + (s.interactions !== 1 ? 's' : ''); }
      if (sr) {
        const passed = s.resetLabel === 'passed — update ⚙';
        sr.textContent = '● ' + (s.interactions === 0 && !c.sessionResetTime ? 'no activity' : 'Resets ' + s.resetLabel);
        sr.className = 'win-reset' + (c.sessionResetTime && !passed ? ' ok' : '');
      }

      // Weekly card
      var wt = document.getElementById('winWeeklyTokens');
      var ws = document.getElementById('winWeeklySub');
      var wr = document.getElementById('winWeeklyReset');
      if (wt) { wt.textContent = fmtN(w.tokens); }
      if (ws) { ws.textContent = fmtN(w.outputTokens) + ' output · ' + w.interactions + ' prompt' + (w.interactions !== 1 ? 's' : ''); }
      if (wr) { wr.textContent = '● Resets ' + w.resetLabel; }

      // Save button feedback
      var btn = document.getElementById('btnCfgSave');
      if (btn) {
        btn.textContent = 'Saved ✓';
        btn.style.background = '#39FF14';
        btn.style.color = '#0f1218';
        setTimeout(function() {
          btn.textContent = 'Save';
          btn.style.background = '';
          btn.style.color = '';
          btn.disabled = false;
        }, 2000);
      }
    }

    window.addEventListener('message', function(ev) {
      if (ev.data.type === 'windowConfigSaved') { applyWindowUpdate(ev.data); }
    });

    ${navJs()}
  </script>
</body>
</html>`;
  }
}

// ─── template helpers ───────────────────────────────────────────────────────

function statCard(label: string, value: string, sub: string): string {
  return `<div class="stat-card">
    <div class="stat-label">${label}</div>
    <div class="stat-value">${value}</div>
    ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
  </div>`;
}

function connectedApiSection(maskedKey: string): string {
  return `<div class="connected-key-row">
    <div class="connected-key-info">
      <div class="connected-key-dot"></div>
      <span class="connected-key-text">${maskedKey}</span>
    </div>
    <button class="btn-disconnect" onclick="handleDisconnect()">Disconnect</button>
  </div>
  <div class="rl-grid" id="rlCards">
    ${['', '', ''].map(() =>
      `<div class="rl-card rl-skeleton"><div class="rl-skel-bar"></div><div class="rl-skel-bar short"></div></div>`
    ).join('')}
  </div>`;
}

function disconnectedApiSection(): string {
  return `<p class="api-note">Enter your Anthropic API key to see live rate limits. Your key is stored in VS&nbsp;Code's secure secret storage and never leaves your machine.<br>
    If you have a <strong>Claude Pro or Max subscription</strong> you don't need this — your usage is already tracked above from local Claude Code session files.</p>
  <div class="api-connect-form">
    <input type="password" id="apiKeyInput" class="api-key-input"
      placeholder="sk-ant-api03-…" autocomplete="off" spellcheck="false"
      onkeydown="if(event.key==='Enter') handleConnect()">
    <button id="btnConnect" class="btn-connect" onclick="handleConnect()">Connect API Key</button>
    <div id="connectError" class="connect-error" style="display:none;"></div>
  </div>`;
}

function collapsedApiSection(): string {
  return `<p class="api-note" style="margin:0;">Enter your Anthropic API key to see live rate limits.<br>
    <strong style="color:var(--text-primary);">Claude Pro / Max subscribers don't need this</strong> — usage is tracked above from local session files.</p>
  <div class="api-connect-form" style="margin-top:12px;">
    <input type="password" id="apiKeyInput" class="api-key-input"
      placeholder="sk-ant-api03-…" autocomplete="off" spellcheck="false"
      onkeydown="if(event.key==='Enter') handleConnect()">
    <button id="btnConnect" class="btn-connect" onclick="handleConnect()">Connect API Key</button>
    <div id="connectError" class="connect-error" style="display:none;"></div>
  </div>`;
}

function buildModelRows(
  modelUsage: Record<string, import('../types').ModelUsageMetrics> | undefined,
  fmt: (n: number) => string,
): string {
  if (!modelUsage || Object.keys(modelUsage).length === 0) { return ''; }
  return Object.entries(modelUsage)
    .filter(([model, m]) => model.trim() !== '' && m.totalTokens > 0)
    .sort(([, a], [, b]) => b.totalTokens - a.totalTokens)
    .map(([model, m]) =>
      `<tr>
        <td>${model}</td>
        <td class="data-text" style="text-align:right;">${fmt(m.totalTokens)}</td>
        <td class="data-text" style="text-align:right;">${fmt(m.inputTokens)}</td>
        <td class="data-text" style="text-align:right;">${fmt(m.outputTokens)}</td>
        <td class="data-text" style="text-align:right;">$${m.totalCost.toFixed(4)}</td>
      </tr>`
    ).join('');
}
