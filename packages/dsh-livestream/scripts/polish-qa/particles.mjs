// node scripts/polish-qa/particles.mjs；浏览器仅采集，像素运算在本地进程中完成。
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { measureParticles } from './particles-measure.mjs';
const script = await readFile(resolve(import.meta.dirname, 'particles-capture.mjs'), 'utf8');
await new Promise((done, fail) => {
  const child = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(script);
  child.on('exit', code => code === 0 ? done() : fail(new Error(`粒子采集退出 ${code}`)));
});
await measureParticles();
