import * as vscode from 'vscode';
import { PromptRecord } from '../core/promptHistory';
import { PROVIDER_ICONS } from './providerIcons';
import { navCss, navTopbarHtml, navPagebarHtml, navJs, NAV_COMMANDS } from './navShared';
import { designTokensCss } from './designSystem';

export class PromptHistoryViewProvider {
  static readonly viewType = 'aiInsights.promptHistory';
  private static currentPanel: vscode.WebviewPanel | undefined;

  static createPanel(context: vscode.ExtensionContext, records: PromptRecord[], refreshing = false): vscode.WebviewPanel {
    const logoPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'logo.png');

    if (PromptHistoryViewProvider.currentPanel) {
      const logoUri = PromptHistoryViewProvider.currentPanel.webview.asWebviewUri(logoPath).toString();
      PromptHistoryViewProvider.currentPanel.webview.html = PromptHistoryViewProvider.buildHtml(records, refreshing, logoUri);
      PromptHistoryViewProvider.currentPanel.reveal(vscode.ViewColumn.One);
      return PromptHistoryViewProvider.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      PromptHistoryViewProvider.viewType,
      'Prompt History',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'assets')],
      },
    );
    const logoUri = panel.webview.asWebviewUri(logoPath).toString();
    panel.webview.html = PromptHistoryViewProvider.buildHtml(records, refreshing, logoUri);

    panel.webview.onDidReceiveMessage(
      (message) => {
        const navCmd = NAV_COMMANDS[message.command];
        if (navCmd) { vscode.commands.executeCommand(navCmd); return; }
        if (message.command === 'refresh') {
          vscode.commands.executeCommand('aiInsights.showPromptHistory');
        } else if (message.command === 'openFile' && message.path) {
          vscode.workspace.openTextDocument(vscode.Uri.file(message.path))
            .then(doc => vscode.window.showTextDocument(doc))
            .then(undefined, () => vscode.window.showErrorMessage(`Cannot open: ${message.path}`));
        }
      },
      undefined,
      context.subscriptions,
    );

    panel.onDidDispose(() => {
      PromptHistoryViewProvider.currentPanel = undefined;
    }, null, context.subscriptions);

    PromptHistoryViewProvider.currentPanel = panel;
    return panel;
  }

  private static buildHtml(records: PromptRecord[], refreshing = false, logoUri = ''): string {
    const recent = records.slice(0, 50);
    const serialized = JSON.stringify(recent.map(r => ({
      timestamp: r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp),
      provider: r.provider,
      sessionId: r.sessionId,
      model: r.model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cachedTokens: r.cachedTokens,
      cost: r.cost,
      responseMs: r.responseMs,
      fileContext: r.fileContext,
      turnCount: r.turnCount,
      promptPreview: r.promptPreview ?? '',
      sourceFile: r.sourceFile ?? '',
    }))).replace(/<\/script>/gi, '<\\/script>');

    const p: string[] = [];

    p.push('<!DOCTYPE html><html lang="en"><head>');
    p.push('<meta charset="UTF-8">');
    p.push('<meta name="viewport" content="width=device-width, initial-scale=1.0">');
    p.push('<title>Prompt History</title>');
    p.push('<style>');
    p.push(designTokensCss());
    p.push('*{margin:0;padding:0;box-sizing:border-box;}');
    p.push('body{font-family:var(--font-primary);background:var(--bg-base);color:var(--text-primary);padding:0;line-height:1.6;}');
    p.push(navCss());
    p.push('.btn{background:transparent;border:1px solid var(--border);color:var(--text-primary);padding:8px 16px;border-radius:4px;cursor:pointer;font-size:0.85em;font-weight:500;transition:all 0.2s;}');
    p.push('.btn:hover{background:rgba(255,255,255,0.05);}');
    p.push('.btn-primary{background:var(--primary);color:white;border:none;box-shadow:0 0 15px var(--primary-glow);}');
    p.push('.btn-primary:hover{background:#005bc1;}');
    p.push('.btn.is-loading{opacity:0.7;pointer-events:none;}');
    p.push('.btn.is-loading::after{content:"";display:inline-block;width:10px;height:10px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 0.7s linear infinite;margin-left:6px;vertical-align:middle;}');
    p.push('.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px;margin-bottom:32px;}');
    p.push('.card{background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:20px;text-align:center;transition:transform 0.2s;}');
    p.push('.card:hover{transform:translateY(-2px);border-color:rgba(0,122,255,0.3);}');
    p.push('.card-label{font-size:0.75em;text-transform:uppercase;color:var(--text-secondary);letter-spacing:0.05em;margin-bottom:8px;font-weight:600;}');
    p.push('.card-value{font-size:1.8em;font-weight:600;font-family:var(--font-data);}');
    p.push('.card-sub{font-size:0.8em;color:var(--text-secondary);margin-top:4px;opacity:0.7;}');
    p.push('.sparkline-section{background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;padding:24px;margin-bottom:32px;}');
    p.push('.sparkline-title{font-size:0.82em;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:16px;display:flex;align-items:center;gap:8px;}');
    p.push('.sparkline-wrap{position:relative;height:120px;}');
    p.push('.section{background:var(--bg-surface);border:1px solid var(--border);border-radius:8px;overflow-x:auto;margin-bottom:32px;}');
    p.push('table{width:100%;min-width:900px;border-collapse:collapse;}');
    p.push('th{text-align:left;padding:11px 14px;background:var(--bg-surface-high);color:var(--text-secondary);font-size:0.72em;text-transform:uppercase;letter-spacing:0.05em;border-bottom:1px solid var(--border);font-weight:500;white-space:nowrap;}');
    p.push('td{padding:10px 14px;border-bottom:1px solid var(--border);font-size:0.875em;vertical-align:middle;}');
    p.push('tr:last-child td{border-bottom:none;}');
    p.push('tr:hover td{background:rgba(255,255,255,0.02);}');
    p.push('.provider-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:3px;font-size:0.8em;font-weight:500;white-space:nowrap;}');
    p.push('.p-copilot{background:rgba(0,200,100,0.1);color:#00c864;}');
    p.push('.p-antigravity{background:rgba(240,147,251,0.1);color:#f093fb;}');
    p.push('.p-claudeCode{background:rgba(0,122,255,0.1);color:#007AFF;}');
    p.push('.p-codex{background:rgba(52,199,89,0.1);color:#34C759;}');
    p.push('.model-tag{display:inline-block;padding:2px 7px;background:var(--bg-surface-high);border-radius:3px;font-size:0.78em;font-family:var(--font-data);color:var(--text-secondary);}');
    p.push('.turn-badge{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:3px;font-size:0.78em;font-family:var(--font-data);background:rgba(255,159,10,0.12);color:#FF9F0A;}');
    p.push('.cost-cell{font-family:var(--font-data);font-size:0.88em;color:#39FF14;font-weight:600;}');
    p.push('.tok-wrap{min-width:180px;}');
    p.push('.tok-bar{display:flex;height:5px;border-radius:3px;overflow:hidden;margin-bottom:5px;background:rgba(255,255,255,0.04);}');
    p.push('.tok-labels{display:flex;gap:8px;font-family:var(--font-data);font-size:0.75em;flex-wrap:wrap;}');
    p.push('.tok-chip{display:inline-flex;align-items:center;gap:3px;white-space:nowrap;}');
    p.push('.tok-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;}');
    p.push('.resp-cell{font-family:var(--font-data);font-size:0.82em;color:var(--text-secondary);}');
    p.push('.empty{padding:48px;text-align:center;color:var(--text-secondary);font-size:0.9em;}');
    p.push('.filter-bar{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap;}');
    p.push('.filter-bar select{background:var(--bg-surface);border:1px solid var(--border);color:var(--text-primary);padding:7px 12px;border-radius:4px;font-size:0.85em;outline:none;}');
    p.push('.filter-bar label{font-size:0.8em;color:var(--text-secondary);}');
    p.push('.info-note{font-size:0.78em;color:var(--text-secondary);opacity:0.6;margin-left:auto;}');
    p.push('.preview-cell{max-width:260px;font-size:0.82em;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:default;}');
    p.push('.preview-cell.has-text{color:var(--text-primary);}');
    p.push('.btn-open{background:transparent;border:1px solid var(--border);color:var(--text-secondary);padding:3px 8px;border-radius:3px;cursor:pointer;font-size:0.75em;white-space:nowrap;transition:all 0.15s;}');
    p.push('.btn-open:hover{border-color:var(--primary);color:var(--primary);}');
    p.push('.loading-bar{position:fixed;top:0;left:0;right:0;z-index:100;height:3px;background:rgba(0,122,255,0.15);overflow:hidden;}');
    p.push('.loading-bar-fill{height:100%;width:40%;background:var(--primary);border-radius:0 2px 2px 0;animation:loadslide 1.4s ease-in-out infinite;}');
    p.push('@keyframes loadslide{0%{transform:translateX(-100%)}60%{transform:translateX(280%)}100%{transform:translateX(280%)}}');
    p.push('.loading-banner{background:rgba(0,122,255,0.08);border-bottom:1px solid rgba(0,122,255,0.2);padding:8px 32px;font-size:0.82em;color:#6db3ff;display:flex;align-items:center;gap:8px;}');
    p.push('.loading-spinner{width:12px;height:12px;border:2px solid rgba(0,122,255,0.3);border-top-color:var(--primary);border-radius:50%;animation:spin 0.7s linear infinite;flex-shrink:0;}');
    p.push('@keyframes spin{to{transform:rotate(360deg)}}');
    p.push('</style></head><body>');

    p.push(navTopbarHtml(logoUri, true, refreshing));
    if (refreshing) {
      p.push('<div class="loading-bar"><div class="loading-bar-fill"></div></div>');
      p.push('<div class="loading-banner"><div class="loading-spinner"></div>Loading prompt history…</div>');
    }
    p.push(navPagebarHtml('promptHistory', 'Prompt History'));
    p.push('<div class="ns-content">');

    p.push('<div class="summary-grid">');
    p.push('  <div class="card"><div class="card-label">Prompts (today)</div><div class="card-value" id="statToday">0</div><div class="card-sub" id="statTodaySub">0 sessions</div></div>');
    p.push('  <div class="card"><div class="card-label">Avg Cost / Prompt</div><div class="card-value" id="statAvgCost">$0.00</div><div class="card-sub" id="statTotalCost">$0 total shown</div></div>');
    p.push('  <div class="card"><div class="card-label">Avg Turns / Prompt</div><div class="card-value" id="statAvgTurns">0</div><div class="card-sub">agent tool-call turns</div></div>');
    p.push('  <div class="card"><div class="card-label">Avg Response Time</div><div class="card-value" id="statAvgResp">-</div><div class="card-sub" id="statAvgRespSub">first to last turn</div></div>');
    p.push('  <div class="card"><div class="card-label">Top Model</div><div class="card-value" id="statTopModel" style="font-size:0.95em;word-break:break-all">-</div><div class="card-sub" id="statTopModelSub"></div></div>');
    p.push('</div>');

    p.push('<div class="sparkline-section">');
    p.push('  <div class="sparkline-title">Cost per prompt - last 50 <span style="font-weight:400;opacity:0.5">(oldest → newest)</span></div>');
    p.push('  <div class="sparkline-wrap"><canvas id="sparkline"></canvas></div>');
    p.push('</div>');

    p.push('<div class="filter-bar">');
    p.push('  <label>Show</label>');
    p.push('  <select id="limitSelect"><option value="10">Last 10</option><option value="25">Last 25</option><option value="50" selected>Last 50</option></select>');
    p.push('  <select id="providerFilter"><option value="">All providers</option><option value="copilot">Copilot</option><option value="claudeCode">Claude Code</option><option value="antigravity">Antigravity</option><option value="codex">Codex</option><option value="jetbrainsAI">JetBrains AI</option><option value="visualStudio">Visual Studio</option></select>');
    p.push('  <span class="info-note">Grouped by 2-min gap - each row is one user prompt + all agent turns</span>');
    p.push('</div>');

    p.push('<div class="section"><div id="tableContainer"></div></div>');
    p.push('</div><!-- /ns-content -->');

    p.push('<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>');
    p.push(`<script>window.__RECORDS__=${serialized};</script>`);
    p.push(`<script>window.__ICONS__=${JSON.stringify(PROVIDER_ICONS)};</script>`);

    p.push('<script>');
    p.push('(function(){');
    p.push('var vscode=acquireVsCodeApi();');
    p.push('window.vscode=vscode;');
    p.push('var ALL=window.__RECORDS__||[];');
    p.push('var ICONS=window.__ICONS__||{};');
    p.push('var sparkChart;');
    p.push('var currentRows=[];');

    p.push('function _clr(){document.querySelectorAll(".is-loading").forEach(function(e){e.classList.remove("is-loading");});var r=document.getElementById("btnRefresh");if(r)r.textContent="\u21ba Refresh";}');
    p.push('var _rb=document.getElementById("btnRefresh");if(_rb){_rb.addEventListener("click",function(){_rb.classList.add("is-loading");_rb.textContent="\u27f3 Refreshing\u2026";vscode.postMessage({command:"refresh"});setTimeout(_clr,5000);});}');
    p.push('document.getElementById("limitSelect").onchange=render;');
    p.push('document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible"){_clr();}});');
    p.push('document.getElementById("providerFilter").onchange=render;');

    p.push('function fmt(n){if(n>=1e6)return(n/1e6).toFixed(1)+"M";if(n>=1e3)return(n/1e3).toFixed(1)+"K";return String(n||0);}');
    p.push('function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}');
    p.push('function fmtTime(iso){var d=new Date(iso);var now=new Date();var todayStart=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();var t=d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});if(d.getTime()>=todayStart)return"Today "+t;return d.toLocaleDateString([],{month:"short",day:"numeric"})+" "+t;}');
    p.push('function fmtMs(ms){if(ms<=0||ms>7200000)return"-";var s=Math.floor(ms/1000);if(s<60)return s+"s";var m=Math.floor(s/60);return m+"m "+(s%60)+"s";}');
    p.push('function badge(p){return"<span class=\\"provider-badge p-"+esc(p)+"\\">"+(ICONS[p]||"")+esc(p)+"</span>";}');
    p.push('function tokRow(r){');
    p.push('  var total=(r.inputTokens+r.outputTokens)||1;');
    p.push('  var slots=[{k:"inputTokens",c:"#007AFF",l:"In"},{k:"outputTokens",c:"#39FF14",l:"Out"},{k:"cachedTokens",c:"#FF9F0A",l:"Cache"}];');
    p.push('  var segs=slots.filter(function(s){return r[s.k]>0;}).map(function(s){return"<div style=\\"flex:none;width:"+(r[s.k]/total*100).toFixed(1)+"%;background:"+s.c+";height:100%;\\"></div>";}).join("");');
    p.push('  var chips=slots.filter(function(s){return r[s.k]>0;}).map(function(s){return"<span class=\\"tok-chip\\"><span class=\\"tok-dot\\" style=\\"background:"+s.c+"\\"></span>"+s.l+" <span style=\\"color:"+s.c+"\\">"+fmt(r[s.k])+"</span></span>";}).join("");');
    p.push('  return"<div class=\\"tok-wrap\\"><div class=\\"tok-bar\\">"+(segs||"<div style=\\"flex:1;background:rgba(255,255,255,0.08)\\"></div>")+"</div><div class=\\"tok-labels\\">"+chips+"</div></div>";');
    p.push('}');

    p.push('function filtered(){');
    p.push('  var pv=document.getElementById("providerFilter").value;');
    p.push('  var lv=parseInt(document.getElementById("limitSelect").value)||10;');
    p.push('  return(pv?ALL.filter(function(r){return r.provider===pv;}):ALL).slice(0,lv);');
    p.push('}');

    p.push('function updateStats(rows){');
    p.push('  var now=new Date();var todayStart=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();');
    p.push('  var todayRows=rows.filter(function(r){return new Date(r.timestamp).getTime()>=todayStart;});');
    p.push('  var todaySessions=new Set(todayRows.map(function(r){return r.sessionId;})).size;');
    p.push('  var totalCost=rows.reduce(function(a,r){return a+r.cost;},0);');
    p.push('  var avgCost=rows.length?totalCost/rows.length:0;');
    p.push('  var totalTurns=rows.reduce(function(a,r){return a+r.turnCount;},0);');
    p.push('  var avgTurns=rows.length?(totalTurns/rows.length).toFixed(1):0;');
    p.push('  var respRows=rows.filter(function(r){return r.responseMs>0&&r.responseMs<7200000;});');
    p.push('  var avgResp=respRows.length?respRows.reduce(function(a,r){return a+r.responseMs;},0)/respRows.length:0;');
    p.push('  var modelCounts={};rows.forEach(function(r){modelCounts[r.model]=(modelCounts[r.model]||0)+1;});');
    p.push('  var topModel=Object.keys(modelCounts).sort(function(a,b){return modelCounts[b]-modelCounts[a];})[0]||"-";');
    p.push('  document.getElementById("statToday").textContent=todayRows.length;');
    p.push('  document.getElementById("statTodaySub").textContent=todaySessions+" session"+(todaySessions!==1?"s":"");');
    p.push('  document.getElementById("statAvgCost").textContent="$"+avgCost.toFixed(4);');
    p.push('  document.getElementById("statTotalCost").textContent="$"+totalCost.toFixed(4)+" total shown";');
    p.push('  document.getElementById("statAvgTurns").textContent=avgTurns;');
    p.push('  document.getElementById("statAvgResp").textContent=fmtMs(avgResp);');
    p.push('  document.getElementById("statTopModel").textContent=topModel;');
    p.push('  document.getElementById("statTopModelSub").textContent=(modelCounts[topModel]||0)+" prompts";');
    p.push('}');

    p.push('function updateSparkline(){');
    p.push('  var last50=ALL.slice(0,50).reverse();');
    p.push('  if(sparkChart)sparkChart.destroy();');
    p.push('  sparkChart=new Chart(document.getElementById("sparkline"),{type:"line",data:{labels:last50.map(function(_,i){return"#"+(i+1);}),datasets:[{data:last50.map(function(r){return r.cost;}),borderColor:"#007AFF",backgroundColor:"rgba(0,122,255,0.08)",borderWidth:2,pointRadius:3,pointBackgroundColor:"#007AFF",tension:0.3,fill:true}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:function(c){return"$"+c.parsed.y.toFixed(4)+" · "+last50[c.dataIndex].turnCount+" turn"+(last50[c.dataIndex].turnCount!==1?"s":"");}}}},scales:{x:{display:false},y:{beginAtZero:true,grid:{color:"rgba(255,255,255,0.04)"},ticks:{color:"#c1c6d7",callback:function(v){return"$"+Number(v).toFixed(3);}}}}}});');
    p.push('}');

    p.push('function render(){');
    p.push('  currentRows=filtered();');
    p.push('  var rows=currentRows;');
    p.push('  updateStats(rows);');
    p.push('  if(rows.length===0){document.getElementById("tableContainer").innerHTML="<div class=\\"empty\\">No prompt records yet. Use an AI assistant then refresh.</div>";return;}');
    p.push('  var trs=rows.map(function(r,i){');
    p.push('    var ctx=r.fileContext?(r.fileContext.replace(/\\\\/g,"/").split("/").pop()||r.fileContext):"-";');
    p.push('    var turns=r.turnCount>1?"<span class=\\"turn-badge\\">&#128279; "+r.turnCount+" turns</span>":"<span style=\\"opacity:0.4;font-size:0.8em\\">1 turn</span>";');
    p.push('    var preview=r.promptPreview?("<span class=\\"preview-cell has-text\\" title=\\""+esc(r.promptPreview)+"\\">"+ esc(r.promptPreview.substring(0,80))+(r.promptPreview.length>80?"…":"")+"</span>"):"<span class=\\"preview-cell\\" style=\\"opacity:0.3\\">—</span>";');
    p.push('    var openBtn=r.sourceFile?"<button class=\\"btn-open\\" onclick=\\"openFile("+i+")\\">Open log</button>":"";');
    p.push('    return"<tr>"');
    p.push('      +"<td style=\\"color:var(--text-secondary);font-size:0.82em;white-space:nowrap\\">"+fmtTime(r.timestamp)+"</td>"');
    p.push('      +"<td>"+badge(r.provider)+"</td>"');
    p.push('      +"<td><span class=\\"model-tag\\">"+esc(r.model)+"</span></td>"');
    p.push('      +"<td>"+turns+"</td>"');
    p.push('      +"<td>"+preview+"</td>"');
    p.push('      +"<td>"+tokRow(r)+"</td>"');
    p.push('      +"<td class=\\"cost-cell\\">$"+r.cost.toFixed(4)+"</td>"');
    p.push('      +"<td class=\\"resp-cell\\">"+fmtMs(r.responseMs)+"</td>"');
    p.push('      +"<td style=\\"font-size:0.78em;color:var(--text-secondary);white-space:nowrap\\" title=\\""+esc(r.fileContext)+"\\">"+esc(ctx)+"</td>"');
    p.push('      +"<td>"+openBtn+"</td>"');
    p.push('      +"</tr>";');
    p.push('  }).join("");');
    p.push('  document.getElementById("tableContainer").innerHTML="<table><thead><tr><th>Time</th><th>Provider</th><th>Model</th><th>Turns</th><th>Prompt</th><th>Token Breakdown</th><th>Cost</th><th>Response</th><th>Workspace</th><th></th></tr></thead><tbody>"+trs+"</tbody></table>";');
    p.push('}');

    p.push('function openFile(idx){var r=currentRows[idx];if(r&&r.sourceFile)vscode.postMessage({command:"openFile",path:r.sourceFile});}');
    p.push('window.openFile=openFile;');
    p.push('Chart.defaults.font.family="var(--font-primary)";');
    p.push('Chart.defaults.color="#c1c6d7";');
    p.push('updateSparkline();');
    p.push('render();');
    p.push('})();');
    p.push(navJs());
    p.push('</script>');
    p.push('</body></html>');

    return p.join('');
  }
}
