import {readFile,writeFile} from 'node:fs/promises';
const base='scripts/merged-qa/';
const rows=[];
const exploring=process.argv.includes('--exploration');
for(const run of process.argv.slice(2).filter(a=>!a.startsWith('--'))) {
 const r=JSON.parse(await readFile(`${base}${exploring?'exploration':'derived'}-${run}.json`,'utf8'));
 // 秒回也可能被语音拆截：合并同段字幕识别原话，延迟仍取第一截开口时刻。
 const normal=s=>(s??'').replace(/\[\[[\s\S]*?\]\]/g,'').replace(/\*/g,'').replace(/\s+/g,' ').trim();
 const events=r.events.filter(e=>['gift','owner','question','crew-off'].includes(e.kind)&&!e.error);
 const off=r.events.find(e=>e.kind==='crew-off')?.at??r.finishedAt;
 const start=r.subtitles.filter(s=>s.openedAt<=r.openedAt).at(-1)?.openedAt??r.openedAt;
 const audible=r.subtitles.filter(s=>s.openedAt>=start&&s.openedAt<off);
 const ids=new Set(audible.map(s=>s.id.replace(/-\d+$/, '')));
 const traces=r.traces.filter(t=>t.time>=start&&t.time<off);
 const plans=r.traces.filter(t=>t.time<off&&t.title==='舞台团队').map(t=>JSON.parse(t.body)).filter(p=>ids.has(p.id));
 const ignoredPlans=r.traces.filter(t=>t.time<off&&t.title==='舞台团队').length-plans.length;

 const lane={};
 for(const name of ['graphics','lighting','sound']) {
  const calls=plans.flatMap(p=>p.results.filter(x=>x.lane===name));
  const times=calls.map(x=>x.ms).sort((a,b)=>a-b);
  lane[name]={calls:calls.length,p90:times[Math.ceil(times.length*.9)-1],ok:calls.filter(x=>x.status==='ok').length};
 }
 let sparseStart,spans=[];
 const previous=r.sparse.filter(s=>s.at<=start).at(-1);
 const samples=[...(previous?[{...previous,at:start}]:[]),...r.sparse.filter(s=>s.at>start&&s.at<off)];
 for(const s of samples) {
  if(s.count<=1) sparseStart??=s.at;
  else if(sparseStart!==undefined){if(s.at-sparseStart>=20000)spans.push({from:sparseStart,to:s.at,ms:s.at-sparseStart});sparseStart=undefined;}
 }
 if(sparseStart!==undefined&&off-sparseStart>=20000)spans.push({from:sparseStart,to:off,ms:off-sparseStart});
 const ack=r.metrics.filter(x=>x.kind!=='crew-off'&&x.acknowledgement);
 const ackRepeated=ack.length-new Set(ack.map(x=>x.acknowledgement)).size;
 const doubleThanks=ack.filter(x=>/谢/.test(x.acknowledgement)&&/^(?:[^，,。！？]{1,10}[，,]\s*)?(?:谢谢|感谢|多谢|谢啦|谢了|谢你)/.test(x.response??''));
 const bridges=traces.filter(t=>t.title==='回程桥').map(t=>({at:t.time,...JSON.parse(t.body)}));
 const opening=s=>(s??'').split(/[，,。！？!?]/)[0].slice(0,8);
 const bridgeRepeated=bridges.filter((b,i)=>bridges.slice(0,i).some(a=>b.at-a.at<300000&&opening(a.text)===opening(b.text))).length;
 const actions=traces.filter(t=>t.title==='车道动作').map(t=>JSON.parse(t.body));
 const crossed=actions.filter(a=>a.ok&&!({graphics:['draw','touch','link','group','shift','erase','page'],lighting:['vfx'],sound:['sound']}[a.lane]??[]).includes(a.type));
 const own=r.metrics.filter(x=>x.kind!=='crew-off');
 const mainSubs=r.subtitles.filter(s=>s.openedAt>=start&&s.openedAt<off);
 const gaps=mainSubs.slice(1).map((s,i)=>Math.max(0,s.openedAt-(mainSubs[i].endedAt??mainSubs[i].openedAt+mainSubs[i].ms)));
 if(mainSubs.length)gaps.push(Math.max(0,off-(mainSubs.at(-1).endedAt??mainSubs.at(-1).openedAt+mainSubs.at(-1).ms)));
 const allSubs=r.subtitles.filter(s=>s.openedAt>=start);
 const allGaps=allSubs.slice(1).map((s,i)=>Math.max(0,s.openedAt-(allSubs[i].endedAt??allSubs[i].openedAt+allSubs[i].ms)));
 if(allSubs.length)allGaps.push(Math.max(0,r.finishedAt-(allSubs.at(-1).endedAt??allSubs.at(-1).openedAt+allSubs.at(-1).ms)));
 const offHostCalls=r.traces.filter(t=>t.time>=off&&t.title==='调用 speak'&&/\[\[(?:draw|page|erase|fx|sound|circle|highlight)\b/.test(t.body??''));
 // 回执序号不是调用序号，按回执引用的原始标记定位提交；关前错误的迟到回执单列。
 const speakCalls=r.traces.filter(t=>t.title==='调用 speak');
 const issues=r.traces.filter(t=>t.time>=off&&t.title==='结果 · speak').flatMap(t=>(t.body??'').split('\n').flatMap(line=>{
   if (!line.startsWith('标记有问题（没生效）：')) return [];
   const unexpected=line.replace(/^标记有问题（没生效）：/,'').replace(/\[\[fx [^\]]+\]\]：lighting: (?:同一种灯光30秒内不重复|全屏灯光每分钟最多2次|粒子灯光每分钟最多3次)[；;]?\s*/g,'');
   if (!unexpected.trim()) return [];
   const cues=[...unexpected.matchAll(/\[\[[\s\S]*?\]\]/g)].map(m=>m[0]);
   return (cues.length?cues:['']).map(cue=>{
     const source=cue?speakCalls.filter(c=>c.time<=t.time&&(c.body??'').includes(cue)).at(-1):undefined;
     return { ...t, body:line, cue, submittedAt:source?.time };
   });
 }));
 const offCueErrors=issues.filter(t=>t.submittedAt===undefined||t.submittedAt>=off);
 const inheritedCueErrors=issues.filter(t=>t.submittedAt!==undefined&&t.submittedAt<off);
 const giftEvent=r.events.find(e=>e.kind==='gift'), who=giftEvent?.body[0]?.user?.name;
 const giftOrderId=[...(r.metrics.find(m=>m.kind==='gift')?.checkpoint??'').matchAll(/\b(o\d+) ([^；\n]+)；/g)].find(m=>m[2]===who)?.[1];
 const giftClosed=r.closed.find(c=>c.title===`点单关闭 ${giftOrderId} done`&&c.body?.includes(who));
 const row={run,giftOrderId,mainMs:off-start,ignoredPlans,offMs:r.finishedAt-off,lane,segments:plans.length,beforeStart:plans.filter(p=>p.beforeStart).length,beforeStartRate:plans.length?plans.filter(p=>p.beforeStart).length/plans.length:null,actions:actions.length,rejected:actions.filter(x=>!x.ok).length,crossed:crossed.length,sparseSpans:spans,ackRepeated,doubleThanks:doubleThanks.length,bridgeRepeated,maxGapMs:Math.max(0,...gaps),metrics:own,closed:r.closed,offCrewPlans:r.traces.filter(t=>t.title==='舞台团队'&&t.time>=off+1000).length,maxGapWithOffMs:Math.max(0,...allGaps),offHostCalls,inheritedCueErrors,offErrors:[...r.traces.filter(t=>t.time>=off&&t.kind==='error'),...offCueErrors],passed:{ack:own.length===3&&own.every(x=>x.ackMs!==null&&x.ackMs<=2500),own:own.length===3&&own.every(x=>x.ownMs!==null&&x.ownMs<=10000),resume:own.length===3&&own.every(x=>x.resumed&&x.bridgeChanged),orders:!!giftClosed,silence:Math.max(0,...allGaps)<=6000}};
 rows.push(row);
}
await writeFile(`${base}${exploring?'exploration-metrics':'metrics'}.json`,JSON.stringify(rows,null,2));
for(const r of rows)console.log(JSON.stringify({...r,metrics:r.metrics.map(({kind,ackMs,ownMs,resumed,bridgeChanged,acknowledgement,response})=>({kind,ackMs,ownMs,resumed,bridgeChanged,acknowledgement,response})),closed:r.closed.map(c=>({title:c.title,time:c.time})),sparseSpans:r.sparseSpans}));
