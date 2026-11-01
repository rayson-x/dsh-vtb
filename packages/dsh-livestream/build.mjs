// 构建：
//   宿主端 → Node ESM（lib/index.js、lib/agent.js 共用 lib/chunks/ 里的舞台控制器；lib/dev.js 单独起舞台）
//   舞台页、调试台 → 浏览器脚本（lib/stage.js、lib/control.js，React 打进去）和 lib/stage.css
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';

await rm('lib', { recursive: true, force: true });
await mkdir('lib', { recursive: true });

await build({
  entryPoints: { index: 'src/dsh/index.ts', agent: 'src/dsh/agent.ts', dev: 'src/host/dev.ts', console: 'src/host/console.ts' },
  outdir: 'lib',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // DSH 宿主提供
  external: ['@deepseek-ai/*'],
});

await build({
  entryPoints: { stage: 'src/page/main.tsx', control: 'src/page/control.tsx' },
  outdir: 'lib',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});

await copyFile('src/page/stage.css', 'lib/stage.css');
// 展示字体不进仓库：先 node scripts/fetch-font.mjs；没有就退回系统字体
if (existsSync('assets/fonts/smiley-sans.woff2')) await copyFile('assets/fonts/smiley-sans.woff2', 'lib/smiley-sans.woff2');
console.log('built lib/{index,agent,dev}.js, lib/{stage,control}.js, lib/stage.css');
