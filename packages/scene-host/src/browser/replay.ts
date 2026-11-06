/** Project adapter at the native Film HTML-program extension point. No live socket or AudioBus. */
import{resolveSceneInputs}from'../inputs';
import { IsolatedSceneHost } from './isolation';
interface ReplayScene {
  startFrame: number;
  endFrameExclusive: number;
  id: string;
  moduleUrl: string;
  codeVersion: string;
  props: Record<string, unknown>;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  patches?: { atFrame: number; inputs: Record<string, unknown>;snapshot?:boolean }[];
  inputPatchSemantics?:'deep-merge'|'shallow-merge';
  frameMap?: { from: number; until: number; localFrom: number; rate: number }[];
  deterministicSeek: boolean;
}
const pending = new Set<Promise<unknown>>();
let compositionFrame = 0;
function watch(promise: Promise<unknown>) {
  pending.add(promise);
  void promise.finally(() => pending.delete(promise)).catch(() => {});
  return promise;
}
(globalThis as any).__aivtbReplay = {
  mount(root: HTMLElement, data: ReplayScene) {
    if (data.deterministicSeek !== true) throw Error('Scene has no deterministic replay certification');
    const host = new IsolatedSceneHost(root, () => {});
    let prepared = false,
      lastInputs = '',
      lastFrame = -1,
      chain = Promise.resolve();
    const render = async (frame: number) => {
      const props=resolveSceneInputs(data.props,(data.patches??[]).filter(p=>p.atFrame<=frame),data.inputPatchSemantics??'shallow-merge');
      const signature = JSON.stringify(props);
      // Rebuild when input history changes or seeking backwards: stateful patches must not leak across seeks.
      if (!prepared || signature !== lastInputs || frame < lastFrame) {
        await host.dispose(data.id);
        await host.prepare({ ...data, instanceId: data.id, directionEpoch: 0, props });
        prepared = true;
        lastInputs = signature;
      }
      const interval = data.frameMap?.find((m) => frame >= m.from && frame < m.until);
      const local = interval
        ? Math.floor(interval.localFrom + (frame - interval.from) * interval.rate)
        : frame;
      lastFrame = frame;
      await host.renderAt(data.id, Math.max(0, Math.min(data.durationInFrames - 1, local)));
    };
    return (frame: number) => {
      const active = compositionFrame >= data.startFrame && compositionFrame < data.endFrameExclusive;
      const next = chain.then(async () => {
        if (!active) {
          if (prepared) {
            await host.dispose(data.id);
            prepared = false;
          }
          return;
        }
        await render(frame);
      });
      chain = next.catch(() => {});
      watch(next);
    };
  },
};
window.addEventListener('composition-frame', (event: Event) => {
  const detail = (event as CustomEvent).detail;
  if (Number.isSafeInteger(detail?.frame)) compositionFrame = detail.frame;
  if (typeof detail?.waitUntil === 'function')
    detail.waitUntil(Promise.resolve().then(() => Promise.all([...pending])));
});
