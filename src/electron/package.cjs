const fs = require('node:fs');
const path = require('node:path');
const { build, Platform, Arch } = require('electron-builder');
const metadata = require('../../package.json');

const root = path.resolve(__dirname, '../..');
const appDir = path.join(root, 'dist', 'electron');

// Package the standalone bundle, without the extension manifest or its dependencies.
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
  name: 'ai-insights-desktop',
  productName: 'AI Insights',
  version: metadata.version,
  description: metadata.description,
  license: metadata.license,
  author: metadata.publisher,
  main: 'main.js',
}, null, 2));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(appDir, 'LICENSE'));

build({
  targets: Platform.WINDOWS.createTarget('portable', Arch.x64),
  config: {
    appId: 'dev.thewalking.ai-insights',
    productName: 'AI Insights',
    electronVersion: require('electron/package.json').version,
    directories: { app: appDir, output: path.join(root, 'app') },
    files: ['**/*', '!**/*.map', '!**/node_modules/**/*'],
    asar: true,
    compression: 'normal',
    npmRebuild: false,
    win: {
      artifactName: 'ai_insights_win.exe',
      executableName: 'ai_insights_win',
      icon: path.join(root, 'assets', 'logo.png'),
      signExecutable: false,
      target: ['portable'],
    },
    portable: { artifactName: 'ai_insights_win.exe', useZip: true },
  },
}).then(files => {
  console.log('Windows artifacts:', files.join('\n'));
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
