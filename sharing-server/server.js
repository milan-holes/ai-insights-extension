const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'snapshots.json');
const SNAPSHOT_TTL_HOURS = Number(process.env.SNAPSHOT_TTL_HOURS || 72);
const MAX_BODY_BYTES = 2 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

const tokenCache = new Map();

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return { snapshots: {} };
  }
}

function writeStore(store) {
  const tmp = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function validateGitHubToken(token) {
  const key = crypto.createHash('sha256').update(token).digest('hex');
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user;
  }

  const response = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'AI-Insights-Sharing-Server',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    return null;
  }
  const user = await response.json();

  const allowedOrg = (process.env.ALLOWED_GITHUB_ORG || '').trim();
  if (allowedOrg) {
    const orgResponse = await fetch(`https://api.github.com/orgs/${allowedOrg}/members/${user.login}`, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_ORG_CHECK_TOKEN || token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'AI-Insights-Sharing-Server',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (orgResponse.status !== 204) {
      return null;
    }
  }

  tokenCache.set(key, {
    user: { id: user.id, login: user.login, name: user.name, avatarUrl: user.avatar_url },
    expiresAt: Date.now() + 10 * 60 * 1000,
  });
  return tokenCache.get(key).user;
}

function pruneExpired(store) {
  const now = Date.now();
  for (const [id, snapshot] of Object.entries(store.snapshots)) {
    if (snapshot.expiresAt && Date.parse(snapshot.expiresAt) <= now) {
      delete store.snapshots[id];
    }
  }
}

async function handleSnapshotUpload(req, res) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    json(res, 401, { error: 'Unauthorized' });
    return;
  }

  const user = await validateGitHubToken(auth.slice(7));
  if (!user) {
    json(res, 401, { error: 'Unauthorized' });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    json(res, 400, { error: String(error.message || error) });
    return;
  }

  if (!payload || typeof payload !== 'object' || !payload.metrics) {
    json(res, 400, { error: 'Body must contain a dashboard snapshot with metrics.' });
    return;
  }

  const id = crypto.randomBytes(18).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SNAPSHOT_TTL_HOURS * 60 * 60 * 1000).toISOString();
  const store = readStore();
  pruneExpired(store);
  store.snapshots[id] = {
    id,
    owner: user,
    createdAt: now.toISOString(),
    expiresAt,
    snapshot: payload,
  };
  writeStore(store);

  json(res, 201, {
    snapshotId: id,
    dashboardUrl: `${BASE_URL}/dashboard/${id}`,
    expiresAt,
  });
}

function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return Math.round(n).toLocaleString();
}

