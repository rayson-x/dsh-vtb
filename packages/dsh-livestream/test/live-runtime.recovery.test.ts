/** Transport/scheduler simulation. Media replies are fixtures, never a sound/visual trial. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm,readFile,writeFile } from 'node:fs/promises';
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
  const directorWakes:string[]=[];r.onWake=(role,text)=>{if(role==='director')directorWakes.push(text);};
  const first = browser();
  await first.prepared;
  await r.invoke('performer', 'offerSpeech', {
    commandId: 'first',
    directionEpoch: r.kernel.epoch(),
    partId: 'first',
    text: 'one',
  });
  await vi.waitFor(() => expect(r.kernel.view().speech.first.state).toBe('playing'));
  expect(directorWakes).toHaveLength(1); // Speech was already planned when offered.
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
it('can acknowledge first, preserve the unfinished answer, and complete it in later spoken parts',async()=>{
 const r=await openRuntime(true),peer=browser();await peer.prepared;const epoch=r.kernel.epoch();
 const target={kind:'show' as const,id:r.kernel.view().project.id};
 expect(r.kernel.submit({commandId:'viewer-input',idempotencyKey:'viewer-input',actorId:'live:input',directionEpoch:epoch,target,expectedRevision:r.kernel.revision(target),payload:{type:'ingestAudience',eventId:'viewer-1',audienceId:'lamp',text:'阿灯：窗边能加暖灯吗？',kind:'proposal',priority:'urgent'}}).ok).toBe(true);
 const offer=(partId:string,text:string,responseStage?:'answer'|'finish')=>r.invoke('performer','offerSpeech',{directionEpoch:epoch,partId,text,...(responseStage?{responseTo:'viewer-1',responseStage}:{})});
 const end=async(partId:string)=>{const op=peer.observed.find(op=>op.type==='speech'&&op.payload.partId===partId);peer.ws.send(JSON.stringify({type:'audio',kind:'ended',partId,epoch,audioRef:op.payload.audioRef,mediaTimeMs:1000,sequence:2}));await vi.waitFor(()=>expect(r.kernel.view().speech[partId].state).toBe('ended'));};
 await offer('current','先讲完眼前这一小句。');await vi.waitFor(()=>expect(r.kernel.view().speech.current.state).toBe('playing'));
 await offer('ordinary-future','旧内容'.repeat(18));
 const inputRef=r.kernel.view().audience[0].replyRef!;
 expect(inputRef).toMatch(/^q\d+$/);
 expect(await r.invoke('performer','acknowledgeInput',{directionEpoch:epoch,inputId:inputRef,text:'阿灯，窗边就选暖光。',partId:'ack'})).toMatchObject({ok:true});
 expect(r.kernel.view().speech.ack.responseTo).toBe('viewer-1');
 expect(r.kernel.view().speech['ordinary-future'].state).toBe('cancelled');expect(r.kernel.view().speech.current.state).toBe('playing');
 expect(r.brief('performer').responses.find((x:any)=>x.eventId==='viewer-1')).toMatchObject({acknowledged:false,verbalComplete:false});
 expect(await r.invoke('performer','acknowledgeInput',{directionEpoch:epoch,inputId:'viewer-1',text:'又接住一次'})).toMatchObject({ok:false});
 await end('current');await vi.waitFor(()=>expect(r.kernel.view().speech.ack.state).toBe('playing'));
 await offer('answer-1','暖光放在窗边，桌面可以留空。','answer');
 await end('ack');await vi.waitFor(()=>expect(r.kernel.view().speech['answer-1'].state).toBe('playing'));
 expect(r.brief('performer').responses.find((x:any)=>x.eventId==='viewer-1')).toMatchObject({acknowledged:true,verbalComplete:false});
 await end('answer-1');
 expect(r.brief('performer').pendingReplies.some((x:any)=>x.eventId==='viewer-1')).toBe(true);
 await offer('answer-end','灯的位置先这样定，等画面出来再看。','finish');await vi.waitFor(()=>expect(r.kernel.view().speech['answer-end'].state).toBe('playing'));await end('answer-end');
 expect(r.brief('performer').responses.find((x:any)=>x.eventId==='viewer-1')).toMatchObject({acknowledged:true,verbalComplete:true});
 await r.stop();runtime=new ProductionRuntime({repoRoot:folder!,dataDir:join(folder!,'data'),port:0,secret:()=>undefined});
 expect(runtime.brief('performer').responses.find((x:any)=>x.eventId==='viewer-1')).toMatchObject({acknowledged:true,verbalComplete:true});
 expect(runtime.kernel.view().audience[0].replyRef).toBe(inputRef);
});
it.each([false,true])('hands A to a ready reply and resumes rewritten A, preserving a late stop after withdrawal=%s',async(withdraw)=>{
 const r=await openRuntime(),peer=browser();await peer.prepared;const epoch=r.kernel.epoch(),target={kind:'show' as const,id:r.kernel.view().project.id};
 r.kernel.submit({commandId:'input',idempotencyKey:'input',actorId:'live:input',directionEpoch:epoch,target,expectedRevision:r.kernel.revision(target),payload:{type:'ingestAudience',eventId:'viewer',audienceId:'lamp',text:'灯光改暖色？',kind:'proposal',priority:'urgent'}});
 const offer=(partId:string,text:string,extra={})=>r.invoke('performer','offerSpeech',{directionEpoch:epoch,partId,text,...extra});
 const ended=async(partId:string)=>{const op=peer.observed.find(op=>op.type==='speech'&&op.payload.partId===partId);peer.ws.send(JSON.stringify({type:'audio',kind:'ended',partId,epoch,audioRef:op.payload.audioRef,mediaTimeMs:1000,sequence:5}));await vi.waitFor(()=>expect(r.kernel.view().speech[partId].state).toBe('ended'));};
 await offer('A','窗边有盏灯，接着读信。');await vi.waitFor(()=>expect(r.kernel.view().speech.A.state).toBe('playing'));
 let release!:(r:Response)=>void;const gate=new Promise<Response>(done=>{release=done;});vi.mocked(fetch).mockImplementationOnce(()=>gate);
 await r.invoke('performer','acknowledgeInput',{directionEpoch:epoch,inputId:'viewer',partId:'ack',text:'暖光留窗边，这个好。'});
 await vi.waitFor(()=>expect(vi.mocked(fetch).mock.calls).toHaveLength(2));expect(peer.observed.some(op=>op.type==='interruptSpeech')).toBe(false);
 const chars=[...'暖光留窗边，这个好。'];release(new Response(JSON.stringify({audio_base64:Buffer.from('fixture-only').toString('base64'),alignment:{characters:chars,character_start_times_seconds:chars.map((_,i)=>i*.04),character_end_times_seconds:chars.map((_,i)=>(i+1)*.04)}})));
 await vi.waitFor(()=>expect(peer.observed.some(op=>op.type==='interruptSpeech')).toBe(true));
 const interrupt=peer.observed.find(op=>op.type==='interruptSpeech');expect(r.kernel.view().speech.A.state).toBe('playing');expect(Object.keys(r.kernel.view().continuations)).toHaveLength(0);
 peer.ws.send(JSON.stringify({type:'audio',kind:'interrupted',partId:'A',epoch,interruptId:'unknown-token',audioRef:interrupt.payload.audioRef,mediaTimeMs:220,sequence:2}));
 await new Promise(resolve=>setTimeout(resolve,10));expect(r.kernel.view().speech.A.state).toBe('playing');
 if(withdraw){expect(await r.invoke('performer','yieldSpeech',{directionEpoch:epoch,partId:'ack',expectedRevision:r.kernel.view().speech.ack.revision})).toMatchObject({ok:true});await vi.waitFor(()=>expect(peer.observed.some(op=>op.type==='cancelSpeechInterrupt')).toBe(true));}
 const window=interrupt.payload.windows[0];peer.ws.send(JSON.stringify({type:'audio',kind:'interrupted',partId:'A',epoch,interruptId:interrupt.payload.interruptId,audioRef:interrupt.payload.audioRef,mediaTimeMs:(window.fromMs+window.toMs)/2,sequence:3}));
 await vi.waitFor(()=>expect(r.kernel.view().speech.A.state).toBe('aborted'));
 const continuation=Object.values(r.kernel.view().continuations)[0];expect(continuation).toMatchObject({firstUnreadChar:6,unreadText:'接着读信。',status:'pending',boundaryReached:true});
 const replyId=withdraw?'ack-retry':'ack';if(withdraw)await r.invoke('performer','acknowledgeInput',{directionEpoch:epoch,inputId:'viewer',partId:replyId,text:'暖光留窗边，这个好。'});
 await vi.waitFor(()=>expect(r.kernel.view().speech[replyId].state).toBe('playing'));await ended(replyId);
 await offer('answer','暖灯先这样定，信上的名字接着看。',{responseTo:'viewer',responseStage:'finish'});await vi.waitFor(()=>expect(r.kernel.view().speech.answer.state).toBe('playing'));await ended('answer');
 await offer('A-new','灯的位置定了，我们接着读信。',{resumesContinuationIds:[continuation.id]});
 await vi.waitFor(()=>expect(r.kernel.view().continuations[continuation.id].status).toBe('resumed'));
 expect(peer.observed.filter(op=>op.type==='speech'&&op.payload.partId==='A')).toHaveLength(1);expect(r.kernel.view().speech['A-new'].text).not.toBe(continuation.unreadText);
});
it('cancels an armed handoff if the reply stream fails after its first playable chunk',async()=>{
 const r=await openRuntime(),peer=browser();await peer.prepared;const epoch=r.kernel.epoch(),target={kind:'show' as const,id:r.kernel.view().project.id};
 r.kernel.submit({commandId:'input',idempotencyKey:'input',actorId:'live:input',directionEpoch:epoch,target,expectedRevision:r.kernel.revision(target),payload:{type:'ingestAudience',eventId:'viewer',audienceId:'lamp',text:'暖灯？',kind:'proposal',priority:'urgent'}});
 await r.invoke('performer','offerSpeech',{directionEpoch:epoch,partId:'A',text:'窗边有盏灯，接着读信。'});await vi.waitFor(()=>expect(r.kernel.view().speech.A.state).toBe('playing'));
 let producer!:ReadableStreamDefaultController<Uint8Array>;vi.mocked(fetch).mockImplementationOnce(async()=>new Response(new ReadableStream({start(c){producer=c;}})));
 await r.invoke('performer','acknowledgeInput',{directionEpoch:epoch,inputId:'viewer',partId:'ack',text:'暖光留窗边。'});await vi.waitFor(()=>expect(producer).toBeDefined());
 producer.enqueue(new TextEncoder().encode(JSON.stringify({audio_base64:Buffer.alloc(5000,1).toString('base64'),alignment:{characters:['暖'],character_start_times_seconds:[0],character_end_times_seconds:[.2]}})+'\n'));
 await vi.waitFor(()=>expect(peer.observed.some(op=>op.type==='interruptSpeech')).toBe(true));producer.error(Error('remote stream failed'));
 await vi.waitFor(()=>expect(peer.observed.some(op=>op.type==='cancelSpeechInterrupt')).toBe(true));
 expect(r.kernel.view().speech.ack.state).toBe('rejected');expect(r.kernel.view().speech.A.state).toBe('playing');expect(r.kernel.view().speech.A.interruption).toBeUndefined();
});
it('keeps a failed producer voice occupied until the actual browser stop, including its final progress',async()=>{
 const r=await openRuntime(),peer=browser();await peer.prepared;let producer!:ReadableStreamDefaultController<Uint8Array>;
 vi.mocked(fetch).mockImplementationOnce(async()=>new Response(new ReadableStream({start(c){producer=c;}})));
 await r.invoke('performer','offerSpeech',{directionEpoch:r.kernel.epoch(),partId:'active',text:'你好'});await vi.waitFor(()=>expect(producer).toBeDefined());
 producer.enqueue(new TextEncoder().encode(JSON.stringify({audio_base64:Buffer.alloc(5000,1).toString('base64'),alignment:{characters:['你'],character_start_times_seconds:[0],character_end_times_seconds:[.2]}})+'\n'));
 await vi.waitFor(()=>expect(r.kernel.view().speech.active.state).toBe('playing'));const audioRef=peer.observed.find(op=>op.type==='speech').payload.audioRef;
 producer.error(Error('remote stream failed'));await vi.waitFor(()=>expect(peer.observed.some(op=>op.type==='abortSpeech')).toBe(true));
 expect(r.kernel.view().speech.active.state).toBe('playing');
 peer.ws.send(JSON.stringify({type:'audio',kind:'aborted',partId:'active',epoch:r.kernel.epoch(),audioRef,mediaTimeMs:100,sequence:3}));
 await vi.waitFor(()=>expect(r.kernel.view().speech.active.state).toBe('failed'));expect(r.kernel.view().speech.active.spokenChars).toBe(1);
});
it('reserves first contact for the separate generator without letting a full answer jump ahead',async()=>{
 const r=await openRuntime(),peer=browser();await peer.prepared;const epoch=r.kernel.epoch(),target={kind:'show' as const,id:r.kernel.view().project.id};
 r.kernel.submit({commandId:'input',idempotencyKey:'input',actorId:'live:input',directionEpoch:epoch,target,expectedRevision:r.kernel.revision(target),payload:{type:'ingestAudience',eventId:'viewer',audienceId:'lamp',text:'暖灯？',kind:'proposal',priority:'urgent'}});
 const release=r.reserveAcknowledgement('viewer');
 expect(await r.invoke('performer','offerSpeech',{directionEpoch:epoch,partId:'bypass',text:'暖灯留窗边。',responseTo:'viewer',responseStage:'ack'})).toMatchObject({ok:false,reject:'ACK_PENDING'});
 expect(await r.invoke('performer','offerSpeech',{directionEpoch:epoch,partId:'long-first',text:'先讲一段完整答案',responseTo:'viewer',responseStage:'answer'})).toMatchObject({ok:true});
 expect(r.kernel.view().speech['long-first'].state).toBe('offered');expect(peer.observed.some(op=>op.type==='speech')).toBe(false);expect(vi.mocked(fetch)).not.toHaveBeenCalled();expect(r.quickAcknowledgementContext('viewer')).toBeDefined();
 expect((await r.offerQuickAcknowledgement('viewer','暖灯留窗边。',epoch)).ok).toBe(true);release();
 await vi.waitFor(()=>expect(Object.values(r.kernel.view().speech).some(p=>p.responseTo==='viewer'&&p.state==='playing')).toBe(true));
 expect(peer.observed.find(op=>op.type==='speech').payload.partId).not.toBe('long-first');
});
it('lets a new first contact enter an unfinished answer at a pause, preserving which input to continue',async()=>{
 const r=await openRuntime(),peer=browser();await peer.prepared;const epoch=r.kernel.epoch(),target={kind:'show' as const,id:r.kernel.view().project.id};
 for(const id of['older','newer'])r.kernel.submit({commandId:id,idempotencyKey:id,actorId:'live:input',directionEpoch:epoch,target,expectedRevision:r.kernel.revision(target),payload:{type:'ingestAudience',eventId:id,audienceId:id,text:'灯光问题',kind:'proposal',priority:'urgent'}});
 await r.invoke('performer','offerSpeech',{directionEpoch:epoch,partId:'answer-old',responseTo:'older',responseStage:'answer',text:'窗边有盏灯，接着看杯子。'});await vi.waitFor(()=>expect(r.kernel.view().speech['answer-old'].state).toBe('playing'));
 await r.invoke('performer','acknowledgeInput',{directionEpoch:epoch,inputId:'newer',partId:'ack-new',text:'暖灯留窗边。'});await vi.waitFor(()=>expect(peer.observed.some(op=>op.type==='interruptSpeech')).toBe(true));
 const interrupt=peer.observed.find(op=>op.type==='interruptSpeech'),window=interrupt.payload.windows[0];peer.ws.send(JSON.stringify({type:'audio',kind:'interrupted',partId:'answer-old',epoch,interruptId:interrupt.payload.interruptId,audioRef:interrupt.payload.audioRef,mediaTimeMs:(window.fromMs+window.toMs)/2,sequence:3}));
 await vi.waitFor(()=>expect(r.kernel.view().speech['ack-new'].state).toBe('playing'));const note=Object.values(r.kernel.view().continuations)[0];expect(note.sourceResponseTo).toBe('older');
 const result=r.kernel.submit({commandId:'no-ack-cut',idempotencyKey:'no-ack-cut',actorId:'live:runtime',directionEpoch:epoch,target:{kind:'speechPart',id:'ack-new'},expectedRevision:r.kernel.view().speech['ack-new'].revision,payload:{type:'requestSpeechInterrupt',partId:'ack-new',interruptId:'bad',responseTo:'older'}});expect(result.ok).toBe(false);
});
it('does not interrupt an answer for its own next answer segment',async()=>{
 const r=await openRuntime(),peer=browser();await peer.prepared;const epoch=r.kernel.epoch(),target={kind:'show' as const,id:r.kernel.view().project.id};
 r.kernel.submit({commandId:'input',idempotencyKey:'input',actorId:'live:input',directionEpoch:epoch,target,expectedRevision:r.kernel.revision(target),payload:{type:'ingestAudience',eventId:'viewer',audienceId:'lamp',text:'暖灯？',kind:'proposal',priority:'urgent'}});
 await r.invoke('performer','offerSpeech',{directionEpoch:epoch,partId:'answer-one',text:'暖光留在窗边，亮度别太高。',responseTo:'viewer',responseStage:'answer'});await vi.waitFor(()=>expect(r.kernel.view().speech['answer-one'].state).toBe('playing'));
 await r.invoke('performer','offerSpeech',{directionEpoch:epoch,partId:'answer-two',text:'杯子放另一侧。',responseTo:'viewer',responseStage:'finish'});await vi.waitFor(()=>expect(r.timingsSince().events.some(e=>e.phase==='tts-ready'&&e.fields.partId==='answer-two')).toBe(true));
 expect(peer.observed.some(op=>op.type==='interruptSpeech')).toBe(false);expect(r.kernel.view().speech['answer-one'].interruption).toBeUndefined();
});
it.each([1,2])('accepts a known late stop after %s soft switches without restoring the old topic',async(switches)=>{
 const r=await openRuntime(),peer=browser();await peer.prepared;const epoch=r.kernel.epoch(),target={kind:'show' as const,id:r.kernel.view().project.id};
 r.kernel.submit({commandId:'input',idempotencyKey:'input',actorId:'live:input',directionEpoch:epoch,target,expectedRevision:r.kernel.revision(target),payload:{type:'ingestAudience',eventId:'viewer',audienceId:'lamp',text:'暖灯？',kind:'proposal',priority:'urgent'}});
 await r.invoke('performer','offerSpeech',{directionEpoch:epoch,partId:'A',text:'窗边有盏灯，接着读信。'});await vi.waitFor(()=>expect(r.kernel.view().speech.A.state).toBe('playing'));
 await r.invoke('performer','acknowledgeInput',{directionEpoch:epoch,inputId:'viewer',partId:'ack',text:'暖光留窗边。'});await vi.waitFor(()=>expect(peer.observed.some(op=>op.type==='interruptSpeech')).toBe(true));
 const interrupt=peer.observed.find(op=>op.type==='interruptSpeech');for(let i=0;i<switches;i++)expect((await r.switchDirection('new-'+i)).ok).toBe(true);
 await r.invoke('performer','offerSpeech',{directionEpoch:r.kernel.epoch(),partId:'new-topic',text:'现在聊新方向。'});
 const window=interrupt.payload.windows[0];peer.ws.send(JSON.stringify({type:'audio',kind:'interrupted',partId:'A',epoch,interruptId:interrupt.payload.interruptId,audioRef:interrupt.payload.audioRef,mediaTimeMs:(window.fromMs+window.toMs)/2,sequence:4}));
 await vi.waitFor(()=>expect(r.kernel.view().speech.A.state).toBe('aborted'));
 await vi.waitFor(()=>expect(r.kernel.view().speech['new-topic'].state).toBe('playing'));
 expect(Object.values(r.kernel.view().continuations).some(n=>n.sourcePartId==='A'&&n.status==='pending')).toBe(false);
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

it('notifies the independent visual director before speech is playable, then revises its outlook on replacement',async()=>{
 const r=await openRuntime();const wakes:any[]=[];r.onWake=(role,text)=>{wakes.push({role,text});};
 vi.mocked(fetch).mockImplementation(async()=>new Promise(()=>{}));
 await r.invoke('performer','offerSpeech',{directionEpoch:r.kernel.epoch(),partId:'first-plan',text:'先看看窗边那盏暖灯。'});
 expect(wakes.some(w=>w.role==='director')).toBe(true);
 let outlook:any=(r.brief('director') as any).speechOutlook;
 expect(outlook.current).toBeNull();expect(outlook.upcoming[0]).toMatchObject({partId:'first-plan',text:'先看看窗边那盏暖灯。',spokenChars:0});
 await r.invoke('performer','offerSpeech',{directionEpoch:r.kernel.epoch(),partId:'new-plan',text:'先聊聊观众的问题。',replacePending:{partId:'first-plan',expectedRevision:r.kernel.view().speech['first-plan'].revision}});
 outlook=(r.brief('director') as any).speechOutlook;expect(outlook.upcoming.map((p:any)=>p.partId)).toEqual(['new-plan']);
 expect(wakes.filter(w=>w.role==='director')).toHaveLength(2);expect(r.kernel.view().project.channel.mode).toBe('neutral');
});

it('lets the visual director revise and withdraw future cues without controlling the speaker',async()=>{
 const r=await openRuntime(),epoch=r.kernel.epoch();
 await r.invoke('director','bindCue',{directionEpoch:epoch,cue:{cueId:'visual-exit',anchor:{kind:'showTime',at:60000},payload:{params:{visible:false}}}});
 const cue:any=(r.brief('director') as any).visualTimeline.cues.find((c:any)=>c.cueId==='visual-exit');expect(cue.revision).toBe(1);
 expect(await r.invoke('director','editCue',{directionEpoch:epoch,cueId:'visual-exit',expectedRevision:cue.revision,payload:{params:{visible:true}}})).toMatchObject({ok:true});
 expect(await r.invoke('director','cancelCue',{directionEpoch:epoch,cueId:'visual-exit',expectedRevision:r.kernel.view().cues['visual-exit'].revision})).toMatchObject({ok:true});
 expect(r.kernel.view().cues['visual-exit'].status).toBe('invalidated');expect(Object.keys(r.kernel.view().speech)).toHaveLength(0);
 expect(await r.invoke('director','editCue',{directionEpoch:epoch,cueId:'visual-exit',expectedRevision:r.kernel.view().cues['visual-exit'].revision,payload:{params:{visible:true}}})).toMatchObject({ok:false});
});

it('selects runnable production before alphabetic dependants and normalizes named priorities',async()=>{
 const r=await openRuntime(),epoch=r.kernel.epoch();
 await r.invoke('editorial','requestProduction',{directionEpoch:epoch,task:{id:'z-base',goal:'先制作可复用底场',priority:'high',inputs:[],dependsOn:[]}});
 await r.invoke('editorial','requestProduction',{directionEpoch:epoch,task:{id:'a-fish',goal:'依赖底场的鱼群',priority:'normal',inputs:[],dependsOn:['z-base']}});
 expect(r.kernel.view().tasks['z-base'].priority).toBe(80);
 const contracts=r.brief('production').toolContracts;expect(contracts).not.toHaveProperty('requestProduction');expect(contracts).toHaveProperty('workspaceBuildPreview');
 const brief=r.brief('production').brief;expect(Array.isArray(brief)?brief[0]?.task?.id:null).toBe('z-base');
 await expect(r.invoke('production','workspaceBuildPreview',{directionEpoch:epoch,taskId:'a-fish',taskVersion:1,source:'export default {}'})).rejects.toThrow(/dependenc/i);
});
it('keeps another viewers queued completion when a new first contact gets priority',async()=>{
 const r=await openRuntime(),peer=browser();await peer.prepared;const epoch=r.kernel.epoch(),target={kind:'show' as const,id:r.kernel.view().project.id};
 for(const id of['older','newer'])r.kernel.submit({commandId:id,idempotencyKey:id,actorId:'live:input',directionEpoch:epoch,target,expectedRevision:r.kernel.revision(target),payload:{type:'ingestAudience',eventId:id,audienceId:id,text:'窗边的灯怎么放？',kind:'proposal',priority:'urgent'}});
 await r.invoke('performer','offerSpeech',{directionEpoch:epoch,partId:'programme',text:'说说刚才那封信，纸边还湿着。'});await vi.waitFor(()=>expect(r.kernel.view().speech.programme.state).toBe('playing'));
 await r.invoke('performer','offerSpeech',{directionEpoch:epoch,partId:'older-finish',responseTo:'older',responseStage:'finish',text:'我倾向灯放左侧，光斜着照到桌面。'});
 expect(r.brief('performer').responses.find(p=>p.eventId==='older')?.verbalComplete).toBe(false);
 expect(r.brief('performer').nextReply?.eventId).not.toBe('older');
 await r.invoke('performer','acknowledgeInput',{directionEpoch:epoch,partId:'newer-ack',inputId:'newer',text:'你提的暖灯，我看到了。'});
 expect(r.kernel.view().speech['older-finish'].state).toBe('offered');
});
it('rejects incomplete editorial cards before they poison every role brief',async()=>{
 const r=await openRuntime();
 const result:any=await r.invoke('editorial','publishEditorialProposal',{directionEpoch:r.kernel.epoch(),proposal:{id:'incomplete',minimumMaterials:['原始素材'],handoff:'交给现场',alternatives:[]}});
 expect(result.ok).toBe(false);expect(r.kernel.view().editorial.incomplete).toBeUndefined();
 for(const role of['performer','director','editorial','production']as const)expect(()=>r.brief(role)).not.toThrow();
});

it('quarantines incomplete editorial facts restored from an older accepted WAL',async()=>{
 const r=await openRuntime();await r.invoke('editorial','publishEditorialProposal',{directionEpoch:r.kernel.epoch(),proposal:{id:'legacy',segmentIntent:'看窗边的灯',viewingValue:'看光线变化',participation:'选择灯位',minimumMaterials:['原创场景'],handoff:'交给现场',alternatives:[]}});await r.stop();
 const file=join(folder!,'data','events.jsonl'),rows=(await readFile(file,'utf8')).trim().split('\n').map((x:string)=>JSON.parse(x));
 for(const row of rows){for(const f of row.event?.payload?.facts??[]){if(f.op==='editorial'){delete f.proposal.segmentIntent;delete f.proposal.viewingValue;delete f.proposal.participation;}if(f.op==='direction')for(const item of f.direction.contentPool??[])if(item.id==='legacy')delete item.summary;}}
 await writeFile(file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
 runtime=new ProductionRuntime({repoRoot:folder!,dataDir:join(folder!,'data'),port:0,secret:()=>undefined});await runtime.start();
 for(const role of['performer','director','editorial','production']as const)expect(()=>runtime!.brief(role)).not.toThrow();
 expect(runtime.brief('performer').contentShelf.editorial).toHaveLength(0);expect(runtime.kernel.view().editorial.legacy.segmentIntent).toBeUndefined();
});
