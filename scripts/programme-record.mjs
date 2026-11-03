/** Record actual programme pixels and the complete host/scene mix through an existing Ego page. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const run = promisify(execFile);
const [space, page = 'p1', seconds = '10'] = process.argv.slice(2);
const duration = Number(seconds);
if (!/^\d+$/.test(space ?? '') || !/^p\d+$/.test(page) || !Number.isFinite(duration) || duration < 1 || duration > 60)
  throw Error('Usage: node scripts/programme-record.mjs <Ego space> <page> [seconds 1..60]');
const output = resolve('.deps/programme-recordings', String(Date.now()));
await mkdir(join(output, 'frames'), { recursive: true });
const script = `
const fs=await import('node:fs/promises');const task=await taskSpace(${Number(space)}),page=task.page(${JSON.stringify(page)}),output=${JSON.stringify(output)};
await page.cdp('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
await page.waitForFunction(()=>!!window.__aivtbRecord,undefined,{timeout:10000});
await page.cdp('Network.disable');await page.cdp('Page.enable');await page.events();
const started=await page.cdp('Runtime.evaluate',{expression:'window.__aivtbRecord.start()',awaitPromise:true,returnByValue:true,userGesture:true});
if(started.exceptionDetails)throw Error(started.exceptionDetails.text+' '+started.exceptionDetails.exception?.description);
const frames=[];let captureError;
try{
 await page.cdp('Page.startScreencast',{format:'jpeg',quality:88,maxWidth:1920,maxHeight:1080,everyNthFrame:1});
 const end=Date.now()+${Math.round(duration * 1000)};
 while(Date.now()<end){
  for(const e of await page.events())if(e.method==='Page.screencastFrame'){
   const p=e.params;const name=String(frames.length).padStart(6,'0')+'.jpg';await fs.writeFile(output+'/frames/'+name,Buffer.from(p.data,'base64'));frames.push({file:'frames/'+name,timestamp:p.metadata.timestamp*1000});await page.cdp('Page.screencastFrameAck',{sessionId:p.sessionId});
  }
  await new Promise(r=>setTimeout(r,15));
 }
}catch(e){captureError=e;}
finally{await page.cdp('Page.stopScreencast');}
const endedAt=Date.now();const audio=await page.evaluate(()=>window.__aivtbRecord.stop());
if(captureError)throw captureError;if(!frames.length)throw Error('Browser supplied no programme frames');
for(let i=0;i<audio.length;i++){await fs.writeFile(output+'/audio-'+i+'.webm',Buffer.from(audio[i].base64,'base64'));delete audio[i].base64;audio[i].file='audio-'+i+'.webm';}
const record={schema:1,kind:'actual-programme-capture',sourceUrl:await page.url(),captureStart:started.result.value,from:frames[0].timestamp,until:endedAt,width:1920,height:1080,fps:30,frames,audio};
if(record.until<=record.from||Math.abs(record.from-Date.now())>120000)throw Error('Unexpected browser presentation clock');
await fs.writeFile(output+'/capture.json',JSON.stringify(record,null,2));console.log(JSON.stringify({recorded:true,output,actualFrames:frames.length,audioStreams:audio.length}));
`;
const captured = await run('ego-browser', ['nodejs', '-e', script], { timeout: (duration + 40) * 1000, maxBuffer: 1024 * 1024 });
process.stdout.write(captured.stdout);
const record = JSON.parse(await readFile(join(output, 'capture.json'), 'utf8'));
const length = (record.until - record.from) / 1000;
const concat = record.frames.map((frame, i) => {
  const end = record.frames[i + 1]?.timestamp ?? record.until;
  return `file '${frame.file}'\nduration ${Math.max(.001, (end - frame.timestamp) / 1000)}\n`;
}).join('') + `file '${record.frames.at(-1).file}'\n`;
await writeFile(join(output, 'frames.txt'), concat);
await run('ffmpeg', ['-v','error','-y','-f','concat','-safe','0','-i',join(output,'frames.txt'),'-t',String(length),'-vf','fps=30,scale=1920:1080','-c:v','libx264','-pix_fmt','yuv420p',join(output,'picture.mp4')], { timeout: 120000, maxBuffer: 1024 * 1024 });
const audioArgs = record.audio.flatMap(a => ['-i', join(output, a.file)]);
if (!audioArgs.length) throw Error('Programme capture has no audio taps');
const filters = record.audio.map((a,i) => `[${i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=start=${Math.max(0,(record.from-a.startedAt)/1000)},asetpts=PTS-STARTPTS,adelay=${Math.max(0,a.startedAt-record.from)}:all=1,apad,atrim=duration=${length}[a${i}]`);
filters.push(record.audio.map((_,i)=>`[a${i}]`).join('')+`amix=inputs=${record.audio.length}:normalize=0[mix]`);
await run('ffmpeg',['-v','error','-y',...audioArgs,'-filter_complex',filters.join(';'),'-map','[mix]','-ar','48000','-ac','2','-c:a','pcm_s16le',join(output,'programme.wav')],{timeout:120000,maxBuffer:1024*1024});
await run('ffmpeg',['-v','error','-y','-i',join(output,'picture.mp4'),'-i',join(output,'programme.wav'),'-map','0:v','-map','1:a','-c:v','copy','-c:a','aac','-t',String(length),'-movflags','+faststart',join(output,'programme.mp4')],{timeout:120000,maxBuffer:1024*1024});
const probe=JSON.parse((await run('ffprobe',['-v','error','-count_frames','-show_streams','-of','json',join(output,'programme.mp4')])).stdout);
if(!probe.streams.some(s=>s.codec_type==='audio')||!probe.streams.some(s=>s.codec_type==='video'&&s.width===1920&&s.height===1080))throw Error('Programme recording has missing media streams');
await writeFile(join(output,'proof.json'),JSON.stringify({kind:record.kind,duration:length,actualFrames:record.frames.length,outputFps:30,framePolicy:'CFR resampling of actual presented frames; not a native 30fps performance claim',audioPolicy:'actual host and trusted scene-client output taps',probe},null,2));
console.log(JSON.stringify({programmeCapture:true,output,video:join(output,'programme.mp4'),duration:length}));

const files={};for(const name of ['capture.json','picture.mp4','programme.wav','programme.mp4'])files[name]=createHash('sha256').update(await readFile(join(output,name))).digest('hex');await writeFile(join(output,'manifest.json'),JSON.stringify({schema:1,kind:record.kind,files},null,2));
