/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Electron Main & Preload Production Compilation Script.
 * Uses esbuild to bundle TypeScript into CommonJS for Electron runtime.
 */

import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const isDev = process.argv.includes('--watch');

async function build() {
  const outDir = path.resolve('dist-electron');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  console.log('[Build Electron] Compiling Main and Preload scripts...');

  await esbuild.build({
    entryPoints: {
      main: 'src/main/app.ts',
      preload: 'src/preload/index.ts',
    },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outdir: 'dist-electron',
    outExtension: { '.js': '.cjs' },
    external: [
      'electron',
      'onnxruntime-web',
      'node:sqlite',
      'node:path',
      'node:fs',
      'node:crypto',
      'node:url',
      'node:os'
    ],
    sourcemap: isDev,
    minify: !isDev,
    treeShaking: true,
    logLevel: 'info',
  });

  console.log('[Build Electron] Electron compilation completed successfully.');
}

build().catch((err) => {
  console.error('[Build Electron] Failed to compile:', err);
  process.exit(1);
});
