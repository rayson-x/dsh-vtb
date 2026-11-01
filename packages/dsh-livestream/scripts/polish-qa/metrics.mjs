// 最终回放机器门槛：只读实际DOM逐帧与舞台状态，既有指标不放宽。
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const out = resolve(import.meta.dirname, 'out');
const capture = JSON.parse(await readFile(resolve(out, 'capture-after.json')));
const plans = JSON.parse(await readFile(resolve(out, 'plans.json'))).B;
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1];
const lanes = Object.fromEntries(['graphics', 'lighting', 'sound'].map(lane => {
  const calls = plans.flatMap(p => p.calls.filter(c => c.lane === lane));
  return [lane, { calls: calls.length, p90Ms: percentile(calls.map(c => c.ms), .9), onTimeRatio: calls.filter(c => c.status === 'ok' && c.ms <= 9000).length / calls.length }];
}));
const titleChecks = capture.titleChecks.filter(c => c.oldTitles.length);
const uiFonts = JSON.parse(await readFile(resolve(out, 'ui-fonts.json')));
const particles = JSON.parse(await readFile(resolve(out, 'particles/metrics.json')));
const ui = await readFile(resolve(out, 'ui-measure.txt'), 'utf8');
const fx = await readFile(resolve(out, 'fx-measure.txt'), 'utf8');
const checks = {
  renderedFrames: capture.metrics.measuredFrames > 0,
  ui: ui.trim().endsWith('ALL PASS'),
  uiFonts: uiFonts.length === 30 && uiFonts.every(f => f.smallText.length === 0),
  fx: fx.trim().endsWith('ALL PASS'),
  particles: particles.length === 5 && particles.every(p => p.pass),
  duplicateFrames: capture.metrics.duplicateFrames === 0,
  smallTextFrames: capture.metrics.smallTextFrames === 0,
  titlesWithin5s: titleChecks.every(c => c.retiredMs !== null && c.retiredMs <= 5000),
  overlapFrames: capture.metrics.overlapFrames === 0,
  overflowFrames: capture.metrics.overflowFrames === 0,
  latency: Object.values(lanes).every(l => l.p90Ms <= 4000),
  onTime: Object.values(lanes).every(l => l.onTimeRatio >= .9),
  crossLane: capture.metrics.acceptedCrossLane === 0,
  sparse: capture.metrics.sparseRuns.length === 0,
};
const result = { checks, lanes, titleChecks, metrics: capture.metrics, generatedAt: new Date().toISOString() };
await writeFile(resolve(out, 'validation.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ checks, lanes, titleChecks }, null, 2));
if (Object.values(checks).some(x => !x)) process.exitCode = 1;
