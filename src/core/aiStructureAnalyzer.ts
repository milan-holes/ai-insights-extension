import * as fs from 'fs';
import * as path from 'path';

export type AIProviderId =
  | 'claudeCode' | 'copilot' | 'cursor' | 'windsurf' | 'cline' | 'codex' | 'antigravity' | 'agentsMd';

export interface DetectedProvider {
  id: AIProviderId;
  label: string;
  detected: boolean;
  signals: string[]; // relative paths that triggered detection
}

export interface InstructionFile {
  relativePath: string;
  providers: AIProviderId[];
  scope: 'repo-wide' | 'scoped';
  appliesTo?: string;
  wordCount: number;
  quality: 'stub' | 'basic' | 'good' | 'rich';
  lastModified: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  relativePath: string;
  source: 'claude-skill' | 'claude-command';
}

export interface AgentInfo {
  name: string;
  description?: string;
  tools?: string[];
  relativePath: string;
  source: 'claude-agent' | 'github-agent';
}

export interface MCPServerInfo {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  type?: string;
  envKeys: string[];
  sourceFile: string;
  scope: 'project' | 'local';
}

export interface AIStructureReport {
  rootPath: string;
  generatedAt: string;
  providers: DetectedProvider[];
  instructions: InstructionFile[];
  skills: SkillInfo[];
  agents: AgentInfo[];
  mcpServers: MCPServerInfo[];
}

export const PROVIDER_LABELS: Record<AIProviderId, string> = {
  claudeCode: 'Claude Code',
  copilot: 'GitHub Copilot',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  cline: 'Cline',
  codex: 'Codex (OpenAI)',
  antigravity: 'Antigravity / Gemini',
  agentsMd: 'AGENTS.md (open standard)',
};

const PROVIDER_NAME_HINTS: Array<{ id: AIProviderId; re: RegExp }> = [
  { id: 'claudeCode', re: /\bclaude\b/i },
  { id: 'copilot', re: /\bcopilot\b/i },
  { id: 'cursor', re: /\bcursor\b/i },
  { id: 'windsurf', re: /\bwindsurf\b/i },
  { id: 'cline', re: /\bcline\b/i },
  { id: 'codex', re: /\bcodex\b/i },
  { id: 'antigravity', re: /\bantigravity\b|\bgemini\b/i },
];

function exists(p: string): boolean {
  try { return fs.existsSync(p); } catch { return false; }
}

function isNonEmptyDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory() && fs.readdirSync(p).length > 0;
  } catch { return false; }
}

function listFiles(dir: string, exts: string[]): string[] {
  try {
    return fs.readdirSync(dir)
      .filter(f => exts.some(e => f.endsWith(e)))
      .map(f => path.join(dir, f))
      .filter(f => fs.statSync(f).isFile());
  } catch { return []; }
}

function readSafe(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function wordCountAndQuality(content: string): { wordCount: number; quality: InstructionFile['quality'] } {
  const wordCount = content.trim().split(/\s+/).filter(Boolean).length;
  const quality = wordCount < 50 ? 'stub' : wordCount < 200 ? 'basic' : wordCount < 500 ? 'good' : 'rich';
  return { wordCount, quality };
}

/** Minimal YAML-ish frontmatter parser for `---\nkey: value\n---` blocks, incl. flow/block arrays for `tools:`. */
function parseFrontmatter(content: string): Record<string, string | string[]> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) { return {}; }
  const body = m[1];
  const result: Record<string, string | string[]> = {};
  const lines = body.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = /^(\w[\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) { continue; }
    const key = kv[1];
    let rest = kv[2].trim();

    // Flow sequence `[...]` may start on this line or the next (indented) one.
    if (rest === '' && i + 1 < lines.length && lines[i + 1].trim().startsWith('[')) {
      i++;
      rest = lines[i].trim();
    }
    if (rest.startsWith('[')) {
      let buf = rest;
      while (!buf.includes(']') && i + 1 < lines.length) { i++; buf += ' ' + lines[i].trim(); }
      const inner = buf.slice(buf.indexOf('[') + 1, buf.lastIndexOf(']'));
      result[key] = inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      continue;
    }

    if (rest === '' && i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
      // Block sequence.
      const arr: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        i++;
        arr.push(lines[i].replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
      }
      result[key] = arr;
      continue;
    }

    result[key] = rest.replace(/^["']|["']$/g, '');
  }
  return result;
}

const ROOT_INSTRUCTION_FILES: Array<{ rel: string; provider: AIProviderId }> = [
  { rel: 'CLAUDE.md', provider: 'claudeCode' },
  { rel: 'claude.md', provider: 'claudeCode' },
  { rel: '.cursorrules', provider: 'cursor' },
  { rel: '.windsurfrules', provider: 'windsurf' },
  { rel: '.clinerules', provider: 'cline' },
  { rel: '.codex', provider: 'codex' },
  { rel: 'AGENTS.md', provider: 'agentsMd' },
  { rel: 'GEMINI.md', provider: 'antigravity' },
  { rel: path.join('.github', 'copilot-instructions.md'), provider: 'copilot' },
];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'out', 'build', '__pycache__', 'vendor', '.venv', 'venv']);
const MAX_AGENTS_MD_SCAN = 2000;

