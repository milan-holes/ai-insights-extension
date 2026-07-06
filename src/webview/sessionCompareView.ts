import * as vscode from 'vscode';
import { Session } from '../types';
import { computeContextRotScore } from '../core/contextRot';
import { navCss, navTopbarHtml, navJs, NAV_COMMANDS } from './navShared';
import { designTokensCss } from './designSystem';

interface CompareSessionData {
  id: string;
  title: string;
  provider: string;
  providerName: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  workspace: string;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalThinkingTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  estimatedCostUsd: number;
  interactions: number;
  totalToolCalls: number;
  totalCommandRuns: number;
  fileReadCount: number;
  fileEditCount: number;
  uniqueFilesRead: number;
  uniqueFilesEdited: number;
  cacheHitRate: number;
  cacheTokensEstimated: boolean;
  outputInputRatio: number;
  costPerInteraction: number;
  tokensPerInteraction: number;
  compactionEvents: number;
  contextRotScore: number;
  contextRotLabel: string;
  toolBreakdown: Record<string, number>;
  commandBreakdown: Record<string, number>;
  modeBreakdown: Record<string, number>;
  models: string[];
}

const SESSION_COLORS = ['#007AFF', '#34C759', '#FF9F0A', '#BF5AF2', '#FF3B30', '#00C7BE'];
const SESSION_COLORS_FAINT = [
  'rgba(0,122,255,0.12)', 'rgba(52,199,89,0.12)', 'rgba(255,159,10,0.12)',
  'rgba(191,90,242,0.12)', 'rgba(255,59,48,0.12)', 'rgba(0,199,190,0.12)',
];

function prepareData(session: Session): CompareSessionData {
  const toolBreakdown: Record<string, number> = {};
  const commandBreakdown: Record<string, number> = {};
  const modeBreakdown: Record<string, number> = {};
  const fileReadsSet = new Set<string>();
  const fileEditsSet = new Set<string>();
  let fileReadCount = 0;
  let fileEditCount = 0;
  let totalToolCalls = 0;
  let totalCommandRuns = 0;
  let compactionEvents = 0;

  for (const i of session.interactions || []) {
    for (const tool of i.toolCalls || []) {
      toolBreakdown[tool] = (toolBreakdown[tool] || 0) + 1;
      totalToolCalls++;
    }
    for (const cmd of i.commandRuns || []) {
      commandBreakdown[cmd] = (commandBreakdown[cmd] || 0) + 1;
      totalCommandRuns++;
    }
    for (const fa of i.fileAccesses || []) {
      const t = fa.tool?.toLowerCase() || '';
      if (t === 'edit' || t === 'notebookedit' || t === 'write') {
        fileEditsSet.add(fa.path);
        fileEditCount++;
      } else {
        fileReadsSet.add(fa.path);
        fileReadCount++;
      }
    }
    if (i.mode) {
      modeBreakdown[i.mode] = (modeBreakdown[i.mode] || 0) + 1;
    }
    if (i.isCompactionEvent) { compactionEvents++; }
  }

  const start = new Date(session.startTime).getTime();
  const end = new Date(session.endTime).getTime();
  const durationMinutes = Math.max(0, (end - start) / 60000);
  const cacheTotal = (session.totalCacheReadTokens || 0) + (session.totalCacheWriteTokens || 0);
  const cacheHitRate = cacheTotal > 0 ? (session.totalCacheReadTokens || 0) / cacheTotal : 0;
  const interactions = (session.interactions || []).length;
  const rot = computeContextRotScore(session);

  return {
    id: session.id,
    title: session.title || session.id.slice(0, 18),
    provider: session.provider,
    providerName: session.providerName,
    startTime: session.startTime instanceof Date ? session.startTime.toISOString() : String(session.startTime),
    endTime: session.endTime instanceof Date ? session.endTime.toISOString() : String(session.endTime),
    durationMinutes,
    workspace: session.workspace || '',
    totalTokens: session.totalTokens || 0,
    totalInputTokens: session.totalInputTokens || 0,
    totalOutputTokens: session.totalOutputTokens || 0,
    totalThinkingTokens: session.totalThinkingTokens || 0,
    totalCacheReadTokens: session.totalCacheReadTokens || 0,
    totalCacheWriteTokens: session.totalCacheWriteTokens || 0,
    estimatedCostUsd: session.estimatedCostUsd || 0,
    interactions,
    totalToolCalls,
    totalCommandRuns,
    fileReadCount,
    fileEditCount,
    uniqueFilesRead: fileReadsSet.size,
    uniqueFilesEdited: fileEditsSet.size,
    cacheHitRate,
    cacheTokensEstimated: !!session.cacheTokensEstimated,
    outputInputRatio: session.totalInputTokens > 0 ? (session.totalOutputTokens || 0) / session.totalInputTokens : 0,
    costPerInteraction: interactions > 0 ? (session.estimatedCostUsd || 0) / interactions : 0,
    tokensPerInteraction: interactions > 0 ? (session.totalTokens || 0) / interactions : 0,
    compactionEvents,
    contextRotScore: rot?.score ?? 0,
    contextRotLabel: rot?.label ?? 'n/a',
    toolBreakdown,
    commandBreakdown,
    modeBreakdown,
    models: session.models || [],
  };
}