function money(n) {
  if (!Number.isFinite(n) || n === 0) return '$0.00';
  if (n < 0.01) return `$${(n * 100).toFixed(3)}¢`;
  return `$${n.toFixed(2)}`;
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function providerRows(metrics) {
  const providers = metrics.byProvider || {};
  const names = {
    copilot: 'GitHub Copilot',
    antigravity: 'Antigravity',
    claudeCode: 'Claude Code',
    codex: 'Codex',
    jetbrainsAI: 'JetBrains AI',
    visualStudio: 'Visual Studio',
  };
  return Object.entries(providers)
    .filter(([, p]) => p && p.totalTokens > 0)
    .sort(([, a], [, b]) => b.totalTokens - a.totalTokens)
    .map(([id, p]) => `<tr><td>${esc(names[id] || id)}</td><td>${fmt(p.totalTokens)}</td><td>${fmt(p.sessions)}</td><td>${money(p.estimatedCost)}</td></tr>`)
    .join('');
}

function dashboardPage(record) {
  const snapshot = record.snapshot;
  const metrics = snapshot.metrics;
  const source = snapshot.source || {};
  const rows = providerRows(metrics) || '<tr><td colspan="4" class="muted center">No provider data</td></tr>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Insights Shared Dashboard</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--panel2:#1f2430;--text:#edf0f7;--muted:#9ba4b5;--line:#2b3240;--blue:#5aa9ff;--green:#45d483}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5}
header{padding:22px 24px;border-bottom:1px solid var(--line);background:var(--panel)}
.wrap{max-width:980px;margin:0 auto;padding:28px 20px}
.brand{font-weight:700;font-size:18px}.meta{color:var(--muted);font-size:12px;margin-top:4px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:26px}
.card,.section{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:18px}
.label{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}.value{font-size:30px;font-weight:700;margin-top:4px}.blue{color:var(--blue)}.green{color:var(--green)}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 12px}
table{width:100%;border-collapse:collapse}th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:left;font-size:13px}th{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.06em}tr:last-child td{border-bottom:0}.muted{color:var(--muted)}.center{text-align:center}
footer{color:var(--muted);font-size:11px;text-align:center;padding:20px}
</style>
</head>
<body>
<header><div class="wrap" style="padding:0 20px"><div class="brand">AI Insights Shared Dashboard</div><div class="meta">Shared by @${esc(record.owner.login)} · ${esc(source.workspaceName || 'Unknown workspace')} · generated ${esc(new Date(snapshot.generatedAt || record.createdAt).toLocaleString())}</div></div></header>
<main class="wrap">
<h2>Today</h2>
<div class="grid">
<div class="card"><div class="label">Tokens</div><div class="value blue">${fmt(metrics.today?.totalTokens || 0)}</div><div class="meta">${fmt(metrics.today?.sessions || 0)} sessions</div></div>
<div class="card"><div class="label">Cost</div><div class="value">${money(metrics.today?.estimatedCost || 0)}</div><div class="meta">${fmt(metrics.today?.interactions || 0)} interactions</div></div>
<div class="card"><div class="label">Output</div><div class="value">${fmt(metrics.today?.outputTokens || 0)}</div><div class="meta">${fmt(metrics.today?.inputTokens || 0)} input</div></div>
</div>
<h2>This Month</h2>
<div class="grid">
<div class="card"><div class="label">Tokens</div><div class="value blue">${fmt(metrics.currentMonth?.totalTokens || 0)}</div><div class="meta">${fmt(metrics.currentMonth?.sessions || 0)} sessions</div></div>
<div class="card"><div class="label">Cost</div><div class="value">${money(metrics.currentMonth?.estimatedCost || 0)}</div><div class="meta">${fmt(metrics.currentMonth?.interactions || 0)} interactions</div></div>
<div class="card"><div class="label">Cache Hit</div><div class="value green">${Math.round((metrics.cache?.cacheHitRate || 0) * 100)}%</div><div class="meta">${money(metrics.cache?.cacheSavingsUsd || 0)} saved</div></div>
</div>
<section class="section"><h2>All-Time By Provider</h2><table><thead><tr><th>Provider</th><th>Tokens</th><th>Sessions</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table></section>
</main>
<footer>Expires ${esc(new Date(record.expiresAt).toLocaleString())}</footer>
</body>
</html>`;
}

function handleDashboard(req, res, id) {
  const store = readStore();
  pruneExpired(store);
  const record = store.snapshots[id];
  if (!record) {
    html(res, 404, '<!doctype html><title>Not found</title><body style="font-family:system-ui">Snapshot not found or expired.</body>');
    if (Object.keys(store.snapshots).length !== Object.keys(readStore().snapshots || {}).length) {
      writeStore(store);
    }
    return;
  }
  html(res, 200, dashboardPage(record));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, BASE_URL);
    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/snapshots') {
      await handleSnapshotUpload(req, res);
      return;
    }
    const match = url.pathname.match(/^\/dashboard\/([A-Za-z0-9_-]+)$/);
    if (req.method === 'GET' && match) {
      handleDashboard(req, res, match[1]);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(302, { Location: '/health' });
      res.end();
      return;
    }
    json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    json(res, 500, { error: 'Internal Server Error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Insights sharing server listening on ${BASE_URL}`);
});
