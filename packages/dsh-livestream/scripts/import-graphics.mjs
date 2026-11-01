// 从 reelmorph-agent 效果库把能上舞台的特效拷进 assets/graphics/（这个目录在 .gitignore 里，靠本脚本复现）。
// 用法：node scripts/import-graphics.mjs [效果库目录]
//
// 不迁：shotcraft（要 Remotion 渲染页）、remotion 来源（超过 3 人要商业授权）、
// builtin（surface，不是一段动画）、gl-transitions（要两段素材做转场，以后再接）。

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const DEFAULT_LIB = '/Users/Ruihan/orca/projects/reelmorph-agent/acceptance/effects';
const GSAP = 'vendor/cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js';
const SKIP_SOURCES = new Set(['shotcraft', 'remotion', 'builtin', 'gl-transitions']);
const HAN = /\p{Script=Han}/u;
const TYPE_ZH = { string: '文字', number: '数字', enum: '选项', color: '颜色', boolean: '开关', image: '图片' };
const TEXT_EXT = /\.(html?|css|js|mjs|svg|json|txt|md)$/i;

const require = createRequire(join(PKG, 'package.json'));

/** 从 graphics.ts 抽出源组件名。不 import TS。 */
export function graphicSources(ts) {
  return [...ts.matchAll(/source:\s*'([^']+)'/g)].map((m) => m[1]);
}

/** 短名字 → hf-<source>。手工模板的字段映射不动，目录里只记别名。 */
export function aliasesFromGraphics(ts) {
  const out = {};
  let name = '';
  for (const line of ts.split('\n')) {
    const key = /^ {2}([A-Za-z][\w]*)\s*:\s*\{/.exec(line);
    if (key) name = key[1];
    const source = /source:\s*'([^']+)'/.exec(line);
    if (name && source) {
      out[`hf-${source[1]}`] = name;
      name = '';
    }
  }
  return out;
}

const LABELS = { 画面: 'see', 风格: 'style', 输入: 'input', 适用: 'use', 避免: 'avoid', 运行: 'run' };

/** summary_zh 的六段：画面/风格/输入/适用/避免/运行。 */
export function effectSections(summary) {
  const sections = {};
  const parts = String(summary ?? '').split(/(?:^|；)\s*(画面|风格|输入|适用|避免|运行)：/);
  for (let i = 1; i < parts.length; i += 2) sections[LABELS[parts[i]]] = parts[i + 1].replace(/[；。\s]+$/, '').trim();
  if (parts.length <= 1) sections.see = String(summary ?? '').trim();
  return sections;
}

function isTextVar(variable) {
  if (variable.type !== 'string') return false;
  return variable.role !== 'layout' && variable.role !== 'timing' && variable.role !== 'style' && variable.role !== 'motion';
}

function meaning(variable) {
  const label = String(variable.label || variable.id || '');
  if (HAN.test(label)) return label;
  const desc = String(variable.description || '');
  if (HAN.test(desc)) return desc;
  return `${TYPE_ZH[variable.type] || variable.type}：${label}`;
}

