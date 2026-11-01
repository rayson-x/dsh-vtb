import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {OUT,normal,heardAt} from './common.mjs';
import {coverageGap,collectionClean} from './coverage.mjs';
const run=process.argv[2];
if(!run)throw Error('需要证据编号');
const raw=JSON.parse(await readFile(`${OUT}/run-${run}.json`,'utf8'));
const shots=(await readFile(`${OUT}/shots-${run}/shots.jsonl`,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const observed=shots.flatMap(s=>s.observed?.events??[]);
const at=s=>heardAt(s,observed);
const significant=raw.events.filter(e=>['question','gift','owner','crew-off'].includes(e.kind));
const baseId=id=>id.replace(/-\d+$/,'');
const metrics=significant.filter(e=>e.kind!=='crew-off').map(e=>{
  const next=significant.find(x=>x.at>e.at)?.at??raw.finishedAt;
  const scope=raw.traces.filter(t=>t.time>=e.at&&t.time<next);
  const cut=scope.find(t=>t.title==='软打断'),generated=scope.find(t=>t.title==='接话员生成');
  const before=raw.subtitles.find(s=>at(s)!==undefined&&at(s)<=(cut?.time??e.at)&&(s.endedAt??at(s)+s.ms)>=(cut?.time??e.at));
  const stopped=before?Math.min(before.endedAt??Infinity,at(before)+before.ms):cut?.time??e.at;
  const full=id=>raw.subtitles.filter(s=>baseId(s.id)===id&&at(s)!==undefined).map(s=>s.text).join('');
  const ack=raw.subtitles.find(s=>generated&&at(s)!==undefined&&at(s)>=generated.time&&at(s)<next&&normal(full(baseId(s.id)))===normal(generated.body));
  const bridge=scope.find(t=>t.title==='回程桥');let transition;try{transition=JSON.parse(bridge?.body);}catch{}
  const who=e.kind==='owner'?'主人':e.kind==='gift'?e.body[0].user.name:e.body.user.name;
  const calls=scope.filter(t=>t.title==='调用 speak'&&(
    (transition?.reply&&normal(t.body).includes(normal(transition.reply))) ||
    (e.kind==='owner'?/主人|话题|换|接|收住|安排|说不出口|相处/.test(t.body??''):t.body?.includes(who))));
  const own=raw.subtitles.find(s=>at(s)!==undefined&&at(s)>=e.at&&at(s)<next&&baseId(s.id)!==baseId(ack?.id??'')&&calls.some(t=>t.time<=at(s)&&normal(t.body).includes(normal(s.text))));
  const resumed=transition&&raw.subtitles.some(s=>at(s)!==undefined&&at(s)>=bridge.time&&normal(s.text).startsWith(normal(transition.text)));
  return {kind:e.kind,ackMs:ack?Math.max(0,at(ack)-stopped):null,ownMs:own?at(own)-e.at:null,
    ackAudioAt:ack?at(ack):undefined,ownAudioAt:own?at(own):undefined,stoppedAudioAt:stopped,
    resumed:!!resumed,bridgeChanged:!!transition&&normal(transition.text)!==normal(transition.original),
    checkpoint:cut?.body,acknowledgement:ack?generated.body:undefined,response:own?full(baseId(own.id)):undefined,bridge:transition};
});
// 原始文件保持不变；derived仅补独立浏览器音频测量值，两个判定器读同一份。
const derived={...raw,metrics,subtitles:raw.subtitles.map(s=>{
  const heard=at(s);return {...s,serverOpenedAt:s.openedAt,openedAt:heard??s.openedAt,heardAt:heard};
})};
await writeFile(`${OUT}/derived-${run}.json`,JSON.stringify(derived,null,2));
for(const name of ['track-analyze.mjs','plan-analyze.mjs']){
  const result=spawnSync(process.execPath,[`${OUT}/${name}`,run],{encoding:'utf8'});
  process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
  // 失败也继续生成另一套判定，不隐藏根因；缺文件最终自然失败。
  if(result.error)throw result.error;
}
const track=JSON.parse(await readFile(`${OUT}/track-verdict-${run}.json`,'utf8'));
const plan=JSON.parse(await readFile(`${OUT}/plan-verdict-${run}.json`,'utf8'));
const off=raw.events.find(e=>e.kind==='crew-off')?.at;
const boardCoverage=coverageGap(raw.boards,b=>b.at,b=>b.until??b.at,raw.openedAt,raw.finishedAt);
const trackCoverage=coverageGap(raw.tracks,t=>t.now,t=>t.until??t.now,raw.openedAt,raw.finishedAt);
const correctEvents=raw.events.filter(e=>['question','gift','owner'].includes(e.kind));
const offsets=Object.fromEntries(correctEvents.map(e=>[e.kind,e.at-raw.openedAt]));
const actualResponse=metrics.length===3&&metrics.every(m=>m.ackAudioAt!==undefined&&m.ownAudioAt!==undefined);
const voiceRows=raw.subtitles.filter(s=>s.startedAt>=raw.openedAt&&s.startedAt<raw.finishedAt);
const playedVoiceRatio=voiceRows.length?voiceRows.filter(s=>at(s)!==undefined).length/voiceRows.length:0;
const offStart=off+1000;
const priorOff=raw.sparse.filter(s=>s.at<=offStart).at(-1);
const offCanvas=[...(priorOff?[{...priorOff,at:offStart}]:[]),...raw.sparse.filter(s=>s.at>offStart)];
const clean=s=>normal(s).replace(/[\p{P}\p{S}]/gu,'');
const boardEvents=[...raw.boards.map(b=>({at:b.at,board:b.board})),...raw.traces.filter(t=>t.title==='舞台黑板').flatMap(t=>{try{return [{at:t.time,board:JSON.parse(t.body)}];}catch{return [];}})].sort((a,b)=>a.at-b.at);
const minimalTheme=offCanvas.length>0&&offCanvas.every(s=>{
  // 同一同步黑板回调可先推画面、再记黑板轨迹，允许25ms的服务器记录顺序差。
  const board=boardEvents.filter(b=>b.at<=s.at+25).at(-1)?.board;
  const title=clean(board?.topic?.title??'');
  return title&&s.count>=1&&s.count<=2&&(s.items??[]).some(i=>i.kind==='text'&&clean(i.text)&&title.startsWith(clean(i.text)));
});
const errors=[...raw.events.filter(e=>e.error),...(raw.pollErrors??[]).map(e=>({...e,kind:`poll-${e.kind}`}))];
const guardChecks={
  completeOn:off!==undefined&&off-raw.openedAt>=360000,
  completeOff:off!==undefined&&raw.finishedAt-off>=60000,
  realResponseEvidence:actualResponse,
  realVoiceCoverage:playedVoiceRatio>=.9,
  minimalTheme,
  eventSchedule:correctEvents.length===3&&['question','gift','owner'].every((name,i)=>offsets[name]>=[60000,180000,270000][i]&&offsets[name]<[65000,185000,275000][i]),
  boardCoverage:raw.boards.length>0&&boardCoverage<=2000,
  trackCoverage:raw.tracks.length>0&&trackCoverage<=1500,
  retraction:raw.events.some(e=>e.kind==='retraction'&&e.id&&e.text&&typeof e.removed==='string'&&e.removed.length>0),
  noCollectionErrors:collectionClean(raw),
  offErrors:track.legacy.offErrors.length===0,
};
const result={run,productVersion:raw.productVersion,passed:plan.passed&&track.passed&&Object.values(guardChecks).every(Boolean),plan:plan.checks,track:track.checks,guard:guardChecks,
  onMs:off-raw.openedAt,offMs:raw.finishedAt-off,offsets,boardCoverage,trackCoverage,playedVoiceRatio,metrics,
  word:track.word,timely:track.timely,cross:track.cross,edits:track.edits,realGap:track.realGap,
  sparseSpans:track.legacy.sparseSpans,orphan:track.orphan,forbidden:track.forbidden,requests:plan.requests,errors};
await writeFile(`${OUT}/verdict-${run}.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify({run,passed:result.passed,plan:result.plan,track:result.track,guard:guardChecks,word:`${result.timely}/${result.word}`,cross:result.cross,edits:result.edits,realGap:result.realGap},null,2));
if(!result.passed)process.exitCode=1;
