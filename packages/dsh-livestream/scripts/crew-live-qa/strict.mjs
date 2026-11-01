// 严格门槛：只统计实际时间窗口，缺证据也失败，不用多数轮通过代替每轮通过。
import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { effectOf } from '../../src/stage/sets.ts';
const base = 'scripts/crew-live-qa/';
const compiled = await build({ entryPoints: ['src/stage/cues.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { parseCues } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const rows = JSON.parse(await readFile(base + 'metrics.json', 'utf8'));
const verdicts = [];
for (const row of rows) {
  const raw = JSON.parse(await readFile(`${base}run-${row.run}.json`, 'utf8'));
  const off = raw.events.find(e => e.kind === 'crew-off')?.at;
  const allShots = (await readFile(`${base}shots-${row.run}/shots.jsonl`, 'utf8')).trim().split('\n').map(JSON.parse);
  const shots = allShots.filter(s => s.at >= raw.openedAt && s.at <= raw.finishedAt);
  const overlap = allShots.filter(s => !s.overlap || s.overlap.pairs.length || s.overlap.overflow.length);
  const lights = raw.lighting?.filter(f => f.at >= raw.openedAt - 60000 && f.at <= raw.finishedAt).map(f => ({...f, steps: effectOf(f.set, f.name)?.steps ?? []}));
  const full = lights?.filter(f => f.steps.some(s => ['flash','dark','static'].includes(s.prim))) ?? [];
  const particles = lights?.filter(f => f.steps.some(s => s.prim === 'burst')) ?? [];
  const maximum = events => Math.max(0, ...events.map(e => events.filter(f => f.at <= e.at && f.at > e.at - 60000).length));
  const same = lights?.filter((f,i) => lights.slice(0,i).some(e => e.name === f.name && f.at-e.at < 30000)) ?? [];
  const preserved = row.metrics.every(m => {
    if (!m.bridge) return false;
    const { original, text } = m.bridge;
    const body = original.replace(/^(?:然后|接着|所以|不过|但是|而且|于是|那么|另外)[，,、]?/, '');
    return [original,body].some(tail => text.endsWith(tail) && [...text.slice(0,text.length-tail.length)].length <= 12);
  });
  const offSyntax = raw.traces.filter(t=>t.time>=off&&t.title==='调用 speak').flatMap(t=>parseCues(t.body??'').errors.map(error=>({at:t.time,error})));
  const checks = {
    complete: off-raw.openedAt >= 300000 && raw.finishedAt-off >= 60000 && !raw.events.some(e=>e.error),
    screenshots: shots.length >= 70 && overlap.length === 0,
    sparse: row.sparseSpans.length === 0,
    ack: row.passed.ack, own: row.passed.own, silence: row.passed.silence,
    thanks: row.doubleThanks === 0, ackUnique: row.ackRepeated === 0, bridgeUnique: row.bridgeRepeated === 0,
    resume: row.passed.resume && preserved,
    lighting: !!lights && maximum(full) <= 2 && maximum(particles) <= 3 && same.length === 0,
    timely: row.beforeStartRate >= .9, lanes: row.crossed === 0,
    fallback: row.offCrewPlans === 0 && row.offErrors.length === 0 && offSyntax.length === 0 && row.offHostCalls.length > 0,
    orders: row.passed.orders,
  };
  verdicts.push({ run: row.run, checks, passed: Object.values(checks).every(Boolean), shots: shots.length, totalShots: allShots.length, overlap, fullPerMinute: maximum(full), particlesPerMinute: maximum(particles), sameLightRepeated: same.length, offSyntax, preserved });
}
await writeFile(base+'strict.json', JSON.stringify(verdicts,null,2));
console.log(JSON.stringify(verdicts,null,2));
if ((!process.argv.includes('--partial') && verdicts.length !== 3) || verdicts.some(r=>!r.passed)) process.exitCode=1;
