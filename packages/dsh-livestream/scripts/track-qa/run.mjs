import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = process.cwd();
const overlap = readFileSync('scripts/crew-qa/overlap.mjs','utf8').replace('export function', 'function');
const observer = readFileSync('scripts/track-qa/observe.mjs','utf8');
const capture = readFileSync('scripts/track-qa/capture.mjs','utf8').replace("await fs.mkdir(QA.out",observer+"\nawait fs.mkdir(QA.out");
for (const run of process.argv.slice(2).length ? process.argv.slice(2) : ['1','2','3']) {
  if(existsSync(`scripts/track-qa/run-${run}.json`)||existsSync(`scripts/track-qa/shots-${run}/shots.jsonl`))throw Error(`证据编号${run}已经用过，请换新编号，不能覆盖旧证据`);
  const setup = spawn('ego-browser',['nodejs'],{stdio:['pipe','pipe','pipe']});
  setup.stdin.end(`const task=await taskSpace('aivtb-track 直播'); const page=task.page('p1'); ${observer}
await page.mouse.click(10,10,{label:'开启舞台声音'}); console.log(task.spaceId);`);
  let setupLog=''; setup.stdout.on('data',d=>setupLog+=d); setup.stderr.on('data',d=>setupLog+=d);
  if(await new Promise(r=>setup.on('close',r)))throw Error(setupLog);
  let done=false, failures=0;
  const sim=spawn(process.execPath,['scripts/track-qa/sim.mjs',run],{stdio:['ignore','pipe','pipe']});
  let output=''; sim.stdout.on('data',d=>output+=d); sim.stderr.on('data',d=>output+=d);
  const complete=new Promise(resolve=>sim.on('close',code=>{done=true;resolve(code);}));
  const out=resolve(root,`scripts/track-qa/shots-${run}`); mkdirSync(out,{recursive:true});
  while(!done) {
    const child=spawn('ego-browser',['nodejs'],{stdio:['pipe','pipe','pipe']});
    child.stdin.end(`const QA=${JSON.stringify({out})};\n${overlap}\n`+capture);
    let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
    const code=await new Promise(r=>child.on('close',r));
    if(code) {
      appendFileSync('scripts/track-qa/browser-errors.log', `${Date.now()} run=${run} ${log}\n`);
      if (++failures <= 2 && log.includes('NodeRuntime disconnected')) { console.log('同一 TaskSpace 重连后继续截图'); continue; }
      sim.kill('SIGTERM'); await complete;
      writeFileSync(`scripts/track-qa/run-${run}.log`,output);
      throw new Error(log);
    }
    console.log(`第${run}轮：${log.trim()}`);
  }
  const simCode = await complete;
  writeFileSync(`scripts/track-qa/run-${run}.log`,output);
  if (simCode) throw new Error(`第${run}轮模拟进程失败：${simCode}`);
  const check = spawn(process.execPath, ['scripts/track-qa/analyze.mjs', run], {stdio:'inherit'});
  const code = await new Promise(r=>check.on('close',r));
  if (code) throw new Error(`第${run}轮严格检查失败`);
  console.log(`第${run}轮严格通过`);
}
