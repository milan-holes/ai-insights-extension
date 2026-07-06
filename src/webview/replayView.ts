import * as vscode from 'vscode';
import { Session } from '../types';
import { calculateCost } from '../core/costEstimation';
import { navCss, navTopbarHtml, navJs, NAV_COMMANDS } from './navShared';
import { designTokensCss, baseResetCss } from './designSystem';
import { providerIcon } from './providerIcons';

interface ReplayTurn {
  idx: number;
  ts: string;
  model: string;
  mode: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheTokensEstimated: boolean;
  totalTokens: number;
  effectiveContextTokens: number;
  toolCalls: string[];
  commandRuns: string[];
  fileAccesses: Array<{ tool: string; path: string }>;
  promptPreview: string;
  isCompactionEvent: boolean;
  compactionTrigger: string;
  preCompactionTokens: number;
  postCompactionTokens: number;
  costUsd: number;
  webSearchRequests: number;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmt(n: number): string {
  return n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M'
    : n >= 1_000 ? (n / 1_000).toFixed(1) + 'K'
    : n.toString();
}

function fmtCost(n: number): string {
  if (n === 0) { return '$0.0000'; }
  if (n < 0.001) { return `$${n.toFixed(5)}`; }
  return `$${n.toFixed(4)}`;
}

function fmtDuration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  if (h > 0) { return `${h}h ${m % 60}m`; }
  return `${m}m`;
}

export class ReplayViewProvider {
  static readonly viewType = 'aiInsights.replay';
  private static currentPanel: vscode.WebviewPanel | undefined;

  static createPanel(context: vscode.ExtensionContext, session: Session): vscode.WebviewPanel {
    const logoPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'logo.png');

    if (ReplayViewProvider.currentPanel) {
      ReplayViewProvider.currentPanel.reveal(vscode.ViewColumn.One);
      const logoUri = ReplayViewProvider.currentPanel.webview.asWebviewUri(logoPath).toString();
      ReplayViewProvider.currentPanel.title = `Replay · ${session.title || session.id.slice(0, 12)}`;
      ReplayViewProvider.currentPanel.webview.html = ReplayViewProvider.buildHtml(session, logoUri);
      return ReplayViewProvider.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      ReplayViewProvider.viewType,
      `Replay · ${session.title || session.id.slice(0, 12)}`,
      vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')] },
    );

    const logoUri = panel.webview.asWebviewUri(logoPath).toString();
    panel.webview.html = ReplayViewProvider.buildHtml(session, logoUri);

    panel.webview.onDidReceiveMessage((msg) => {
      const navCmd = NAV_COMMANDS[msg.command];
      if (navCmd) { vscode.commands.executeCommand(navCmd); }
    }, undefined, context.subscriptions);

    panel.onDidDispose(() => {
      ReplayViewProvider.currentPanel = undefined;
    }, null, context.subscriptions);

