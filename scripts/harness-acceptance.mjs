/** Real local team probe. Inputs are scripted audience requests, never mocked model answers. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import {projectResponseMeasurements,summarizeResponseMeasurements} from './response-measurements.mjs';
const run=promisify(execFile),brain=process.argv[2]??'http://127.0.0.1:3972',stage=process.argv[3]??'http://127.0.0.1:3974',duration=Number(process.argv[4]??1800),space=process.argv[5];
const browserPage=process.argv[6]??'p1';if(!/^p\d+$/.test(browserPage))throw Error('Invalid Ego page label');
if(!Number.isFinite(duration)||duration<60)throw Error('Use a bounded duration >=60 seconds');
for(const url of [brain,stage])if(new URL(url).hostname!=='127.0.0.1')throw Error('Local acceptance endpoints only');
const output=resolve('.deps/acceptance',String(Date.now()));await mkdir(output,{recursive:true});
const report={kind:'real-local-team-with-scripted-audience',startedAt:Date.now(),durationSeconds:duration,externalBroadcast:false,samples:[],inputs:[],actions:[],errors:[],browser:[],timings:[]};
const prompts=['窗外能先加一盏暖灯吗？','书桌上放一只旧杯子怎么样？','我想让窗外有一小群鱼，可以吗？','能把灯光调得柔和一点吗？','书房里如果有封来信，会是谁写的？','先保留这个房间，讲讲桌上的一本旧书好吗？','能给书架留一格空位吗？','我更喜欢安静一点的配色，可以试一下吗？','刚才那条光可以移到窗边吗？','故事里的主人公为什么留在这里？'];
async function get(path){const r=await fetch(brain+path,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Brain HTTP '+r.status);return r.json();}
async function post(url,body){const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const j=await r.json();if(!r.ok||j.ok===false)throw Error(JSON.stringify({status:r.status,error:j.error}));return j;}
let pid;try{pid=JSON.parse(await readFile('packages/dsh-livestream/.cache/brain.pid','utf8')).pid;}catch{}
let memoryScope='launcher PID';try{pid=Number((await run('lsof',['-tiTCP:'+new URL(brain).port,'-sTCP:LISTEN'])).stdout.trim().split('\n')[0]);memoryScope='brain HTTP listener process';}catch{}
let timingCursor=0,initialAudienceIds;const unhealthy=new Map();report.roleHealth=[];
const seenPlaying=new Set(),actions=new Set();let sent=0,lastBrowser=0;
while(Date.now()-report.startedAt<duration*1000){
 const elapsed=(Date.now()-report.startedAt)/1000;
 try{
  const h=await get('/live/harness'),s=h.state;
  for(const role of h.roles){
   const prior=unhealthy.get(role.role),code=role.error;
   if(!code){unhealthy.delete(role.role);continue;}
   const count=prior?.code===code?prior.count+1:1;unhealthy.set(role.role,{code,count});
   if(prior?.code!==code)report.roleHealth.push({at:Date.now(),role:role.role,code});
   if(['QUOTA','AUTH','UNAUTHORIZED'].includes(code)||(code==='UNKNOWN'&&count>=3))report.stopReason={kind:'role-unavailable',role:role.role,code,at:Date.now()};
  }
  if(report.stopReason){report.errors.push({phase:'role-health',...report.stopReason});break;}
  initialAudienceIds??=new Set(s.audience.map(row=>row.eventId));
  const timings=await get('/live/timings?after='+timingCursor);
  if(timingCursor&&timings.oldest>timingCursor+1)report.errors.push({phase:'timing-gap',after:timingCursor,oldest:timings.oldest});
  report.timings.push(...timings.events);timingCursor=timings.latest;
  for(const input of report.inputs)input.eventId??=s.audience.find(row=>!initialAudienceIds.has(row.eventId)&&row.text?.includes(input.name))?.eventId;
  report.responsePhases=projectResponseMeasurements(report.inputs,s,report.timings);
  report.continuations=Object.values(s.continuations??{});
  report.resumeParts=Object.values({...s.speechArchive,...s.speech}).filter(p=>p.resumesContinuationIds?.length);
  let rssKb=null;if(pid)try{rssKb=Number((await run('ps',['-o','rss=','-p',String(pid)])).stdout.trim());}catch{}
  const speech=Object.entries(s.speech);const sample={at:Date.now(),elapsed,rssKb,memoryScope,roles:h.roles.map(r=>({role:r.role,ready:r.ready,paused:r.paused,phase:r.phase,sessionId:r.sessionId})),epoch:s.project.currentEpoch,channel:s.project.channel.mode,assets:Object.keys(s.assets).length,tasks:Object.keys(s.tasks).length,scenes:Object.keys(s.scenes).length,speech:speech.reduce((a,[,p])=>(a[p.state]=(a[p.state]??0)+1,a),{})};
  if(!report.samples.length||sample.at-report.samples.at(-1).at>=15000)report.samples.push(sample);
  // A named actual speaking part is semantic evidence; unrelated speech is not counted as a reply.
  for(const [id,part] of speech)if(['playing','ended'].includes(part.state)&&!seenPlaying.has(id)){
   seenPlaying.add(id);for(const input of report.inputs)if(input.replyMs===undefined&&part.text?.includes(input.name)){input.replyMs=Date.now()-input.at;input.replyPartId=id;input.replyState=part.state;}
  }
  if(sent<30&&!h.roles.some(r=>r.error==='UNKNOWN')&&elapsed>=sent*20){
   const name='小灯'+String(sent+1).padStart(2,'0'),text=name+'：'+prompts[sent%prompts.length]+' 先简短回应我，再按你的节奏继续就好。';
   const input={index:sent+1,name,text,at:Date.now(),replyMs:undefined};
   await post(stage+'/input',{platform:'bilibili',kind:'superchat',user:{id:'local-acceptance-'+(sent+1),name},text});report.inputs.push(input);sent++;
  }
  const schedule=[{at:180,key:'editorial-off',url:'/live/roles',body:{role:'editorial',online:false}},{at:270,key:'editorial-on',url:'/live/roles',body:{role:'editorial',online:true}},{at:330,key:'production-off',url:'/live/roles',body:{role:'production',online:false}},{at:420,key:'production-on',url:'/live/roles',body:{role:'production',online:true}},{at:600,key:'prepare-next',url:'/live/say',body:{text:'请提前准备下一段海底邮局，当前方向继续。',prepareOnly:true,directionId:'acceptance-post-office',direction:'海底邮局：观众一起给远方写一封信，准备可复用的邮柜、信纸和灯光。'}},{at:780,key:'soft-switch',url:'/live/say',body:{text:'切换方向：一起设计一间海底邮局，保留观众参与，先接住现场再使用已准备的内容。'}},{at:1080,key:'cold-switch',url:'/live/say',body:{text:'立即切换方向：现在进入海底博物馆的深夜，观众一起为第一件展品编一个原创故事。'}}];
  for(const action of schedule)if(elapsed>=action.at&&!actions.has(action.key)){await post(brain+action.url,action.body);actions.add(action.key);report.actions.push({key:action.key,at:Date.now()});}
  if(space&&Date.now()-lastBrowser>=60000){lastBrowser=Date.now();try{
   const browserFile=join(output,'browser-current.json');const screenshot=join(output,'frame-'+Math.floor(elapsed)+'.png');
   const script=`const fs=await import('node:fs/promises');const t=await taskSpace(${Number(space)}),p=t.page(${JSON.stringify(browserPage)});await p.cdp('Performance.enable');const metrics=await p.cdp('Performance.getMetrics');const data={at:Date.now(),metrics:metrics.metrics.filter(x=>['JSHeapUsedSize','Nodes','Documents','Frames','TaskDuration'].includes(x.name)),page:await p.evaluate(()=>({iframes:document.querySelectorAll('iframe').length,images:document.images.length}))};await p.screenshot({path:${JSON.stringify(screenshot)}});data.screenshot=${JSON.stringify(screenshot)};await fs.writeFile(${JSON.stringify(browserFile)},JSON.stringify(data));`;
   await run('ego-browser',['nodejs','-e',script],{timeout:20000,maxBuffer:200000});
   const row=JSON.parse(await readFile(browserFile,'utf8'));if(report.browser.at(-1)?.at===row.at)throw Error('Stale browser metrics');report.browser.push(row);
  }catch(error){report.errors.push({at:Date.now(),phase:'browser-metrics',error:String(error).slice(0,250)});}}
 }catch(error){report.errors.push({at:Date.now(),phase:'sample',error:String(error).slice(0,250)});}
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
 await new Promise(r=>setTimeout(r,1000));
}
report.endedAt=Date.now();const values=report.inputs.filter(x=>x.replyMs!==undefined).map(x=>x.replyMs).sort((a,b)=>a-b);
report.phaseResult=summarizeResponseMeasurements(report.responsePhases??[]);
report.result={actualDurationSeconds:(report.endedAt-report.startedAt)/1000,inputCount:report.inputs.length,namedAudibleReplies:values.length,unmatched:report.inputs.filter(x=>x.replyMs===undefined).map(x=>x.index),replyLatencyMs:values.length?{p50:values[Math.floor(values.length*.5)],p95:values[Math.min(values.length-1,Math.floor(values.length*.95))],max:values.at(-1)}:null,note:'Latency uses observed real speaking/ended parts naming the scripted viewer; does not count unrelated speech or infer unnamed semantic replies. Browser metrics cover this page, not all browser/GPU processes.'};
await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,result:report.result,errors:report.errors.length,stopReason:report.stopReason}));
