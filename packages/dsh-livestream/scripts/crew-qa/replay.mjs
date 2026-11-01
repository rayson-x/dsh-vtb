// 真实台词双版本回放；仅使用3914，不向开发舞台传入任何语音密钥。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import sharp from 'sharp';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(ROOT, 'scripts/crew-qa/out-2a');
const BASE = 'http://127.0.0.1:3914';
const input = resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? resolve(ROOT, 'scripts/crew-qa/segments-1031.json'));
await mkdir(OUT, { recursive: true });
await build({ stdin: { contents: `export * from './src/host/crew/index.ts'; export {initialState} from './src/stage/protocol.ts'; export {parseCues} from './src/stage/cues.ts'; export {speechMs, splitForStart} from './src/host/controller.ts';`, resolveDir: ROOT }, outfile: resolve(OUT, 'runtime.mjs'), platform: 'node', format: 'esm', bundle: true });
const { callLane, mergeCrew, laneOf, initialState, parseCues, speechMs, splitForStart } = await import(resolve(OUT, 'runtime.mjs'));
const source = JSON.parse(await readFile(input, 'utf8'));
const env = parseEnv(await readFile(resolve(ROOT, '../../.env'), 'utf8'));
const key = env.DEEPSEEK_API_KEY;
if (!key) throw new Error('当前目录的 .env 缺少 DeepSeek 凭据');
const segments = source.segments;
const plans = process.argv.includes('--reuse-plan') ? JSON.parse(await readFile(resolve(OUT, 'plans.json'), 'utf8')) : { A: [], B: [] };
if (!process.argv.includes('--reuse-plan')) {
for (const version of ['A', 'B']) {
  let state = initialState(), now = 1_000_000;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i], parsed = parseCues(segment.text), ms = speechMs(parsed.text);
    const host = version === 'A' ? parsed.cues : parsed.cues.filter((cue) => !['graphics', 'lighting', 'sound'].includes(laneOf(cue.cmd)));
    const calls = version === 'A' ? [] : await Promise.all(['graphics', 'lighting', 'sound'].map((lane) => callLane(lane, {
      text: segment.text, segment: i + 1, before: segments.slice(Math.max(0, i - 2), i).map((s) => parseCues(s.text).text),
      after: segments.slice(i + 1, i + 3).map((s) => parseCues(s.text).text), tone: segment.tone,
      topic: source.topic, state,
    }, key)));
    const merged = mergeCrew(state, parsed.text, host, calls, ms, now);
    const markers = parsed.marks;
    let from = 0;
    const chunks = splitForStart(parsed.text).map((length) => {
      const text = [...parsed.text].slice(from, from + length).join('');
      const chunk = { from, length, text, ms: speechMs(text) }; from += length; return chunk;
    });
    // /speak 负责念原文和主持人标记；岗位指令按实际字幕时钟发到 /command。
    const speak = version === 'A' ? segment.text : segment.text.replace(/[<`]\s*(\[\[[\s\S]*?\]\])\s*[>`]/g, '$1').replace(/\[\[[\s\S]*?\]\]/g, (raw) => {
      const cue = parseCues(raw).cues[0];
      return cue && host.some((h) => h.raw === raw) ? raw : '';
    });
    plans[version].push({ segment: i + 1, text: parsed.text, speak, markers, chunks, ms, cues: merged.cues, receipts: merged.receipts, errors: [...parsed.errors, ...merged.errors], calls });
    state = merged.state; now += ms + 1000;
    console.log(`${version} 第${i + 1}段：${merged.cues.length}个动作；${calls.map((r) => `${r.lane} ${r.ms}ms ${r.status}`).join('，')}；丢弃${merged.errors.length}`);
  }
}
}
// 复核保存的模型输出时仍用当前 reducer/合并规则重算，禁止沿用旧的通过/拒绝结论。
if (process.argv.includes('--reuse-plan')) {
  for (const version of ['A', 'B']) {
    let state = initialState(), now = 1_000_000;
    for (const [i, plan] of plans[version].entries()) {
      const parsed = parseCues(segments[i].text);
      const host = version === 'A' ? parsed.cues : parsed.cues.filter((cue) => !['graphics', 'lighting', 'sound'].includes(laneOf(cue.cmd)));
      const merged = mergeCrew(state, plan.text, host, plan.calls, plan.ms, now);
      Object.assign(plan, { cues: merged.cues, receipts: merged.receipts, errors: [...parsed.errors, ...merged.errors] });
      state = merged.state; now += plan.ms + 1000;
    }
  }
}
await writeFile(resolve(OUT, 'plans.json'), JSON.stringify(plans, null, 2));
if (process.argv.includes('--plan-only')) process.exit(0);
let server;
function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: ROOT, ...options });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`${command} 退出码 ${code}`)));
  });
}
async function stop() {
  if (!server) return;
  const child = server; server = undefined;
  await new Promise((resolveStop) => { child.once('exit', resolveStop); child.kill('SIGTERM'); });
}
async function browser(script) { await run('ego-browser', ['nodejs', '-e', script], { stdio: 'inherit' }); }
try {
  // 不占用别的舞台；已有3914也拒绝接管。
  if (await fetch(`${BASE}/state`).then(() => true).catch(() => false)) throw new Error('3914已被占用，未接管现有服务');
  const capture = await readFile(resolve(ROOT, 'scripts/crew-qa/capture.mjs'), 'utf8');
  for (const version of ['A', 'B']) {
    if (version === 'A' && process.argv.includes('--reuse-a')) continue;
    // 明确不给语音凭据，即使调用此脚本的 shell 带有密钥也不会合成。
    server = spawn(process.execPath, ['lib/dev.js', '--port', '3914'], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', () => {}); server.stderr.on('data', () => {});
    for (let tries = 0; ; tries++) {
      if (await fetch(`${BASE}/state`).then((r) => r.ok).catch(() => false)) break;
      if (tries > 80) throw new Error('3914启动失败');
      await new Promise((r) => setTimeout(r, 100));
    }
    await browser(`globalThis.QA=${JSON.stringify({ root: ROOT, out: OUT, base: BASE, version, space: 'aivtb-crew2 回放' })};\n${capture}`);
    await stop();
  }
} finally {
  await stop();

}
const captureA = JSON.parse(await readFile(resolve(OUT, 'capture-A.json'), 'utf8'));
const captureB = JSON.parse(await readFile(resolve(OUT, 'capture-B.json'), 'utf8'));
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;
const metrics = {};
for (const version of ['A', 'B']) {
  const capture = version === 'A' ? captureA : captureB;
  const plan = plans[version];
  const lanes = Object.fromEntries(['graphics', 'lighting', 'sound'].map((lane) => {
    const calls = plan.flatMap((s) => s.calls.filter((c) => c.lane === lane));
    return [lane, { calls: calls.length, p50Ms: percentile(calls.map((c) => c.ms), 0.5), p90Ms: percentile(calls.map((c) => c.ms), 0.9), onTimeRatio: calls.length ? calls.filter((c) => c.status === 'ok' && c.ms <= 9000).length / calls.length : null, failures: calls.filter((c) => c.status !== 'ok').length }];
  }));
  capture.metrics.acceptedCrossLane ??= capture.dispatches.filter((d) => d.cue.cmd.lane && d.cue.cmd.lane !== laneOf(d.cue.cmd) && d.response.results.some((r) => r.ok)).length;
  const drops = plan.flatMap((s) => s.errors);
  metrics[version] = { lanes, dropped: drops.length, rejectedLane: drops.filter((x) => /车道|只有 host/.test(x)).length, ...capture.metrics, graphicsPageWithInteractive: { accepted: capture.dispatches.filter((d) => d.interactive && d.cue.cmd.type === 'page' && d.response.results.some((r) => r.ok)).length, rejected: plan.flatMap((s) => s.receipts ?? []).filter((r) => r.type === 'page' && r.interactive && !r.ok).length + capture.dispatches.filter((d) => d.interactive && d.cue.cmd.type === 'page' && d.response.results.some((r) => !r.ok)).length }, drops };
}
// 每个时间点都拼成左右对比，再分为每页六行的联系表，便于逐张检查。
const pairs = [];
const phase1 = JSON.parse(await readFile(resolve(ROOT, 'scripts/crew-qa/out-phase1/capture-B.json'), 'utf8'));
for (let i = 0; i < phase1.shots.length; i++) {
  const old = phase1.shots[i];
  const a = { ...old, path: resolve(ROOT, 'scripts/crew-qa/out-phase1/raw/B', old.path.split('/').at(-1)) };
  const b = captureB.shots.find((s) => s.segment === a.segment && s.frame === a.frame);
  if (!b) continue;
  const left = await sharp(a.path).resize(720, 405).toBuffer();
  const right = await sharp(b.path).resize(720, 405).toBuffer();
  pairs.push({ label: `段 ${a.segment} / ${a.frame * 2} 秒`, left, right });
}
const comparisons = [];
for (let from = 0; from < pairs.length; from += 6) {
  const rows = pairs.slice(from, from + 6), width = 1440, rowHeight = 437;
  const composites = [];
  for (let j = 0; j < rows.length; j++) {
    const row = rows[j], top = j * rowHeight;
    const label = `<svg width="1440" height="32"><rect width="1440" height="32" fill="#18222b"/><text x="12" y="23" font-size="20" fill="white">第一期 B　｜　${row.label}　｜　第二期 a B</text></svg>`;
    composites.push({ input: Buffer.from(label), left: 0, top }, { input: row.left, left: 0, top: top + 32 }, { input: row.right, left: 720, top: top + 32 });
  }
  const path = resolve(OUT, `compare-${String(comparisons.length + 1).padStart(2, '0')}.jpg`);
  await sharp({ create: { width, height: rows.length * rowHeight, channels: 3, background: '#18222b' } }).composite(composites).jpeg({ quality: 88 }).toFile(path);
  comparisons.push(path);
}
const result = { input, generatedAt: new Date().toISOString(), timing: '无语音合成；每字220ms+400ms，9秒提前量；使用实际字幕 startedAt/ms 调度；截图2秒、状态采样约100ms', metrics, comparisons, pairs: pairs.length };
await writeFile(resolve(OUT, 'metrics.json'), JSON.stringify(result, null, 2));
let table = '|版本|车道|调用|p50(ms)|p90(ms)|9秒内成功|失败|\n|---|---|---:|---:|---:|---:|---:|\n';
for (const version of ['A', 'B']) for (const [lane, m] of Object.entries(metrics[version].lanes)) table += `|${version}|${lane}|${m.calls}|${m.p50Ms ?? '—'}|${m.p90Ms ?? '—'}|${m.onTimeRatio === null ? '—' : (m.onTimeRatio * 100).toFixed(1) + '%'}|${m.failures}|\n`;
table += '\n|版本|稀疏画布≥20秒次数|丢弃|上屏拒绝|越道接受|自动淘汰|关键词时间差p50/p90(ms)|\n|---|---:|---:|---:|---:|---:|---|\n';
for (const v of ['A', 'B']) { const m = metrics[v], times = m.alignment.map((a) => a.errorMs); table += `|${v}|${m.sparseRuns.length}|${m.dropped}|${m.stageRejected}|${m.acceptedCrossLane}|${Object.values(m.evictedPerPage).reduce((a, b) => a + b, 0)}|${percentile(times, 0.5) ?? '—'} / ${percentile(times, 0.9) ?? '—'}|\n`; }
table += '\n|版本|DOM采样|相交帧|溢出帧|超过五实体帧|互动在场翻页成功/拒绝|\n|---|---:|---:|---:|---:|---|\n';
for (const v of ['A', 'B']) { const m = metrics[v]; table += `|${v}|${m.measuredFrames}|${m.overlapFrames}|${m.overflowFrames}|${m.overBudgetFrames}|${m.graphicsPageWithInteractive.accepted} / ${m.graphicsPageWithInteractive.rejected}|\n`; }
await writeFile(resolve(OUT, 'metrics.md'), table);
console.log(table);

console.log(JSON.stringify(Object.fromEntries(Object.entries(metrics).map(([v,m])=>[v,{overlapFrames:m.overlapFrames,overflowFrames:m.overflowFrames,overBudgetFrames:m.overBudgetFrames,graphicsPageWithInteractive:m.graphicsPageWithInteractive}]))));
