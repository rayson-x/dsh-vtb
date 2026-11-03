import { useEffect, type RefObject } from 'react';
import { startAudioCapture, stopAudioCapture } from '../../../scene-host/src/recording/audio';
import { audioContext } from './voice';
import { beginAudioAudit,endAudioAudit } from './audio-audit';

/** Explicit operator API: mix tap only. No microphone/screen permission or on-air UI. */
export function useProgrammeRecording(frame: RefObject<HTMLIFrameElement>, sceneUrl?: string) {
  const origin=sceneUrl?new URL(sceneUrl).origin:undefined;
  useEffect(() => {
    const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    let active = false;
    const child = (action: string) => {
      if (!origin) return Promise.resolve(undefined);
      return new Promise<unknown>((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => { pending.delete(id); reject(Error('Scene audio recorder did not respond')); }, 6000);
        pending.set(id, { resolve, reject, timer });
        frame.current?.contentWindow?.postMessage({ type: 'aivtb-recording-request', action, requestId: id }, origin);
      });
    };
    const receive = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow || event.data?.type !== 'aivtb-recording-result') return;
      const request = pending.get(event.data.requestId);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(event.data.requestId);
      if (event.data.ok) request.resolve(event.data.value);
      else request.reject(Error(event.data.error));
    };
    window.addEventListener('message', receive);
    const api = {
      async start() {
        if (active) throw Error('Programme recording is already active');
        if (Array.from(document.querySelectorAll('video,audio')).some(media => !(media as HTMLMediaElement).muted))
          throw Error('Route audible workspace media into the programme audio bus before recording');
        beginAudioAudit();
        let local;try{local=await startAudioCapture(audioContext());}catch(error){endAudioAudit();throw error;}
        try {
          const remote = await child('start');
          active = true;
          return { startedAt: performance.timeOrigin + performance.now(), local, remote, scope: 'actual-programme-output' };
        } catch (error) { endAudioAudit();await stopAudioCapture(audioContext()); throw error; }
      },
      async stop() {
        if (!active) throw Error('Programme recording is not active');
        active = false;
        const results = await Promise.allSettled([stopAudioCapture(audioContext()), child('stop')]);
        if(!endAudioAudit())throw Error('Unrouted media was requested during programme capture');
        const failed = results.find(r => r.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
        return results.flatMap(r => r.status === 'fulfilled' && r.value ? [r.value] : []);
      },
    };
    const target = window as Window & { __aivtbRecord?: typeof api };
    target.__aivtbRecord = api;
    return () => {
      window.removeEventListener('message', receive);
      if (active) { endAudioAudit();void stopAudioCapture(audioContext()).catch(() => {}); void child('stop').catch(() => {}); }
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error('Programme page disconnected')); }
      pending.clear();
      if (target.__aivtbRecord === api) delete target.__aivtbRecord;
    };
  }, [frame, origin]);
}
