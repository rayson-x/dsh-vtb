// 使用真实控制器队列、离线语音fixture；不启动服务或模型，不代替长轮。
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {retractionCandidate} from './retraction.mjs';
const built=await build({stdin:{contents:'export {StageController} from "./src/host/controller.ts";',resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,platform:'node',format:'esm'});
const {StageController}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const stage=new StageController({tickHz:0,now:()=>100000,voice:{synthesize:async text=>({ms:[...text].length*1000,starts:[...text].map((_,i)=>i*1000),file:'fixture',url:'/voice/fixture'})}});
try{
  const q=stage.enqueue('正在说的第一句，后面的内容仍要接着说。这里还有一段确实尚未开口的话，稍后才应该轮到它。');
  await new Promise(setImmediate);
  const lineup=stage.lineup(),speech=stage.timeline.snapshot();
  assert.equal(lineup.length,1);assert.equal(lineup[0].playing,true);
  assert(speech.some(p=>p.segment===q.id&&p.status==='speaking'));
  assert(speech.some(p=>p.segment===q.id&&p.status==='queued'));
  const candidate=retractionCandidate(speech,lineup);
  assert(candidate);assert.equal(candidate.id,q.id);
  assert(candidate.parts.every(p=>['queued','held'].includes(p.status)));
  const before=structuredClone(stage.state.subtitle),active=speech.filter(p=>p.status==='speaking').map(({key,...p})=>p);
  const removed=stage.retract(candidate.id);
  assert.equal(removed,candidate.text);assert(removed.length>0);
  assert.deepEqual(stage.state.subtitle,before,'撤回同root尾部不得硬切当前发声');
  assert.deepEqual(stage.timeline.snapshot().filter(p=>p.status==='speaking').map(({key,...p})=>p),active);
  assert(!stage.timeline.snapshot().some(p=>p.segment===q.id&&['queued','held'].includes(p.status)));
  assert.equal(retractionCandidate(stage.timeline.snapshot(),stage.lineup()),undefined);
  const next=stage.enqueue('另一段还没有开口的排队话。');await new Promise(setImmediate);
  assert.equal(retractionCandidate(stage.timeline.snapshot(),stage.lineup()).id,next.id);
  assert.equal(retractionCandidate([{segment:'held',text:'挂起尾部。',positions:[9,10,11,12,13],status:'held'}],[{id:'held',playing:true}]).parts[0].status,'held');
  console.log('PASS 真实拆截队列：单playing root的未念尾部可撤，当前字幕与开口时钟不变；独立排队段及held尾部均可选。');
}finally{stage.stop();}