export class SessionCompareProvider {
  static readonly viewType = 'aiInsights.sessionCompare';
  private static currentPanel: vscode.WebviewPanel | undefined;

  static createPanel(context: vscode.ExtensionContext, sessions: Session[]): vscode.WebviewPanel {
    const data = sessions.slice(0, 6).map(prepareData);
    const logoPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'logo.png');

    if (SessionCompareProvider.currentPanel) {
      const logoUri = SessionCompareProvider.currentPanel.webview.asWebviewUri(logoPath).toString();
      SessionCompareProvider.currentPanel.webview.html = SessionCompareProvider.buildHtml(data, logoUri);
      SessionCompareProvider.currentPanel.reveal(vscode.ViewColumn.One);
      return SessionCompareProvider.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      SessionCompareProvider.viewType,
      'Session Comparison',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')] },
    );

    const logoUri = panel.webview.asWebviewUri(logoPath).toString();
    panel.webview.html = SessionCompareProvider.buildHtml(data, logoUri);

    panel.webview.onDidReceiveMessage(
      (message) => {
        const navCmd = NAV_COMMANDS[message.command];
        if (navCmd) { vscode.commands.executeCommand(navCmd); }
      },
      undefined,
      context.subscriptions,
    );

    panel.onDidDispose(() => {
      SessionCompareProvider.currentPanel = undefined;
    }, null, context.subscriptions);