function firstHeadingProviders(content: string): AIProviderId[] {
  const heading = /^#.*/m.exec(content)?.[0] ?? content.slice(0, 300);
  const found: AIProviderId[] = [];
  for (const { id, re } of PROVIDER_NAME_HINTS) {
    if (re.test(heading)) { found.push(id); }
  }
  return found;
}

function buildInstructionEntry(
  rootPath: string, relPath: string, owner: AIProviderId,
  scope: InstructionFile['scope'], appliesTo?: string,
): InstructionFile | null {
  const abs = path.join(rootPath, relPath);
  const content = readSafe(abs);
  if (content === null) { return null; }
  const { wordCount, quality } = wordCountAndQuality(content);
  const stat = fs.statSync(abs);
  const providers = new Set<AIProviderId>([owner, ...firstHeadingProviders(content)]);
  return {
    relativePath: relPath.split(path.sep).join('/'),
    providers: [...providers],
    scope, appliesTo, wordCount, quality,
    lastModified: stat.mtime.toISOString(),
  };
}

function scanScopedInstructions(rootPath: string): InstructionFile[] {
  const out: InstructionFile[] = [];

  for (const abs of listFiles(path.join(rootPath, '.github', 'instructions'), ['.md'])) {
    const rel = path.relative(rootPath, abs);
    const content = readSafe(abs);
    if (content === null) { continue; }
    const fm = parseFrontmatter(content);
    const applyTo = typeof fm.applyTo === 'string' ? fm.applyTo : undefined;
    const entry = buildInstructionEntry(rootPath, rel, 'copilot', applyTo && applyTo !== '**' ? 'scoped' : 'repo-wide', applyTo);
    if (entry) { out.push(entry); }
  }

  for (const abs of listFiles(path.join(rootPath, '.cursor', 'rules'), ['.mdc', '.md'])) {
    const rel = path.relative(rootPath, abs);
    const content = readSafe(abs);
    if (content === null) { continue; }
    const fm = parseFrontmatter(content);
    const globs = typeof fm.globs === 'string' ? fm.globs : undefined;
    const entry = buildInstructionEntry(rootPath, rel, 'cursor', globs ? 'scoped' : 'repo-wide', globs);
    if (entry) { out.push(entry); }
  }

  for (const abs of listFiles(path.join(rootPath, '.windsurf', 'rules'), ['.md'])) {
    const rel = path.relative(rootPath, abs);
    const content = readSafe(abs);
    if (content === null) { continue; }
    const fm = parseFrontmatter(content);
    const globs = typeof fm.globs === 'string' ? fm.globs : undefined;
    const entry = buildInstructionEntry(rootPath, rel, 'windsurf', globs ? 'scoped' : 'repo-wide', globs);
    if (entry) { out.push(entry); }
  }

  if (!exists(path.join(rootPath, '.clinerules')) || fs.statSync(path.join(rootPath, '.clinerules')).isDirectory()) {
    for (const abs of listFiles(path.join(rootPath, '.clinerules'), ['.md'])) {
      const rel = path.relative(rootPath, abs);
      const entry = buildInstructionEntry(rootPath, rel, 'cline', 'repo-wide');
      if (entry) { out.push(entry); }
    }
  }

  return out;
}

