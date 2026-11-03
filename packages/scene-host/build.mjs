import { build } from 'esbuild';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
import { mkdir, writeFile, rm, copyFile } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('.generated', { recursive: true });
const vendors = { react: 'react', remotion: 'remotion', 'react-dom': 'react-dom', 'react-dom-client': 'react-dom/client', jsx: 'react/jsx-runtime', 'jsx-dev': 'react/jsx-dev-runtime' };
for (const [name,mod] of Object.entries(vendors)) {
  if(name==='remotion'){await writeFile(`.generated/${name}.ts`,`export * from ${JSON.stringify(mod)};`);continue;}
  const names=Object.keys(require(mod)).filter(key=>key!=='default'&&/^[A-Za-z_$][\w$]*$/.test(key));
  await writeFile(`.generated/${name}.ts`,`import * as namespace from ${JSON.stringify(mod)}; const value=namespace.default??namespace; export default value; export const {${names.join(',')}}=value;`);
}
await build({ entryPoints: { client: 'src/browser/client.ts', scene: 'src/browser/scene-client.ts',  ...Object.fromEntries(Object.keys(vendors).map(name => [name, `.generated/${name}.ts`])) }, outdir: 'dist', splitting: true, format: 'esm', bundle: true, jsx: 'automatic', target: 'es2022', define: { 'process.env.NODE_ENV': '"production"' }, minify: false });
const imports = { react: '/react.js', remotion: '/remotion.js', 'react-dom': '/react-dom.js', 'react-dom/client': '/react-dom-client.js', 'react/jsx-runtime': '/jsx.js', 'react/jsx-dev-runtime': '/jsx-dev.js' };
await writeFile('dist/index.html', `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;background:transparent;color:#fff;font:18px system-ui}#stage{position:absolute;inset:0}#caption{position:absolute;bottom:5%;left:10%;right:10%;text-align:center;white-space:pre-wrap;text-shadow:0 2px 5px #000;font-size:32px}#status{position:absolute;bottom:1%;left:1%;font-size:14px}</style><script type="importmap">${JSON.stringify({ imports })}</script><div id="stage"></div><div id="caption"></div><div id="status"></div><script type="module" src="/client.js"></script></html>`);

await copyFile('node_modules/@hyperframes/core/dist/hyperframe.runtime.iife.js','dist/hf-runtime.js');
await writeFile('.generated/gsap-entry.ts', "import {gsap} from 'gsap'; globalThis.gsap=gsap;");
await build({entryPoints:['.generated/gsap-entry.ts'],outfile:'dist/gsap.js',bundle:true,format:'iife',minify:true});

const originPlaceholder = '__ASSET_ORIGIN__';
const sceneImports = Object.fromEntries(Object.entries(imports).map(([key,value])=>[key,originPlaceholder+value]));
await writeFile('dist/scene.html', `<!doctype html><html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}#stage{position:absolute;inset:0}</style><script type="importmap">${JSON.stringify({imports:sceneImports})}</script><div id="stage"></div><script type="module" src="${originPlaceholder}/scene.js"></script></html>`);

await build({entryPoints:['src/browser/replay.ts'],outfile:'dist/replay.js',bundle:true,format:'iife',target:'es2022'});
