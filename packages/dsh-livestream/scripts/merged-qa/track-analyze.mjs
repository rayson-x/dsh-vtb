import { readFile,writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { effectOf } from '../../src/stage/sets.ts';
import { build } from 'esbuild';
import {wordProof,hasSuccessfulExit,crossesSpokenSegments} from './speech-proof.mjs';
const run=process.argv[2], base='scripts/merged-qa/';
const c=spawnSync(process.execPath,[base+'metrics.mjs',run],{encoding:'utf8'}); if(c.status)throw Error(c.stderr);
const row=JSON.parse(await readFile(base+'metrics.json','utf8'))[0];
const raw=JSON.parse(await readFile(`${base}derived-${run}.json`,'utf8'));
const off=raw.events.find(e=>e.kind==='crew-off')?.at;
const allShots=(await readFile(`${base}shots-${run}/shots.jsonl`,'utf8')).trim().split('\n').map(JSON.parse);
const shots=allShots.filter(s=>s.at>=raw.openedAt&&s.at<=raw.finishedAt);
const executions=raw.traces.filter(t=>t.title==='画面轨执行').map(t=>JSON.parse(t.body));
const edits=raw.traces.filter(t=>t.title==='画面轨编辑').map(t=>({at:t.time,...JSON.parse(t.body)}));
const entries=executions.filter(e=>e.phase==='enter'&&e.ok&&e.now>=raw.openedAt&&e.now<off);
const clips=new Map(raw.tracks.flatMap(t=>t.visual.map(v=>[v.id,v])));
const missingClips=entries.filter(e=>!clips.has(e.id));
const word=entries.filter(e=>clips.has(e.id)&&'segment' in clips.get(e.id).enter.anchor);
const observed=allShots.flatMap(s=>s.observed?.events??[]);
const browserWord=word.map(e=>{
 const proof=wordProof(e,clips.get(e.id),raw,observed);
 const appearance=observed.find(o=>o.type==='enter'&&o.id===e.id)?.at;
 return {id:e.id,server:e.now,target:e.target,appearance,wordAt:proof.wordAt,spoken:proof.spoken,reason:proof.reason,
   hasSubtitle:!!proof.subtitle,audioAvailable:!!proof.subtitle?.audio,
   errorMs:proof.spoken&&appearance!==undefined&&proof.wordAt!==undefined?appearance-proof.wordAt:null};
});
const timely=browserWord.filter(e=>e.spoken&&e.errorMs!==null&&Math.abs(e.errorMs)<=500);
const cross=entries.filter(e=>{
 const exit=executions.find(x=>x.id===e.id&&x.ok===true&&x.phase!=='enter'&&x.phase!=='effect');
 return crossesSpokenSegments(e,exit?.now,raw,observed);
});
const orphan=entries.filter(e=>{
 const clip=clips.get(e.id);
 return clip&&'segment'in clip.enter.anchor&&!wordProof(e,clip,raw,observed).spoken;
});
const previous=new Map(),changed=[];
for(const receipt of edits) {
 if(!receipt.ok)continue;
 const e=receipt.edit;
 if(e.op==='add') previous.set(e.clip.id,structuredClone(e.clip));
 else if(e.op==='edit') {
   const prior=previous.get(e.id); let different=false;
   for(const field of ['enter','exit','effects']) if(e[field]!==undefined) {
     if(JSON.stringify(prior?.[field])!==JSON.stringify(e[field])) different=true;
     if(prior)prior[field]=structuredClone(e[field]);
   }
   if(different&&receipt.at<off)changed.push(receipt);
 }
}
const retired=entries.every(e=>hasSuccessfulExit(e,executions));
const compiled=await build({entryPoints:['src/stage/cues.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const {parseCues}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const forbidden=raw.traces.filter(t=>t.title==='调用 speak').flatMap(t=>parseCues(t.body??'').cues.filter(c=>!['mark','avatar','emote','result','ans','judge','rank'].includes(c.cmd.type)&&!(c.cmd.type==='draw'&&['poll','tier','score','guess','soup','timer','wall'].includes(c.cmd.kind))));
for(const call of raw.traces.filter(t=>t.title==='调用 speak')) for(const match of (call.body??'').matchAll(/\[\[([^\]]+)\]\]/g)) {
 const body=match[1].trim();
 if (/^意图(?:\s|$)|^(?:show|graphic|room|fx|sound|page|erase|set|do|place|layout|look)\b/.test(body) || /^draw\b/.test(body)&&!/^draw\s+\S+\s+(?:poll|tier|score|guess|soup|timer|wall)\b/.test(body)) {
  if(!forbidden.some(c=>c.raw===match[0]))forbidden.push({raw:match[0],cmd:{type:'host-visual-marker'}});
 }
}
// 真声音的间隔单独检查，合成失败的字幕不能掩盖静音。
const soundSpans=raw.subtitles.filter(s=>s.audio).flatMap(s=>{
 const audio=observed.filter(o=>o.type==='audio'&&new URL(o.src).pathname===s.audio).sort((a,b)=>Math.abs(a.at-s.startedAt)-Math.abs(b.at-s.startedAt))[0];
 if(!audio)return [];
 const at=audio.at-audio.currentTime*1000/audio.rate;
 return [{from:Math.max(raw.openedAt,at),to:Math.min(raw.finishedAt,s.endedAt??at+s.ms,at+s.ms)}];
}).filter(s=>s.to>s.from).sort((a,b)=>a.from-b.from);
let soundEnd=raw.openedAt,realGap=0;
for(const span of soundSpans){realGap=Math.max(realGap,span.from-soundEnd);soundEnd=Math.max(soundEnd,span.to);}
realGap=Math.max(realGap,raw.finishedAt-soundEnd);
const lights=raw.lighting.map(f=>({...f,steps:effectOf(f.set,f.name)?.steps??[]}));
const max=es=>Math.max(0,...es.map(e=>es.filter(f=>f.at<=e.at&&f.at>e.at-60000).length));
const full=max(lights.filter(f=>f.steps.some(s=>['flash','dark','static'].includes(s.prim)))),particles=max(lights.filter(f=>f.steps.some(s=>s.prim==='burst')));
const offSamples=raw.tracks.filter(t=>(t.until??t.now)>off+1000);
const fallback=offSamples.reduce((n,t)=>n+(t.samples??1),0)>200&&offSamples.every(t=>t.visual.every(v=>!['pending','active'].includes(v.status)))&&raw.sparse.filter(s=>s.at>off+1000).every(s=>s.count<=2);
const checks={planEvidence:missingClips.length===0,version:!!raw.productVersion&&raw.productVersion===raw.versionAtEnd,audio:raw.subtitles.length>0&&raw.subtitles.filter(s=>!!s.audio).length/raw.subtitles.length>=.9,complete:off-raw.openedAt>=360000&&raw.finishedAt-off>=60000&&!raw.events.some(e=>e.error),screenshots:shots.length>=82&&shots.every(s=>s.overlap&&!s.overlap.pairs.length&&!s.overlap.overflow.length),sparse:row.sparseSpans.length===0,ack:row.passed.ack,own:row.passed.own,silence:row.passed.silence&&realGap<=6000,thanks:row.doubleThanks===0,lighting:full<=2&&particles<=3,wordTiming:word.length>0&&timely.length/word.length>=.9,exits:retired,cross:cross.length>=5,edits:changed.length>=10,orphan:orphan.length===0,host:forbidden.length===0,fallback,mutation:raw.events.some(e=>e.kind==='revision'||e.kind==='retraction')};
const result={run,missingClips,productVersion:raw.productVersion,checks,passed:Object.values(checks).every(Boolean),realGap,voiceFallbacks:raw.subtitles.filter(s=>!s.audio).length,word:word.length,timely:timely.length,browserWord,cross:cross.length,edits:changed.length,orphan,forbidden,full,particles,legacy:row};
await writeFile(`${base}track-verdict-${run}.json`,JSON.stringify(result,null,2)); console.log(JSON.stringify({...result,legacy:{metrics:row.metrics,sparse:row.sparseSpans,maxGap:row.maxGapWithOffMs}}));
if(!result.passed)process.exitCode=1;
