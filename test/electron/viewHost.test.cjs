const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');

function loadHost(withRepositoryView = false) {
  const { outputFiles } = esbuild.buildSync({
    stdin: { contents: `export * from './src/electron/viewHost';export * from './src/electron/viewPolicy';${withRepositoryView ? "export { RepoAnalysisViewProvider } from './src/webview/repoAnalysisView';" : ''}`, resolveDir: process.cwd() },
    bundle: true, platform: 'node', alias: { vscode: path.resolve('src/electron/viewHost.ts') },
    format: 'cjs', write: false, external: ['electron'],
  });
  const module = { exports: {} };
  const electron = { dialog: {}, shell: {}, safeStorage: { isEncryptionAvailable: () => false } };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, process, Buffer, structuredClone,
    require: name => name === 'electron' ? electron : require(name),
  });
  return module.exports;
}

test('desktop excludes settings, A/B and sharing while retaining analytics', () => {
  const host = loadHost();
  for (const command of ['showDiagnostics', 'showAbTest', 'startSharing', 'stopSharing', 'runAbTest', 'updateSetting']) {
    assert.equal(host.isExcludedDesktopCommand(command), true);
    assert.equal(host.isExcludedDesktopCommand(`aiInsights.${command}`), true);
  }
  for (const command of ['showDashboard', 'showSessions', 'showBenchmark', 'showPricing', 'refresh']) {
    assert.equal(host.isExcludedDesktopCommand(command), false);
  }
});

test('desktop view messages reach only the active panel', async () => {
  const host = loadHost();
  const received = [];
  const rendered = [];
  host.configureViewHost({ render: panel => rendered.push(panel.id), post() {} });
  const first = host.window.createWebviewPanel('first', 'First');
  first.webview.onDidReceiveMessage(message => received.push(['first', message.command]));
  first.webview.html = '<p>First</p>';
  const second = host.window.createWebviewPanel('second', 'Second');
  second.webview.onDidReceiveMessage(message => received.push(['second', message.command]));
  second.webview.html = '<p>Second</p>';
  await host.receiveViewMessage({ command: 'refresh' });
  first.reveal();
  await host.receiveViewMessage({ command: 'analyze' });
  let disposed = false;
  first.onDidDispose(() => { disposed = true; });
  first.dispose();
  assert.equal(disposed, true);
  assert.equal(host.getActivePanel(), undefined);
  assert.deepEqual(received, [['second', 'refresh'], ['first', 'analyze']]);
  assert.deepEqual(rendered, ['first', 'second', 'first']);
});

test('extension setting names map to standalone config without unrelated writes', async () => {
  const host = loadHost();
  let config = { providers: { copilot: { cacheEstimationEnabled: true } }, teamSize: 1 };
  host.configureViewHost({ getConfig: () => config, saveConfig: next => { config = next; } });
  const settings = host.workspace.getConfiguration('aiInsights');
  assert.equal(settings.get('providers.copilot.cacheEstimation.enabled'), true);
  await settings.update('providers.copilot.cacheEstimation.enabled', false);
  assert.equal(config.providers.copilot.cacheEstimationEnabled, false);
  await assert.rejects(settings.update('terminal.executable', '/bad'), /Unsupported standalone setting/);
  assert.equal(config.terminal, undefined);
});

test('calculator discovery skips dependencies, build outputs and symlinks', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-insights-electron-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const x = 1;');
  fs.writeFileSync(path.join(root, 'node_modules', 'skip.ts'), 'skip');
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(root, 'linked'), 'dir');
  const host = loadHost();
  host.setWorkspaceRoot(root);
  const files = await host.workspace.findFiles('**/*', '', 100);
  assert.deepEqual(Array.from(files, uri => host.workspace.asRelativePath(uri)), [path.join('src', 'app.ts')]);
});

test('API keys are never stored when OS encryption is unavailable', async t => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-insights-electron-secrets-'));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));
  const host = loadHost();
  host.configureViewHost({ storageDir });
  const context = host.desktopContext(process.cwd(), {});
  await assert.rejects(context.secrets.store('key', 'secret-value'), /OS keyring/);
  assert.equal(fs.existsSync(path.join(storageDir, 'desktop-state.json')), false);
});

test('reused repository graph emits valid JavaScript and the canonical palette', async t => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-insights-electron-view-'));
  t.after(() => fs.rmSync(storageDir, { recursive: true, force: true }));
  const host = loadHost(true);
  let html = '';
  host.configureViewHost({ storageDir, render: panel => { html = panel.webview.html; } });
  await host.RepoAnalysisViewProvider.createPanel(host.desktopContext(process.cwd(), {}));
  assert.match(html, /--bg-base:#0f1218/);
  assert.match(html, /--primary:#007AFF/);
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert(scripts.some(source => source.includes('buildHandoffMarkdown')));
  for (const script of scripts) { assert.doesNotThrow(() => new vm.Script(script)); }
});

test('calculator cannot read files outside the selected repository', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-insights-electron-path-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'repo'); fs.mkdirSync(root);
  const outside = path.join(parent, 'private.txt'); fs.writeFileSync(outside, 'private');
  const host = loadHost(); host.setWorkspaceRoot(root);
  await assert.rejects(host.workspace.fs.readFile(host.Uri.file(outside)), /outside the selected repository/);
});
