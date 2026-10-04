import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { describe, it } from 'node:test';
import { readPromptPrefix } from '../src/core/copilotPrefix';
import { makeTempDir, writeText } from './helpers';

/** The prefix reader is addressed by the session's main.jsonl path. */
function mainLog(dir: string): string {
  return path.join(dir, 'main.jsonl');
}

/** Copilot writes each sidecar as `{"content": "<text>"}`. */
function writeSidecar(dir: string, name: string, content: string): void {
  writeText(path.join(dir, name), JSON.stringify({ content }));
}

function tool(name: string, padding = 0): Record<string, unknown> {
  return { type: 'function', name, description: 'x'.repeat(padding) };
}

describe('Copilot prompt-prefix attribution', () => {
  it('returns null when no sidecars were written', () => {
    const dir = makeTempDir('prefix-none');
    writeText(path.join(dir, 'main.jsonl'), '{}\n');
    assert.equal(readPromptPrefix(mainLog(dir), []), null);
  });

  it('returns null for a directory that does not exist', () => {
    assert.equal(readPromptPrefix('/nonexistent/debug-logs/abc/main.jsonl', []), null);
  });

  it('splits the prefix into tool catalog and system prompt', () => {
    const dir = makeTempDir('prefix-split');
    const catalog = JSON.stringify([tool('read_file', 100), tool('grep_search', 100)]);
    writeSidecar(dir, 'tools_0.json', catalog);
    writeSidecar(dir, 'system_prompt_0.json', 'y'.repeat(400));

    const prefix = readPromptPrefix(mainLog(dir), ['read_file'])!;
    assert.equal(prefix.systemPromptTokens, 100); // 400 chars / 4
    assert.equal(prefix.toolCatalogTokens, Math.round(catalog.length / 4));
    assert.equal(prefix.totalTokens, prefix.toolCatalogTokens + prefix.systemPromptTokens);
    assert.deepEqual(prefix.definedTools, ['read_file', 'grep_search']);
    assert.deepEqual(prefix.usedTools, ['read_file']);
    assert.deepEqual(prefix.unusedTools, ['grep_search']);
    assert.ok(prefix.unusedToolTokens > 0);
  });

  it('attributes the unused share of the catalog, not the whole of it', () => {
    const dir = makeTempDir('prefix-unused');
    // Three same-sized tools; one is called, so ~2/3 of the schema is unused.
    writeSidecar(dir, 'tools_0.json', JSON.stringify([
      tool('alpha', 400), tool('beta', 400), tool('gamma', 400),
    ]));

    const prefix = readPromptPrefix(mainLog(dir), ['alpha'])!;
    assert.equal(prefix.unusedTools.length, 2);
    const unusedShare = prefix.unusedToolTokens / prefix.toolCatalogTokens;
    assert.ok(unusedShare > 0.6 && unusedShare < 0.72, `unused share ${unusedShare}`);
  });

  it('counts the whole catalog file even when an entry cannot be named', () => {
    const dir = makeTempDir('prefix-unnamed');
    const catalog = JSON.stringify([tool('alpha', 200), { type: 'function', description: 'z'.repeat(200) }]);
    writeSidecar(dir, 'tools_0.json', catalog);

    const prefix = readPromptPrefix(mainLog(dir), ['alpha'])!;
    // The nameless entry is not a tool we can report, but its bytes still cost money.
    assert.deepEqual(prefix.definedTools, ['alpha']);
    assert.equal(prefix.toolCatalogTokens, Math.round(catalog.length / 4));
    assert.ok(prefix.toolCatalogTokens > Math.round(JSON.stringify([tool('alpha', 200)]).length / 4));
  });

  it('reads the OpenAI-style nested function name', () => {
    const dir = makeTempDir('prefix-nested');
    writeSidecar(dir, 'tools_0.json', JSON.stringify([
      { type: 'function', function: { name: 'apply_patch', parameters: {} } },
    ]));
    const prefix = readPromptPrefix(mainLog(dir), ['apply_patch'])!;
    assert.deepEqual(prefix.definedTools, ['apply_patch']);
    assert.deepEqual(prefix.unusedTools, []);
  });

  it('uses the lowest-numbered sidecar when several requests wrote one', () => {
    const dir = makeTempDir('prefix-index');
    writeSidecar(dir, 'tools_0.json', JSON.stringify([tool('first', 50)]));
    writeSidecar(dir, 'tools_10.json', JSON.stringify([tool('eleventh', 50)]));
    writeSidecar(dir, 'tools_2.json', JSON.stringify([tool('third', 50)]));

    // Numeric, not lexicographic: tools_10 must not win over tools_2.
    assert.deepEqual(readPromptPrefix(mainLog(dir), [])!.definedTools, ['first']);
  });

  it('expresses the prefix as a share of a typical request', () => {
    const dir = makeTempDir('prefix-share');
    writeSidecar(dir, 'system_prompt_0.json', 'y'.repeat(4000)); // 1000 tokens
    const prefix = readPromptPrefix(mainLog(dir), [], 4000)!;
    assert.equal(prefix.shareOfMeanInput, 0.25);
  });

  it('omits the share when there is no input to compare against', () => {
    const dir = makeTempDir('prefix-noshare');
    writeSidecar(dir, 'system_prompt_0.json', 'y'.repeat(400));
    assert.equal(readPromptPrefix(mainLog(dir), [], 0)!.shareOfMeanInput, undefined);
    assert.equal(readPromptPrefix(mainLog(dir), [])!.shareOfMeanInput, undefined);
  });

  it('survives a malformed sidecar rather than throwing', () => {
    const dir = makeTempDir('prefix-malformed');
    writeText(path.join(dir, 'tools_0.json'), '{not json');
    writeSidecar(dir, 'system_prompt_0.json', 'y'.repeat(400));

    const prefix = readPromptPrefix(mainLog(dir), [])!;
    assert.equal(prefix.toolCatalogTokens, 0);
    assert.deepEqual(prefix.definedTools, []);
    assert.equal(prefix.systemPromptTokens, 100);
  });

  it('handles a catalog whose content is not an array', () => {
    const dir = makeTempDir('prefix-notarray');
    writeSidecar(dir, 'tools_0.json', JSON.stringify({ tools: [tool('wrapped', 20)] }));
    assert.deepEqual(readPromptPrefix(mainLog(dir), [])!.definedTools, ['wrapped']);
  });

  it('reads used tools from the log, independent of what the caller attributed', () => {
    const dir = makeTempDir('prefix-fromlog');
    writeSidecar(dir, 'tools_0.json', JSON.stringify([
      tool('read_file', 200), tool('run_in_terminal', 200), tool('never_called', 200),
    ]));
    // The log is the authoritative record: whichever duplicate session file won
    // de-duplication, these two were invoked.
    writeText(path.join(dir, 'main.jsonl'), [
      JSON.stringify({ type: 'tool_call', name: 'read_file', attrs: {} }),
      JSON.stringify({ type: 'tool_call', name: 'run_in_terminal', attrs: {} }),
      JSON.stringify({ type: 'llm_request', attrs: { model: 'gpt-5.4' } }),
      '{malformed',
    ].join('\n'));

    // Caller supplies nothing - the log alone must establish usage.
    const prefix = readPromptPrefix(mainLog(dir), [])!;
    assert.deepEqual(prefix.usedTools, ['read_file', 'run_in_terminal']);
    assert.deepEqual(prefix.unusedTools, ['never_called']);
  });

  it('unions log evidence with caller-supplied tool calls', () => {
    const dir = makeTempDir('prefix-union');
    writeSidecar(dir, 'tools_0.json', JSON.stringify([
      tool('from_log', 100), tool('from_caller', 100), tool('neither', 100),
    ]));
    writeText(path.join(dir, 'main.jsonl'), JSON.stringify({ type: 'tool_call', name: 'from_log' }));

    const prefix = readPromptPrefix(mainLog(dir), ['from_caller'])!;
    assert.deepEqual(prefix.usedTools, ['from_log', 'from_caller']);
    assert.deepEqual(prefix.unusedTools, ['neither']);
  });

  it('ignores a tool name the session called but was never offered', () => {
    const dir = makeTempDir('prefix-phantom');
    writeSidecar(dir, 'tools_0.json', JSON.stringify([tool('alpha', 50)]));
    const prefix = readPromptPrefix(mainLog(dir), ['alpha', 'not_in_catalog', ''])!;
    assert.deepEqual(prefix.usedTools, ['alpha']);
    assert.deepEqual(prefix.definedTools, ['alpha']);
  });
});

