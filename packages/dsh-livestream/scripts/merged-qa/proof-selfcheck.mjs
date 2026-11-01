// 判定器已复现误判的可重跑负控；不调用模型/服务，不替代真实长轮。
import assert from 'node:assert/strict';
import {coverageGap,collectionClean} from './coverage.mjs';
import {wordProof,hasSuccessfulExit,crossesSpokenSegments,archiveComplete} from './speech-proof.mjs';

const gap=rows=>coverageGap(rows,s=>s.at,s=>s.until,0,20000);
assert.equal(gap([{at:0,until:10000,samples:50},{at:10200,until:20000,samples:49}]),200,'正常压缩区间不是断采');
assert.equal(gap([{at:0,until:10000},{at:12501,until:20000}]),2501,'真实中间空洞不能被压缩掩盖');
assert.equal(gap([{at:2001,until:19000}]),2001,'轮次边界同样检查覆盖');
assert.equal(collectionClean({events:[],pollErrors:[]}),true);
assert.equal(collectionClean({events:[],pollErrors:[{kind:'track',error:'fetch failed'}]}),false,'poll失败不能被延长until掩盖');
assert.equal(collectionClean({events:[{kind:'error',error:'SSE关闭'}],pollErrors:[]}),false);

const part={segment:'say1',text:'0123456789',positions:Array.from({length:10},(_,i)=>i),starts:Array.from({length:10},(_,i)=>i*1000),startedAt:0,duration:10000,status:'speaking'};
const raw={finishedAt:12000,tracks:[{speech:[part]},{speech:[{...part,status:'retracted',spoken:3}]}],subtitles:[{id:'say1',text:part.text,startedAt:0,ms:10000,audio:'/voice/a',endedAt:3000}]};
const media=[{type:'audio',src:'http://stage/voice/a',at:0,currentTime:0,rate:1}];
const clip=char=>({enter:{anchor:{segment:'say1',char}}});
assert.equal(wordProof({now:8000,target:8000},clip(8),raw,media).spoken,false,'旧speaking快照不能证明撤回尾字已念');
assert.equal(wordProof({now:2000,target:2000},clip(2),raw,media).spoken,true,'同一已截断段中确实念过的字仍合法');
assert.equal(wordProof({now:2000,target:2000},clip(2),{...raw,tracks:[{speech:[{...part,starts:undefined,status:'done',spoken:10}]}]},media).spoken,false,'均匀估时不能替代真实starts');
assert.equal(hasSuccessfulExit({id:'v1'},[{id:'v1',phase:'exit',ok:false}]),false,'失败擦除回执不算退场');
assert.equal(hasSuccessfulExit({id:'v1'},[{id:'v1',phase:'exit',ok:true}]),true);

const cross={finishedAt:10000,subtitles:[{id:'say1',startedAt:0,ms:5000,audio:'/voice/a'},{id:'say2',startedAt:5000,ms:5000}]};
const seen=[{type:'enter',id:'v1',at:1000},...media];
assert.equal(crossesSpokenSegments({id:'v1'},9000,cross,seen),false,'无声估时段不能凑跨段数');
cross.subtitles[1].audio='/voice/b';seen.push({type:'audio',src:'http://stage/voice/b',at:5000,currentTime:0,rate:1});
assert.equal(crossesSpokenSegments({id:'v1'},9000,cross,seen),true);
assert.equal(archiveComplete({beats:[{id:'b1',status:'done'}],remaining:[],summary:''}),true,'全部已讲完时空remaining合法');
assert.equal(archiveComplete({beats:[{id:'b1',status:'pending'}],remaining:[],summary:''}),false,'真正未讲点不得从归档中消失');
assert.equal(archiveComplete({beats:[{id:'b1',status:'pending'}],remaining:[{id:'b1',status:'pending'}],summary:'未讲原点'}),true);

const text='甲乙。\n\n丙丁。',positions=[...text].map((_,i)=>i);
const multiline={segment:'say8',text,positions,starts:positions.map(i=>i*500),startedAt:1000,duration:4000,status:'done',spoken:positions.length};
const subtitle={id:'say8',text:'甲乙。 丙丁。',startedAt:1000,ms:4000,audio:'/voice/multiline',endedAt:5000};
const paragraph={finishedAt:6000,tracks:[{speech:[multiline]}],subtitles:[subtitle]};
const paragraphMedia=[{type:'audio',src:'http://stage/voice/multiline',at:1000,currentTime:0,rate:1}];
const paragraphClip={enter:{anchor:{segment:'say8',char:5}}},entry={now:3500,target:3500};
assert.equal(wordProof(entry,paragraphClip,paragraph,paragraphMedia).spoken,true,'协议折叠字幕空白不应丢失真实音频关联');
assert.equal(wordProof(entry,paragraphClip,{...paragraph,subtitles:[{...subtitle,startedAt:11000}]},paragraphMedia).spoken,false,'空白归一不能串联不同开口时钟');
assert.equal(wordProof(entry,paragraphClip,{...paragraph,tracks:[{speech:[{...multiline,status:'speaking'}]},{speech:[{...multiline,status:'retracted',spoken:3}]}],subtitles:[{...subtitle,endedAt:2500}]},paragraphMedia).spoken,false,'多行文本也不得放行真正未念尾字');

console.log('PASS 判定负控：压缩覆盖/错误、最终字音/starts、退场成功、真实跨段、完整归档、字幕空白与时钟。');