    ReplayViewProvider.currentPanel = panel;
    return panel;
  }

  static buildHtml(session: Session, logoUri: string): string {
    const turns: ReplayTurn[] = session.interactions.map((i, idx) => ({
      idx,
      ts: i.timestamp instanceof Date ? i.timestamp.toISOString() : String(i.timestamp),
      model: i.model || '',
      mode: i.mode || '',
      inputTokens: i.inputTokens,
      outputTokens: i.outputTokens,
      thinkingTokens: i.thinkingTokens,
      cacheReadTokens: i.cacheReadTokens,
      cacheWriteTokens: i.cacheWriteTokens,
      cacheTokensEstimated: i.cacheTokensEstimated || false,
      totalTokens: i.totalTokens,
      effectiveContextTokens: i.effectiveContextTokens,
      toolCalls: i.toolCalls || [],
      commandRuns: i.commandRuns || [],
      fileAccesses: (i.fileAccesses || []).slice(0, 30).map(f => ({ tool: f.tool, path: f.path })),
      promptPreview: i.promptPreview || '',
      isCompactionEvent: !!i.isCompactionEvent,
      compactionTrigger: i.compactionTrigger || '',
      preCompactionTokens: i.preCompactionTokens || 0,
      postCompactionTokens: i.postCompactionTokens || 0,
      costUsd: calculateCost(i.model, i.inputTokens, i.outputTokens, i.cacheReadTokens, i.cacheWriteTokens),
      webSearchRequests: i.webSearchRequests || 0,
    }));

    const maxCtx = session.peakEffectiveContextTokens || Math.max(...turns.map(t => t.effectiveContextTokens), 1);
    const totalCost = session.estimatedCostUsd ?? turns.reduce((s, t) => s + t.costUsd, 0);
    const durationMs = session.endTime.getTime() - session.startTime.getTime();
    const provIcon = providerIcon(session.provider);
    const sessionDate = session.startTime.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const sessionTitle = session.title || `Session ${session.id.slice(0, 8)}`;

    const timelineBlocks = turns.map((t, i) =>
      `<div class="tblock ${t.isCompactionEvent ? 'tc-compact' : 'tc-normal'} tb-future" data-turn="${i}"></div>`,
    ).join('');

    // Safely embed JSON inside <script> — escape </ to avoid early script close
    const turnsJson = JSON.stringify(turns).replace(/<\//g, '<\\/');

    const startTime = session.startTime.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const endTime = session.endTime.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const compactionCount = turns.filter(t => t.isCompactionEvent).length;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Replay</title>
<style>
${designTokensCss()}
${baseResetCss()}
${navCss()}
.replay-header{padding:14px 32px 0;display:flex;align-items:center;gap:14px;}
.back-btn{background:transparent;border:1px solid var(--border);border-radius:7px;padding:5px 12px;color:var(--text-secondary);cursor:pointer;font-size:12px;font-family:var(--font-primary);transition:all .15s;}
.back-btn:hover{border-color:rgba(255,255,255,.18);color:var(--text-primary);}
.rh-title{font-size:15px;font-weight:600;color:var(--text-primary);line-height:1.3;}
.rh-sub{font-size:12px;color:var(--text-secondary);margin-top:3px;display:flex;align-items:center;gap:7px;flex-wrap:wrap;}
.prov-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;background:var(--bg-surface);border:1px solid var(--border);border-radius:6px;padding:2px 8px;color:var(--text-secondary);}
.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:20px;}
.sc{background:var(--bg-surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px;}
.sc-lbl{font-size:10px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:var(--text-secondary);margin-bottom:6px;}
.sc-val{font-size:20px;font-weight:700;font-family:var(--font-data);color:var(--text-primary);line-height:1.2;}
.sc-sub{font-size:10.5px;color:var(--text-secondary);margin-top:4px;}
.replay-panel{background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:18px 20px;margin-bottom:14px;}
.transport-row{display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap;}
.tbtn{background:var(--bg-surface-high);border:1px solid var(--border);border-radius:8px;width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:var(--text-secondary);font-size:14px;transition:all .15s;flex-shrink:0;user-select:none;font-family:var(--font-primary);}
.tbtn:hover:not([disabled]){border-color:rgba(255,255,255,.2);color:var(--text-primary);}
.tbtn[disabled]{opacity:.3;cursor:not-allowed;}
.tbtn-play{background:var(--primary)!important;border-color:var(--primary)!important;color:#fff!important;width:42px!important;height:42px!important;font-size:18px!important;}
.tbtn-play:hover:not([disabled]){background:#005ecc!important;}
.speed-wrap{position:relative;display:inline-flex;align-items:center;}
.speed-wrap::after{content:'▾';position:absolute;right:8px;color:var(--text-secondary);pointer-events:none;font-size:10px;}
.speed-sel{background:var(--bg-surface-high);border:1px solid var(--border);border-radius:8px;padding:0 28px 0 10px;height:34px;color:var(--text-primary);font-family:var(--font-data);font-size:12px;cursor:pointer;outline:none;-webkit-appearance:none;appearance:none;}
.turn-ctr{font-family:var(--font-data);font-size:13px;color:var(--text-secondary);padding-left:6px;white-space:nowrap;}
.turn-ts{font-family:var(--font-data);font-size:11px;color:var(--text-secondary);margin-left:2px;}
.tl-label-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;}
.tl-label{font-size:10px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:var(--text-secondary);}
.tl-legend{display:flex;align-items:center;gap:10px;font-size:10px;color:var(--text-secondary);}
.tl-legend-item{display:flex;align-items:center;gap:4px;}
.tl-swatch{width:10px;height:10px;border-radius:2px;flex-shrink:0;}
.tl-strip{position:relative;display:flex;gap:2px;height:26px;background:var(--bg-base);border:1px solid var(--border);border-radius:7px;padding:3px 5px;overflow:hidden;cursor:pointer;user-select:none;margin-bottom:14px;}
.tblock{border-radius:3px;height:100%;transition:opacity .1s,box-shadow .1s;cursor:pointer;flex:1;min-width:3px;}
.tc-normal{background:var(--primary);}
.tc-compact{background:var(--stage-2);}
.tb-past{opacity:.3;}
.tb-current{opacity:1!important;box-shadow:0 0 0 1.5px #fff,0 0 7px var(--stage-4);z-index:2;}
.tb-future{opacity:.1;}
.tl-cursor{position:absolute;top:2px;bottom:2px;width:2px;background:var(--stage-4);border-radius:1px;pointer-events:none;box-shadow:0 0 6px var(--stage-4);transition:left .25s ease;}
.ctx-sec{margin-bottom:14px;}
.ctx-lbl-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;}
.ctx-lbl{font-size:10px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:var(--text-secondary);}
.ctx-toks{font-family:var(--font-data);font-size:11.5px;color:var(--text-secondary);}
.ctx-track{height:16px;background:var(--bg-base);border:1px solid var(--border);border-radius:8px;overflow:hidden;}
.ctx-fill{height:100%;border-radius:8px;transition:width .35s ease,background .35s ease;min-width:0;}
.cum-row{display:flex;gap:24px;flex-wrap:wrap;}
.cum-m{display:flex;flex-direction:column;gap:2px;}
.cum-lbl{font-size:10px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:var(--text-secondary);}
.cum-val{font-family:var(--font-data);font-size:14px;font-weight:600;color:var(--text-primary);}
.detail-grid{display:grid;grid-template-columns:260px 1fr;gap:12px;margin-top:14px;}
.dc{background:var(--bg-surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;}
.dc-hdr{font-size:10px;font-weight:700;letter-spacing:.9px;text-transform:uppercase;color:var(--text-secondary);margin-bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;}
.tok-r{display:flex;align-items:center;justify-content:space-between;padding:4.5px 0;border-bottom:1px solid rgba(255,255,255,.04);}
.tok-r:last-of-type{border-bottom:none;}
.tok-lbl{font-size:12px;color:var(--text-secondary);display:flex;align-items:center;gap:5px;}
.tok-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;}
.tok-val{font-family:var(--font-data);font-size:12.5px;color:var(--text-primary);}
.tok-bar-row{display:flex;height:6px;border-radius:3px;overflow:hidden;gap:1px;margin:10px 0;}
.tok-seg{border-radius:2px;transition:flex .35s ease;min-width:1px;}
.cost-row{border-top:1px solid rgba(255,255,255,.08);margin-top:8px;padding-top:8px;display:flex;justify-content:space-between;align-items:center;}
.cost-lbl{font-size:12px;color:var(--text-secondary);font-weight:600;}
.cost-val{font-family:var(--font-data);font-size:14px;color:var(--stage-4);font-weight:700;}
.act-r{display:flex;align-items:flex-start;gap:7px;padding:4.5px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:12px;}
.act-r:last-child{border-bottom:none;}
.act-ico{flex-shrink:0;width:18px;text-align:center;color:var(--text-secondary);margin-top:1px;}
.act-lbl{color:var(--text-secondary);white-space:nowrap;flex-shrink:0;min-width:56px;}
.act-val{font-family:var(--font-data);font-size:11px;color:var(--text-primary);word-break:break-all;}
.act-none{color:var(--text-secondary);font-style:italic;font-size:12px;padding:6px 0;}
.model-tag{display:inline-block;background:var(--bg-surface-high);border:1px solid var(--border);border-radius:6px;padding:2px 8px;font-family:var(--font-data);font-size:10.5px;color:var(--text-secondary);}
.compact-tag{display:inline-block;background:rgba(250,179,135,.12);border:1px solid rgba(250,179,135,.3);border-radius:6px;padding:2px 8px;font-size:10.5px;color:var(--stage-2);}
.compact-banner{background:rgba(250,179,135,.07);border:1px solid rgba(250,179,135,.25);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px;color:var(--stage-2);font-size:12.5px;margin-top:10px;}
.prompt-sec{margin-top:10px;}
.prompt-preview{background:var(--bg-surface-high);border-radius:8px;border:1px solid var(--border);padding:10px 13px;font-size:12px;color:var(--text-secondary);line-height:1.6;font-style:italic;}
.kbd-hint{font-size:10px;color:var(--text-secondary);margin-left:auto;opacity:.6;}
.empty-state{text-align:center;padding:60px 24px;color:var(--text-secondary);font-size:14px;}
@media(max-width:640px){.detail-grid{grid-template-columns:1fr;}}
</style>
</head>
<body>
${navTopbarHtml(logoUri, false)}
<div class="replay-header">
  <button class="back-btn" data-nav="showSessions" data-label="Loading sessions…">← Sessions</button>
  <div>
    <div class="rh-title">${esc(sessionTitle)}</div>
    <div class="rh-sub">
      ${esc(sessionDate)}
      <span class="prov-badge">${provIcon} ${esc(session.providerName)}</span>
      ${session.workspace ? `<span style="opacity:.6;font-size:10.5px;">${esc(session.workspace.replace(/\\/g, '/').split('/').pop() || session.workspace)}</span>` : ''}
    </div>
  </div>
</div>
<div class="ns-content" style="padding-top:16px;">

${turns.length === 0 ? `<div class="empty-state">No interactions recorded for this session.</div>` : `
<div class="summary-grid">
  <div class="sc">
    <div class="sc-lbl">Turns</div>
    <div class="sc-val">${turns.length}</div>
    <div class="sc-sub">${compactionCount > 0 ? `+${compactionCount} compaction` : 'interactions'}</div>
  </div>
  <div class="sc">
    <div class="sc-lbl">Duration</div>
    <div class="sc-val">${fmtDuration(durationMs)}</div>
    <div class="sc-sub">${startTime} – ${endTime}</div>
  </div>
  <div class="sc" style="border-top:2px solid var(--stage-4);">
    <div class="sc-lbl">Total Cost</div>
    <div class="sc-val" style="color:var(--stage-4)">${fmtCost(totalCost)}</div>
    <div class="sc-sub">estimated</div>
  </div>
  <div class="sc">
    <div class="sc-lbl">Peak Context</div>
    <div class="sc-val">${fmt(maxCtx)}</div>
    <div class="sc-sub">tokens</div>
  </div>
  <div class="sc">
    <div class="sc-lbl">Total Tokens</div>
    <div class="sc-val">${fmt(session.totalTokens)}</div>
    <div class="sc-sub">all turns</div>
  </div>
  <div class="sc">
    <div class="sc-lbl">Models</div>
    <div class="sc-val" style="font-size:${session.models.length > 1 ? '12' : '14'}px;">${session.models.slice(0, 2).map(m => esc(m.replace(/^claude-/, '').substring(0, 20))).join(', ') || '—'}</div>
    <div class="sc-sub">${session.models.length} model${session.models.length !== 1 ? 's' : ''}</div>
  </div>
</div>

<div class="replay-panel">
  <div class="transport-row">
    <button class="tbtn" id="btn-start" title="Go to start [Home]" onclick="goTo(0)">⏮</button>
    <button class="tbtn" id="btn-back" title="Previous [←]" onclick="stepBack()">⏪</button>
    <button class="tbtn tbtn-play" id="btn-play" title="Play / Pause [Space]" onclick="togglePlay()">▶</button>
    <button class="tbtn" id="btn-fwd" title="Next [→]" onclick="stepFwd()">⏩</button>
    <button class="tbtn" id="btn-end" title="Go to end [End]" onclick="goTo(TURNS.length-1)">⏭</button>
    <div class="speed-wrap">
      <select class="speed-sel" id="speed-sel" title="Playback speed (turns/sec)">
        <option value="0.5">0.5×</option>
        <option value="1" selected>1×</option>
        <option value="2">2×</option>
        <option value="5">5×</option>
        <option value="10">10×</option>
      </select>
    </div>
    <span class="turn-ctr" id="turn-ctr">Turn 1 / ${turns.length}</span>
    <span class="turn-ts" id="turn-ts"></span>
    <span class="kbd-hint">← → Space</span>
  </div>

  <div class="tl-label-row">
    <span class="tl-label">Timeline</span>
    <span class="tl-legend">
      <span class="tl-legend-item"><span class="tl-swatch" style="background:var(--primary)"></span>turn</span>
      ${compactionCount > 0 ? `<span class="tl-legend-item"><span class="tl-swatch" style="background:var(--stage-2)"></span>compaction</span>` : ''}
    </span>
  </div>
  <div class="tl-strip" id="tl-strip">
    ${timelineBlocks}
    <div class="tl-cursor" id="tl-cursor"></div>
  </div>

  <div class="ctx-sec">
    <div class="ctx-lbl-row">
      <span class="ctx-lbl">Context Window</span>
      <span class="ctx-toks" id="ctx-toks">0 / ${fmt(maxCtx)} tokens</span>
    </div>
    <div class="ctx-track"><div class="ctx-fill" id="ctx-fill" style="width:0%;background:var(--primary)"></div></div>
  </div>

  <div class="cum-row">
    <div class="cum-m"><span class="cum-lbl">Cum. Cost</span><span class="cum-val" id="cum-cost">$0.0000</span></div>
    <div class="cum-m"><span class="cum-lbl">Cum. Tokens</span><span class="cum-val" id="cum-toks">0</span></div>
    <div class="cum-m"><span class="cum-lbl">Cum. Output</span><span class="cum-val" id="cum-out">0</span></div>
    <div class="cum-m"><span class="cum-lbl">Turns Done</span><span class="cum-val" id="cum-done">0 / ${turns.length}</span></div>
  </div>
</div>

<div class="detail-grid">
  <div class="dc" id="tok-card">
    <div class="dc-hdr"><span>Token Breakdown</span></div>
    <div id="tok-content"></div>
  </div>
  <div class="dc" id="act-card">
    <div class="dc-hdr">
      <span>Turn Activity</span>
      <span id="model-mode-tags" style="display:flex;gap:5px;flex-wrap:wrap;"></span>
    </div>
    <div id="act-content"></div>
    <div id="prompt-sec"></div>
    <div id="compact-banner"></div>
  </div>
</div>
`}

</div>

<script>
  var vscode = acquireVsCodeApi();
  ${turns.length > 0 ? `
  var TURNS = ${turnsJson};
  var MAX_CTX = ${maxCtx};
  var cur = 0;
  var playing = false;
  var playTimer = null;

  function fmtN(n){return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1000?(n/1000).toFixed(1)+'K':String(Math.round(n));}
  function fmtC(n){if(n===0)return'$0.0000';if(n<0.001)return'$'+n.toFixed(5);return'$'+n.toFixed(4);}
  function escH(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  function fmtTs(iso){try{return new Date(iso).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit'});}catch(e){return iso;}}
  function ctxColor(p){if(p<0.5)return'var(--primary)';if(p<0.75)return'var(--stage-3)';if(p<0.9)return'var(--stage-2)';return'var(--stage-1)';}

  function renderTurn(idx) {
    cur = idx;
    var t = TURNS[idx];
    var total = TURNS.length;

    // header counters
    document.getElementById('turn-ctr').textContent = 'Turn '+(idx+1)+' / '+total;
    document.getElementById('turn-ts').textContent = fmtTs(t.ts);

    // timeline blocks + cursor
    var blocks = document.querySelectorAll('.tblock');
    blocks.forEach(function(b,i){
      b.classList.remove('tb-past','tb-current','tb-future');
      if(i<idx) b.classList.add('tb-past');
      else if(i===idx) b.classList.add('tb-current');
      else b.classList.add('tb-future');
    });
    var strip = document.getElementById('tl-strip');
    var cursor = document.getElementById('tl-cursor');
    if(strip && cursor){
      var pct = total>1 ? idx/(total-1) : 0;
      var usable = strip.clientWidth - 10;
      cursor.style.left = (5 + pct * usable).toFixed(1) + 'px';
    }

    // context bar
    var ctx = t.effectiveContextTokens || 0;
    var pct = MAX_CTX > 0 ? Math.min(1, ctx / MAX_CTX) : 0;
    var ctxFill = document.getElementById('ctx-fill');
    if(ctxFill){
      ctxFill.style.width = (pct * 100).toFixed(1) + '%';
      ctxFill.style.background = ctxColor(pct);
    }
    document.getElementById('ctx-toks').textContent = fmtN(ctx) + ' / ' + fmtN(MAX_CTX) + ' tokens · ' + (pct * 100).toFixed(1) + '%';

    // cumulative metrics up to current turn
    var cumCost=0, cumToks=0, cumOut=0;
    for(var j=0; j<=idx; j++){
      cumCost += TURNS[j].costUsd;
      cumToks += TURNS[j].totalTokens;
      cumOut  += TURNS[j].outputTokens;
    }
    document.getElementById('cum-cost').textContent = fmtC(cumCost);
    document.getElementById('cum-toks').textContent = fmtN(cumToks);
    document.getElementById('cum-out').textContent  = fmtN(cumOut);
    document.getElementById('cum-done').textContent = (idx+1) + ' / ' + total;

    // token breakdown card
    var totTok = t.inputTokens + t.outputTokens + t.thinkingTokens + t.cacheReadTokens + t.cacheWriteTokens;
    var barHtml = '';
    if(totTok > 0){
      var segs = [
        {v:t.cacheReadTokens,  c:'rgba(57,255,20,.55)'},
        {v:t.cacheWriteTokens, c:'rgba(57,255,20,.28)'},
        {v:t.inputTokens,      c:'var(--primary)'},
        {v:t.outputTokens,     c:'var(--stage-3)'},
        {v:t.thinkingTokens,   c:'rgba(139,92,246,.75)'},
      ].filter(function(s){return s.v>0;});
      barHtml = '<div class="tok-bar-row">' + segs.map(function(s){
        return '<div class="tok-seg" style="flex:'+(s.v/totTok).toFixed(4)+';background:'+s.c+'"></div>';
      }).join('') + '</div>';
    }
    var tokHtml = barHtml +
      '<div class="tok-r"><span class="tok-lbl"><span class="tok-dot" style="background:var(--primary)"></span>Input</span><span class="tok-val">'+fmtN(t.inputTokens)+'</span></div>'+
      '<div class="tok-r"><span class="tok-lbl"><span class="tok-dot" style="background:var(--stage-3)"></span>Output</span><span class="tok-val">'+fmtN(t.outputTokens)+'</span></div>'+
      (t.thinkingTokens>0 ? '<div class="tok-r"><span class="tok-lbl"><span class="tok-dot" style="background:rgba(139,92,246,.8)"></span>Thinking</span><span class="tok-val">'+fmtN(t.thinkingTokens)+'</span></div>' : '')+
      (t.cacheReadTokens>0 ? '<div class="tok-r"><span class="tok-lbl"><span class="tok-dot" style="background:rgba(57,255,20,.55)"></span>Cache Read'+(t.cacheTokensEstimated?' <span style="opacity:.7" title="Calculated estimate, not measured by GitHub Copilot">(calc.)</span>':'')+'</span><span class="tok-val">'+fmtN(t.cacheReadTokens)+'</span></div>' : '')+
      (t.cacheWriteTokens>0 ? '<div class="tok-r"><span class="tok-lbl"><span class="tok-dot" style="background:rgba(57,255,20,.28)"></span>Cache Write'+(t.cacheTokensEstimated?' <span style="opacity:.7" title="Calculated estimate, not measured by GitHub Copilot">(calc.)</span>':'')+'</span><span class="tok-val">'+fmtN(t.cacheWriteTokens)+'</span></div>' : '')+
      '<div class="tok-r"><span class="tok-lbl">Eff. Context</span><span class="tok-val">'+fmtN(t.effectiveContextTokens)+'</span></div>'+
      '<div class="cost-row"><span class="cost-lbl">Turn Cost</span><span class="cost-val">'+fmtC(t.costUsd)+'</span></div>';
    document.getElementById('tok-content').innerHTML = tokHtml;

    // activity card
    var actRows = [];
    if(t.mode) {
      actRows.push('<div class="act-r"><span class="act-ico">⚙</span><span class="act-lbl">Mode</span><span class="act-val">'+escH(t.mode)+'</span></div>');
    }
    if(t.toolCalls && t.toolCalls.length > 0){
      var tools = t.toolCalls.slice(0, 10);
      actRows.push('<div class="act-r"><span class="act-ico">🔧</span><span class="act-lbl">Tools</span><span class="act-val">'+escH(tools.join(', '))+(t.toolCalls.length>10?' +more':'')+'</span></div>');
    }
    if(t.commandRuns && t.commandRuns.length > 0){
      t.commandRuns.slice(0, 4).forEach(function(cmd){
        actRows.push('<div class="act-r"><span class="act-ico">$</span><span class="act-lbl">Run</span><span class="act-val">'+escH(cmd.length>90?cmd.slice(0,90)+'…':cmd)+'</span></div>');
      });
      if(t.commandRuns.length > 4){
        actRows.push('<div class="act-r"><span class="act-ico"></span><span class="act-lbl"></span><span class="act-val" style="color:var(--text-secondary)">+'+(t.commandRuns.length-4)+' more commands</span></div>');
      }
    }
    if(t.fileAccesses && t.fileAccesses.length > 0){
      var byTool = {};
      t.fileAccesses.forEach(function(f){ (byTool[f.tool] = byTool[f.tool]||[]).push(f.path); });
      Object.keys(byTool).slice(0, 5).forEach(function(tool){
        var paths = byTool[tool];
        var icon = tool==='Edit'?'✏':tool==='Write'?'📝':'📄';
        var names = paths.slice(0,4).map(function(p){
          var base=(p||'').replace(/\\\\/g,'/').split('/').pop()||p;
          return '<span title="'+escH(p)+'">'+escH(base)+'</span>';
        });
        actRows.push('<div class="act-r"><span class="act-ico">'+icon+'</span><span class="act-lbl">'+escH(tool)+'</span><span class="act-val">'+names.join(', ')+(paths.length>4?' +more':'')+'</span></div>');
      });
    }
    if(t.webSearchRequests > 0){
      actRows.push('<div class="act-r"><span class="act-ico">🔍</span><span class="act-lbl">Search</span><span class="act-val">'+t.webSearchRequests+' request'+(t.webSearchRequests!==1?'s':'')+'</span></div>');
    }
    if(actRows.length === 0){
      actRows.push('<div class="act-none">No tool activity this turn</div>');
    }
    document.getElementById('act-content').innerHTML = actRows.join('');

    // model/mode tags in card header
    var tags = '';
    if(t.model) tags += '<span class="model-tag">'+escH(t.model.replace(/^claude-/,'').substring(0,28))+'</span>';
    if(t.isCompactionEvent) tags += '<span class="compact-tag">compaction</span>';
    document.getElementById('model-mode-tags').innerHTML = tags;

    // prompt preview
    var ps = document.getElementById('prompt-sec');
    if(t.promptPreview && !t.isCompactionEvent){
      var preview = t.promptPreview.length > 320 ? t.promptPreview.slice(0,320)+'…' : t.promptPreview;
      ps.innerHTML = '<div class="prompt-sec"><div class="prompt-preview">'+escH(preview)+'</div></div>';
    } else {
      ps.innerHTML = '';
    }

    // compaction banner
    var cb = document.getElementById('compact-banner');
    if(t.isCompactionEvent){
      var trigger = t.compactionTrigger==='manual' ? 'Manual' : 'Auto';
      var detail = '';
      if(t.preCompactionTokens > 0 && t.postCompactionTokens > 0){
        detail = ' · ' + fmtN(t.preCompactionTokens) + ' → ' + fmtN(t.postCompactionTokens) + ' tokens';
        var freed = t.preCompactionTokens - t.postCompactionTokens;
        if(freed > 0) detail += ' (' + fmtN(freed) + ' freed)';
      }
      cb.innerHTML = '<div class="compact-banner">⚡ '+trigger+' context compaction'+detail+'</div>';
    } else {
      cb.innerHTML = '';
    }

    // transport button states
    document.getElementById('btn-back').toggleAttribute('disabled', idx===0);
    document.getElementById('btn-start').toggleAttribute('disabled', idx===0);
    document.getElementById('btn-fwd').toggleAttribute('disabled', idx>=total-1);
    document.getElementById('btn-end').toggleAttribute('disabled', idx>=total-1);
    if(idx >= total-1 && playing){ pause(); }
  }

  function togglePlay(){
    if(playing) pause(); else play();
  }

  function play(){
    if(cur >= TURNS.length-1){ goTo(0); }
    playing = true;
    document.getElementById('btn-play').textContent = '⏸';
    var spd = parseFloat(document.getElementById('speed-sel').value) || 1;
    var ms = Math.max(50, Math.round(1000 / spd));
    playTimer = setInterval(function(){
      if(cur >= TURNS.length-1){ pause(); return; }
      renderTurn(cur + 1);
    }, ms);
  }

  function pause(){
    playing = false;
    if(playTimer){ clearInterval(playTimer); playTimer = null; }
    document.getElementById('btn-play').textContent = '▶';
  }

  function stepFwd(){ pause(); if(cur < TURNS.length-1) renderTurn(cur+1); }
  function stepBack(){ pause(); if(cur > 0) renderTurn(cur-1); }
  function goTo(idx){ pause(); renderTurn(Math.max(0, Math.min(TURNS.length-1, idx))); }

  // Timeline click / drag
  (function(){
    var strip = document.getElementById('tl-strip');
    var dragging = false;
    function seekFromEvent(e){
      var rect = strip.getBoundingClientRect();
      var pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      var idx = Math.round(pct * (TURNS.length-1));
      goTo(idx);
    }
    strip.addEventListener('mousedown', function(e){ dragging=true; seekFromEvent(e); });
    document.addEventListener('mousemove', function(e){ if(dragging) seekFromEvent(e); });
    document.addEventListener('mouseup',   function(){ dragging=false; });
  })();

  // Speed change — restart if playing
  document.getElementById('speed-sel').addEventListener('change', function(){
    if(playing){ pause(); play(); }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', function(e){
    var tag = (e.target||{}).tagName;
    if(tag==='INPUT'||tag==='SELECT'||tag==='TEXTAREA') return;
    if(e.key==='ArrowRight' || e.key==='l'){ e.preventDefault(); stepFwd(); }
    else if(e.key==='ArrowLeft' || e.key==='h'){ e.preventDefault(); stepBack(); }
    else if(e.key===' ' || e.key==='k'){ e.preventDefault(); togglePlay(); }
    else if(e.key==='Home'){ e.preventDefault(); goTo(0); }
    else if(e.key==='End'){ e.preventDefault(); goTo(TURNS.length-1); }
  });

  // Initial render
  renderTurn(0);
  ` : ''}
  ${navJs()}
</script>
</body>
</html>`;
  }
}
