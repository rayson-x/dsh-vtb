import test from 'node:test';import assert from'node:assert/strict';
import{projectResponseMeasurements,summarizeResponseMeasurements}from'./response-measurements.mjs';
test('does not count queued audio, and keeps first contact separate from later completion and visual evidence',()=>{
 const inputs=[{index:1,eventId:'viewer',at:1000}],state={speech:{ack:{partId:'ack',responseTo:'viewer',responseStage:'ack',text:'窗边留暖光。',state:'offered'}},speechArchive:{},proposals:{p:{eventIds:['viewer'],status:'presented'}},playback:[]};
 const timings=[{phase:'tts-ready',at:1100,fields:{partId:'ack'}}];
 assert.equal(projectResponseMeasurements(inputs,state,timings)[0].firstResponse,null);
 state.speech.ack.state='ended';timings.push({phase:'audio-playing',at:2000,fields:{partId:'ack'}},{phase:'audio-ended',at:3000,fields:{partId:'ack'}});
 state.speech.answer={partId:'answer',responseTo:'viewer',responseStage:'answer',text:'亮度先压低一点。',state:'ended'};
 state.speech.finish={partId:'finish',responseTo:'viewer',responseStage:'finish',text:'先这样定，等画面出来再看。',state:'ended'};
 for(const[id,start,end]of[['answer',6000,8000],['finish',10000,12000]])timings.push({phase:'audio-playing',at:start,fields:{partId:id}},{phase:'audio-ended',at:end,fields:{partId:id}});
 const [row]=projectResponseMeasurements(inputs,state,timings);assert.equal(row.firstResponse.firstAudibleMs,1000);assert.equal(row.firstAnswer.firstAudibleMs,5000);assert.equal(row.verbalCompletion.completedMs,11000);assert.equal(row.visualFulfilledMs,null);
 assert.equal(summarizeResponseMeasurements([row]).firstResponse.p95,1000);assert.equal(summarizeResponseMeasurements([row]).verbalCompletion.p95,11000);
 state.speech.ack.state='failed';const retry=summarizeResponseMeasurements(projectResponseMeasurements(inputs,state,timings));assert.equal(retry.acknowledgement.count,0);assert.equal(retry.firstResponse.p95,5000);
});
test('acceptance stops feeding requests when the model role is unavailable',async()=>{
 const{createServer}=await import('node:http'),{execFile}=await import('node:child_process'),{promisify}=await import('node:util'),{mkdtemp,readFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join,resolve}=await import('node:path');
 for(const code of['QUOTA','UNKNOWN']){
  const folder=await mkdtemp(join(tmpdir(),'acceptance-health-'));let inputs=0;
  const state={speech:{},speechArchive:{},proposals:{},audience:[],continuations:{},project:{currentEpoch:1,channel:{mode:'neutral'}},assets:{},tasks:{},scenes:{}};
  const server=createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.method==='POST')inputs++;res.end(JSON.stringify(req.url==='/live/harness'?{state,roles:[{role:'performer',ready:true,phase:'idle',error:code}]}:req.url?.startsWith('/live/timings')?{events:[],oldest:1,latest:0}:{ok:true}));});
  await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
  try{
   const{stdout}=await promisify(execFile)(process.execPath,[resolve('scripts/harness-acceptance.mjs'),origin,origin,'60'],{cwd:folder,timeout:8000});
   const result=JSON.parse(stdout.trim());assert.equal(result.stopReason.code,code);assert.equal(inputs,0);const report=JSON.parse(await readFile(join(result.output,'report.json'),'utf8'));assert.equal(report.errors[0].phase,'role-health');assert.equal(report.inputs.length,0);
  }finally{await new Promise(done=>server.close(done));await rm(folder,{recursive:true,force:true});}
 }
});
