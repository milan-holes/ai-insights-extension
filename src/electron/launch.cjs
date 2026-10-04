#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const electron = require('electron');

const args = process.argv.slice(2);
const env = { ...process.env };

// VS Code Remote/WSL can export this so helper Node processes run under Electron's
// embedded Node mode. For the standalone app we need the actual Electron runtime.
delete env.ELECTRON_RUN_AS_NODE;

const isWsl = Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
// Remote shells can override DISPLAY and XDG_RUNTIME_DIR with stale endpoints.
// Prefer WSLg's own Wayland socket when it is available.
if (process.platform === 'linux' && isWsl && fs.existsSync('/mnt/wslg/runtime-dir/wayland-0')
  && env.AI_INSIGHTS_ELECTRON_USE_SYSTEM_DISPLAY !== '1') {
  env.XDG_RUNTIME_DIR = '/mnt/wslg/runtime-dir';
  env.WAYLAND_DISPLAY = 'wayland-0';
  env.DISPLAY = ':0';
  if (!args.some(arg => arg.startsWith('--ozone-platform'))) {
    args.unshift('--ozone-platform=wayland');
  }
  console.log('[electron] Using WSLg Wayland display');
}
if (process.platform === 'linux' && isWsl && env.AI_INSIGHTS_ELECTRON_SANDBOX !== '1') {
  args.unshift('--no-sandbox');
  env.ELECTRON_DISABLE_SANDBOX = '1';
}

const child = spawn(electron, args, {
  stdio: 'inherit',
  env,
  windowsHide: false,
});

child.on('error', error => {
  console.error('[electron] Failed to start:', error.message);
  process.exitCode = 1;
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
