/** Transport/scheduler simulation. Media replies are fixtures, never a sound/visual trial. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { ProductionRuntime } from '../src/live/runtime/production';
let runtime: ProductionRuntime | undefined;
let folder: string | undefined;
const sockets: WebSocket[] = [];
const fetchHttp=globalThis.fetch;
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await runtime?.stop();
  runtime = undefined;
  if (folder) await rm(folder, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function openRuntime(fullStart = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, options: any) => {
      const chars = [...JSON.parse(options.body).text];
      return new Response(
        JSON.stringify({
          audio_base64: Buffer.from('transport-fixture-not-a-media-proof').toString('base64'),
          alignment: {
            characters: chars,
            character_start_times_seconds: chars.map((_, i) => i * 0.04),
            character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.04),
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  folder = await mkdtemp(join(tmpdir(), 'live-recovery-'));
  // This root intentionally has no private SDK, public scripts or Scene packages.
  runtime = new ProductionRuntime({
    repoRoot: folder,
    dataDir: join(folder, 'data'),
    port: 0,
    secret: () => 'fixture',
  });
  if (fullStart) await runtime.start();
  else await runtime.gateway.start();
  return runtime;
}
function browser() {
  const observed: any[] = [];
  let ready!: () => void;
  const prepared = new Promise<void>((done) => (ready = done));
  const ws = new WebSocket(runtime!.gateway.origin.replace('http', 'ws') + '/ws', {
    origin: runtime!.gateway.origin,
  });
  sockets.push(ws);
  ws.on('message', (bytes) => {
    const op = JSON.parse(bytes.toString());
    observed.push(op);
    ws.send(
      JSON.stringify({
        type: 'result',
        opId: op.opId,
        ok: true,
        value: op.type === 'snapshot' ? { scenes: [], audio: null } : null,
      }),
    );
    if (op.type === 'snapshot') ready();
    if (op.type === 'speech')
      ws.send(
        JSON.stringify({
          type: 'audio',
          kind: 'playing',
          partId: op.payload.partId,
          epoch: op.epoch,
          audioRef: op.payload.audioRef,
          mediaTimeMs: 0,
        }),
      );
  });
  return { ws, observed, prepared };
}
it('releases the voice lane after WS disconnect and reconciliation so the next request can start', async () => {
  const r = await openRuntime();
  const first = browser();
  await first.prepared;
  await r.invoke('performer', 'offerSpeech', {
    commandId: 'first',
    directionEpoch: r.kernel.epoch(),
    partId: 'first',
    text: 'one',
  });
  await vi.waitFor(() => expect(r.kernel.view().speech.first.state).toBe('playing'));
  await new Promise<void>((done) => {
    first.ws.once('close', () => done());
    first.ws.close();
  });
  const second = browser();
  await second.prepared;
  await vi.waitFor(() => expect(r.kernel.view().speech.first.state).toBe('failed'));
  await r.invoke('performer', 'offerSpeech', {
    commandId: 'second',
    directionEpoch: r.kernel.epoch(),
    partId: 'second',
    text: 'two',
  });
  await vi.waitFor(
    () =>
      expect(second.observed.some((op) => op.type === 'speech' && op.payload.partId === 'second')).toBe(true),
    { timeout: 2000 },
  );
});
it('keeps the performer available when private SDK discovery fails in the production seat', async () => {
  const r = await openRuntime(true);
  const peer = browser();
  await peer.prepared;
  await expect(r.invoke('production', 'searchSdk', {})).rejects.toThrow();
  await r.invoke('performer', 'offerSpeech', {
    commandId: 'independent',
    directionEpoch: r.kernel.epoch(),
    partId: 'independent',
    text: 'hello',
  });
  await vi.waitFor(() => expect(r.kernel.view().speech.independent.state).toBe('playing'));
  expect(r.gateway.connected()).toBe(true);
});
it('synthesizes the one queued part while the current part plays, without sending it early or synthesizing twice', async () => {
  const r = await openRuntime(), peer = browser();
  await peer.prepared;
  const offer = (partId: string) => r.invoke('performer', 'offerSpeech', { directionEpoch: r.kernel.epoch(), partId, text: partId });
  await offer('current');
  await vi.waitFor(() => expect(r.kernel.view().speech.current.state).toBe('playing'));
  await offer('next');
  await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBe(2));
  await vi.waitFor(()=>expect(r.timingsSince().events.some(e=>e.phase==='tts-ready'&&e.fields.partId==='next')).toBe(true));
  expect(r.timingsSince().events.some(e=>e.phase==='audio-playing'&&e.fields.partId==='next')).toBe(false);
  expect(peer.observed.filter(op => op.type === 'speech').length).toBe(1);
  const first = peer.observed.find(op => op.type === 'speech');
  peer.ws.send(JSON.stringify({ type:'audio',kind:'ended',partId:'current',epoch:r.kernel.epoch(),audioRef:first.payload.audioRef,mediaTimeMs:1000,sequence:2 }));
  await vi.waitFor(() => expect(r.kernel.view().speech.next.state).toBe('playing'));
  expect(r.timingsSince().events.some(e=>e.phase==='audio-playing'&&e.fields.partId==='next')).toBe(true);
  expect(vi.mocked(fetch).mock.calls.length).toBe(2);
});
it('withdrawing an unplayed queued part frees its slot without cutting current audio', async () => {
  const r = await openRuntime(), peer = browser();
  await peer.prepared;
  const offer = (partId: string) => r.invoke('performer', 'offerSpeech', { directionEpoch:r.kernel.epoch(),partId,text:partId });
  await offer('current');
  await vi.waitFor(() => expect(r.kernel.view().speech.current.state).toBe('playing'));
  await offer('withdrawn');
  expect(await r.invoke('performer','yieldSpeech',{directionEpoch:r.kernel.epoch(),partId:'withdrawn',expectedRevision:r.kernel.revision({kind:'speechPart',id:'withdrawn'})})).toMatchObject({ok:true});
  expect(await offer('replacement')).toMatchObject({ok:true});
  expect(r.kernel.view().speech.current.state).toBe('playing');
  expect(peer.observed.filter(op=>op.type==='speech').length).toBe(1);
});
it('a direction switch releases obsolete future synthesis slots while retaining the soft-switch current part', async () => {
  const r = await openRuntime(), peer = browser();
  await peer.prepared;
  const offer = (partId: string) => r.invoke('performer','offerSpeech',{directionEpoch:r.kernel.epoch(),partId,text:partId});
  await offer('current');
  await vi.waitFor(() => expect(r.kernel.view().speech.current.state).toBe('playing'));
  await offer('obsolete');
  expect((await r.switchDirection('Next direction')).ok).toBe(true);
  expect(await offer('new-direction')).toMatchObject({ok:true});
  expect(r.kernel.view().speech.current.state).toBe('playing');
});
it('atomically replaces only an uncommitted future sentence, with revision checks and no cut to current audio',async()=>{
 const r=await openRuntime(),peer=browser();await peer.prepared;
 const epoch=r.kernel.epoch();
 const offer=(partId:string,replacePending?:{partId:string;expectedRevision:number})=>r.invoke('performer','offerSpeech',{directionEpoch:epoch,partId,text:partId,...(replacePending?{replacePending}:{})});
 await offer('current');await vi.waitFor(()=>expect(r.kernel.view().speech.current.state).toBe('playing'));
 await offer('old-future');
 const replace={partId:'old-future',expectedRevision:r.kernel.view().speech['old-future'].revision};
 expect(await offer('stale',{...replace,expectedRevision:999})).toMatchObject({ok:false,reject:'REVISION_CONFLICT'});
 expect(r.kernel.view().speech['old-future'].state).toBe('offered');expect(r.kernel.view().speech.stale).toBeUndefined();
 expect(await offer('response',replace)).toMatchObject({ok:true});
 expect(r.kernel.view().speech['old-future'].state).toBe('cancelled');expect(r.kernel.view().speech.current.state).toBe('playing');
 expect(peer.observed.filter(op=>op.type==='speech')).toHaveLength(1);
 const current=peer.observed.find(op=>op.type==='speech');peer.ws.send(JSON.stringify({type:'audio',kind:'ended',partId:'current',epoch,audioRef:current.payload.audioRef,mediaTimeMs:1000,sequence:2}));
 await vi.waitFor(()=>expect(r.kernel.view().speech.response.state).toBe('playing'));
 expect(await offer('cut-current',{partId:'response',expectedRevision:r.kernel.view().speech.response.revision})).toMatchObject({ok:false,reject:'TOO_LATE'});
 expect(r.kernel.view().speech['cut-current']).toBeUndefined();
});
it('sends playable HTTP bytes before synthesis finishes, extends real timing, and preserves the current stream on a soft switch',async()=>{
 const r=await openRuntime(),peer=browser();await peer.prepared;
 let producer!:ReadableStreamDefaultController<Uint8Array>;
 vi.mocked(fetch).mockImplementation(async()=>new Response(new ReadableStream({start(c){producer=c;}})));
 const encode=(char:string,start:number,end:number)=>new TextEncoder().encode(JSON.stringify({audio_base64:Buffer.alloc(5000,1).toString('base64'),alignment:{characters:[char],character_start_times_seconds:[start],character_end_times_seconds:[end]}})+'\n');
 await r.invoke('performer','offerSpeech',{directionEpoch:r.kernel.epoch(),partId:'streamed',text:'你好'});
 await vi.waitFor(()=>expect(producer).toBeDefined());producer.enqueue(encode('你',0,.2));
 await vi.waitFor(()=>expect(r.kernel.view().speech.streamed.state).toBe('playing'));
 const spoken=peer.observed.find(op=>op.type==='speech');
 const media=await fetchHttp(spoken.payload.audioRef),reader=media.body!.getReader();
 expect((await reader.read()).value?.byteLength).toBe(5000);
 expect(r.timingsSince().events.some(e=>e.phase==='tts-ready'&&e.fields.partId==='streamed')).toBe(false);
 expect((await r.switchDirection('next')).ok).toBe(true);
 expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(false);
 producer.enqueue(encode('好',.2,.4));producer.close();
 await vi.waitFor(()=>expect(r.kernel.view().speech.streamed.alignment.starts).toEqual([0,200]));
 expect((await reader.read()).value?.byteLength).toBe(5000);expect((await reader.read()).done).toBe(true);
 expect(r.kernel.view().speech.streamed.state).toBe('playing');
});
it('admits several short future phrases, then applies bounded backpressure without claiming they were played',async()=>{
 const r=await openRuntime(),peer=browser();await peer.prepared;
 const offer=(partId:string,text=partId)=>r.invoke('performer','offerSpeech',{directionEpoch:r.kernel.epoch(),partId,text});
 await offer('current');await vi.waitFor(()=>expect(r.kernel.view().speech.current.state).toBe('playing'));
 for(const id of['a','b','c','d'])expect(await offer(id)).toMatchObject({ok:true});
 expect(await offer('overflow')).toMatchObject({ok:false,reject:'SPEECH_QUEUE_FULL'});
 expect(r.kernel.view().speech.overflow).toBeUndefined();expect(peer.observed.filter(op=>op.type==='speech')).toHaveLength(1);
});
it('records a requested hard cut as aborted only after the browser stop receipt, not as a synthesis failure',async()=>{
 const r=await openRuntime(),peer=browser();await peer.prepared;const epoch=r.kernel.epoch();
 let producer!:ReadableStreamDefaultController<Uint8Array>;
 vi.mocked(fetch).mockImplementation(async(_url,options)=>new Response(new ReadableStream({start(c){producer=c;options?.signal?.addEventListener('abort',()=>c.error(Object.assign(Error('cancelled'),{name:'AbortError'})),{once:true});}})));
 await r.invoke('performer','offerSpeech',{directionEpoch:epoch,partId:'cut-stream',text:'你好'});
 await vi.waitFor(()=>expect(producer).toBeDefined());producer.enqueue(new TextEncoder().encode(JSON.stringify({audio_base64:Buffer.alloc(5000,1).toString('base64'),alignment:{characters:['你'],character_start_times_seconds:[0],character_end_times_seconds:[.2]}})+'\n'));
 await vi.waitFor(()=>expect(r.kernel.view().speech['cut-stream'].state).toBe('playing'));
 const audioRef=peer.observed.find(op=>op.type==='speech').payload.audioRef;
 await r.switchDirection('cold next',true);
 await new Promise(resolve=>setTimeout(resolve,10));
 expect(r.kernel.view().speech['cut-stream'].state).toBe('playing');
 peer.ws.send(JSON.stringify({type:'audio',kind:'aborted',partId:'cut-stream',epoch,audioRef,mediaTimeMs:20,sequence:2}));
 await vi.waitFor(()=>expect(r.kernel.view().speech['cut-stream'].state).toBe('aborted'));
});
it('keeps write receipts thin and production briefs bounded while retaining full engineering history', async () => {
 const r=await openRuntime();
 for(let i=0;i<100;i++){
  const receipt=await r.invoke('editorial','requestProduction',{directionEpoch:r.kernel.epoch(),task:{id:'history-'+i,goal:'任务资料'.repeat(200),priority:1,inputs:[],dependsOn:[]}});
  expect(receipt).toMatchObject({ok:true});
  expect(receipt).not.toHaveProperty('events');expect(receipt).not.toHaveProperty('latest');
  expect(JSON.stringify(receipt).length).toBeLessThan(700);
 }
 const brief=r.brief('production');
 expect(Object.keys(brief.revisions.tasks).length).toBe(12);
 expect(JSON.stringify(brief).length).toBeLessThan(50000);
 expect(Object.keys(r.kernel.view().tasks).length).toBe(100);
});
it('restores durable master instructions independently of model session history', async()=>{
 const r=await openRuntime();await r.recordMasterNote('窗边的灯保留，不要粉色');await r.stop();
 runtime=new ProductionRuntime({repoRoot:folder!,dataDir:join(folder!,'data'),port:0,secret:()=>undefined});await runtime.start();
 expect(runtime.brief('performer').masterNotes[0].text).toContain('不要粉色');
});
