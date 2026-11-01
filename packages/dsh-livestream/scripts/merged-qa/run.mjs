import {spawn} from 'node:child_process';
import {readFileSync,existsSync,mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
const out='scripts/merged-qa',runs=process.argv.slice(2);
if(!runs.length)throw Error('需要三个尚未使用的证据编号；调试可先传单个编号');
const overlap=readFileSync('scripts/merged-qa/overlap.mjs','utf8').replace('export function','function');
const observer=readFileSync(`${out}/observe.mjs`,'utf8'),capture=readFileSync(`${out}/capture.mjs`,'utf8');
async function browser(source){const p=spawn('ego-browser',['nodejs'],{stdio:['pipe','pipe','pipe']});p.stdin.end(source);let log='';p.stdout.on('data',d=>log+=d);p.stderr.on('data',d=>log+=d);return {code:await new Promise(r=>p.on('close',r)),log};}
let sim, expectedVersion;
process.once('SIGTERM',()=>sim?.kill('SIGTERM'));
process.once('SIGINT',()=>sim?.kill('SIGTERM'));
for(const run of runs){
  if(!/^[A-Za-z0-9_-]+$/.test(run))throw Error('证据编号只用字母数字下划线或连字符');
  if(existsSync(`${out}/run-${run}.json`)||existsSync(`${out}/version-${run}.json`)||existsSync(`${out}/shots-${run}/shots.jsonl`))throw Error(`证据编号${run}已使用，拒绝覆盖`);
  const setup=await browser(`const task=await taskSpace('aivtb 合并验收'),page=task.page('p1');if(!(await page.url()).startsWith('http://127.0.0.1:3925/'))throw Error('请先由父协调者打开3925舞台');${observer}\nawait page.mouse.click(10,10,{label:'开启舞台声音'});console.log({spaceId:task.spaceId,activated:await page.evaluate(()=>navigator.userActivation.hasBeenActive)});`);
  writeFileSync(`${out}/audio-ready-${run}.log`,setup.log);if(setup.code)throw Error(setup.log);
  let done=false,output='',failures=0;
  sim=spawn(process.execPath,[`${out}/sim.mjs`,run],{stdio:['ignore','pipe','pipe']});sim.stdout.on('data',d=>output+=d);sim.stderr.on('data',d=>output+=d);
  const complete=new Promise(r=>sim.on('close',code=>{done=true;r(code);}));
  const shots=resolve(out,`shots-${run}`);mkdirSync(shots,{recursive:true});
  while(!done){const r=await browser(`const QA=${JSON.stringify({out:shots})};\n${overlap}\n${capture}`);
    if(r.code){appendFileSync(`${out}/browser-errors.log`,`${Date.now()} run=${run} ${r.log}\n`);if(++failures<=2&&r.log.includes('NodeRuntime disconnected'))continue;sim.kill('SIGTERM');await complete;writeFileSync(`${out}/run-${run}.log`,output);throw Error(r.log);}
    console.log(`第${run}轮 ${r.log.trim()}`);
  }
  const code=await complete;writeFileSync(`${out}/run-${run}.log`,output);if(code)throw Error(`第${run}轮采集失败`);
  const check=spawn(process.execPath,[`${out}/analyze.mjs`,run],{stdio:'inherit'});if(await new Promise(r=>check.on('close',r)))throw Error(`第${run}轮严格检查失败，停止后续轮`);
  const verdict=JSON.parse(readFileSync(`${out}/verdict-${run}.json`,'utf8'));
  expectedVersion??=verdict.productVersion;
  if(verdict.productVersion!==expectedVersion)throw Error('连续轮次产品指纹不同，不能合并为同版本验收');
  console.log(`第${run}轮统一严格全过`);
}
