/**
 * Claude Code live plan-quota fetcher.
 *
 * Reads the OAuth access token Claude Code itself already wrote to
 * `~/.claude/.credentials.json` (from `claude login`) and uses it to read
 * Anthropic's `anthropic-ratelimit-unified-5h-utilization` / `-7d-utilization`
 * response headers - the same 5-hour/weekly session-window numbers shown on
 * `claude.ai/settings/usage`. This is real plan-quota data, distinct from the
 * local session-log estimate `claudeAccountView.ts`'s `calcWindow()` computes
 * as a fallback when this is unavailable (no credentials file, disabled, or
 * the ping fails).
 *
 * No login flow of our own: this only reuses credentials that already exist
 * on disk because the user is signed into Claude Code. Never throws - every
 * failure (missing file, bad JSON, no token, network error, missing headers)
 * resolves to `null` so callers can fall back silently.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const RATE_LIMIT_ENDPOINT = 'https://api.anthropic.com/v1/messages';
/** Minimum ms between live pings - quota windows move slowly, so 5 minutes is plenty. */
export const MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export interface ClaudeRateLimitSnapshot {
  fiveHourPct: number | null;
  fiveHourResetsAt: string | null;
  sevenDayPct: number | null;
  sevenDayResetsAt: string | null;
  fetchedAt: string;
}

/**
 * Reads and parses the OAuth access token from Claude Code's local credentials
 * file. The file's shape is undocumented, so a few plausible key paths are
 * tried defensively; any failure (file missing, malformed JSON, no token
 * found) returns `null` rather than throwing.
 */
export function readClaudeOAuthAccessToken(): string | null {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    const oauth = data.claudeAiOauth as Record<string, unknown> | undefined;
    const token =
      (typeof oauth?.accessToken === 'string' && oauth.accessToken) ||
      (typeof data.accessToken === 'string' && data.accessToken) ||
      null;
    return token || null;
  } catch {
    return null;
  }
}

/** True once at least `MIN_REFRESH_INTERVAL_MS` has passed since the last successful fetch. */
export function shouldRefreshClaudeQuota(lastFetchAt: Date | null, now = new Date()): boolean {
  if (!lastFetchAt) { return true; }
  return now.getTime() - lastFetchAt.getTime() >= MIN_REFRESH_INTERVAL_MS;
}

function parsePct(header: string | null): number | null {
  if (header === null) { return null; }
  const n = parseFloat(header);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : null;
}

/**
 * Makes a minimal (max_tokens: 1) request to the Messages API using the OAuth
 * token, purely to read the rate-limit headers off the response - no message
 * content is sent beyond a single filler character, and nothing is stored
 * remotely. Anthropic includes these headers on both success and 4xx
 * responses, so a rejected request (e.g. insufficient balance) still yields
 * usable quota data.
 */
export async function fetchClaudeRateLimitHeaders(accessToken: string): Promise<ClaudeRateLimitSnapshot | null> {
  try {
    const response = await fetch(RATE_LIMIT_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'x' }],
      }),
    });

    const fiveHourPct = parsePct(response.headers.get('anthropic-ratelimit-unified-5h-utilization'));
    const sevenDayPct = parsePct(response.headers.get('anthropic-ratelimit-unified-7d-utilization'));
    if (fiveHourPct === null && sevenDayPct === null) { return null; }

    return {
      fiveHourPct,
      fiveHourResetsAt: response.headers.get('anthropic-ratelimit-unified-5h-reset'),
      sevenDayPct,
      sevenDayResetsAt: response.headers.get('anthropic-ratelimit-unified-7d-reset'),
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
