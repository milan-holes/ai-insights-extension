import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { dialog, shell, safeStorage } from 'electron';
import type { StandaloneConfig } from '../standalone/config';

type Handler = (message: Record<string, any>) => unknown;
export interface DesktopPanel {
  id: string; title: string;
  webview: { html: string; cspSource: string; asWebviewUri(uri: Uri): Uri;
    onDidReceiveMessage(handler: Handler): { dispose(): void }; postMessage(message: unknown): Promise<boolean> };
  reveal(): void; onDidDispose(handler: () => void): void; dispose(): void;
}
interface Host {
  render(panel: DesktopPanel): void; post(message: unknown): void;
  command(command: string, ...args: any[]): Promise<unknown>;
  getConfig(): StandaloneConfig; saveConfig(config: StandaloneConfig): void; storageDir: string;
}
let host: Host;
let activePanel: DesktopPanel | undefined;
let workspaceRoot: string | undefined;
const receivers = new WeakMap<DesktopPanel, Handler>();
const panels = new Set<DesktopPanel>();
export function configureViewHost(value: Host): void { host = value; }
export function getActivePanel(): DesktopPanel | undefined { return activePanel; }
export function setWorkspaceRoot(root: string): void { workspaceRoot = root; }
export function disposeAllPanels(): void { for (const panel of [...panels]) { panel.dispose(); } }
export async function receiveViewMessage(message: Record<string, any>): Promise<void> { await receivers.get(activePanel!)?.(message); }
export class Uri {
  readonly scheme = 'file';
  constructor(readonly fsPath: string) {}
  static file(value: string): Uri { return new Uri(path.resolve(value)); }
  static joinPath(base: Uri, ...parts: string[]): Uri { return new Uri(path.join(base.fsPath, ...parts)); }
  toString(): string { return pathToFileURL(this.fsPath).href; }
}
const disposable = { dispose() {} };
export const ViewColumn = { One: 1, Beside: 2 };
export const ConfigurationTarget = { Global: 1 };
export const version = `Electron ${process.versions.electron}`;
export const env = { openExternal: (uri: Uri) => shell.openExternal(uri.toString()) };
export const extensions = { getExtension: () => undefined };
export const lm = { selectChatModels: async () => [] };
// Editor language-model calls are unavailable; CLI and direct API adapters work.
export class CancellationTokenSource {
  constructor() { throw new Error('Editor language models require VS Code. Select a CLI or API provider.'); }
}
export const LanguageModelChatMessage = {
  User() { throw new Error('Editor language models require VS Code.'); },
  Assistant() { throw new Error('Editor language models require VS Code.'); },
};
export class LanguageModelTextPart { constructor(readonly value: string) {} }
export class LanguageModelToolCallPart {}
export class LanguageModelToolResultPart {}
export class TabInputText {}
export const commands = {
  executeCommand: async (command: string, ...args: any[]) => {
    try { return await host.command(command, ...args); }
    catch (error) { await window.showErrorMessage(String(error)); return undefined; }
  },
};
export const window = {
  activeTextEditor: undefined, tabGroups: { all: [] },
  onDidChangeActiveTextEditor: () => disposable, onDidChangeTextEditorSelection: () => disposable,
  createWebviewPanel(id: string, title: string): DesktopPanel {
    const disposers: Array<() => void> = [];
    let html = '';
    const panel: DesktopPanel = { id, title,
      webview: {
        get html() { return html; },
        set html(value) { html = value; if (activePanel === panel) { host.render(panel); } },
        cspSource: 'file:', asWebviewUri: uri => uri,
        onDidReceiveMessage(handler) { receivers.set(panel, handler); return disposable; },
        async postMessage(message) { if (activePanel === panel) { host.post(message); } return true; },
      },
      reveal() { activePanel = panel; if (html) { host.render(panel); } },
      onDidDispose(handler) { disposers.push(handler); },
      dispose() { disposers.forEach(handler => handler()); receivers.delete(panel); panels.delete(panel); if (activePanel === panel) { activePanel = undefined; } },
    };
    activePanel = panel;
    panels.add(panel);
    return panel;
  },
  async showSaveDialog(options: any): Promise<Uri | undefined> {
    const result = await dialog.showSaveDialog({ title: options.title, defaultPath: options.defaultUri?.fsPath,
      filters: Object.entries(options.filters ?? {}).map(([name, extensions]) => ({ name, extensions: extensions as string[] })) });
    return result.canceled || !result.filePath ? undefined : Uri.file(result.filePath);
  },
  async showInformationMessage(message: string) { await dialog.showMessageBox({ type: 'info', message }); },
  async showWarningMessage(message: string) { await dialog.showMessageBox({ type: 'warning', message }); },
  async showErrorMessage(message: string) { await dialog.showMessageBox({ type: 'error', message }); },
  async showTextDocument(document: { uri: Uri }) { await shell.openPath(document.uri.fsPath); },
};
const aliases: Record<string, string> = {
  'providers.copilot.cacheEstimation.enabled': 'providers.copilot.cacheEstimationEnabled',
  'providers.copilot.cacheEstimation.convention': 'providers.copilot.cacheEstimationConvention',
};
function configKey(key: string): string { const own = key.replace(/^aiInsights\./, ''); return aliases[own] ?? own; }
function getValue(object: any, key: string): unknown { return key.split('.').reduce((value, part) => value?.[part], object); }
export const workspace = {
  get workspaceFolders() { return workspaceRoot ? [{ name: path.basename(workspaceRoot), uri: Uri.file(workspaceRoot) }] : []; },
  getConfiguration(section = '') { return {
    get<T>(key: string, fallback?: T): T { return (getValue(host.getConfig(), configKey(section ? `${section}.${key}` : key)) ?? fallback) as T; },
    async update(key: string, value: unknown) {
      const config = structuredClone(host.getConfig());
      const parts = configKey(section ? `${section}.${key}` : key).split('.');
      const leaf = parts.pop()!;
      const parent = parts.reduce((object: any, part) => object?.[part], config);
      if (!parent || !Object.hasOwn(parent, leaf)) { throw new Error(`Unsupported standalone setting: ${key}`); }
      parent[leaf] = value; host.saveConfig(config);
    },
  }; },
  fs: {
    async readFile(uri: Uri) {
      if (!workspaceRoot) { throw new Error('Select a repository first.'); }
      const target = await fs.promises.realpath(uri.fsPath);
      const root = await fs.promises.realpath(workspaceRoot);
      const relative = path.relative(root, target);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { throw new Error('File is outside the selected repository.'); }
      return fs.promises.readFile(target);
    },
    writeFile: (uri: Uri, data: Uint8Array) => fs.promises.writeFile(uri.fsPath, data),
  },
  async openTextDocument(uri: Uri | string) { return { uri: typeof uri === 'string' ? Uri.file(uri) : uri }; },
  asRelativePath(uri: Uri) { return workspaceRoot ? path.relative(workspaceRoot, uri.fsPath) : uri.fsPath; },
  async findFiles(_include: string, _exclude: string, limit = 10000): Promise<Uri[]> {
    const files: Uri[] = [];
    const excluded = new Set(['node_modules', '.git', 'dist', 'build', '.nuxt', '.output', '.data']);
    async function walk(directory: string): Promise<void> {
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        if (files.length >= limit) { return; }
        if (entry.isSymbolicLink() || excluded.has(entry.name)) { continue; }
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) { await walk(target); }
        else if (!entry.name.endsWith('.lock') && entry.name !== 'package-lock.json') { files.push(Uri.file(target)); }
      }
    }
    if (workspaceRoot) { await walk(workspaceRoot); }
    return files;
  },
};
export function desktopContext(assetRoot: string, packageJSON: any): any {
  const stateFile = path.join(host.storageDir, 'desktop-state.json');
  let state: Record<string, any> = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* First launch. */ }
  let pendingWrite = Promise.resolve();
  function persist(): Promise<void> {
    pendingWrite = pendingWrite.catch(() => {}).then(async () => {
      fs.mkdirSync(host.storageDir, { recursive: true });
      await fs.promises.writeFile(stateFile, JSON.stringify(state, null, 2));
    });
    return pendingWrite;
  }
  return { extensionUri: Uri.file(assetRoot), extension: { packageJSON }, subscriptions: [],
    globalState: { get: (key: string, fallback?: unknown) => state[key] ?? fallback,
      async update(key: string, value: unknown) { state[key] = value; await persist(); } },
    secrets: {
      async get(key: string) { const encrypted = state[`secret:${key}`]; return encrypted && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : undefined; },
      async store(key: string, value: string) {
        if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) { throw new Error('Set up an OS keyring to save API keys.'); }
        state[`secret:${key}`] = safeStorage.encryptString(value).toString('base64'); await persist();
      },
    },
  };
}