/** Nested AGENTS.md files apply only to their own directory subtree (nearest-file-wins convention). */
function scanNestedAgentsMd(rootPath: string): InstructionFile[] {
  const out: InstructionFile[] = [];
  let visited = 0;

  function walk(dir: string) {
    if (visited >= MAX_AGENTS_MD_SCAN) { return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (visited >= MAX_AGENTS_MD_SCAN) { return; }
      visited++;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) { walk(full); }
      } else if (e.name === 'AGENTS.md' && path.dirname(full) !== rootPath) {
        const rel = path.relative(rootPath, full);
        const entry = buildInstructionEntry(rootPath, rel, 'agentsMd', 'scoped', path.dirname(rel).split(path.sep).join('/') + '/**');
        if (entry) { out.push(entry); }
      }
    }
  }
  walk(rootPath);
  return out;
}

function scanSkills(rootPath: string): SkillInfo[] {
  const out: SkillInfo[] = [];

  const skillsDir = path.join(rootPath, '.claude', 'skills');
  try {
    for (const name of fs.readdirSync(skillsDir)) {
      const skillFile = path.join(skillsDir, name, 'SKILL.md');
      const content = readSafe(skillFile);
      if (content === null) { continue; }
      const fm = parseFrontmatter(content);
      out.push({
        name: typeof fm.name === 'string' ? fm.name : name,
        description: typeof fm.description === 'string' ? fm.description : '',
        relativePath: path.relative(rootPath, skillFile).split(path.sep).join('/'),
        source: 'claude-skill',
      });
    }
  } catch { /* no skills dir */ }

  for (const abs of listFiles(path.join(rootPath, '.claude', 'commands'), ['.md'])) {
    const content = readSafe(abs);
    if (content === null) { continue; }
    const fm = parseFrontmatter(content);
    const base = path.basename(abs, '.md');
    out.push({
      name: typeof fm.name === 'string' ? fm.name : base,
      description: typeof fm.description === 'string' ? fm.description : (content.split(/\r?\n/).find(l => l.trim() && !l.startsWith('---')) ?? '').trim(),
      relativePath: path.relative(rootPath, abs).split(path.sep).join('/'),
      source: 'claude-command',
    });
  }

  return out;
}

function scanAgents(rootPath: string): AgentInfo[] {
  const out: AgentInfo[] = [];

  for (const abs of listFiles(path.join(rootPath, '.claude', 'agents'), ['.md'])) {
    const content = readSafe(abs);
    if (content === null) { continue; }
    const fm = parseFrontmatter(content);
    out.push({
      name: typeof fm.name === 'string' ? fm.name : path.basename(abs, '.md'),
      description: typeof fm.description === 'string' ? fm.description : undefined,
      tools: Array.isArray(fm.tools) ? fm.tools : undefined,
      relativePath: path.relative(rootPath, abs).split(path.sep).join('/'),
      source: 'claude-agent',
    });
  }

  for (const abs of listFiles(path.join(rootPath, '.github', 'agents'), ['.agent.md', '.md'])) {
    const content = readSafe(abs);
    if (content === null) { continue; }
    const fm = parseFrontmatter(content);
    out.push({
      name: typeof fm.name === 'string' ? fm.name : path.basename(abs).replace(/\.agent\.md$|\.md$/, ''),
      description: typeof fm.description === 'string' ? fm.description : undefined,
      tools: Array.isArray(fm.tools) ? fm.tools : undefined,
      relativePath: path.relative(rootPath, abs).split(path.sep).join('/'),
      source: 'github-agent',
    });
  }

  return out;
}

