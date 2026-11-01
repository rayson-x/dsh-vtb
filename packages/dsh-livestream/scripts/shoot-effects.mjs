// 把目录里每个特效用默认字段上屏，停在中间一帧和最后一帧各截一张，拼成联系表。
// 白屏或报错的在 catalog.json 里标 disabled。背景不透明的留着，只记在报告里。
// 浏览器只用 ego lite（ego-browser），一页一页截，批与批之间停一下。用完关掉 3905，并 finish 任务空间。
//
//   node scripts/shoot-effects.mjs [--limit N]
// 先在 packages/dsh-livestream 里 node build.mjs，并已经跑过导入。

import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const ROOT = join(PKG, '..', '..');
const PORT = 3905;
const SPACE = 'aivtb effects 验收';
const CATALOG = join(PKG, 'assets/graphics/catalog.json');
const SHOTS = join(ROOT, '.deps/tasks/shots');
const THUMBS = join(SHOTS, 'effects-thumbs');
const PROGRESS = join(SHOTS, 'effects-progress.json');
const BATCH = join(SHOTS, 'effects-batch.json');
const BATCH_OUT = join(SHOTS, 'effects-batch-out.json');
const COLS = 3;
const ROWS = 4;
const PER = COLS * ROWS;
const THUMB_W = 320;
const THUMB_H = 180;
const LABEL_H = 36;
const CELL_W = THUMB_W * 2;
const CELL_H = THUMB_H + LABEL_H;
const BATCH_SIZE = 8;
const PAUSE_MS = 4000;

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;

const escapeXml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function fieldsOf(item) {
  const fields = {};
  for (const variable of item.variables ?? []) {
    if (variable.default === undefined || variable.default === '') continue;
    fields[variable.id] = variable.default;
  }
  return fields;
}

function sample(data) {
  let magenta = 0;
  let white = 0;
  let other = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    n += 1;
    if (r > 220 && b > 220 && g < 100) magenta += 1;
    else if (r > 242 && g > 242 && b > 242) white += 1;
    else other += 1;
  }
  return { magenta: magenta / n, white: white / n, other: other / n };
}

function verdict(mid, end, transparent, error) {
  if (error) return { kind: 'bad', reason: String(error).slice(0, 180) };
  const drawn = (frame) => frame.other >= 0.003;
  if (!drawn(mid) && !drawn(end)) return { kind: 'bad', reason: mid.white > 0.8 || end.white > 0.8 ? '白屏' : '没有画出来' };
  if (transparent && mid.magenta < 0.04 && end.magenta < 0.04 && mid.other > 0.4 && end.other > 0.4) return { kind: 'opaque', reason: '背景不透明' };
  return { kind: 'ok', reason: '' };
}

