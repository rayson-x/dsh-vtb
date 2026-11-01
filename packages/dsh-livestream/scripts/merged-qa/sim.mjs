import { writeFile, mkdir } from 'node:fs/promises';
import { BASE, OUT, bridge, fingerprint, normal, observed, heardAt, post } from './common.mjs';
import {retractionCandidate} from './retraction.mjs';
const run = process.argv[2];
if (!run || !/^[A-Za-z0-9_-]+$/.test(run)) throw Error('需要未用过的证据编号');
const version = { run, start: await fingerprint() };
const traces=[], subtitles=[], events=[], lighting=[], boards=[], tracks=[], sparse=[], pollErrors=[];
let openedAt, offAt, current, retractionTask, retractionSearching=false;
const startedAt = Date.now(), stop = new AbortController(), streams = new AbortController();
process.once('SIGTERM',()=>stop.abort());
process.once('SIGINT',()=>stop.abort());
const sleep = ms => new Promise((resolve,reject) => {
  const fail=()=>{clearTimeout(timer);reject(Error('验收中断，保存已有证据'));};
  const timer=setTimeout(()=>{stop.signal.removeEventListener('abort',fail);resolve();},ms);
  if(stop.signal.aborted)fail();else stop.signal.addEventListener('abort',fail,{once:true});
});
async function stream(path,receive) {
  try {
    const response=await fetch(BASE+path,{signal:streams.signal});
    if(!response.ok)throw Error(`HTTP ${response.status}`);
    const reader=response.body.getReader(), decoder=new TextDecoder();let buffer='';
    for(;;){const {done,value}=await reader.read();if(done)throw Error('SSE提前关闭');buffer+=decoder.decode(value,{stream:true});let end;
      while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=frame.split('\n').filter(x=>x.startsWith('data: ')).map(x=>x.slice(6)).join('\n');if(data)receive(JSON.parse(data));}
    }
  } catch(error){if(!streams.signal.aborted)events.push({kind:'error',at:Date.now(),stream:path,error:error.message});}
}
const tasks=[stream('/trace',m=>{if(m.items)traces.push(...m.items);}),stream('/events',m=>{
  sparse.push({at:m.now,count:m.state.draw?.items?.length??0,items:(m.state.draw?.items??[]).map(({id,kind,text,docked})=>({id,kind,text,docked}))});
  for(const fx of m.state.vfx??[])if(!lighting.some(f=>f.id===fx.id))lighting.push({...fx,set:m.state.set});
  const s=m.state.subtitle;
  if(current&&(!s||s.id!==current.id||s.startedAt!==current.startedAt)){current.endedAt=m.now;current=undefined;}
  if(s&&!subtitles.some(x=>x.id===s.id&&x.startedAt===s.startedAt)){current={...s,openedAt:m.now};subtitles.push(current);}
})];
let polling=true;
async function poll(kind, ms, get, rows, signature) {
  let last;
  while(polling){const at=Date.now();try{
    const value=await get(), sig=signature(value);
    if(sig===last&&rows.length){rows.at(-1).until=Date.now();rows.at(-1).samples++;}
    else{rows.push(kind==='board'?{at:Date.now(),until:Date.now(),samples:1,board:value}:{...value,until:value.now,samples:1});last=sig;}
  }catch(error){pollErrors.push({kind,at,error:error.message});}
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,at+ms-Date.now())));
  }
}
const pollers=[poll('board',500,()=>bridge('blackboard.read'),boards,b=>JSON.stringify(b)),poll('track',200,async()=>{
  const r=await fetch(BASE+'/tracks',{signal:AbortSignal.timeout(2500)});if(!r.ok)throw Error(`HTTP ${r.status}`);return r.json();
},tracks,t=>JSON.stringify({speech:t.speech,visual:t.visual}))];
async function send(kind,path,body){const lineup=await bridge('speech.lineup');const event={kind,at:Date.now(),body,lineup};events.push(event);await post(path,body);}
async function retractQueuedBefore(deadline) {
  try {
    while(retractionSearching&&Date.now()<deadline){
      const response=await fetch(BASE+'/tracks',{signal:AbortSignal.timeout(2500)});
      if(!response.ok)throw Error(`读取撤回候选HTTP ${response.status}`);
      const before=await response.json(),lineup=await bridge('speech.lineup');
      if(!retractionSearching||Date.now()>=deadline)break;
      const candidate=retractionCandidate(before.speech,lineup);
      if(candidate){
        const at=Date.now(),removed=await bridge('speech.retract',{id:candidate.id});
        if(typeof removed==='string'&&removed.trim()){
          const event={kind:'retraction',at,...candidate,removed,lineup,speakingBefore:before.speech.filter(p=>p.status==='speaking')};
          events.push(event);
          const after=await fetch(BASE+'/tracks',{signal:AbortSignal.timeout(2500)}).then(r=>{if(!r.ok)throw Error(`读取撤回后状态HTTP ${r.status}`);return r.json();});
          event.speakingAfter=after.speech.filter(p=>p.status==='speaking');return event;
        }
      }
      await sleep(Math.min(300,Math.max(0,deadline-Date.now())));
    }
  }catch(error){events.push({kind:'error',scope:'retraction',at:Date.now(),error:error.message});}
}
try {
  await post('/crew',{enabled:true});
  await post('/live/start',{direction:'自然地陪观众聊天，按当前话题展开，使用虚构情境表达看法，不编造事实。有新消息先短回应，再接回内容。点单请及时点名兑现并关闭。'});
  await post('/live/reset',{audience:true});
  const readyAt=Date.now();let first;
  while(!first&&Date.now()<readyAt+60000){
    const media=await observed(run);
    first=subtitles.map(s=>({s,at:heardAt(s,media)})).find(({s,at})=>at!==undefined&&at>=readyAt&&traces.some(t=>t.time>=readyAt&&t.title==='调用 speak'&&normal(t.body).includes(normal(s.text))));
    if(!first)await sleep(250);
  }
  if(!first)throw Error('60秒内缺少主播真实开口的字幕＋浏览器playing证据');
  openedAt=first.at;
  await sleep(Math.max(0,openedAt+60000-Date.now()));
  const board=await bridge('blackboard.read');
  const direction=board.beats.find(b=>b.status==='pending')?.text??board.topic?.title;
  if(!direction)throw Error('动态点题时缺少话题/节目单');
  await send('question','/input',{platform:'douyin',kind:'danmaku',user:{id:`ask-${run}`,name:'小麦'},text:`讲讲「${direction}」里容易忽略的另一种情况，给我一个虚构情境好吗？`});
  await sleep(Math.max(0,openedAt+120000-Date.now()));
  // 后台寻找真实queued/held部分；同root正在念的头部不影响撤回其未念尾部。
  // 不等待此任务，避免阻塞三分钟礼物与四分半主人事件。
  retractionSearching=true;retractionTask=retractQueuedBefore(openedAt+360000);
  await sleep(Math.max(0,openedAt+180000-Date.now()));
  await send('gift','/input',[{platform:'douyin',kind:'gift',user:{id:`gift-${run}`,name:`阿叶${run}`},text:'请用一句虚构情境说明刚才的选择有什么不同，点名讲给我听好吗？',gift:{name:'小心心',count:5,value:.5}}]);
  await sleep(Math.max(0,openedAt+270000-Date.now()));
  await send('owner','/live/say',{text:'换个话题聊聊日常相处里那些说不出口的话，用虚构情境表达看法就好。'});
  await sleep(Math.max(0,openedAt+360100-Date.now()));
  retractionSearching=false;await retractionTask;
  if(!events.some(e=>e.kind==='retraction'))events.push({kind:'error',at:Date.now(),error:'开启期结束前未完成一次真实未念部分撤回'});
  const off=await post('/crew',{enabled:false});offAt=Date.now();events.push({kind:'crew-off',at:offAt,result:off});
  await sleep(60100);
}catch(error){events.push({kind:'error',at:Date.now(),error:error.message});}
finally {
  retractionSearching=false;await retractionTask;
  const finishedAt=Date.now();polling=false;streams.abort();await Promise.all([...tasks,...pollers]);
  version.end=await fingerprint();
  const result={run,startedAt,openedAt,finishedAt,offAt,elapsedMs:finishedAt-startedAt,productVersion:version.start.sha256,versionAtEnd:version.end.sha256,events,boards,tracks,sparse,lighting,pollErrors,subtitles:subtitles.filter(s=>s.openedAt>=startedAt),traces:traces.filter(t=>t.time>=startedAt),metrics:[],closed:traces.filter(t=>t.time>=startedAt&&t.title.startsWith('点单关闭 ')&&t.title.endsWith(' done'))};
  await mkdir(OUT,{recursive:true});await writeFile(`${OUT}/version-${run}.json`,JSON.stringify(version,null,2));await writeFile(`${OUT}/run-${run}.json`,JSON.stringify(result,null,2));
  console.log(JSON.stringify({run,openedAt,offAt,finishedAt,events,boardSamples:boards.length,trackSamples:tracks.length}));
  if(events.some(e=>e.error))process.exitCode=1;
}
