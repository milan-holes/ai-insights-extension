// @ts-check
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const electron = process.argv.includes('--electron');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  logLevel: 'info',
  loader: {
    '.json': 'json',
  },
};

/** @type {import('esbuild').BuildOptions[]} */
const electronBuildOptions = [
  {
    entryPoints: ['src/electron/main.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/electron/main.js',
    external: ['electron'],
    alias: { vscode: path.resolve('src/electron/viewHost.ts') },
    logLevel: 'info',
    loader: { '.json': 'json' },
  },
  {
    entryPoints: ['src/electron/preload.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/electron/preload.js',
    external: ['electron'],
    logLevel: 'info',
    loader: { '.json': 'json' },
  },
  {
    entryPoints: ['src/electron/renderer.ts'],
    bundle: true,
    format: 'iife',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'browser',
    outfile: 'dist/electron/renderer.js',
    logLevel: 'info',
    loader: { '.json': 'json' },
  },
];

function copyElectronAssets() {
  const outDir = path.join('dist', 'electron');
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(path.join('src', 'electron', 'index.html'), path.join(outDir, 'index.html'));
  for (const directory of ['assets', 'media']) {
    fs.cpSync(directory, path.join(outDir, directory), { recursive: true });
  }
}

async function main() {
  if (electron) {
    if (watch) {
      const contexts = await Promise.all(electronBuildOptions.map(options => esbuild.context(options)));
      await Promise.all(contexts.map(ctx => ctx.watch()));
      copyElectronAssets();
      console.log('[esbuild] watching Electron app changes...');
    } else {
      await Promise.all(electronBuildOptions.map(options => esbuild.build(options)));
      copyElectronAssets();
      console.log('[esbuild] Electron build complete');
    }
    return;
  }

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('[esbuild] watching for changes...');
  } else {
    await esbuild.build(buildOptions);
    console.log('[esbuild] build complete');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
