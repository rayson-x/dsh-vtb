/** Capture the native Film frame API through an existing Ego TaskSpace; no second browser. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile),
  [space, pageLabel, logPath] = process.argv.slice(2);
if (!Number.isSafeInteger(Number(space)) || !/^p\d+$/.test(pageLabel ?? ''))
  throw Error('Usage: node harness-film-capture.mjs <Ego space ID> <page label> <export log>');
const config = JSON.parse(
  (await readFile(resolve(logPath), 'utf8')).split('\n').find((line) => line.startsWith('{"offline":')),
);
const script = `
const fs=await import('node:fs/promises'),crypto=await import('node:crypto');
const config=${JSON.stringify(config)};
const task=await taskSpace(${Number(space)}),page=task.page(${JSON.stringify(pageLabel)});
await page.goto(config.url);await page.cdp('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
await page.evaluate(async()=>{await window.__compositionFrameProgram.prepare()});
const folder=config.output+'/frames';await fs.mkdir(folder,{recursive:true});
const hashes=[];
async function capture(frame){await page.evaluate(async f=>{await window.__compositionFrameProgram.applyFrame(f);if(window.__compositionHtmlVisualError)throw Error(window.__compositionHtmlVisualError)},frame);const value=await page.cdp('Page.captureScreenshot',{format:'png',fromSurface:true});return Buffer.from(value.data,'base64');}
for(let frame=0;frame<config.frames;frame++){const bytes=await capture(frame);hashes.push(crypto.createHash('sha256').update(bytes).digest('hex'));await fs.writeFile(folder+'/'+String(frame).padStart(5,'0')+'.png',bytes);if(frame%30===0)console.log('captured '+frame+'/'+config.frames);}
const recording=JSON.parse(await fs.readFile(config.output+'/recording.json','utf8'));
const hold=recording.scenes.flatMap(s=>(s.frameMap??[]).filter(m=>m.rate===0&&m.until-m.from>3).map(m=>({from:s.startFrame+m.from,until:s.startFrame+m.until})))[0];
if(!hold)throw Error('Selected simulation has no recorded hold');
const held=[Math.ceil(hold.from)+1,Math.floor(hold.until)-1];if(hashes[held[0]]!==hashes[held[1]])throw Error('Recorded hold changed pixels');
const seeks=[0,held[0],Math.min(config.frames-1,Math.floor(config.frames*.75))];
for(const frame of seeks){const bytes=await capture(frame);if(crypto.createHash('sha256').update(bytes).digest('hex')!==hashes[frame])throw Error('Reverse/repeated seek changed frame '+frame);}
await fs.writeFile(config.output+'/capture-proof.json',JSON.stringify({simulation:config.simulation,frames:config.frames,holdFrames:held,holdIdentical:true,repeatedSeeks:seeks,repeatIdentical:true},null,2));
console.log(JSON.stringify({captured:config.frames,holdIdentical:true,repeatIdentical:true}));
`;
const captured = await run('ego-browser', ['nodejs', '-e', script], {
  timeout: 300000,
  maxBuffer: 1024 * 1024,
});
process.stdout.write(captured.stdout);
const video = join(config.output, 'replay.mp4');
await run(
  'ffmpeg',
  [
    '-v',
    'error',
    '-y',
    '-framerate',
    String(config.fps),
    '-i',
    join(config.output, 'frames/%05d.png'),
    '-frames:v',
    String(config.frames),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    video,
  ],
  { timeout: 120000, maxBuffer: 1024 * 1024 },
);
const probe = JSON.parse(
  (
    await run('ffprobe', [
      '-v',
      'error',
      '-count_frames',
      '-show_entries',
      'stream=codec_type,width,height,nb_read_frames,r_frame_rate',
      '-of',
      'json',
      video,
    ])
  ).stdout,
);
const stream = probe.streams.find((s) => s.codec_type === 'video');
if (Number(stream?.nb_read_frames) !== config.frames || stream.width !== 1920 || stream.height !== 1080)
  throw Error('Encoded video does not match native Film timeline');
await writeFile(
  join(config.output, 'video-proof.json'),
  JSON.stringify({ simulation: config.simulation, video, probe }, null, 2),
);
console.log(JSON.stringify({ simulation: config.simulation, video, frames: config.frames, fps: config.fps }));