async function analyze(png) {
  // 右上角直播标和右栏弹幕叠在特效上面，取样时裁掉一圈，免得空画面被角标当成画出来了
  const meta = await sharp(png).metadata();
  const w = meta.width ?? THUMB_W;
  const h = meta.height ?? THUMB_H;
  const insetX = Math.max(0, Math.round(w * 0.12));
  const insetY = Math.max(0, Math.round(h * 0.12));
  const cropped = sharp(png).extract({ left: insetX, top: insetY, width: Math.max(1, w - insetX * 2), height: Math.max(1, h - insetY * 2) });
  const { data } = await cropped.resize(160, 90, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const thumb = await sharp(png).resize(THUMB_W, THUMB_H, { fit: 'fill' }).jpeg({ quality: 62 }).toBuffer();
  return { stats: sample(data), thumb };
}

async function blankThumb(text) {
  const svg = `<svg width="${THUMB_W}" height="${THUMB_H}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#241018"/><text x="12" y="96" fill="#ff8b8b" font-size="18" font-family="sans-serif">${escapeXml(text).slice(0, 42)}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 70 }).toBuffer();
}

async function cellImage(item, mid, end, kind) {
  const color = kind === 'ok' ? '#8fe3d8' : kind === 'opaque' ? '#f4c86a' : '#ff8b8b';
  const label = Buffer.from(`<svg width="${CELL_W}" height="${LABEL_H}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#0b1020"/><text x="8" y="24" fill="${color}" font-size="15" font-family="sans-serif">${escapeXml(`${item.id}  ${item.name}`).slice(0, 64)}</text></svg>`);
  return sharp({ create: { width: CELL_W, height: CELL_H, channels: 3, background: '#0b1020' } })
    .composite([
      { input: label, top: 0, left: 0 },
      { input: mid, top: LABEL_H, left: 0 },
      { input: end, top: LABEL_H, left: THUMB_W },
    ])
    .jpeg({ quality: 72 })
    .toBuffer();
}

async function writeSheets(rows) {
  const old = await readFile(join(SHOTS, 'effects-sheet-01.jpg')).then(() => true).catch(() => false);
  if (old) {
    const { readdir } = await import('node:fs/promises');
    for (const name of await readdir(SHOTS)) {
      if (/^effects-sheet-\d+\.jpg$/.test(name)) await rm(join(SHOTS, name));
    }
  }
  const paths = [];
  for (let i = 0; i < rows.length; i += PER) {
    const slice = rows.slice(i, i + PER);
    const cells = await Promise.all(slice.map((row) => cellImage(row.item, row.mid, row.end, row.kind)));
    const composites = cells.map((input, index) => ({
      input,
      left: (index % COLS) * CELL_W,
      top: Math.floor(index / COLS) * CELL_H,
    }));
    const height = Math.ceil(slice.length / COLS) * CELL_H;
    const name = `effects-sheet-${String(paths.length + 1).padStart(2, '0')}.jpg`;
    const path = join(SHOTS, name);
    await sharp({ create: { width: COLS * CELL_W, height, channels: 3, background: '#0b1020' } })
      .composite(composites)
      .jpeg({ quality: 74 })
      .toFile(path);
    paths.push(path);
  }
  return paths;
}

function startServer() {
  const child = spawn(process.execPath, ['lib/dev.js', '--port', String(PORT)], {
    cwd: PKG,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (buf) => { log += buf; });
  child.stderr.on('data', (buf) => { log += buf; });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`舞台没起来：${log.slice(-500)}`)), 20_000);
    const poll = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/state`);
        if (res.ok) { clearTimeout(timer); resolve(); return; }
      } catch { /* 还在起 */ }
      setTimeout(poll, 200);
    };
    poll();
  });
  return { child, ready };
}

function pageScript() {
  return `
const fs = await import('node:fs/promises');
const batch = JSON.parse(await fs.readFile(${JSON.stringify(BATCH)}, 'utf8'));
const port = batch.port;
const task = await taskSpace(${JSON.stringify(SPACE)});
console.log(JSON.stringify({ spaceId: task.spaceId, page: 'p1' }));
const page = task.page('p1');

async function post(body) {
  const res = await fetch('http://127.0.0.1:' + port + '/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  const first = json.results && json.results[0];
  if (!first || !first.ok) throw new Error((first && first.error) || '指令没做成');
}

async function prepare() {
  let url = '';
  try { url = await page.url(); } catch { url = ''; }
  if (!url.includes('127.0.0.1:' + port)) {
    await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  }
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await page.waitForSelector('.stage', { timeout: 10000 });
  await page.evaluate(() => { window.__graphicProbe = true; window.__graphicLastError = ''; window.__graphicFreeze = 0; });
  await post({ type: 'scene', scene: 'watch', cut: 'hard', by: 'owner' });
}

async function clipOf(id) {
  return page.evaluate((name) => {
    const el = document.querySelector('[data-graphic-box="' + name + '"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(window.innerWidth - 2, Math.round(r.x)));
    const y = Math.max(0, Math.min(window.innerHeight - 2, Math.round(r.y)));
    const width = Math.max(1, Math.min(window.innerWidth - x, Math.round(r.width)));
    const height = Math.max(1, Math.min(window.innerHeight - y, Math.round(r.height)));
    return { x, y, width, height };
  }, id);
}

async function shootOne(item, attempt) {
  try {
    await page.evaluate(() => { window.__graphicLastError = ''; window.__graphicFreeze = 0; });
    await post({ type: 'ungraphic' });
    await page.waitForFunction(() => !document.querySelector('[data-graphic-box]'), undefined, { timeout: 4000 }).catch(() => {});
    await page.evaluate(() => { window.__graphicLastError = ''; });
    await post({ type: 'graphic', name: item.id, fields: item.fields, seconds: 20, id: 'probe-' + item.id });
    let status = '';
    try {
      await page.waitForFunction((name) => {
        if (window.__graphicLastError) return window.__graphicLastError;
        const box = document.querySelector('[data-graphic-box="' + name + '"]');
        if (box && box.getAttribute('data-graphic-state') === 'ready') return 'ready';
        return '';
      }, item.id, { timeout: 18000, polling: 100 });
      status = await page.evaluate((name) => {
        if (window.__graphicLastError) return window.__graphicLastError;
        const box = document.querySelector('[data-graphic-box="' + name + '"]');
        return box && box.getAttribute('data-graphic-state') === 'ready' ? 'ready' : '没有画出来';
      }, item.id);
    } catch (err) {
      status = await page.evaluate(() => window.__graphicLastError || '').catch(() => '');
      if (!status) status = '超时，没有画出来';
    }
    if (status !== 'ready') return { id: item.id, error: status };
    const grab = async (time, path) => {
      await page.evaluate((t) => { window.__graphicFreeze = t; }, time);
      await page.waitForTimeout(item.runtime === 'module' ? 500 : 250);
      const clip = await clipOf(item.id);
      if (!clip || clip.width < 8 || clip.height < 8) throw new Error('截不到画面');
      await page.screenshot({ path, clip });
    };
    await grab(item.duration / 2, item.mid);
    await grab(item.duration, item.end);
    return { id: item.id, ok: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (attempt === 0 && /unresponsive|detached|Target closed|Execution context|页面没响应/i.test(message)) {
      try { await page.cdp('Page.stopLoading'); } catch { /* 已经停了 */ }
      await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await prepare();
      return shootOne(item, 1);
    }
    return { id: item.id, error: message.slice(0, 180) };
  }
}

await prepare();
const done = [];
for (const item of batch.items) {
  const row = await shootOne(item, 0);
  done.push(row);
  await fs.writeFile(${JSON.stringify(BATCH_OUT)}, JSON.stringify(done));
  console.log('SHOT ' + item.id + ' ' + (row.ok ? 'shot' : row.error));
}
console.log('BATCH ' + done.length);
`;
}

