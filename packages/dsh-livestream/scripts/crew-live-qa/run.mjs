import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = process.cwd();
const overlap = readFileSync('scripts/crew-qa/overlap.mjs','utf8').replace('export function', 'function');
const capture = readFileSync('scripts/crew-live-qa/capture.mjs','utf8');
for (const run of process.argv.slice(2).length ? process.argv.slice(2) : ['1','2','3']) {
  let done=false, failures=0;
  const sim=spawn(process.execPath,['scripts/crew-live-qa/sim.mjs',run],{stdio:['ignore','pipe','pipe']});
  let output=''; sim.stdout.on('data',d=>output+=d); sim.stderr.on('data',d=>output+=d);
  const complete=new Promise(resolve=>sim.on('close',code=>{done=true;resolve(code);}));
  const out=resolve(root,`scripts/crew-live-qa/shots-${run}`); mkdirSync(out,{recursive:true});
  while(!done) {
    const child=spawn('ego-browser',['nodejs'],{stdio:['pipe','pipe','pipe']});
    child.stdin.end(`const QA=${JSON.stringify({out})};\n${overlap}\n`+capture);
    let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
    const code=await new Promise(r=>child.on('close',r));
    if(code) {
      appendFileSync('scripts/crew-live-qa/browser-errors.log', `${Date.now()} run=${run} ${log}\n`);
      if (++failures <= 2 && log.includes('NodeRuntime disconnected')) { console.log('同一 TaskSpace 重连后继续截图'); continue; }
      sim.kill('SIGTERM'); await complete;
      writeFileSync(`scripts/crew-live-qa/run-${run}.log`,output);
      throw new Error(log);
    }
    console.log(`第${run}轮：${log.trim()}`);
  }
  const simCode = await complete;
  writeFileSync(`scripts/crew-live-qa/run-${run}.log`,output);
  if (simCode) throw new Error(`第${run}轮模拟进程失败：${simCode}`);
  for (const args of [['scripts/crew-live-qa/metrics.mjs',run], ['scripts/crew-live-qa/strict.mjs','--partial']]) {
    const check = spawn(process.execPath,args,{stdio:['ignore','pipe','pipe']});
    let log=''; check.stdout.on('data',d=>log+=d); check.stderr.on('data',d=>log+=d);
    const code = await new Promise(r=>check.on('close',r));
    appendFileSync(`scripts/crew-live-qa/check-${run}.log`,log);
    if (code) throw new Error(`第${run}轮严格检查失败，停止后续轮；见 check-${run}.log`);
  }
  console.log(`第${run}轮严格通过`);
}
