/**
 * Prompt-prefix attribution for GitHub Copilot sessions.
 *
 * Next to `debug-logs/<session>/main.jsonl` Copilot writes two sidecar files per
 * request index:
 *
 * - `tools_N.json` - the full tool catalog offered to the model
 * - `system_prompt_N.json` - the system prompt
 *
 * Both are `{"content": "<text>"}`, where the tool catalog's content is itself a JSON
 * array of tool definitions. They are the *fixed* part of every request in the session:
 * resent each turn, normally served from the prompt cache. That matters because it
 * separates "your context is large" from "your context is mostly tool schemas you never
 * invoke" - on one measured session, 86 tools were offered and 4 were called, leaving
 * ~19K tokens per request of schema the model could not use.
 *
 * Token counts here are character estimates (~4 chars/token): Copilot writes these files
 * as text and never reports their token count, so every figure this module produces is
 * an estimate by construction. Callers should label it as such.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PromptPrefixBreakdown } from '../types';

/** Copilot writes the sidecars as text; ~4 chars per token is the usual rough ratio. */
const CHARS_PER_TOKEN = 4;

const TOOLS_SIDECAR = /^tools_(\d+)\.json$/;
const SYSTEM_PROMPT_SIDECAR = /^system_prompt_(\d+)\.json$/;

function estimateTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

/** Read a sidecar's `content` string. Returns '' for anything unreadable or unexpected. */
function readSidecarContent(filePath: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const content = parsed?.content;
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

/**
 * The lowest-numbered sidecar matching `pattern` in `dir`. Copilot writes one per
 * request index; index 0 is the first request's, which is the prefix the session was
 * established with. Later indices differ only when the toolset changed mid-session.
 */
function firstSidecar(dir: string, entries: string[], pattern: RegExp): string | null {
  const matches = entries
    .map(name => ({ name, match: pattern.exec(name) }))
    .filter((e): e is { name: string; match: RegExpExecArray } => e.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]));
  return matches.length > 0 ? path.join(dir, matches[0].name) : null;
}

interface ToolDefinition {
  name: string;
  /** Characters of JSON this tool's definition contributes to the catalog. */
  chars: number;
}

/**
 * Parse the tool catalog. Copilot has shipped both a bare array and an OpenAI-style
 * `{type: 'function', function: {name}}` wrapper, so accept the name at either level.
 */
function parseToolCatalog(content: string): ToolDefinition[] {
  if (!content) { return []; }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { tools?: unknown })?.tools)
      ? (parsed as { tools: unknown[] }).tools
      : [];

  const tools: ToolDefinition[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') { continue; }
    const record = entry as { name?: unknown; function?: { name?: unknown } };
    const name = typeof record.name === 'string'
      ? record.name
      : typeof record.function?.name === 'string' ? record.function.name : '';
    if (!name) { continue; }
    tools.push({ name, chars: JSON.stringify(entry).length });
  }
  return tools;
}

/**
 * Tool names the debug log records as actually invoked (`tool_call` events carry the tool
 * name in `name`).
 *
 * This is the authoritative "used" signal and the reason it is read here rather than
 * taken from the parsed interactions: one Copilot session is often written to several
 * files (`chatSessions/`, `transcripts/`), only some of which yield tool calls, and
 * whichever variant survives session de-duplication decides what `Interaction.toolCalls`
 * holds. Reading the log beside the sidecars makes the answer independent of that.
 */
function readCalledToolsFromLog(mainJsonlPath: string): Set<string> {
  const called = new Set<string>();
  let content: string;
  try {
    content = fs.readFileSync(mainJsonlPath, 'utf-8');
  } catch {
    return called;
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) { continue; }
    try {
      const event = JSON.parse(line);
      if (event?.type !== 'tool_call') { continue; }
      const name = typeof event.name === 'string' ? event.name : event.attrs?.toolName;
      if (typeof name === 'string' && name) { called.add(name); }
    } catch {
      // Skip malformed telemetry lines.
    }
  }
  return called;
}

/**
 * Build the prefix breakdown for a Copilot session from its `main.jsonl` path.
 *
 * "Used" is the union of the tool calls the log recorded and any the caller attributed to
 * interactions, so a tool counts as used on either evidence - never-used is the claim
 * that needs to be hard to make, not used.
 *
 * Returns null when neither sidecar is present (the common case - they are written only
 * for some sessions), so callers can leave `Session.promptPrefix` undefined rather than
 * reporting zeros as a measurement.
 */
export function readPromptPrefix(
  mainJsonlPath: string,
  calledTools: Iterable<string>,
  meanInputTokens?: number,
): PromptPrefixBreakdown | null {
  const debugLogDir = path.dirname(mainJsonlPath);
  let entries: string[];
  try {
    entries = fs.readdirSync(debugLogDir);
  } catch {
    return null;
  }

  const toolsPath = firstSidecar(debugLogDir, entries, TOOLS_SIDECAR);
  const systemPromptPath = firstSidecar(debugLogDir, entries, SYSTEM_PROMPT_SIDECAR);
  if (!toolsPath && !systemPromptPath) { return null; }

  const toolCatalogContent = toolsPath ? readSidecarContent(toolsPath) : '';
  const catalog = parseToolCatalog(toolCatalogContent);
  const systemPromptChars = systemPromptPath ? readSidecarContent(systemPromptPath).length : 0;

  // Charge the whole catalog file, not just the sum of recognised tool definitions, so
  // array punctuation and any entry we failed to name still counts against the prefix.
  const toolCatalogChars = toolCatalogContent.length;

  const called = readCalledToolsFromLog(mainJsonlPath);
  for (const name of calledTools) {
    if (name) { called.add(name); }
  }

  const definedTools = catalog.map(t => t.name);
  const usedTools = definedTools.filter(name => called.has(name));
  const unused = catalog.filter(t => !called.has(t.name));

  const toolCatalogTokens = estimateTokens(toolCatalogChars);
  const systemPromptTokens = estimateTokens(systemPromptChars);
  const totalTokens = toolCatalogTokens + systemPromptTokens;

  return {
    toolCatalogTokens,
    systemPromptTokens,
    totalTokens,
    definedTools,
    usedTools,
    unusedTools: unused.map(t => t.name),
    unusedToolTokens: estimateTokens(unused.reduce((sum, t) => sum + t.chars, 0)),
    shareOfMeanInput: meanInputTokens && meanInputTokens > 0
      ? totalTokens / meanInputTokens
      : undefined,
  };
}
