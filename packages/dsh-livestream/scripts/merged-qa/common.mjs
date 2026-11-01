import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
export const BASE = 'http://127.0.0.1:3825';
export const SPACE = 'aivtb 合并验收';
export const OUT = 'scripts/merged-qa';
export const normal = text => (text ?? '').replace(/\[\[[\s\S]*?\]\]/g, '').replace(/\*/g, '').replace(/\s+/g, '').trim();
export async function fingerprint() {
  const files = [];
  async function walk(dir) {
    for (const item of (await readdir(dir, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))) {
      const path = `${dir}/${item.name}`;
      if (item.isDirectory()) await walk(path);
      else if (item.isFile()) files.push(path);
    }
  }
  await walk('src'); await walk('lib');
  if (!files.some(f => f.startsWith('lib/'))) throw Error('缺少当前构建产物，请先构建');
  const rows = [];
  for (const file of files) rows.push({ file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
  return { sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'), files: rows };
}
export async function post(path, body = {}) {
  const response = await fetch(BASE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw Error(`${path}: ${JSON.stringify(data)}`);
  return data;
}
export const bridge = async (method, args = {}) => (await post('/bridge/call', { method, args })).value;
export async function observed(run) {
  try {
    return (await readFile(resolve(OUT, `shots-${run}/shots.jsonl`), 'utf8')).trim().split('\n').filter(Boolean).flatMap(s => JSON.parse(s).observed?.events ?? []);
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export function audioFor(subtitle, events) {
  return events.filter(o => {
    try { return o.type === 'audio' && subtitle?.audio && new URL(o.src).pathname === subtitle.audio; } catch { return false; }
  }).sort((a,b) => Math.abs(a.at-subtitle.startedAt)-Math.abs(b.at-subtitle.startedAt))[0];
}
export function heardAt(subtitle, events) {
  const audio = audioFor(subtitle, events);
  return audio && audio.rate > 0 ? audio.at-audio.currentTime*1000/audio.rate : undefined;
}
