import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
const root = process.cwd();
const overlap = readFileSync('scripts/crew-qa/overlap.mjs','utf8').replace('export function', 'function');
const capture = readFileSync('scripts/plan-qa/capture.mjs','utf8');
const fingerprint = () => {
  const manifest = JSON.parse(readFileSync('scripts/plan-qa/verification.json', 'utf8'));
  const sources = Object.fromEntries(Object.keys(manifest.sources).sort().map(path => [path, createHash('sha256').update(readFileSync(resolve(root, '../..', path))).digest('hex')]));
  const build = Object.fromEntries(['lib/index.js', 'lib/agent.js', 'lib/console.js'].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
  return { sources, build, sha256: createHash('sha256').update(JSON.stringify({sources,build})).digest('hex') };
};
for (const run of process.argv.slice(2).length ? process.argv.slice(2) : ['1','2','3']) {
  if (existsSync(`scripts/plan-qa/run-${run}.json`) || existsSync(`scripts/plan-qa/version-${run}.json`)) throw new Error(`第${run}轮已有证据，拒绝覆盖，请使用新的轮次编号`);
  const version = { run, startedAt: Date.now(), start: fingerprint() };
  writeFileSync(`scripts/plan-qa/version-${run}.json`, JSON.stringify(version,null,2));
  const prepare=spawn('ego-browser',['nodejs'],{stdio:['pipe','pipe','pipe']});
  prepare.stdin.end(readFileSync('scripts/plan-qa/prepare.mjs','utf8'));
  let prepared=''; prepare.stdout.on('data',d=>prepared+=d); prepare.stderr.on('data',d=>prepared+=d);
  const preparedCode=await new Promise(resolve=>prepare.on('close',resolve));
  writeFileSync(`scripts/plan-qa/audio-ready-${run}.log`,prepared);
  if(preparedCode)throw new Error(`第${run}轮浏览器声音准备失败，不开始计时`);
  let done=false, failures=0;
  const sim=spawn(process.execPath,['scripts/plan-qa/sim.mjs',run],{stdio:['ignore','pipe','pipe']});
  let output=''; sim.stdout.on('data',d=>output+=d); sim.stderr.on('data',d=>output+=d);
  const complete=new Promise(resolve=>sim.on('close',code=>{done=true;resolve(code);}));
  const out=resolve(root,`scripts/plan-qa/shots-${run}`); mkdirSync(out,{recursive:true});
  while(!done) {
    const child=spawn('ego-browser',['nodejs'],{stdio:['pipe','pipe','pipe']});
    child.stdin.end(`const QA=${JSON.stringify({out})};\n${overlap}\n`+capture);
    let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
    const code=await new Promise(r=>child.on('close',r));
    if(code) {
      appendFileSync('scripts/plan-qa/browser-errors.log', `${Date.now()} run=${run} ${log}\n`);
      if (++failures <= 2 && log.includes('NodeRuntime disconnected')) { console.log('同一 TaskSpace 重连后继续截图'); continue; }
      sim.kill('SIGTERM'); await complete;
      writeFileSync(`scripts/plan-qa/run-${run}.log`,output);
      throw new Error(log);
    }
    console.log(`第${run}轮：${log.trim()}`);
  }
  const simCode = await complete;
  version.end = fingerprint(); version.finishedAt = Date.now();
  writeFileSync(`scripts/plan-qa/version-${run}.json`, JSON.stringify(version,null,2));
  if (version.start.sha256 !== version.end.sha256) throw new Error(`第${run}轮代码或构建指纹发生变化，本轮不可计为通过`);
  writeFileSync(`scripts/plan-qa/run-${run}.log`,output);
  if (simCode) throw new Error(`第${run}轮模拟进程失败：${simCode}`);
  console.log(`第${run}轮采集完成`);
}