interface RawMcpServer {
  command?: string;
  args?: string[];
  url?: string;
  type?: string;
  env?: Record<string, string>;
}

function extractMcpServers(json: unknown, sourceFile: string, scope: MCPServerInfo['scope']): MCPServerInfo[] {
  const out: MCPServerInfo[] = [];
  if (typeof json !== 'object' || json === null) { return out; }
  const obj = json as Record<string, unknown>;
  const table = (obj.mcpServers ?? obj.servers) as Record<string, RawMcpServer> | undefined;
  if (!table || typeof table !== 'object') { return out; }

  for (const [name, def] of Object.entries(table)) {
    if (!def || typeof def !== 'object') { continue; }
    out.push({
      name,
      command: def.command,
      args: def.args,
      url: def.url,
      type: def.type,
      envKeys: def.env ? Object.keys(def.env) : [],
      sourceFile,
      scope,
    });
  }
  return out;
}

function scanMcpServers(rootPath: string): MCPServerInfo[] {
  const out: MCPServerInfo[] = [];

  const candidates: Array<{ rel: string; scope: MCPServerInfo['scope'] }> = [
    { rel: '.mcp.json', scope: 'project' },
    { rel: path.join('.vscode', 'mcp.json'), scope: 'project' },
    { rel: path.join('.claude', 'settings.json'), scope: 'project' },
    { rel: path.join('.claude', 'settings.local.json'), scope: 'local' },
  ];

  for (const { rel, scope } of candidates) {
    const content = readSafe(path.join(rootPath, rel));
    if (content === null) { continue; }
    try {
      const json = JSON.parse(content);
      out.push(...extractMcpServers(json, rel.split(path.sep).join('/'), scope));
    } catch { /* malformed JSON, skip */ }
  }

  return out;
}

export async function analyzeAIStructure(rootPath: string): Promise<AIStructureReport> {
  const instructions: InstructionFile[] = [];

  for (const { rel, provider } of ROOT_INSTRUCTION_FILES) {
    const entry = buildInstructionEntry(rootPath, rel, provider, 'repo-wide');
    if (entry) { instructions.push(entry); }
  }
  instructions.push(...scanScopedInstructions(rootPath));
  instructions.push(...scanNestedAgentsMd(rootPath));

  const skills = scanSkills(rootPath);
  const agents = scanAgents(rootPath);
  const mcpServers = scanMcpServers(rootPath);

  const signalsByProvider = new Map<AIProviderId, Set<string>>();
  const addSignal = (id: AIProviderId, signal: string) => {
    if (!signalsByProvider.has(id)) { signalsByProvider.set(id, new Set()); }
    signalsByProvider.get(id)!.add(signal);
  };

  for (const ins of instructions) {
    for (const p of ins.providers) { addSignal(p, ins.relativePath); }
  }
  for (const a of agents) {
    addSignal(a.source === 'claude-agent' ? 'claudeCode' : 'copilot', a.relativePath);
  }
  if (skills.length > 0) { addSignal('claudeCode', '.claude/skills'); }

  // Directory-only signals (tool configured but no instruction content yet).
  if (isNonEmptyDir(path.join(rootPath, '.claude'))) { addSignal('claudeCode', '.claude/'); }
  if (isNonEmptyDir(path.join(rootPath, '.cursor'))) { addSignal('cursor', '.cursor/'); }
  if (isNonEmptyDir(path.join(rootPath, '.windsurf'))) { addSignal('windsurf', '.windsurf/'); }
  if (isNonEmptyDir(path.join(rootPath, '.github'))) { addSignal('copilot', '.github/'); }

  const providers: DetectedProvider[] = (Object.keys(PROVIDER_LABELS) as AIProviderId[]).map(id => ({
    id,
    label: PROVIDER_LABELS[id],
    detected: (signalsByProvider.get(id)?.size ?? 0) > 0,
    signals: [...(signalsByProvider.get(id) ?? [])].sort(),
  }));

  return {
    rootPath,
    generatedAt: new Date().toISOString(),
    providers,
    instructions,
    skills,
    agents,
    mcpServers,
  };
}
