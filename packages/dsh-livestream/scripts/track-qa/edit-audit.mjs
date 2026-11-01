/** 区分未进场整片段的真实修改与在场片段尚未执行的退场/效果修改；不计重复提交。 */
import {readFile,writeFile} from 'node:fs/promises';
for(const run of process.argv.slice(2)) {
 const r=JSON.parse(await readFile(`scripts/track-qa/run-${run}.json`,'utf8'));
 const off=r.events.find(e=>e.kind==='crew-off')?.at;
 const prior=new Map(),entered=new Set(),pending=[],active=[];
 for(const t of r.traces.filter(t=>['画面轨编辑','画面轨执行'].includes(t.title)).sort((a,b)=>a.time-b.time)) {
  const a=JSON.parse(t.body);
  if(t.title==='画面轨执行'){if(a.phase==='enter'&&a.ok)entered.add(a.id);continue;}
  if(!a.ok)continue;
  const e=a.edit;
  if(e.op==='add')prior.set(e.clip.id,structuredClone(e.clip));
  if(e.op!=='edit')continue;
  const old=prior.get(e.id);let diff=false;
  for(const field of ['enter','exit','effects'])if(e[field]!==undefined){if(JSON.stringify(old?.[field])!==JSON.stringify(e[field]))diff=true;if(old)old[field]=structuredClone(e[field]);}
  if(diff&&t.time>=r.openedAt&&t.time<off)(entered.has(e.id)?active:pending).push({at:t.time,edit:e});
 }
 const result={run,pendingCount:pending.length,activeFutureCount:active.length,pending,active};
 await writeFile(`scripts/track-qa/edit-audit-${run}.json`,JSON.stringify(result,null,2));
 console.log({run,pendingCount:pending.length,activeFutureCount:active.length});
}
