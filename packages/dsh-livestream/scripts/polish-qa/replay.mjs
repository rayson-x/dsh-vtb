// 复用原回放的调度与全部判断，只在内存中配置本副本、3922及证据目录。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
const root = resolve(import.meta.dirname, '../..');
const out = resolve(import.meta.dirname, 'out');
await mkdir(out, { recursive: true });
const mode = process.argv[2] ?? 'before';
let source = await readFile(resolve(root, 'scripts/crew-qa/replay.mjs'), 'utf8');
source = source
  .replace("'scripts/crew-qa/out-2a'", "'scripts/polish-qa/out'")
  .replaceAll('3914', '3922');
// 先运行原始计划生成/重算部分，凭据仅由原脚本读取，不进入浏览器和输出。
source = source.slice(0, source.indexOf('let server;'));
const runtime = resolve(import.meta.dirname, '.replay-runtime.mjs');
await writeFile(runtime, source);
await new Promise((done, fail) => {
  const child = spawn(process.execPath, [runtime, ...(process.argv.includes('--reuse-plan') ? ['--reuse-plan'] : [])], { cwd: root, stdio: 'inherit' });
  child.on('exit', code => code === 0 ? done() : fail(new Error(`回放计划 ${code}`)));
});
let capture = await readFile(resolve(root, 'scripts/crew-qa/capture.mjs'), 'utf8');
capture = capture.replace('await page.screenshot({ path });', `const shot = await page.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 92 }); await writeFile(path, Buffer.from(shot.data, 'base64'));`);
// 增加逐帧文字与分段标题测量；不改原相交/溢出判断。
capture = capture.replace('q.frames++;', `q.frames++;
    q.duplicateFrames = (q.duplicateFrames ?? 0) + Number(g.duplicates.length > 0);
    q.smallTextFrames = (q.smallTextFrames ?? 0) + Number(g.smallText.length > 0);
    if (g.duplicates.length || g.smallText.length) (q.textFailures ??= []).push({ at: Date.now(), duplicates: g.duplicates, smallText: g.smallText });`)
  .replace("await post('/speak', { text: plan.speak });", `const oldTitles = await page.evaluate(() => [...document.querySelectorAll('.draw-item:has(.size-xl)')].map(el => ({ id: el.dataset.itemId, text: el.textContent })));
  await post('/speak', { text: plan.speak });
  const boundary = Date.now();
  const titleCheck = { segment: plan.segment, boundary, oldTitles, retiredMs: null };
  (globalThis.titleChecks ??= []).push(titleCheck);`)
  .replace('samples.push({ geometry,', `if (titleCheck.retiredMs === null && !oldTitles.some(old => geometry.titles.some(x => x.id === old.id && x.text === old.text))) titleCheck.retiredMs = Date.now() - boundary;
    samples.push({ geometry,`)
  .replace('frameFailures: frameMetrics.failures,', 'titleChecks: globalThis.titleChecks, textFailures: frameMetrics.textFailures, frameFailures: frameMetrics.failures,')
  .replace('measuredFrames: frameMetrics.frames,', 'duplicateFrames: frameMetrics.duplicateFrames, smallTextFrames: frameMetrics.smallTextFrames, measuredFrames: frameMetrics.frames,');
await writeFile(resolve(out, '.capture.mjs'), `globalThis.QA=${JSON.stringify({ root, out, base: 'http://127.0.0.1:3922', version: 'B', space: 'aivtb-polish 验收' })};\n${capture}`);
await new Promise((done, fail) => {
  const child = spawn('ego-browser', ['nodejs'], { cwd: root, stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(`globalThis.QA=${JSON.stringify({ root, out, base: 'http://127.0.0.1:3922', version: 'B', space: 'aivtb-polish 验收' })};\n${capture}`);
  child.on('exit', code => code === 0 ? done() : fail(new Error(`回放截图 ${code}`)));
});
const { rename, cp } = await import('node:fs/promises');
await rename(resolve(out, 'raw/B'), resolve(out, `raw/${mode}`));
await cp(resolve(out, 'capture-B.json'), resolve(out, `capture-${mode}.json`));
console.log('回放完成', mode);