function ego(timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', (buf) => process.stdout.write(buf));
    child.stderr.on('data', (buf) => { err += buf; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, err });
    });
    child.stdin.end(pageScript());
  });
}

async function loadProgress() {
  try {
    const rows = JSON.parse(await readFile(PROGRESS, 'utf8'));
    return new Map(rows.map((row) => [row.id, row]));
  } catch {
    return new Map();
  }
}

async function saveProgress(map) {
  await writeFile(PROGRESS, `${JSON.stringify([...map.values()], null, 2)}\n`);
}

async function shootBatch(items) {
  await rm(BATCH_OUT, { force: true });
  const raw = join(SHOTS, 'effects-raw');
  await mkdir(raw, { recursive: true });
  const payload = {
    port: PORT,
    items: items.map((item) => ({
      id: item.id,
      runtime: item.runtime,
      duration: item.duration > 0 ? item.duration : 4,
      fields: fieldsOf(item),
      mid: join(raw, `${item.id}-mid.png`),
      end: join(raw, `${item.id}-end.png`),
    })),
  };
  await writeFile(BATCH, `${JSON.stringify(payload)}\n`);
  const timeout = items.length * 28_000 + 40_000;
  await ego(timeout);
  let rows = [];
  try { rows = JSON.parse(await readFile(BATCH_OUT, 'utf8')); } catch { rows = []; }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const out = [];
  for (const item of items) {
    const row = byId.get(item.id);
    if (!row) {
      out.push({ item, error: '这批没截完' });
      continue;
    }
    if (!row.ok) {
      out.push({ item, error: row.error || '没有画出来' });
      continue;
    }
    try {
      const mid = await analyze(join(raw, `${item.id}-mid.png`));
      const end = await analyze(join(raw, `${item.id}-end.png`));
      const result = verdict(mid.stats, end.stats, item.transparent === true, '');
      out.push({ item, ...result, mid: mid.thumb, end: end.thumb });
    } catch (err) {
      out.push({ item, error: err instanceof Error ? err.message : String(err) });
    }
  }
  await rm(raw, { recursive: true, force: true });
  return out;
}

async function remember(progress, item, kind, reason, mid, end) {
  await mkdir(THUMBS, { recursive: true });
  const midPath = join(THUMBS, `${item.id}-mid.jpg`);
  const endPath = join(THUMBS, `${item.id}-end.jpg`);
  await writeFile(midPath, mid);
  await writeFile(endPath, end);
  progress.set(item.id, { id: item.id, kind, reason, source: item.source, layer: item.layer, runtime: item.runtime });
  await saveProgress(progress);
}

