import { contextBridge, ipcRenderer } from 'electron';
import type { StandaloneRefreshResult } from '../standalone/service';
import type { StandaloneConfig } from '../standalone/config';
import { excludedDesktopControls } from './viewPolicy';

export interface AiInsightsElectronApi {
  getConfig(): Promise<StandaloneConfig>;
  saveConfig(config: StandaloneConfig): Promise<StandaloneConfig>;
  refresh(): Promise<StandaloneRefreshResult>;
  pickDirectory(): Promise<string | null>;
  openPath(path: string): Promise<void>;
  showItemInFolder(path: string): Promise<void>;
}

const api: AiInsightsElectronApi = {
  getConfig: () => ipcRenderer.invoke('app:getConfig'),
  saveConfig: (config) => ipcRenderer.invoke('app:saveConfig', config),
  refresh: () => ipcRenderer.invoke('app:refresh'),
  pickDirectory: () => ipcRenderer.invoke('app:pickDirectory'),
  openPath: (targetPath) => ipcRenderer.invoke('app:openPath', targetPath),
  showItemInFolder: (targetPath) => ipcRenderer.invoke('app:showItemInFolder', targetPath),
};

contextBridge.exposeInMainWorld('aiInsights', api);

const stateKey = `ai-insights:${new URLSearchParams(location.search).get('view') ?? 'dashboard'}`;
contextBridge.exposeInMainWorld('acquireVsCodeApi', () => ({
  postMessage: (message: Record<string, unknown>) => { void ipcRenderer.invoke('view:command', message); },
  getState: () => { try { return JSON.parse(localStorage.getItem(stateKey) ?? 'null'); } catch { return null; } },
  setState: (state: unknown) => { localStorage.setItem(stateKey, JSON.stringify(state)); return state; },
}));
ipcRenderer.on('view:message', (_event: unknown, message: unknown) => {
  window.dispatchEvent(new MessageEvent('message', { data: message }));
});

window.addEventListener('DOMContentLoaded', () => {
  if (!location.search.includes('view=')) { return; }
  const style = document.createElement('style');
  style.textContent = `*{letter-spacing:0!important}
    ${excludedDesktopControls}{display:none!important}
    .desktop-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 24px;border-bottom:1px solid var(--border);background:var(--bg-base);font:12px var(--font-primary)}
    .desktop-tools button,.desktop-tools select{background:var(--bg-surface);border:1px solid var(--border);color:var(--text-primary);border-radius:6px;padding:5px 10px;cursor:pointer}
    .desktop-tools select{max-width:160px}
    @media(max-width:640px){
      .ns-topbar{padding:0 12px}.desktop-tools{padding:8px 12px}
      .ns-filter-group{flex-wrap:wrap;max-width:100%}.ns-filter-sep{display:none}
      .ns-content{padding:16px}.section{min-width:0;padding:16px;overflow-wrap:anywhere}
      .section>div[style*="display:flex"]{flex-wrap:wrap}
      .section>div[style*="display:flex"]>div{min-width:0;max-width:100%}
      .section table{display:block;max-width:100%;overflow-x:auto}
    }`;
  document.head.appendChild(style);
  const toolbar = document.createElement('div');
  toolbar.className = 'desktop-tools';
  const folder = document.createElement('button');
  folder.textContent = 'Open Repository';
  folder.addEventListener('click', () => { void ipcRenderer.invoke('view:command', { command: 'desktopWorkspace' }); });
  toolbar.appendChild(folder);
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Tools');
  for (const [label, target] of [['Tools', ''], ['Dashboard', 'showDashboard'], ['Sessions', 'showSessions'], ['Charts', 'showCharts'], ['Prompt History', 'showPromptHistory'], ['Calculator', 'showTokenCalculator'], ['Repository', 'showAIStructure'], ['Repository Graph', 'showRepoAnalysis'], ['Benchmark', 'showBenchmark']]) {
    const option = document.createElement('option'); option.textContent = label; option.value = target; select.appendChild(option);
  }
  select.addEventListener('change', () => { if (select.value) { void ipcRenderer.invoke('view:command', { command: 'desktopNavigate', target: `aiInsights.${select.value}` }); } });
  toolbar.appendChild(select);
  const attachment = document.getElementById('attachActiveFile') as HTMLInputElement | null;
  if (attachment) {
    attachment.checked = false;
    attachment.disabled = true;
    attachment.closest('label')?.setAttribute('title', 'Active editor context requires VS Code.');
  }
  const openFiles = document.getElementById('btn-open-files') as HTMLButtonElement | null;
  if (openFiles) { openFiles.disabled = true; openFiles.title = 'Open editor tabs require VS Code. Use repository files instead.'; }
  document.querySelectorAll<HTMLInputElement>('input[name="adapter"][value^="copilot-"]').forEach(input => {
    input.disabled = true;
    input.closest('label')?.setAttribute('title', 'Editor language models require VS Code. Choose a CLI or API adapter.');
  });
  document.querySelectorAll<HTMLInputElement>('input[data-provider="copilot"]').forEach(input => {
    input.checked = false;
    input.disabled = true;
    input.closest('label')?.setAttribute('title', 'Editor language models require VS Code.');
  });
  document.querySelectorAll<HTMLElement>('[data-add-custom="copilot"], #custom-copilot').forEach(control => {
    (control as HTMLInputElement | HTMLButtonElement).disabled = true;
    control.title = 'Editor language models require VS Code.';
  });
  const topbar = document.querySelector('.ns-topbar');
  if (topbar) { topbar.after(toolbar); } else { document.body.prepend(toolbar); }
});
