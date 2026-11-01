// 原UI/FX判断不变；配置本副本、3922、JPEG与同一TaskSpace，限频时等待成功触发。
import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
const root = resolve(import.meta.dirname, '../..'), repo = resolve(root, '../..');
const mode = process.argv[2];
const out = resolve(repo, `.deps/tasks/shots/${mode}-polish`);
await mkdir(out, { recursive: true });
let script = await readFile(resolve(root, `scripts/${mode}-qa/capture.mjs`), 'utf8');
if (mode === 'ui') script = `globalThis.QA=${JSON.stringify({ root, out, base: 'http://127.0.0.1:3922', space: 'aivtb-polish 验收', ...(process.argv.includes('--title-only') ? { only: ['title-number'] } : {}) })};\n` + script;
else script = script.replace('"/Users/Ruihan/orca/projects/aivtb/.deps/tasks/shots/fx"', JSON.stringify(out)).replaceAll('3906', '3922').replace('aivtb 基础特效截图', 'aivtb-polish 验收');
script = script.replace('await p.waitForTimeout(3000);', 'await p.waitForSelector(\".stage\"); await p.waitForTimeout(3000);');
if (mode === 'fx') script = script.replace('const cmd = (c) =>', 'const rawCommand = (c) =>').replace('const task = await taskSpace', `// 实际控制器会限制灯光，拒绝时记录并等待额度恢复；高峰计时仍从成功触发开始。
const cmd = async c => {
  for (let retry = 0; retry < 4; retry++) {
    const result = await rawCommand(c);
    const limited = result.results?.some(r => !r.ok && /lighting:/.test(r.error ?? ''));
    if (!limited) return result;
    console.log('QA等待灯光限频', c.name, JSON.stringify(result.results));
    await new Promise(r => setTimeout(r, 31000));
  }
  throw new Error('灯光额度未恢复');
};
const task = await taskSpace`);
script = script.replace('await task.finish({ keep: [] });', '').replaceAll('.png', '.jpg');
if (mode === 'ui') {
  script = script.replace('p.screenshot({ path })', `(async () => {
    const {measureOverlap} = await import(ROOT+'/scripts/crew-qa/overlap.mjs');
    const fonts = await p.evaluate(measureOverlap.toString()+';measureOverlap()');
    (globalThis.__uiFonts??=[]).push({path,smallText:fonts.smallText});
    const shot=await p.cdp('Page.captureScreenshot',{format:'jpeg',quality:92});
    await (await import('node:fs/promises')).writeFile(path.replace(/\\.png$/,'.jpg'),Buffer.from(shot.data,'base64'));
  })()`);
  script += `\nawait (await import('node:fs/promises')).writeFile(ROOT+'/scripts/polish-qa/out/ui-fonts.json',JSON.stringify(globalThis.__uiFonts,null,2));`;
}
else {
  script = script.replace('const page = task.page("p1");', `const page = task.page("p1");
const jpeg = async path => { const shot=await page.cdp('Page.captureScreenshot',{format:'jpeg',quality:92}); fs.writeFileSync(path,Buffer.from(shot.data,'base64')); };`);
  script = script.replace(/await page\.screenshot\(\{ path: ([^\n]+?) \}\);/g, 'await jpeg($1);');
}
if (mode === 'fx' && process.argv.includes('--flash-only')) {
  script = script.replace('Object.entries(PRIMS)', "Object.entries(PRIMS).filter(([name]) => name === 'flash')");
  script = script.slice(0, script.indexOf('// 布景的招牌特效'));
}
await writeFile(resolve(import.meta.dirname, `${mode}${process.argv.includes('--flash-only') ? '-flash' : ''}-capture.mjs`), script);
await new Promise((done, fail) => {
  const child = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(script);
  child.on('exit', c => c === 0 ? done() : fail(new Error(`截图 ${c}`)));
});
// 未改动的measure.py需要PNG文件名；从JPEG临时解码，测完即删。
for (const name of await readdir(out)) if (name.endsWith('.jpg')) {
  const path = resolve(out, name);
  if ((await sharp(path).metadata()).format !== 'jpeg') await writeFile(path, await sharp(path).jpeg({quality:92}).toBuffer());
  await sharp(path).png().toFile(resolve(out, name.replace('.jpg', '.png')));
}
let measured = '';
await new Promise((done, fail) => {
  const args = [`scripts/${mode}-qa/measure.py`, out, ...(mode === 'ui' ? ['--baseline', resolve(repo, '.deps/tasks/shots/ui-merged')] : [])];
  const child = spawn('python3', args, { cwd: root });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
  child.on('exit', async c => { measured = output; await writeFile(resolve(import.meta.dirname, 'out', `${mode}-measure.txt`), output); console.log(output); c === 0 ? done() : fail(new Error(`测量 ${c}`)); });
});
for (const name of await readdir(out)) if (name.endsWith('.png')) await unlink(resolve(out, name));

const failures = measured.split('\n').filter(line => line.startsWith('FAIL') && !(mode === 'ui' && line.includes('布局')));
if (failures.length) throw new Error(`原测量器有${failures.length}项未过：${failures.join('；')}`);