function seeLine(summary) {
  const see = effectSections(summary).see || String(summary ?? '');
  const line = see.split('。')[0].trim();
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

function runtimeOf(item) {
  if (item.runtime?.type === 'module') return 'module';
  if (item.runtime?.snippet) return 'snippet';
  return 'composition';
}

/** 片段自己没有时间线、demo 页有，就改走完整合成。 */
export function snippetNeedsDemo(snippetHtml, demoHtml) {
  const live = /<template[\s>]/i.test(snippetHtml) || /__timelines|gsap\.timeline|gsap\.from|gsap\.to\(/.test(snippetHtml);
  if (live) return false;
  return /__timelines|gsap\.timeline/.test(demoHtml || '');
}

/** 舞台用的一条精简目录。alias 是手工模板的短名字。 */
export function slimItem(item, alias) {
  const runtime = runtimeOf(item);
  const sections = effectSections(item.summary_zh);
  const variables = (item.variables ?? []).filter((variable) => variable && variable.id && TYPE_ZH[variable.type]).map((variable) => {
    const options = Array.isArray(variable.options)
      ? variable.options.filter((option) => option && option.value !== undefined).map((option) => ({ value: String(option.value), label: String(option.label ?? option.value) }))
      : undefined;
    return {
      id: String(variable.id),
      type: variable.type,
      label: meaning(variable),
      ...(variable.description ? { description: String(variable.description) } : {}),
      ...(variable.default !== undefined && (typeof variable.default === 'string' || typeof variable.default === 'number' || typeof variable.default === 'boolean') ? { default: variable.default } : {}),
      ...(options?.length ? { options } : {}),
      ...(typeof variable.min === 'number' ? { min: variable.min } : {}),
      ...(typeof variable.max === 'number' ? { max: variable.max } : {}),
      ...(isTextVar(variable) ? { text: true } : {}),
    };
  });
  return {
    id: item.id,
    name: item.name_zh || item.id,
    summary: seeLine(item.summary_zh),
    use: sections.use || '',
    capability: item.capability || '',
    category: item.category || '',
    layer: item.layer || 'overlay',
    tags: [...new Set([...(item.tags ?? []), ...(item.keywords ?? [])])],
    useWhen: item.use_when ?? [],
    variables,
    duration: Number(item.duration?.default) > 0 ? Number(item.duration.default) : 4,
    aspect: Array.isArray(item.aspect) ? item.aspect.join(' ') : String(item.aspect ?? ''),
    transparent: item.layer === 'overlay' || item.runtime?.alpha === true,
    runtime,
    entry: runtime === 'module' ? 'bundle.js' : runtime === 'snippet' ? item.runtime.snippet : item.entry,
    ...(alias ? { alias } : {}),
    source: item.source,
  };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function depFile(lib, dep) {
  const roots = [lib, join(lib, 'sources/hyperframes'), join(lib, '..', '..', 'library/third-party/hyperframes')];
  return roots.map((root) => join(root, dep)).find((path) => existsSync(path)) ?? '';
}

async function rewriteTree(dir, replacements) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await rewriteTree(path, replacements);
      continue;
    }
    if (!TEXT_EXT.test(entry.name)) continue;
    const text = await readFile(path, 'utf8');
    let next = text;
    for (const [from, to] of replacements) next = next.split(from).join(to);
    if (next !== text) await writeFile(path, next);
  }
}