async function finishSpace() {
  const code = `
const task = await taskSpace(${JSON.stringify(SPACE)});
await task.finish({ keep: [] });
console.log('finished ' + task.spaceId);
`;
  await new Promise((resolve) => {
    const child = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'pipe', 'inherit'] });
    child.on('close', () => resolve());
    child.stdin.end(code);
  });
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
  const items = catalog.items ?? [];
  const progress = await loadProgress();
  if (progress.size === 0) {
    for (const item of items) {
      if (String(item.reason || '').startsWith('模块打不成包')) continue;
      delete item.disabled;
      delete item.reason;
    }
    await writeFile(CATALOG, `${JSON.stringify(catalog, null, 2)}\n`);
  }

  for (const item of items) {
    if (progress.has(item.id)) continue;
    if (!String(item.reason || '').startsWith('模块打不成包')) continue;
    const thumb = await blankThumb(item.reason);
    await remember(progress, item, 'bad', item.reason, thumb, thumb);
  }

  const todo = items.filter((item) => !progress.has(item.id)).slice(0, Number.isFinite(LIMIT) ? LIMIT : undefined);
  const { child, ready } = todo.length ? startServer() : { child: null, ready: Promise.resolve() };
  const stop = () => { if (child && !child.killed) child.kill('SIGTERM'); };
  process.on('SIGINT', () => { stop(); process.exit(1); });
  try {
    if (todo.length) await ready;
    for (let i = 0; i < todo.length; i += BATCH_SIZE) {
      const slice = todo.slice(i, i + BATCH_SIZE);
      console.log(`开始 ${i + 1}–${i + slice.length} / ${todo.length}`);
      let shot = await shootBatch(slice);
      const missed = shot.filter((row) => row.error === '这批没截完').map((row) => row.item);
      if (missed.length) {
        console.log(`补截 ${missed.length} 个`);
        await delay(PAUSE_MS);
        const again = await shootBatch(missed);
        const byId = new Map(again.map((row) => [row.item.id, row]));
        shot = shot.map((row) => byId.get(row.item.id) ?? row);
      }
      const stuck = shot.find((row) => row.error === '这批没截完');
      for (const row of shot) {
        if (row.error === '这批没截完') continue;
        const kind = row.kind || 'bad';
        const reason = row.reason || row.error || '没有画出来';
        const mid = row.mid || await blankThumb(reason);
        const end = row.end || mid;
        await remember(progress, row.item, kind, kind === 'ok' ? '' : reason, mid, end);
        console.log(`${progress.size}/${items.length} ${row.item.id} ${kind}${kind === 'ok' ? '' : ' ' + reason}`);
      }
      if (stuck) throw new Error(`这批没截完，停在 ${stuck.item.id}，再跑会从这里继续`);
      if (i + BATCH_SIZE < todo.length) await delay(PAUSE_MS);
    }

    if (Number.isFinite(LIMIT) && progress.size < items.length) {
      console.log(`先停在 ${progress.size} 个，任务空间留着，接着跑会从这里继续`);
      return;
    }

    for (const item of items) {
      const row = progress.get(item.id);
      if (!row) continue;
      if (String(item.reason || '').startsWith('模块打不成包')) continue;
      if (row.kind === 'bad') {
        item.disabled = true;
        item.reason = row.reason;
      } else {
        delete item.disabled;
        delete item.reason;
      }
    }
    await writeFile(CATALOG, `${JSON.stringify(catalog, null, 2)}\n`);

    const rows = [];
    for (const item of items) {
      const row = progress.get(item.id);
      const kind = row?.kind || 'bad';
      const mid = await readFile(join(THUMBS, `${item.id}-mid.jpg`)).catch(() => blankThumb(row?.reason || '没有截图'));
      const end = await readFile(join(THUMBS, `${item.id}-end.jpg`)).catch(() => mid);
      rows.push({ item, mid, end, kind });
    }
    const paths = await writeSheets(rows);
    const count = (kind) => [...progress.values()].filter((row) => row.kind === kind).length;
    const bySource = {};
    const byLayer = {};
    for (const item of items) {
      bySource[item.source] = (bySource[item.source] ?? 0) + 1;
      byLayer[item.layer] = (byLayer[item.layer] ?? 0) + 1;
    }
    const report = {
      total: items.length,
      ok: count('ok'),
      opaque: count('opaque'),
      bad: count('bad'),
      bySource,
      byLayer,
      sheets: paths,
      badOnes: [...progress.values()].filter((row) => row.kind === 'bad').map((row) => ({ id: row.id, reason: row.reason, source: row.source, layer: row.layer, runtime: row.runtime })),
      opaqueOnes: [...progress.values()].filter((row) => row.kind === 'opaque').map((row) => row.id),
    };
    await writeFile(join(SHOTS, 'effects-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ total: report.total, ok: report.ok, opaque: report.opaque, bad: report.bad, sheets: paths.length }));
    await finishSpace();
  } finally {
    stop();
    await delay(400);
    if (child && !child.killed) child.kill('SIGKILL');
  }
}

await main();