    SessionCompareProvider.currentPanel = panel;
    return panel;
  }

  private static buildHtml(sessions: CompareSessionData[], logoUri: string): string {
    const safe = JSON.stringify(sessions).replace(/<\/script>/gi, '<\\/script>');
    const n = sessions.length;
    const parts: string[] = [];

    parts.push('<!DOCTYPE html><html lang="en"><head>');
    parts.push('<meta charset="UTF-8">');
    parts.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
    parts.push('<title>Session Comparison</title>');
    parts.push('<style>');
    parts.push(designTokensCss());
    parts.push('*{margin:0;padding:0;box-sizing:border-box;}');
    parts.push('body{font-family:var(--font-primary);background:var(--bg-base);color:var(--text-primary);line-height:1.6;}');
    parts.push(navCss());

    // Layout
    parts.push('.cmp-content{padding:24px 32px;}');
    parts.push('.cmp-section{background:var(--bg-surface);border:1px solid var(--border);border-radius:10px;margin-bottom:24px;overflow:hidden;}');
    parts.push('.cmp-section-hdr{padding:16px 22px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;}');
    parts.push('.cmp-section-title{font-size:0.95em;font-weight:600;letter-spacing:-0.01em;}');
    parts.push('.cmp-section-sub{font-size:0.8em;color:var(--text-secondary);margin-left:auto;}');
    parts.push('.cmp-section-body{padding:20px 22px;}');

    // Session pills row
    parts.push('.session-pills{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:28px;}');
    parts.push('.session-pill{display:flex;align-items:center;gap:10px;background:var(--bg-surface);border-radius:8px;padding:12px 16px;border:1px solid var(--border);flex:1;min-width:200px;max-width:340px;}');
    parts.push('.pill-color{width:12px;height:12px;border-radius:50%;flex-shrink:0;}');
    parts.push('.pill-info{min-width:0;}');
    parts.push('.pill-title{font-size:0.88em;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}');
    parts.push('.pill-meta{font-size:0.75em;color:var(--text-secondary);}');
    parts.push('.pill-prov{display:inline-block;font-size:0.72em;padding:1px 6px;border-radius:3px;font-weight:600;margin-right:5px;}');
    parts.push('.p-copilot{background:rgba(0,200,100,0.1);color:#00c864;}');
    parts.push('.p-antigravity{background:rgba(240,147,251,0.1);color:#f093fb;}');
    parts.push('.p-claudeCode{background:rgba(0,122,255,0.1);color:#007AFF;}');
    parts.push('.p-codex{background:rgba(52,199,89,0.1);color:#34C759;}');

    // Comparison table
    parts.push('.cmp-table{width:100%;border-collapse:collapse;}');
    parts.push('.cmp-table th{text-align:left;padding:9px 14px;background:var(--bg-surface-high);color:var(--text-secondary);font-size:0.72em;text-transform:uppercase;letter-spacing:0.05em;font-weight:500;border-bottom:1px solid var(--border);}');
    parts.push('.cmp-table td{padding:9px 14px;border-bottom:1px solid var(--border);font-size:0.86em;vertical-align:middle;}');
    parts.push('.cmp-table tr:last-child td{border-bottom:none;}');
    parts.push('.cmp-table .row-label{color:var(--text-secondary);font-size:0.82em;white-space:nowrap;}');
    parts.push('.cmp-table .row-best{font-weight:700;}');
    parts.push('.cmp-table td.num{font-family:var(--font-data);text-align:right;}');
    parts.push('.cmp-table th.num{text-align:right;}');

    // Bar comparison rows
    parts.push('.bar-row{display:flex;align-items:center;gap:10px;margin-bottom:10px;}');
    parts.push('.bar-label{font-size:0.78em;color:var(--text-secondary);width:130px;flex-shrink:0;white-space:nowrap;}');
    parts.push('.bar-tracks{flex:1;display:flex;flex-direction:column;gap:4px;}');
    parts.push('.bar-track{display:flex;align-items:center;gap:8px;}');
    parts.push('.bar-track-label{font-size:0.72em;width:90px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}');
    parts.push('.bar-bg{flex:1;height:8px;background:rgba(255,255,255,0.05);border-radius:4px;overflow:hidden;}');
    parts.push('.bar-fill{height:100%;border-radius:4px;transition:width 0.4s ease;}');
    parts.push('.bar-val{font-family:var(--font-data);font-size:0.72em;color:var(--text-secondary);width:70px;text-align:right;flex-shrink:0;white-space:nowrap;}');

    // Tool table
    parts.push('.tool-cmp-table{width:100%;border-collapse:collapse;}');
    parts.push('.tool-cmp-table th{padding:8px 12px;font-size:0.72em;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);font-weight:500;background:var(--bg-surface-high);border-bottom:1px solid var(--border);white-space:nowrap;}');
    parts.push('.tool-cmp-table td{padding:8px 12px;border-bottom:1px solid var(--border);font-size:0.83em;vertical-align:middle;}');
    parts.push('.tool-cmp-table tr:last-child td{border-bottom:none;}');
    parts.push('.tool-name{font-family:var(--font-data);font-size:0.85em;}');
    parts.push('.tool-count{font-family:var(--font-data);font-size:0.85em;text-align:right;}');

    // Rot badges
    parts.push('.rot-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:4px;font-size:0.82em;font-weight:600;}');
    parts.push('.rot-healthy{background:rgba(0,200,100,0.1);color:#00c864;}');
    parts.push('.rot-warning{background:rgba(255,159,10,0.12);color:#FF9F0A;}');
    parts.push('.rot-stale{background:rgba(255,59,48,0.12);color:#FF3B30;}');
    parts.push('.rot-na{background:rgba(255,255,255,0.04);color:rgba(193,198,215,0.4);}');

    // Chart
    parts.push('.chart-wrap{position:relative;height:280px;}');
    parts.push('.chart-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;}');
    parts.push('@media(max-width:900px){.chart-grid{grid-template-columns:1fr;}}');
    parts.push('.chart-group-label{font-size:0.72em;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-secondary);font-weight:600;margin-bottom:8px;}');

    // Winner badge
    parts.push('.win-badge{display:inline-block;width:14px;height:14px;background:rgba(255,215,0,0.15);border:1px solid rgba(255,215,0,0.35);border-radius:50%;color:#FFD700;font-size:8px;line-height:14px;text-align:center;margin-left:4px;flex-shrink:0;}');

    parts.push('</style></head><body>');
    parts.push(navTopbarHtml(logoUri, false));

    // Page header
    parts.push('<div class="ns-pagebar"><div class="ns-pagebar-inner">');
    parts.push(`<p class="ns-page-title">Session Comparison &mdash; ${n} sessions</p>`);
    parts.push('</div></div>');

    parts.push('<div class="cmp-content">');

    // Session pills
    parts.push('<div class="session-pills" id="sessionPills"></div>');

    // Token Overview section
    parts.push('<div class="cmp-section">');
    parts.push('<div class="cmp-section-hdr"><span class="cmp-section-title">Token Usage</span><span class="cmp-section-sub">Split by scale — generated vs. cache</span></div>');
    parts.push('<div class="cmp-section-body">');
    parts.push('<div class="chart-grid">');
    parts.push('<div>');
    parts.push('  <div class="chart-group-label">Generated Tokens</div>');
    parts.push('  <div style="position:relative;height:190px"><canvas id="tokenChartA"></canvas></div>');
    parts.push('  <div class="chart-group-label" style="margin-top:20px">Cache Tokens</div>');
    parts.push('  <div style="position:relative;height:190px"><canvas id="tokenChartB"></canvas></div>');
    parts.push('</div>');
    parts.push('<div id="tokenBars"></div>');
    parts.push('</div>');
    parts.push('</div></div>');

    // Summary stats
    parts.push('<div class="cmp-section">');
    parts.push('<div class="cmp-section-hdr"><span class="cmp-section-title">Cost &amp; Efficiency</span></div>');
    parts.push('<div class="cmp-section-body"><div id="costTable"></div></div>');
    parts.push('</div>');

    // Activity stats
    parts.push('<div class="cmp-section">');
    parts.push('<div class="cmp-section-hdr"><span class="cmp-section-title">Activity</span></div>');
    parts.push('<div class="cmp-section-body"><div id="activityTable"></div></div>');
    parts.push('</div>');

    // Tool usage
    parts.push('<div class="cmp-section">');
    parts.push('<div class="cmp-section-hdr"><span class="cmp-section-title">Tool Usage</span><span class="cmp-section-sub">Calls per tool across sessions</span></div>');
    parts.push('<div class="cmp-section-body"><div id="toolTable"></div></div>');
    parts.push('</div>');

    // Command usage
    parts.push('<div class="cmp-section">');
    parts.push('<div class="cmp-section-hdr"><span class="cmp-section-title">Shell Commands</span></div>');
    parts.push('<div class="cmp-section-body"><div id="cmdTable"></div></div>');
    parts.push('</div>');

    // Mode breakdown
    parts.push('<div class="cmp-section">');
    parts.push('<div class="cmp-section-hdr"><span class="cmp-section-title">Interaction Modes</span></div>');
    parts.push('<div class="cmp-section-body"><div class="chart-grid"><div><div class="chart-wrap"><canvas id="modeChart"></canvas></div></div><div id="modeBars"></div></div></div>');
    parts.push('</div>');

    // Context health
    parts.push('<div class="cmp-section">');
    parts.push('<div class="cmp-section-hdr"><span class="cmp-section-title">Context Health</span></div>');
    parts.push('<div class="cmp-section-body"><div id="rotTable"></div></div>');
    parts.push('</div>');

    parts.push('</div><!-- /cmp-content -->');

    // Data + script
    parts.push('<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>');
    parts.push(`<script>var __DATA__=${safe};</script>`);

    const colors = JSON.stringify(SESSION_COLORS);
    const colorsFaint = JSON.stringify(SESSION_COLORS_FAINT);

    parts.push('<script>');
    parts.push(`(function(){
var vscode=acquireVsCodeApi();
window.vscode=vscode;
var S=__DATA__;
var CLR=${colors};
var FAINT=${colorsFaint};
Chart.defaults.font.family='Inter, system-ui, sans-serif';
Chart.defaults.color='#c1c6d7';

function esc(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML;}
function fmt(n){if(n==null)return'-';if(n>=1e6)return(n/1e6).toFixed(1)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return String(Math.round(n));}
function fmtCost(n){if(n==null||n===0)return'$0.00';if(n<0.01)return'$'+n.toFixed(5);return'$'+n.toFixed(4);}
function fmtPct(n){return(n*100).toFixed(1)+'%';}
function fmtDur(m){if(m<1)return'<1 min';if(m<60)return Math.round(m)+'m';return (m/60).toFixed(1)+'h';}
function fmtDate(s){var d=new Date(s);return d.toLocaleDateString([],{month:'short',day:'numeric'})+ ' ' +d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}
function shortTitle(s){return s.title?(s.title.length>28?s.title.slice(0,26)+'…':s.title):'Session '+S.indexOf(s);}
function repoName(ws){if(!ws)return '-';return ws.replace(/\\\\/g,'/').split('/').pop()||ws;}

// Session pills
(function(){
  var el=document.getElementById('sessionPills');
  var h='';
  S.forEach(function(s,i){
    var repo=repoName(s.workspace);
    h+='<div class="session-pill" style="border-color:'+CLR[i]+'40">';
    h+='<div class="pill-color" style="background:'+CLR[i]+'"></div>';
    h+='<div class="pill-info">';
    h+='<div class="pill-title" title="'+esc(s.title)+'">'+esc(shortTitle(s))+'</div>';
    h+='<div class="pill-meta"><span class="pill-prov p-'+esc(s.provider)+'">'+esc(s.providerName)+'</span>'+esc(repo)+' &middot; '+esc(fmtDate(s.startTime))+'</div>';
    h+='</div></div>';
  });
  el.innerHTML=h;
})();

// Helpers: find best (max or min) index for highlighting
function bestIdx(arr,wantMax){
  var b=wantMax?-Infinity:Infinity,bi=0;
  arr.forEach(function(v,i){if(wantMax?v>b:v<b){b=v;bi=i;}});
  return bi;
}

// Token charts — split into two to avoid cache dwarfing generated tokens
(function(){
  var xGrid={color:'rgba(255,255,255,0.04)'};
  var yGrid={color:'rgba(255,255,255,0.04)'};
  function makeDatasets(keys){
    return S.map(function(s,i){
      return{label:shortTitle(s),backgroundColor:FAINT[i],borderColor:CLR[i],borderWidth:1.5,borderRadius:3,data:keys.map(function(k){return s[k]||0;})};
    });
  }
  function mkChart(id,labels,keys,showLegend){
    new Chart(document.getElementById(id),{
      type:'bar',
      data:{labels:labels,datasets:makeDatasets(keys)},
      options:{
        responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:showLegend,position:'bottom',labels:{boxWidth:9,font:{size:10}}}},
        scales:{x:{grid:xGrid},y:{grid:yGrid,ticks:{callback:function(v){return fmt(v);}}}}
      }
    });
  }
  mkChart('tokenChartA',['Input','Output','Thinking'],['totalInputTokens','totalOutputTokens','totalThinkingTokens'],true);
  mkChart('tokenChartB',['Cache Read','Cache Write'],['totalCacheReadTokens','totalCacheWriteTokens'],false);

  // Bar comparison for total tokens
  var maxTok=Math.max.apply(null,S.map(function(s){return s.totalTokens;}));
  var h='';
  var tkFields=[
    {key:'totalTokens',label:'Total'},
    {key:'totalInputTokens',label:'Input'},
    {key:'totalOutputTokens',label:'Output'},
    {key:'totalThinkingTokens',label:'Thinking'},
    {key:'totalCacheReadTokens',label:'Cache Read'},
    {key:'totalCacheWriteTokens',label:'Cache Write'},
  ];
  tkFields.forEach(function(f){
    var max=Math.max.apply(null,S.map(function(s){return s[f.key]||0;}));
    if(max===0)return;
    h+='<div class="bar-row"><span class="bar-label">'+esc(f.label)+'</span><div class="bar-tracks">';
    S.forEach(function(s,i){
      var v=s[f.key]||0;
      var pct=max>0?(v/max*100).toFixed(1):0;
      h+='<div class="bar-track"><span class="bar-track-label" style="color:'+CLR[i]+'">'+esc(shortTitle(s))+'</span>';
      h+='<div class="bar-bg"><div class="bar-fill" style="width:'+pct+'%;background:'+CLR[i]+'"></div></div>';
      h+='<span class="bar-val">'+fmt(v)+'</span></div>';
    });
    h+='</div></div>';
  });
  document.getElementById('tokenBars').innerHTML=h;
})();

// Cost & efficiency table
(function(){
  var fields=[
    {label:'Est. Cost',key:'estimatedCostUsd',fmt:fmtCost,wantMin:true},
    {label:'Cost / Interaction',key:'costPerInteraction',fmt:fmtCost,wantMin:true},
    {label:'Tokens / Interaction',key:'tokensPerInteraction',fmt:function(v){return fmt(v);},wantMin:true},
    {label:'Cache Hit Rate',key:'cacheHitRate',fmt:fmtPct,wantMax:true},
    {label:'Output / Input Ratio',key:'outputInputRatio',fmt:function(v){return v.toFixed(3);},wantMax:true},
    {label:'Duration',key:'durationMinutes',fmt:fmtDur,wantMin:false},
    {label:'Compactions',key:'compactionEvents',fmt:function(v){return String(v);},wantMin:false},
  ];
  var hdr='<tr><th class="row-label">Metric</th>';
  S.forEach(function(s,i){
    hdr+='<th class="num" style="color:'+CLR[i]+'">'+esc(shortTitle(s))+'</th>';
  });
  hdr+='</tr>';
  var rows='';
  fields.forEach(function(f){
    var vals=S.map(function(s){return s[f.key]!=null?s[f.key]:0;});
    var bi=f.wantMax!=null?bestIdx(vals,!!f.wantMax):-1;
    rows+='<tr><td class="row-label">'+esc(f.label)+'</td>';
    vals.forEach(function(v,i){
      var isBest=f.wantMax!=null&&i===bi;
      var isCalc=f.key==='cacheHitRate'&&S[i].provider==='copilot'&&S[i].cacheTokensEstimated;
      rows+='<td class="num'+(isBest?' row-best':'')+'" title="'+(isCalc?'Calculated estimate, not measured by GitHub Copilot':'')+'">'+esc(f.fmt(v))+(isCalc?' <span style="opacity:.7">(calc.)</span>':'')+(isBest?'<span class="win-badge">&#9733;</span>':'')+'</td>';
    });
    rows+='</tr>';
  });
  document.getElementById('costTable').innerHTML='<table class="cmp-table"><thead>'+hdr+'</thead><tbody>'+rows+'</tbody></table>';
})();

// Activity table
(function(){
  var fields=[
    {label:'Interactions',key:'interactions',wantMax:false},
    {label:'Tool Calls',key:'totalToolCalls',wantMax:true},
    {label:'Shell Commands',key:'totalCommandRuns',wantMax:false},
    {label:'File Reads',key:'fileReadCount',wantMax:false},
    {label:'File Edits',key:'fileEditCount',wantMax:false},
    {label:'Unique Files Read',key:'uniqueFilesRead',wantMax:false},
    {label:'Unique Files Edited',key:'uniqueFilesEdited',wantMax:false},
  ];
  var hdr='<tr><th class="row-label">Metric</th>';
  S.forEach(function(s,i){hdr+='<th class="num" style="color:'+CLR[i]+'">'+esc(shortTitle(s))+'</th>';});
  hdr+='</tr>';
  var rows='';
  fields.forEach(function(f){
    var vals=S.map(function(s){return s[f.key]||0;});
    rows+='<tr><td class="row-label">'+esc(f.label)+'</td>';
    vals.forEach(function(v){rows+='<td class="num">'+fmt(v)+'</td>';});
    rows+='</tr>';
  });
  document.getElementById('activityTable').innerHTML='<table class="cmp-table"><thead>'+hdr+'</thead><tbody>'+rows+'</tbody></table>';
})();

// Tool usage table
(function(){
  var allTools={};
  S.forEach(function(s){Object.keys(s.toolBreakdown).forEach(function(t){allTools[t]=true;});});
  var toolNames=Object.keys(allTools).sort();
  if(toolNames.length===0){document.getElementById('toolTable').innerHTML='<p style="color:var(--text-secondary);font-size:0.85em;">No tool calls recorded.</p>';return;}
  var hdr='<tr><th>Tool</th>';
  S.forEach(function(s,i){hdr+='<th class="num" style="color:'+CLR[i]+'">'+esc(shortTitle(s))+'</th>';});
  hdr+='<th class="num">Total</th></tr>';
  var rows='';
  toolNames.forEach(function(tool){
    var vals=S.map(function(s){return s.toolBreakdown[tool]||0;});
    var total=vals.reduce(function(a,b){return a+b;},0);
    var bi=bestIdx(vals,true);
    rows+='<tr><td class="tool-name">'+esc(tool)+'</td>';
    vals.forEach(function(v,i){
      var isBest=v>0&&i===bi;
      rows+='<td class="tool-count'+(isBest?' row-best':'')+'" style="text-align:right">'+v+'</td>';
    });
    rows+='<td class="tool-count" style="text-align:right;color:var(--text-secondary)">'+total+'</td></tr>';
  });
  document.getElementById('toolTable').innerHTML='<table class="tool-cmp-table"><thead>'+hdr+'</thead><tbody>'+rows+'</tbody></table>';
})();

// Command usage table
(function(){
  var allCmds={};
  S.forEach(function(s){Object.keys(s.commandBreakdown).forEach(function(t){allCmds[t]=true;});});
  var cmdNames=Object.keys(allCmds).sort();
  if(cmdNames.length===0){document.getElementById('cmdTable').innerHTML='<p style="color:var(--text-secondary);font-size:0.85em;">No shell commands recorded.</p>';return;}
  var hdr='<tr><th>Command</th>';
  S.forEach(function(s,i){hdr+='<th class="num" style="color:'+CLR[i]+'">'+esc(shortTitle(s))+'</th>';});
  hdr+='<th class="num">Total</th></tr>';
  var rows='';
  cmdNames.slice(0,30).forEach(function(cmd){
    var vals=S.map(function(s){return s.commandBreakdown[cmd]||0;});
    var total=vals.reduce(function(a,b){return a+b;},0);
    rows+='<tr><td class="tool-name" style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(cmd)+'">'+esc(cmd.length>40?cmd.slice(0,38)+'…':cmd)+'</td>';
    vals.forEach(function(v){rows+='<td class="tool-count" style="text-align:right">'+v+'</td>';});
    rows+='<td class="tool-count" style="text-align:right;color:var(--text-secondary)">'+total+'</td></tr>';
  });
  document.getElementById('cmdTable').innerHTML='<table class="tool-cmp-table"><thead>'+hdr+'</thead><tbody>'+rows+'</tbody></table>';
})();

// Mode breakdown chart + bars
(function(){
  var allModes={};
  S.forEach(function(s){Object.keys(s.modeBreakdown).forEach(function(m){allModes[m]=true;});});
  var modes=Object.keys(allModes).sort();
  if(modes.length===0){document.getElementById('modeBars').innerHTML='<p style="color:var(--text-secondary);font-size:0.85em;">No mode data.</p>';return;}
  var datasets=S.map(function(s,i){
    return{label:shortTitle(s),backgroundColor:FAINT[i],borderColor:CLR[i],borderWidth:1.5,borderRadius:3,data:modes.map(function(m){return s.modeBreakdown[m]||0;})};
  });
  new Chart(document.getElementById('modeChart'),{
    type:'bar',
    data:{labels:modes,datasets:datasets},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{boxWidth:10,font:{size:11}}}},scales:{x:{grid:{color:'rgba(255,255,255,0.04)'}},y:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{precision:0}}}}
  });

  var h='';
  modes.forEach(function(m){
    var max=Math.max.apply(null,S.map(function(s){return s.modeBreakdown[m]||0;}));
    if(max===0)return;
    h+='<div class="bar-row"><span class="bar-label">'+esc(m)+'</span><div class="bar-tracks">';
    S.forEach(function(s,i){
      var v=s.modeBreakdown[m]||0;
      var pct=max>0?(v/max*100).toFixed(1):0;
      h+='<div class="bar-track"><span class="bar-track-label" style="color:'+CLR[i]+'">'+esc(shortTitle(s))+'</span><div class="bar-bg"><div class="bar-fill" style="width:'+pct+'%;background:'+CLR[i]+'"></div></div><span class="bar-val">'+v+'</span></div>';
    });
    h+='</div></div>';
  });
  document.getElementById('modeBars').innerHTML=h||'<p style="color:var(--text-secondary);font-size:0.85em;">No mode data.</p>';
})();

// Context health table
(function(){
  var hdr='<tr><th class="row-label">Metric</th>';
  S.forEach(function(s,i){hdr+='<th class="num" style="color:'+CLR[i]+'">'+esc(shortTitle(s))+'</th>';});
  hdr+='</tr>';
  var rotIcons={healthy:'✓',warning:'⚠',stale:'✗'};
  var rotLabels={healthy:'Healthy',warning:'Warning',stale:'Stale'};
  var scoreVals=S.map(function(s){return s.contextRotScore;});
  var bi=bestIdx(scoreVals,false);
  var rows='<tr><td class="row-label">Health</td>';
  S.forEach(function(s,i){
    rows+='<td style="text-align:right"><span class="rot-badge rot-'+esc(s.contextRotLabel)+'">'+(rotIcons[s.contextRotLabel]||'?')+' '+(rotLabels[s.contextRotLabel]||s.contextRotLabel)+'</span></td>';
  });
  rows+='</tr>';
  rows+='<tr><td class="row-label">Rot Score (0=best)</td>';
  scoreVals.forEach(function(v,i){
    var isBest=i===bi;
    rows+='<td class="num'+(isBest?' row-best':'')+'">'+v+(isBest?'<span class="win-badge">&#9733;</span>':'')+'</td>';
  });
  rows+='</tr>';
  rows+='<tr><td class="row-label">Models</td>';
  S.forEach(function(s){
    var m=(s.models||[]).slice(0,3).map(function(v){return'<span style="font-family:var(--font-data);font-size:0.78em;background:var(--bg-surface-high);border-radius:3px;padding:1px 5px;margin:1px 2px 1px 0;display:inline-block">'+esc(v)+'</span>';}).join('');
    rows+='<td style="text-align:right">'+m+'</td>';
  });
  rows+='</tr>';
  document.getElementById('rotTable').innerHTML='<table class="cmp-table"><thead>'+hdr+'</thead><tbody>'+rows+'</tbody></table>';
})();

})();`);
    parts.push(navJs());
    parts.push('</script>');
    parts.push('</body></html>');

    return parts.join('');
  }
}