describe('Copilot prompt-prefix on real sidecar shapes', () => {
  it('reports a large catalog as mostly unused when few tools are called', () => {
    // Mirrors the measured session: 86 tools offered, 4 called.
    const dir = makeTempDir('prefix-real');
    const names = Array.from({ length: 86 }, (_, i) => `tool_${i}`);
    writeSidecar(dir, 'tools_0.json', JSON.stringify(names.map(n => tool(n, 900))));
    writeSidecar(dir, 'system_prompt_0.json', 'y'.repeat(27_000));

    const called = ['tool_0', 'tool_1', 'tool_2', 'tool_3'];
    const prefix = readPromptPrefix(mainLog(dir), called, 31_703)!;

    assert.equal(prefix.definedTools.length, 86);
    assert.equal(prefix.usedTools.length, 4);
    assert.equal(prefix.unusedTools.length, 82);
    assert.ok(prefix.unusedToolTokens / prefix.toolCatalogTokens > 0.9);
    // The fixed prefix is most of a typical request.
    assert.ok(prefix.shareOfMeanInput! > 0.6, `share ${prefix.shareOfMeanInput}`);
  });

  it('parses the sidecar shape found on disk', () => {
    const dir = makeTempDir('prefix-ondisk');
    // Verified shape: {"content": "<json array as a string>"}.
    fs.writeFileSync(
      path.join(dir, 'tools_0.json'),
      JSON.stringify({ content: '[{"type":"function","name":"apply_patch","description":"Edit text files."}]' }),
      'utf-8',
    );
    assert.deepEqual(readPromptPrefix(mainLog(dir), [])!.definedTools, ['apply_patch']);
  });
});
