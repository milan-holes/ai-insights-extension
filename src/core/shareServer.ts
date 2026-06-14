import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as crypto from 'crypto';
import { AggregatedMetrics } from '../types';

const AUTO_STOP_MS = 30 * 60 * 1000;

export interface ShareServerStartOptions {
  publicHost?: string;
  remoteName?: string;
  fixedPort?: number;
}

export class ShareServer {
  private server: http.Server | null = null;
  private _token = '';
  private _port = 0;
  private _hosts: string[] = [];
  private _warning: string | null = null;
  private autoStopTimer: NodeJS.Timeout | null = null;

  get isRunning(): boolean { return this.server !== null; }

  get shareUrl(): string | null {
    if (!this.server) { return null; }
    return this.shareUrls[0] ?? null;
  }

  get shareUrls(): string[] {
    if (!this.server) { return []; }
    return this._hosts.map(host => `http://${host}:${this._port}/share/${this._token}`);
  }

  get warning(): string | null { return this._warning; }

  get localUrl(): string | null {
    if (!this.server) { return null; }
    return `http://localhost:${this._port}/share/${this._token}`;
  }

  get port(): number { return this._port; }

  /** WSL internal IP (eth0 / first non-internal IPv4), if running inside WSL. Null otherwise. */
  get wslInternalIp(): string | null {
    try {
      const ifaces = os.networkInterfaces();
      for (const [name, infos] of Object.entries(ifaces)) {
        for (const info of (infos ?? [])) {
          if (info.family === 'IPv4' && !info.internal && /^172\.|^10\./.test(info.address)) {
            if (/eth|wsl/i.test(name)) { return info.address; }
          }
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  async start(metrics: AggregatedMetrics, options: ShareServerStartOptions = {}): Promise<string> {
    this.stop();
    this._token = crypto.randomBytes(12).toString('hex');
    const requestedPort = options.fixedPort && options.fixedPort > 0 ? options.fixedPort : 0;
    this._port = await findFreePort(requestedPort);
    const hostInfo = getShareHosts(options);
    this._hosts = hostInfo.hosts;
    this._warning = hostInfo.warning;
    const html = buildShareHtml(metrics);

    this.server = http.createServer((req, res) => {
      if (req.url === `/share/${this._token}`) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this._port, '0.0.0.0', resolve);
      this.server!.once('error', reject);
    });

    this.autoStopTimer = setTimeout(() => this.stop(), AUTO_STOP_MS);
    return this.shareUrl!;
  }

  stop(): void {
    if (this.autoStopTimer) { clearTimeout(this.autoStopTimer); this.autoStopTimer = null; }
    if (this.server) { this.server.close(); this.server = null; }
    this._hosts = [];
    this._warning = null;
  }
}

function findFreePort(preferred = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(preferred, () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.once('error', (err: NodeJS.ErrnoException) => {
      if (preferred > 0 && err.code === 'EADDRINUSE') {
        findFreePort(0).then(resolve, reject);
      } else {
        reject(err);
      }
    });
  });
}

interface ShareHostInfo {
  hosts: string[];
  warning: string | null;
}

function getShareHosts(options: ShareServerStartOptions): ShareHostInfo {
  const configuredHost = normalizeHost(options.publicHost);
  if (configuredHost) {
    return {
      hosts: [configuredHost],
      warning: options.remoteName ? remoteWarning(options.remoteName) : null,
    };
  }

  const candidates: Array<{ name: string; address: string; score: number }> = [];
  try {
    const ifaces = os.networkInterfaces();
    for (const [name, infos] of Object.entries(ifaces)) {
      for (const info of (infos ?? [])) {
        if (info.family !== 'IPv4' || info.internal) { continue; }
        candidates.push({ name, address: info.address, score: scoreAddress(name, info.address) });
      }
    }
  } catch {
    return {
      hosts: ['127.0.0.1'],
      warning: 'Could not detect a LAN address for sharing. The generated link will only work on this computer. Set aiInsights.shareHost to your computer Wi-Fi/LAN IP for phone access.',
    };
  }

  candidates.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
  const hosts = [...new Set(candidates.map(candidate => candidate.address))];
  if (hosts.length === 0) {
    return {
      hosts: ['127.0.0.1'],
      warning: 'No LAN network address was found. The generated link will only work on this computer until you connect to a network or set aiInsights.shareHost.',
    };
  }

  const warning = buildHostWarning(options.remoteName, candidates);
  return { hosts, warning };
}

function normalizeHost(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) { return null; }
  const withoutProtocol = trimmed.replace(/^https?:\/\//i, '');
  return withoutProtocol.split('/')[0].split(':')[0] || null;
}

function scoreAddress(name: string, address: string): number {
  const lowerName = name.toLowerCase();
  let score = 0;
  if (isLikelyLanAddress(address)) { score += 20; }
  if (address.startsWith('192.168.')) { score += 30; }
  if (address.startsWith('10.')) { score += 20; }
  if (isPrivate172Address(address)) { score += 5; }
  if (/wi-?fi|wireless|wlan|en0|eth|ethernet/i.test(name)) { score += 10; }
  if (/docker|br-|veth|virbr|vmnet|vbox|tailscale|zt|wsl/i.test(lowerName)) { score -= 40; }
  return score;
}

function isLikelyLanAddress(address: string): boolean {
  return address.startsWith('10.') || address.startsWith('192.168.') || isPrivate172Address(address);
}

function isPrivate172Address(address: string): boolean {
  const parts = address.split('.').map(part => Number(part));
  return parts.length === 4 && parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

function buildHostWarning(remoteName: string | undefined, candidates: Array<{ name: string; address: string }>): string | null {
  if (remoteName) { return remoteWarning(remoteName); }
  const primary = candidates[0];
  if (!primary) { return null; }
  const name = primary.name.toLowerCase();
  if (/docker|br-|veth|virbr|vmnet|vbox|wsl/i.test(name) || isPrivate172Address(primary.address)) {
    return 'The selected share URL looks like a virtual/WSL/container network address. It may open on this computer but fail from your phone. Set aiInsights.shareHost to your computer Wi-Fi/LAN IP, and make sure the firewall allows the chosen port.';
  }
  return null;
}

function remoteWarning(remoteName: string): string {
  const name = remoteName === 'wsl' ? 'WSL' : `VS Code Remote (${remoteName})`;
  return `${name} is serving this page from the remote extension host. If the link works locally but not on your phone, use your host computer LAN IP in aiInsights.shareHost and allow/forward the share port through the host firewall.`;
}

function fmt(n: number): string {
  if (n >= 1_000_000) { return (n / 1_000_000).toFixed(2) + 'M'; }
  if (n >= 1_000) { return (n / 1_000).toFixed(1) + 'K'; }
  return n.toLocaleString();
}

function fmtCost(n: number): string {
  if (n === 0) { return '$0.00'; }
  if (n < 0.01) { return `$${(n * 100).toFixed(3)}¢`; }
  return `$${n.toFixed(2)}`;
}

function buildShareHtml(m: AggregatedMetrics): string {
  const now = new Date().toLocaleString();
  const cacheHitPct = Math.round(m.cache.cacheHitRate * 100);

  const providerRows = Object.entries(m.byProvider)
    .filter(([, p]) => p.totalTokens > 0)
    .sort(([, a], [, b]) => b.totalTokens - a.totalTokens)
    .map(([id, p]) => {
      const name = ({ copilot: 'Copilot', antigravity: 'Antigravity', claudeCode: 'Claude Code', codex: 'Codex', jetbrainsAI: 'JetBrains AI' } as Record<string, string>)[id] ?? id;
      return `<tr>
        <td>${name}</td>
        <td>${fmt(p.totalTokens)}</td>
        <td>${fmt(p.sessions)}</td>
        <td>${fmtCost(p.estimatedCost)}</td>
      </tr>`;
    }).join('');

  const todayProvRows = Object.entries(m.todayByProvider)
    .filter(([, p]) => p.totalTokens > 0)
    .sort(([, a], [, b]) => b.totalTokens - a.totalTokens)
    .map(([id, p]) => {
      const name = ({ copilot: 'Copilot', antigravity: 'Antigravity', claudeCode: 'Claude Code', codex: 'Codex', jetbrainsAI: 'JetBrains AI' } as Record<string, string>)[id] ?? id;
      return `<tr><td>${name}</td><td>${fmt(p.totalTokens)}</td><td>${fmtCost(p.estimatedCost)}</td></tr>`;
    }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Insights - Usage Snapshot</title>
<style>
  :root {
    --bg: #0e0e0e; --surface: #1a1919; --surface-hi: #201f1f;
    --text: #e5e2e1; --muted: #8a8fa8; --border: rgba(255,255,255,0.07);
    --green: #39FF14; --blue: #007AFF; --red: #FF4D4D;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
  header { border-bottom: 1px solid var(--border); padding: 18px 32px; display: flex; align-items: center; justify-content: space-between; background: var(--surface); }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand-icon { width: 28px; height: 28px; background: linear-gradient(135deg, #3b82f6, #8b5cf6); border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 14px; }
  .brand-name { font-size: 15px; font-weight: 600; }
  .brand-sub { font-size: 12px; color: var(--muted); }
  .meta { font-size: 11px; color: var(--muted); text-align: right; }
  main { max-width: 900px; margin: 0 auto; padding: 32px 24px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 600; margin-bottom: 14px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; margin-bottom: 32px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 18px 20px; }
  .card-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
  .card-value { font-size: 1.9em; font-weight: 600; font-variant-numeric: tabular-nums; }
  .card-sub { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .section { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 22px 24px; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 9px 12px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); border-bottom: 1px solid var(--border); font-weight: 600; }
  td { padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(255,255,255,0.02); }
  .stat-row { display: flex; gap: 24px; flex-wrap: wrap; margin-bottom: 24px; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px 18px; flex: 1; min-width: 130px; }
  .stat-label { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
  .stat-val { font-size: 1.35em; font-weight: 600; }
  footer { text-align: center; padding: 24px; color: var(--muted); font-size: 11px; border-top: 1px solid var(--border); margin-top: 16px; }
  .badge { display: inline-flex; align-items: center; gap: 5px; background: rgba(57,255,20,0.08); border: 1px solid rgba(57,255,20,0.2); color: var(--green); border-radius: 4px; padding: 2px 8px; font-size: 11px; font-weight: 600; }
</style>
</head>
<body>
<header>
  <div class="brand">
    <div class="brand-icon">⚡</div>
    <div>
      <div class="brand-name">AI Insights</div>
      <div class="brand-sub">Usage Snapshot</div>
    </div>
  </div>
  <div class="meta">
    <div>Generated ${now}</div>
    <div style="margin-top:3px;"><span class="badge">LIVE SHARE</span></div>
  </div>
</header>
<main>
  <h2>Today</h2>
  <div class="cards">
    <div class="card">
      <div class="card-label">Tokens</div>
      <div class="card-value" style="color:var(--blue);">${fmt(m.today.totalTokens)}</div>
      <div class="card-sub">${m.today.sessions} session${m.today.sessions !== 1 ? 's' : ''}</div>
    </div>
    <div class="card">
      <div class="card-label">Cost</div>
      <div class="card-value">${fmtCost(m.today.estimatedCost)}</div>
      <div class="card-sub">${m.today.interactions} interactions</div>
    </div>
    <div class="card">
      <div class="card-label">Output Tokens</div>
      <div class="card-value">${fmt(m.today.outputTokens)}</div>
      <div class="card-sub">${fmt(m.today.inputTokens)} input</div>
    </div>
  </div>

  ${todayProvRows ? `<div class="section" style="margin-bottom:32px;">
    <h2>Today by Provider</h2>
    <table>
      <thead><tr><th>Provider</th><th>Tokens</th><th>Cost</th></tr></thead>
      <tbody>${todayProvRows}</tbody>
    </table>
  </div>` : ''}

  <h2>This Month</h2>
  <div class="cards">
    <div class="card">
      <div class="card-label">Total Tokens</div>
      <div class="card-value" style="color:var(--blue);">${fmt(m.currentMonth.totalTokens)}</div>
      <div class="card-sub">${m.currentMonth.sessions} sessions</div>
    </div>
    <div class="card">
      <div class="card-label">Estimated Cost</div>
      <div class="card-value">${fmtCost(m.currentMonth.estimatedCost)}</div>
      <div class="card-sub">${m.currentMonth.interactions} interactions</div>
    </div>
    <div class="card">
      <div class="card-label">Cache Hit Rate</div>
      <div class="card-value" style="color:${cacheHitPct > 50 ? 'var(--green)' : 'var(--text)'};">${cacheHitPct}%</div>
      <div class="card-sub">${fmtCost(m.cache.cacheSavingsUsd)} saved</div>
    </div>
    <div class="card">
      <div class="card-label">Output Tokens</div>
      <div class="card-value">${fmt(m.currentMonth.outputTokens)}</div>
      <div class="card-sub">${fmt(m.currentMonth.inputTokens)} input</div>
    </div>
  </div>

  <div class="section">
    <h2>All-time by Provider</h2>
    <table>
      <thead><tr><th>Provider</th><th>Tokens</th><th>Sessions</th><th>Cost</th></tr></thead>
      <tbody>${providerRows || '<tr><td colspan="4" style="color:var(--muted);text-align:center;padding:20px;">No data yet</td></tr>'}</tbody>
    </table>
  </div>
</main>
<footer>AI Insights · Shared via local network · This link expires in 30 minutes</footer>
</body>
</html>`;
}
