/** A tap on the actual programme mix; never records a microphone or replays audio. */
export interface CapturedAudio { startedAt: number; endedAt: number; mimeType: string; base64: string; sampleRate: number }
interface Tap { output: GainNode; capture?: { destination: MediaStreamAudioDestinationNode; recorder: MediaRecorder; chunks: Blob[]; startedAt: number } }
const taps = new WeakMap<AudioContext, Tap>();
export async function resumeProgrammeAudio(context: Pick<AudioContext,'state'|'resume'>, timeoutMs=250) {
 const running=()=>context.state==='running';
 if(running())return;
 await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new DOMException('Enable programme audio','NotAllowedError')),timeoutMs);
  context.resume().then(()=>{clearTimeout(timer);resolve();},error=>{clearTimeout(timer);reject(error);});
 });
 if(!running())throw new DOMException('Enable programme audio','NotAllowedError');
}
export function programmeOutput(context: AudioContext): GainNode {
  let tap = taps.get(context);
  if (!tap) {
    const output = context.createGain();
    output.connect(context.destination);
    tap = { output };
    taps.set(context, tap);
  }
  return tap.output;
}
export async function startAudioCapture(context: AudioContext) {
  programmeOutput(context);
  const tap = taps.get(context)!;
  if (tap.capture) throw Error('Programme audio is already recording');
  await resumeProgrammeAudio(context,4000);
  if (context.state !== 'running') throw Error('Programme audio is not running');
  const destination = context.createMediaStreamDestination();
  const mimeType = 'audio/webm;codecs=opus';
  if (!MediaRecorder.isTypeSupported(mimeType)) throw Error('Programme recording requires WebM/Opus support');
  const recorder = new MediaRecorder(destination.stream, { mimeType });
  const capture = { destination, recorder, chunks: [] as Blob[], startedAt: 0 };
  recorder.addEventListener('dataavailable', event => { if (event.data.size) capture.chunks.push(event.data); });
  tap.output.connect(destination);
  tap.capture = capture;
  await new Promise<void>((resolve, reject) => {
    recorder.addEventListener('start', () => { capture.startedAt = performance.timeOrigin + performance.now(); resolve(); }, { once: true });
    recorder.addEventListener('error', () => reject(Error('Audio recorder failed to start')), { once: true });
    recorder.start(250);
  });
  return { startedAt: capture.startedAt, mimeType };
}
export async function stopAudioCapture(context: AudioContext): Promise<CapturedAudio> {
  const tap = taps.get(context), capture = tap?.capture;
  if (!tap || !capture) throw Error('Programme audio is not recording');
  const endedAt = performance.timeOrigin + performance.now();
  try {
    await new Promise<void>((resolve, reject) => {
      capture.recorder.addEventListener('stop', () => resolve(), { once: true });
      capture.recorder.addEventListener('error', () => reject(Error('Audio recording failed')), { once: true });
      capture.recorder.stop();
    });
    const bytes = new Uint8Array(await new Blob(capture.chunks, { type: capture.recorder.mimeType }).arrayBuffer());
    let base64 = '';
    for (let i = 0; i < bytes.length; i += 16384) base64 += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return { startedAt: capture.startedAt, endedAt, mimeType: capture.recorder.mimeType, base64: btoa(base64), sampleRate: context.sampleRate };
  } finally {
    tap.output.disconnect(capture.destination);
    capture.destination.stream.getTracks().forEach(track => track.stop());
    tap.capture = undefined;
  }
}
