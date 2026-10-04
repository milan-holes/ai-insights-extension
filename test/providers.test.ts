import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { encode } from '@msgpack/msgpack';
import { afterEach, describe, it } from 'node:test';
import { AntigravityProvider } from '../src/providers/antigravity';
import { ClaudeCodeProvider } from '../src/providers/claudeCode';
import { CodexProvider } from '../src/providers/codex';
import { CopilotProvider } from '../src/providers/copilot';
import { JetBrainsAIProvider } from '../src/providers/jetbrainsAI';
import { VisualStudioProvider } from '../src/providers/visualStudio';
import { makeTempDir, writeJsonl, writeText } from './helpers';

const tempDirs: string[] = [];

function tempRoot(name: string): string {
  const dir = makeTempDir(name);
  tempDirs.push(dir);
  return dir;
}

function writeMsgpackStream(filePath: string, objects: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([
    Buffer.from([1]),
    ...objects.map(obj => Buffer.from(encode(obj))),
  ]));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('provider session parsers', () => {
  it('parses Copilot JSON sessions with real token counts, tools, mode, and context refs', async () => {
    const root = tempRoot('copilot');
    const workspaceRoot = path.join(root, 'workspaceStorage', 'workspace-hash');
    writeText(path.join(workspaceRoot, 'workspace.json'), JSON.stringify({ folder: 'file:///repo/ai-insights' }));
    const sessionFile = path.join(workspaceRoot, 'chatSessions', 'session-1.json');
    writeText(sessionFile, JSON.stringify({
      sessionId: 'session-1',
      title: 'Implement parser tests',
      requests: [
        {
          timestamp: '2026-10-03T08:00:00.000Z',
          model: 'github-copilot/gpt-5-mini',
          modeInfo: { modeId: 'agent' },
          message: { parts: [{ text: 'Use #file and @workspace to add tests' }] },
          response: {
            text: 'Done',
            toolCalls: [{ name: 'read_file' }],
          },
          usage: {
            prompt_tokens: 120,
            completion_tokens: 30,
            cached_input_tokens: 20,
          },
        },
      ],
    }));

    const session = await new CopilotProvider(1, false, 'inclusive', [path.join(root, 'workspaceStorage')]).parseSessionFile(sessionFile);

    assert.ok(session);
    assert.equal(session.id, 'session-1');
    assert.equal(session.workspace, '/repo/ai-insights');
    assert.equal(session.title, 'Implement parser tests');
    assert.equal(session.totalInputTokens, 120);
    assert.equal(session.totalOutputTokens, 30);
    assert.equal(session.totalCacheReadTokens, 20);
    assert.deepEqual(session.models, ['gpt-5-mini']);
    assert.equal(session.interactions[0].mode, 'agent');
    assert.deepEqual(session.interactions[0].toolCalls, ['read_file']);
    assert.deepEqual(session.interactions[0].contextRefs, { file: 1, workspace: 1 });
  });

  it('reads GitHub\'s billed cost and the prompt prefix from a Copilot debug log', async () => {
    const root = tempRoot('copilot-billed');
    const extRoot = path.join(root, 'workspaceStorage', 'hash-1', 'GitHub.copilot-chat');
    const sessionFile = path.join(extRoot, 'transcripts', 'session-b.jsonl');
    const debugDir = path.join(extRoot, 'debug-logs', 'session-b');

    writeJsonl(sessionFile, [
      { type: 'session.start', timestamp: '2026-10-03T08:00:00.000Z', data: { sessionId: 'session-b' } },
      { type: 'user.message', timestamp: '2026-10-03T08:00:01.000Z', data: { content: 'Refactor the parser' } },
      {
        type: 'assistant.message',
        timestamp: '2026-10-03T08:00:02.000Z',
        data: { content: 'Done', toolRequests: [{ name: 'read_file' }] },
      },
    ]);

    // A real cache-miss record: 21,108 input / 0 cached / 121 output billed 8.096775
    // credits, which only balances if fresh input bills at the cache-creation rate.
    writeJsonl(path.join(debugDir, 'main.jsonl'), [
      {
        type: 'llm_request',
        ts: Date.parse('2026-10-03T08:00:05.000Z'),
        attrs: {
          model: 'claude-sonnet-4.6',
          inputTokens: 21108,
          cachedTokens: 0,
          outputTokens: 121,
          copilotUsageNanoAiu: 8096775000,
        },
      },
    ]);

    // Sidecars, in the shape Copilot writes them.
    writeText(path.join(debugDir, 'tools_0.json'), JSON.stringify({
      content: JSON.stringify([
        { type: 'function', name: 'read_file', description: 'r'.repeat(600) },
        { type: 'function', name: 'never_called', description: 'n'.repeat(600) },
      ]),
    }));
    writeText(path.join(debugDir, 'system_prompt_0.json'), JSON.stringify({ content: 's'.repeat(4000) }));

    const session = await new CopilotProvider(1, false, 'inclusive', [path.join(root, 'workspaceStorage')])
      .parseSessionFile(sessionFile);

    assert.ok(session);
    // Exact billed cost, not an estimate.
    assert.equal(session.costSource, 'billed');
    assert.ok(Math.abs(session.billedCostUsd! - 0.08096775) < 1e-9);
    assert.equal(session.estimatedCostUsd, session.billedCostUsd);
    assert.equal(session.billedInteractionCount, 1);
    assert.equal(session.interactions[0].billedCostUsd, session.billedCostUsd);

    // Prefix attribution: one of two tools was called, so about half the catalog is dead weight.
    const prefix = session.promptPrefix!;
    assert.equal(prefix.systemPromptTokens, 1000);
    assert.ok(prefix.toolCatalogTokens > 0);
    assert.deepEqual(prefix.usedTools, ['read_file']);
    assert.deepEqual(prefix.unusedTools, ['never_called']);
    assert.ok(prefix.unusedToolTokens / prefix.toolCatalogTokens > 0.4);
    assert.ok(prefix.shareOfMeanInput! > 0 && prefix.shareOfMeanInput! < 1);
  });

  it('falls back to an estimate when the debug log has no billed cost', async () => {
    const root = tempRoot('copilot-unbilled');
    const extRoot = path.join(root, 'workspaceStorage', 'hash-2', 'GitHub.copilot-chat');
    const sessionFile = path.join(extRoot, 'transcripts', 'session-c.jsonl');

    writeJsonl(sessionFile, [
      { type: 'user.message', timestamp: '2026-10-03T08:00:01.000Z', data: { content: 'Hello' } },
      { type: 'assistant.message', timestamp: '2026-10-03T08:00:02.000Z', data: { content: 'Hi' } },
    ]);
    writeJsonl(path.join(extRoot, 'debug-logs', 'session-c', 'main.jsonl'), [
      {
        type: 'llm_request',
        ts: Date.parse('2026-10-03T08:00:05.000Z'),
        attrs: { model: 'claude-sonnet-4.6', inputTokens: 1000, cachedTokens: 0, outputTokens: 50 },
      },
    ]);

    const session = await new CopilotProvider(1, false, 'inclusive', [path.join(root, 'workspaceStorage')])
      .parseSessionFile(sessionFile);

    assert.ok(session);
    assert.notEqual(session.costSource, 'billed');
    assert.equal(session.billedCostUsd, undefined);
    assert.equal(session.billedInteractionCount, 0);
    assert.equal(session.interactions[0].billedCostUsd, undefined);
    // No sidecars were written, so no prefix is claimed.
    assert.equal(session.promptPrefix, undefined);
    assert.ok((session.estimatedCostUsd ?? 0) > 0);
  });

  it('parses Claude Code JSONL sessions including title, MCP servers, tool details, and compaction events', async () => {
    const root = tempRoot('claude');
    const sessionFile = path.join(root, 'projects', 'repo', 'claude-session.jsonl');
    writeJsonl(sessionFile, [
      { type: 'ai-title', aiTitle: 'Refactor quota guard' },
      { type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: ['mcp__github__search_issues', 'Read'] } },
      {
        timestamp: '2026-10-03T09:00:00.000Z',
        type: 'user',
        cwd: '/repo/ai-insights',
        entrypoint: 'ide',
        permissionMode: 'acceptEdits',
        message: { content: 'Please update #selection' },
      },
      {
        timestamp: '2026-10-03T09:00:05.000Z',
        type: 'assistant',
        entrypoint: 'ide',
        permissionMode: 'acceptEdits',
        message: {
          id: 'msg-1',
          model: 'claude-sonnet-4.5',
          usage: {
            input_tokens: 200,
            output_tokens: 80,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 60,
            thinking_tokens: 10,
            server_tool_use: { web_search_requests: 1, web_fetch_requests: 2 },
          },
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/ai-insights/src/core/quotaGuard.ts' } },
          ],
        },
      },
      {
        timestamp: '2026-10-03T09:10:00.000Z',
        type: 'system',
        subtype: 'compact_boundary',
        compactMetadata: { trigger: 'manual', preTokens: 1000, postTokens: 250 },
      },
    ]);

    const session = await new ClaudeCodeProvider([path.join(root, 'projects')]).parseSessionFile(sessionFile);

    assert.ok(session);
    assert.equal(session.title, 'Refactor quota guard');
    assert.deepEqual(session.activeMcpServers, ['github']);
    assert.equal(session.workspace, '/repo/ai-insights');
    assert.equal(session.totalTokens, 390);
    assert.equal(session.estimatedBaseContextTokens, 60);
    assert.equal(session.peakEffectiveContextTokens, 300);
    assert.equal(session.interactions.length, 2);
    assert.equal(session.interactions[0].mode, 'edit');
    assert.deepEqual(session.interactions[0].toolCalls, ['Bash', 'Edit']);
    assert.deepEqual(session.interactions[0].commandRuns, ['npm test']);
    assert.deepEqual(session.interactions[0].fileAccesses, [{ tool: 'Edit', path: '/repo/ai-insights/src/core/quotaGuard.ts' }]);
    assert.deepEqual(session.interactions[0].contextRefs, { selection: 1 });
    assert.equal(session.interactions[0].webSearchRequests, 1);
    assert.equal(session.interactions[0].webFetchRequests, 2);
    assert.equal(session.interactions[1].isCompactionEvent, true);
    assert.equal(session.interactions[1].compactionTrigger, 'manual');
  });

  it('parses Codex rollout JSONL sessions with pending tool metadata and rate limits', async () => {
    const root = tempRoot('codex');
    const sessionFile = path.join(root, 'sessions', '2026', '10', '03', 'rollout-test.jsonl');
    writeJsonl(sessionFile, [
      {
        timestamp: '2026-10-03T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-1', cwd: '/repo/ai-insights', model: 'gpt-5.3-codex', task: 'Create provider tests' },
      },
      {
        timestamp: '2026-10-03T10:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Read #file and run tests' },
      },
      {
        timestamp: '2026-10-03T10:00:02.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm test' }) },
      },
      {
        timestamp: '2026-10-03T10:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'exec_command_end',
          command: ['bash', '-lc', 'npm test'],
          parsed_cmd: [{ type: 'read', path: '/repo/ai-insights/package.json' }],
        },
      },
      {
        timestamp: '2026-10-03T10:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 300,
              cached_input_tokens: 120,
              output_tokens: 90,
              reasoning_output_tokens: 30,
              total_tokens: 420,
            },
          },
          rate_limits: {
            primary: { used_percent: 58, window_minutes: 300, resets_at: 1791025200 },
            secondary: { used_percent: 101, window_minutes: 10080, resets_at: null },
            credits: 12.5,
            plan_type: 'plus',
            rate_limit_reached_type: null,
          },
        },
      },
    ]);

    const session = await new CodexProvider([path.join(root, 'sessions')]).parseSessionFile(sessionFile);

    assert.ok(session);
    assert.equal(session.id, 'codex-1');
    assert.equal(session.workspace, '/repo/ai-insights');
    assert.equal(session.title, 'Create provider tests');
    assert.equal(session.totalTokens, 420);
    assert.equal(session.totalCacheReadTokens, 120);
    assert.deepEqual(session.interactions[0].commandRuns, ['npm test']);
    assert.deepEqual(session.interactions[0].fileAccesses, [{ tool: 'read', path: '/repo/ai-insights/package.json' }]);
    assert.deepEqual(session.interactions[0].contextRefs, { file: 1 });
    assert.equal(session.rateLimits?.planType, 'plus');
    assert.equal(session.rateLimits?.primary?.usedPercent, 58);
    assert.equal(session.rateLimits?.secondary?.usedPercent, 100);
    assert.equal(session.rateLimits?.creditsRemaining, 12.5);
  });

  it('parses Antigravity overview logs with token counts, workspace, title, and context refs', async () => {
    const root = tempRoot('antigravity');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    writeText(path.join(repo, 'package.json'), '{}');
    const overviewFile = path.join(root, 'ag-root', 'brain', 'conversation-1', '.system_generated', 'logs', 'overview.txt');
    writeJsonl(overviewFile, [
      {
        type: 'USER_INPUT',
        created_at: '2026-10-03T11:00:00.000Z',
        content: `Please inspect @workspace\nActive Document: ${path.join(repo, 'src', 'extension.ts')} (selection)`,
      },
      {
        type: 'MODEL_OUTPUT',
        created_at: '2026-10-03T11:00:10.000Z',
        model: 'gemini-3.1-pro',
        input_tokens: 500,
        output_tokens: 125,
        thinking_tokens: 25,
      },
    ]);

    const session = await new AntigravityProvider([path.join(root, 'ag-root')]).parseSessionFile(overviewFile);

    assert.ok(session);
    assert.equal(session.id, 'conversation-1');
    assert.equal(session.workspace, repo);
    assert.equal(session.title, 'Please inspect @workspace');
    assert.equal(session.totalTokens, 625);
    assert.equal(session.totalThinkingTokens, 25);
    assert.deepEqual(session.models, ['gemini-3.1-pro']);
    assert.deepEqual(session.interactions[0].contextRefs, { workspace: 1 });
  });

  it('parses JetBrains partitions using rendered input, content output, thinking, and tool results', async () => {
    const root = tempRoot('jetbrains');
    const sessionFile = path.join(root, '.copilot', 'jb', 'conversation-1', 'partition-0.jsonl');
    writeJsonl(sessionFile, [
      { type: 'partition.created', timestamp: '2026-10-03T12:00:00.000Z', data: { conversationId: 'conversation-1' } },
      { type: 'user.message', timestamp: '2026-10-03T12:00:01.000Z', data: { turnId: 'turn-1', content: 'raw text that should not be counted' } },
      { type: 'user.message_rendered', timestamp: '2026-10-03T12:00:01.500Z', data: { turnId: 'turn-1', renderedMessage: '<userRequest>abcd</userRequest>' } },
      { type: 'assistant.turn_start', timestamp: '2026-10-03T12:00:02.000Z', data: { turnId: 'turn-1', model: 'gpt-4o' } },
      { type: 'assistant.message', timestamp: '2026-10-03T12:00:03.000Z', data: { content: 'abcdefgh', thinking: { text: 'abcd' } } },
      { type: 'tool.execution_start', timestamp: '2026-10-03T12:00:04.000Z', data: { toolName: 'read_file', toolCallId: 'call_1', arguments: { filePath: '/repo/src/file.ts' } } },
      { type: 'tool.execution_complete', timestamp: '2026-10-03T12:00:05.000Z', data: { toolCallId: 'call_1', success: true, result: { result: [{ value: 'abcd' }] } } },
      { type: 'assistant.turn_end', timestamp: '2026-10-03T12:00:06.000Z', data: { turnId: 'turn-1' } },
    ]);

    const session = await new JetBrainsAIProvider([path.join(root, '.copilot', 'jb')]).parseSessionFile(sessionFile);

    assert.ok(session);
    assert.equal(session.totalInputTokens, 8);
    assert.equal(session.totalOutputTokens, 3);
    assert.equal(session.totalThinkingTokens, 1);
    assert.equal(session.totalTokens, 12);
    assert.deepEqual(session.models, ['gpt-4o']);
    assert.equal(session.interactions[0].mode, 'agent');
    assert.deepEqual(session.interactions[0].toolCalls, ['read_file']);
    assert.equal(session.workspace, 'src');
  });

  it('parses Visual Studio MessagePack sessions with request context and response tokens', async () => {
    const root = tempRoot('visual-studio');
    const sessionFile = path.join(root, 'repo', '.vs', 'Solution', 'copilot-chat', 'abc123', 'sessions', 'session-1');
    writeMsgpackStream(sessionFile, [
      { TimeCreated: '2026-10-03T13:00:00.000Z', TimeUpdated: '2026-10-03T13:05:00.000Z' },
      [0, {
        Content: [[0, { Content: 'abcd' }]],
        Context: [{ ValueContainer: [0, { Content: 'context' }] }],
        Model: { ModelId: 'gpt-4o' },
      }],
      [0, {
        Content: [[0, { Content: 'abcdefgh' }]],
        Model: [1, { Id: 'gpt-4o' }],
      }],
    ]);

    const session = await new VisualStudioProvider([root]).parseSessionFile(sessionFile);

    assert.ok(session);
    assert.equal(session.id, 'vs-session-1');
    assert.equal(session.workspace, 'Solution');
    assert.equal(session.totalInputTokens, 3);
    assert.equal(session.totalOutputTokens, 2);
    assert.equal(session.totalTokens, 5);
    assert.deepEqual(session.models, ['gpt-4o']);
    assert.equal(session.interactions[0].promptPreview, 'abcdcontext');
  });

  it('discovers provider session files from additional provider roots', async () => {
    const root = tempRoot('discover');
    const copilotFile = path.join(root, 'copilot', 'abc', 'chatSessions', 'one.json');
    const claudeFile = path.join(root, 'claude', 'project', 'two.jsonl');
    const codexFile = path.join(root, 'codex', '2026', '10', '03', 'rollout-three.jsonl');
    const antigravityFile = path.join(root, 'antigravity', 'conversations', 'four.pb');
    writeText(copilotFile, '{}');
    writeText(claudeFile, '{}\n');
    writeText(codexFile, '{}\n');
    writeText(antigravityFile, 'pb');

    assert.ok((await new CopilotProvider(1, true, 'inclusive', [path.join(root, 'copilot')]).discoverSessionFiles()).includes(copilotFile));
    assert.ok((await new ClaudeCodeProvider([path.join(root, 'claude')]).discoverSessionFiles()).includes(claudeFile));
    assert.ok((await new CodexProvider([path.join(root, 'codex')]).discoverSessionFiles()).includes(codexFile));
    assert.ok((await new AntigravityProvider([path.join(root, 'antigravity')]).discoverSessionFiles()).includes(antigravityFile));
  });
});
