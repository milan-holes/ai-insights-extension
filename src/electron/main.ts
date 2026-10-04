import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { StandaloneInsightsService } from '../standalone/service';
import { loadStandaloneConfig, saveStandaloneConfig, standaloneStorageDir, StandaloneConfig } from '../standalone/config';
import { DesktopViews } from './views';
import type { DesktopPanel } from './viewHost';

let mainWindow: any;
let service: StandaloneInsightsService;
let views: DesktopViews;
let pendingPanel: DesktopPanel | undefined;
let loadingView = false;
let queuedMessages: unknown[] = [];

function renderPanel(panel: DesktopPanel): void {
  pendingPanel = panel;
  setImmediate(() => {
    if (!pendingPanel || loadingView) { return; }
    const next = pendingPanel;
    pendingPanel = undefined;
    loadingView = true;
    const file = path.join(app.getPath('userData'), 'desktop-view.html');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next.webview.html);
    mainWindow.setTitle(`${next.title} - AI Insights`);
    mainWindow.loadFile(file, { query: { view: next.id } }).catch((error: Error) => {
      console.error('[electron] Failed to load view:', error);
    }).finally(() => {
      loadingView = false;
      for (const message of queuedMessages) { mainWindow.webContents.send('view:message', message); }
      queuedMessages = [];
      if (pendingPanel) { renderPanel(pendingPanel); }
    });
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 820,
    minWidth: 480,
    minHeight: 480,
    title: 'AI Insights',
    icon: path.join(__dirname, 'assets', 'logo.png'),
    backgroundColor: '#0f1218',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    console.log('[electron] AI Insights window ready');
  });
  mainWindow.webContents.on('did-fail-load', (_event: unknown, code: number, description: string) => {
    console.error(`[electron] Window failed to load (${code}): ${description}`);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    if (/^https?:\/\//.test(url)) { void shell.openExternal(url); }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event: { preventDefault(): void }, url: string) => {
    if (/^https?:\/\//.test(url)) { event.preventDefault(); void shell.openExternal(url); }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html')).catch((error: Error) => {
    console.error('[electron] Failed to load app:', error);
    app.exit(1);
  });
}

app.whenReady().then(() => {
  const storageDir = standaloneStorageDir();
  fs.mkdirSync(storageDir, { recursive: true });
  app.setPath('userData', storageDir);
  service = new StandaloneInsightsService(storageDir);
  createWindow();
  views = new DesktopViews(service, storageDir, renderPanel, message => {
    if (loadingView || pendingPanel) { queuedMessages.push(message); }
    else { mainWindow.webContents.send('view:message', message); }
  });
  void views.command('aiInsights.showDashboard').catch((error: Error) => {
    console.error('[electron] Dashboard failed:', error);
    dialog.showErrorBox('AI Insights', error.message);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      void views.command('aiInsights.showDashboard');
    }
  });
}).catch((error: Error) => {
  console.error('[electron] Startup failed:', error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') { app.quit(); }
});

ipcMain.handle('app:getConfig', () => service.getConfig());

ipcMain.handle('app:saveConfig', (_event: unknown, config: StandaloneConfig) => {
  return service.saveConfig(config);
});

ipcMain.handle('app:refresh', async () => service.refresh());

ipcMain.handle('view:command', async (_event: unknown, message: Record<string, unknown>) => {
  try { await views.message(message); }
  catch (error) { console.error('[electron] View action failed:', error); dialog.showErrorBox('AI Insights', String(error)); }
});

app.on('before-quit', () => views?.stop());

ipcMain.handle('app:pickDirectory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('app:openPath', async (_event: unknown, targetPath: string) => {
  await shell.openPath(targetPath);
});

ipcMain.handle('app:showItemInFolder', (_event: unknown, targetPath: string) => {
  shell.showItemInFolder(targetPath);
});

ipcMain.handle('app:resetConfig', () => {
  const storageDir = standaloneStorageDir();
  const config = loadStandaloneConfig(storageDir);
  saveStandaloneConfig(storageDir, config);
  service = new StandaloneInsightsService(storageDir);
  return service.getConfig();
});
