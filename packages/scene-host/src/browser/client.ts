import { createBrowserSceneHost } from './isolation';
const send = (value: unknown) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
const host = createBrowserSceneHost(document.getElementById('stage')!, send);
const caption = document.getElementById('caption')!;
const status = document.getElementById('status')!;
let socket: WebSocket;
let closing=false;
let epoch = 0;
let audio: HTMLAudioElement | undefined;
let partId: string | undefined;
let audioEpoch = 0;
let mediaSeq = 0;
let speechInfo: Record<string,unknown>={};
let parentOrigin:string|undefined;
try{const ref=new URL(document.referrer);if(['127.0.0.1','localhost'].includes(ref.hostname))parentOrigin=ref.origin;}catch{}
const notifyParent=(kind:string)=>{if(parentOrigin&&parent!==window)parent.postMessage({type:'aivtb-v2-voice',kind,partId,...speechInfo,mediaTimeMs:audio?.currentTime?audio.currentTime*1000:0},parentOrigin);};
let frameSamples: number[] = [];
let lastFrame = performance.now();
const chains = new Map<string, Promise<unknown>>();
const audioReceipt = (kind: string) => {
  if (!audio || !partId) return;
  notifyParent(kind);
  send({ type: 'audio', kind, partId, epoch: audioEpoch, mediaTimeMs: audio.currentTime * 1000, audioRef: audio.src, showTime: host.now(), sequence: ++mediaSeq });
};
const stopAudio = () => {
  if (!audio) return;
  audio.pause(); audioReceipt('aborted');
  audio.removeAttribute('src'); audio.load(); audio.remove(); audio = undefined; partId = undefined; caption.textContent = '';
};
function connect() {
const connection = new WebSocket(location.origin.replace('http', 'ws') + '/ws'); socket=connection;
connection.onopen = () => { status.textContent = ''; send({ type: 'hello', showTime: host.now() }); };
connection.onclose = event => {
  if(socket!==connection)return; stopAudio();
  for(const scene of host.snapshot().scenes)if(scene.phase==='program')void host.hold(String(scene.instanceId)).catch(()=>{});
  status.textContent = event.code===1008 ? '已有舞台窗口在播放' : '暂时离线，画面停留';
  if(!closing&&event.code!==1008)setTimeout(connect,1000);
};
connection.onmessage = event => {
  let op: any;
  try { op = JSON.parse(event.data); } catch { return; }
  // Direction revocation bypasses slow prepare, invalidates it immediately.
  if (op.type === 'setEpoch' && op.epoch >= epoch) { epoch = op.epoch; if (audioEpoch !== epoch && !op.payload?.keepSpeech) stopAudio(); void host.setEpoch(epoch); }
  if (op.type === 'abortSpeech') stopAudio();
  const key = ['speech','abortSpeech'].includes(op.type) ? 'audio' : String(op.payload?.instanceId ?? op.type);
  const operation = (chains.get(key) ?? Promise.resolve()).then(async () => {
    try {
      if (!Number.isSafeInteger(op.epoch) || op.epoch !== epoch) throw Error('Stale operation epoch');
      let value: unknown;
      switch (op.type) {
        case 'setEpoch': await host.setEpoch(epoch); break;
        case 'prepare': value = await host.prepare(op.payload); break;
        case 'take': value = await host.take(op.payload.instanceId); break;
        case 'patch': value = await host.updateInputs(op.payload); break;
        case 'hold': await host.hold(op.payload.instanceId); break;
        case 'resume': await host.resume(op.payload.instanceId); break;
        case 'dispose': await host.dispose(op.payload.instanceId); break;
        case 'snapshot': value = { ...await host.inspect(), audio: audio ? { partId, currentTime: audio.currentTime, paused: audio.paused, epoch: audioEpoch } : null, frames: frameSamples }; break;
        case 'abortSpeech': break;
        case 'speech': {
          if (audio) throw Error('Voice lane occupied');
          partId = op.payload.partId; audioEpoch = epoch; speechInfo={text:op.payload.text,ms:op.payload.ms,starts:op.payload.starts};
          if(parentOrigin&&parent!==window)caption.style.display='none';
          const element = new Audio(op.payload.audioRef); audio = element; element.preload = 'auto';
          for (const kind of ['playing', 'timeupdate', 'pause', 'ended', 'error']) element.addEventListener(kind, () => {
            if (audio !== element) return;
            if(kind==='playing')caption.textContent=String(speechInfo.text??'');
            audioReceipt(kind);
            if (kind === 'ended' || kind === 'error') { audio = undefined; partId = undefined; caption.textContent = ''; element.remove(); }
          });
          try{await element.play();}
          catch(error){
            if((error as DOMException).name!=='NotAllowedError'){stopAudio();throw error;}
            status.textContent='点一下页面开声音';value={blocked:true};
            const unlock=()=>{if(audio===element&&audioEpoch===epoch)void element.play().then(()=>{status.textContent='';},()=>{});};
            window.addEventListener('pointerdown',unlock,{once:true});
          }
          break;
        }
        default: throw Error('Unsupported browser operation');
      }
      if(!(value as {blocked?:boolean}|undefined)?.blocked)status.textContent = '';
      send({ type: 'result', opId: op.opId, ok: true, epoch, value: value ?? null });
    } catch (error) { send({ type: 'result', opId: op.opId, ok: false, epoch, error: String(error) }); }
  });
  chains.set(key, operation);
  void operation.finally(() => { if (chains.get(key) === operation) chains.delete(key); });
};
}
connect();
let lastParentSample=0;
function sample(at: number) { if(audio&&!audio.paused&&at-lastParentSample>=50){notifyParent('progress');lastParentSample=at;} frameSamples.push(at - lastFrame); lastFrame = at; if (frameSamples.length > 1800) frameSamples.shift(); requestAnimationFrame(sample); }
requestAnimationFrame(sample);
setInterval(() => send({ type: 'clock', showTime: host.now(), epoch }), 250);
window.addEventListener('pagehide', () => { closing=true; stopAudio(); socket.close(); void host.close(); });