async function bundleModule(dir, entry, kit) {
  await esbuild.build({
    entryPoints: [join(dir, entry)],
    outfile: join(dir, 'bundle.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    absWorkingDir: dir,
    logLevel: 'silent',
    alias: {
      '@reelmorph/scene': join(HERE, 'effect-scene-stub.ts'),
      '@reelmorph/component-kit': kit,
      react: require.resolve('react'),
      'react-dom': require.resolve('react-dom'),
      'react-dom/client': require.resolve('react-dom/client'),
      'react/jsx-runtime': require.resolve('react/jsx-runtime'),
      'react/jsx-dev-runtime': require.resolve('react/jsx-dev-runtime'),
    },
  });
}

async function main() {
  const lib = resolve(process.argv[2] || DEFAULT_LIB);
  const ts = await readFile(join(PKG, 'src/stage/graphics.ts'), 'utf8');
  const sources = graphicSources(ts);
  if (!sources.length) throw new Error('没有从 graphics.ts 抽到 source');
  const aliases = aliasesFromGraphics(ts);
  const catalog = JSON.parse(await readFile(join(lib, 'catalog.json'), 'utf8'));
  const all = catalog.items ?? [];
  const byId = new Map(all.map((item) => [item.id, item]));
  const keep = all.filter((item) => item.listing?.status === 'listed' && !SKIP_SOURCES.has(item.source));

  const outDir = join(PKG, 'assets/graphics');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const urlMap = new Map();
  const deps = new Set();
  for (const item of keep) for (const dep of item.deps ?? []) deps.add(dep);
  for (const item of keep) for (const [url, path] of Object.entries(item.dependencies ?? {})) urlMap.set(url, `/graphics/${path}`);
  const provenance = {};
  for (const dep of deps) {
    const from = depFile(lib, dep);
    if (!from) throw new Error(`找不到依赖：${dep}`);
    const dest = join(outDir, dep);
    await mkdir(dirname(dest), { recursive: true });
    await cp(from, dest);
    provenance[dep] = { from: relative(lib, from), sha256: sha256(await readFile(dest)) };
  }
  const replacements = [...urlMap.entries()];
  if (existsSync(join(outDir, 'vendor'))) await rewriteTree(join(outDir, 'vendor'), replacements);

  const kit = join(lib, '..', '..', 'library/components/_shared/index.ts');
  const slim = [];
  let bundled = 0;
  let failed = 0;
  for (const item of keep) {
    const dir = join(outDir, item.id);
    const from = join(lib, item.path);
    if (!existsSync(from)) throw new Error(`没有源目录：${item.path}`);
    await cp(from, dir, { recursive: true, filter: (path) => basename(path) !== 'preview.jpg' });
    await rewriteTree(dir, replacements);
    for (const file of item.licence?.files ?? []) {
      const abs = join(lib, file);
      if (!existsSync(abs)) continue;
      const dest = join(dir, 'LICENSES', basename(file));
      await mkdir(dirname(dest), { recursive: true });
      await cp(abs, dest);
    }
    const entry = slimItem(item, aliases[item.id]);
    if (entry.runtime === 'snippet' && item.runtime?.snippet && item.entry && item.entry !== item.runtime.snippet) {
      const snippetHtml = await readFile(join(dir, item.runtime.snippet), 'utf8');
      let demoHtml = '';
      try { demoHtml = await readFile(join(dir, item.entry), 'utf8'); } catch { /* 没有 demo */ }
      if (snippetNeedsDemo(snippetHtml, demoHtml)) {
        entry.runtime = 'composition';
        entry.entry = item.entry;
      }
    }
    if (entry.runtime === 'module') {
      try {
        await bundleModule(dir, item.entry, kit);
        bundled += 1;
      } catch (err) {
        entry.disabled = true;
        entry.reason = `模块打不成包：${err instanceof Error ? err.message : String(err)}`.slice(0, 240);
        failed += 1;
      }
    }
    slim.push(entry);
    if (slim.length % 40 === 0) console.log(`已处理 ${slim.length}/${keep.length}`);
  }

  // 16 个手工模板仍放在目录根上，舞台按原来的短名字加载，不改字段映射
  const put = async (name, fromAbs) => {
    const buf = await readFile(fromAbs);
    await writeFile(join(outDir, name), buf);
    provenance[name] = { from: relative(lib, fromAbs), sha256: sha256(buf) };
  };
  for (const source of sources) {
    const item = byId.get(`hf-${source}`);
    if (!item) throw new Error(`效果库里没有 hf-${source}`);
    const snippet = item.runtime?.snippet;
    if (!snippet) throw new Error(`${source} 没有 snippet`);
    await put(`${source}.html`, join(lib, item.path, snippet));
  }
  const gsapFile = depFile(lib, GSAP);
  if (!gsapFile) throw new Error(`找不到 gsap：${GSAP}`);
  await put('gsap.min.js', gsapFile);
  await put('LICENSE', join(lib, 'sources/hyperframes/LICENSE'));
  await put('NOTICE', join(lib, 'sources/hyperframes/NOTICE'));
  await put('module-host.html', join(HERE, 'module-host.html'));

  await writeFile(join(outDir, 'catalog.json'), `${JSON.stringify({ items: slim }, null, 2)}\n`);
  await writeFile(join(outDir, 'PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`);
  const bySource = {};
  const byLayer = {};
  for (const item of slim) {
    bySource[item.source] = (bySource[item.source] ?? 0) + 1;
    byLayer[item.layer] = (byLayer[item.layer] ?? 0) + 1;
  }
  console.log(`写好 ${slim.length} 个特效到 ${outDir}（模块包 ${bundled}，打包失败 ${failed}）`);
  console.log('来源', bySource);
  console.log('层', byLayer);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entry) await main();
