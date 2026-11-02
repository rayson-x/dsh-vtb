import { BrowserProgrammeTime } from './programme-time';
import type { LiveScenePackage } from './host';
type Slot = {
  pkg: LiveScenePackage;
  frame: HTMLIFrameElement;
  nonce: string;
  port: MessagePort;
  send: (message: unknown) => void;
  phase: 'preview' | 'program' | 'held';
  state: Record<string, any>;
  pending: Map<
    string,
    { resolve(v: any): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }
  >;
  loaded: Promise<void>;
  cancelLoad(): void;
};
const paint = () =>
  new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
/** Generated code never shares a realm/origin with the playback transport or control console. */
export class IsolatedSceneHost {
  private readonly slots = new Map<string, Slot>();
  private epoch = 0;
  private program?: string;
  private readonly clock = new BrowserProgrammeTime();
  constructor(
    private readonly root: HTMLElement,
    private readonly emit: (event: Record<string, unknown>) => void,
  ) {}
  now() {
    return this.clock.now();
  }
  synchronize(showTime: number) {
    this.clock.synchronize(showTime);
  }
  private require(id: string) {
    const slot = this.slots.get(id);
    if (!slot || slot.pkg.directionEpoch !== this.epoch) throw Error('Unknown/stale scene');
    return slot;
  }
  private async call(slot: Slot, type: string, payload: unknown = {}) {
    await slot.loaded;
    if (!this.slots.has(slot.pkg.instanceId)) throw Error('Scene retired');
    const opId = crypto.randomUUID();
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        slot.pending.delete(opId);
        reject(Error(`Scene ${type} timeout`));
      }, 20000);
      slot.pending.set(opId, { resolve, reject, timer });
      slot.send({ opId, type, epoch: this.epoch, payload });
    });
  }
  async setEpoch(epoch: number) {
    if (!Number.isSafeInteger(epoch) || epoch < this.epoch) throw Error('Stale epoch');
    this.epoch = epoch;
    for (const [id, slot] of this.slots) if (slot.pkg.directionEpoch !== epoch) await this.dispose(id);
  }
  async prepare(pkg: LiveScenePackage) {
    if (pkg.directionEpoch !== this.epoch || this.slots.has(pkg.instanceId))
      throw Error('Stale/duplicate scene');
    if (this.slots.size >= 2) throw Error('Standby full');
    const frame = document.createElement('iframe');
    frame.sandbox.add('allow-scripts');
    frame.title = '节目画面';
    frame.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;border:0;opacity:0;pointer-events:none';
    const nonce = crypto.randomUUID();
    let resolveLoad!: () => void, rejectLoad!: (e: Error) => void;
    const loaded = new Promise<void>((resolve, reject) => {
      resolveLoad = resolve;
      rejectLoad = reject;
    });
    const timer = setTimeout(() => rejectLoad(Error('Scene document timeout')), 15000);
    const channel = new MessageChannel(),
      send = channel.port1.postMessage.bind(channel.port1);
    frame.onload = () => {
      frame.contentWindow!.postMessage({ source: 'live-scene-connect', nonce }, '*', [channel.port2]);
    };
    frame.onerror = () => {
      clearTimeout(timer);
      rejectLoad(Error('Scene document load failed'));
    };
    const slot: Slot = {
      pkg,
      frame,
      nonce,
      port: channel.port1,
      send,
      phase: 'preview',
      state: {},
      pending: new Map(),
      loaded,
      cancelLoad: () => {
        clearTimeout(timer);
        rejectLoad(Error('Scene retired'));
      },
    };
    this.slots.set(pkg.instanceId, slot);
    channel.port1.onmessage = (event) => {
      const data = event.data;
      if (data?.type === 'connected') {
        clearTimeout(timer);
        resolveLoad();
        return;
      }
      if (data?.type === 'result') {
        const pending = slot.pending.get(data.opId);
        if (!pending) return;
        slot.pending.delete(data.opId);
        clearTimeout(pending.timer);
        if (data.ok === false) pending.reject(Error(String(data.error)));
        else {
          if (data.value && typeof data.value === 'object') slot.state = data.value;
          pending.resolve(data.value);
        }
      } else if (data?.type === 'error')
        this.emit({
          type: 'error',
          instanceId: pkg.instanceId,
          epoch: pkg.directionEpoch,
          error: String(data.error),
        });
    };
    channel.port1.start();
    frame.src = '/scene.html#' + nonce;
    this.root.append(frame);
    try {
      return await this.call(slot, 'prepare', pkg);
    } catch (error) {
      await this.dispose(pkg.instanceId);
      throw error;
    }
  }
  async take(id: string) {
    const slot = this.require(id);
    if (slot.phase !== 'preview') throw Error('Not standby');
    const previous = this.program,
      old = previous ? this.slots.get(previous) : undefined;
    const firstFrame = slot.state.frame ?? 0;
    slot.frame.style.opacity = '1';
    if (old) old.frame.style.opacity = '0';
    slot.phase = 'program';
    this.program = id;
    try {
      await paint();
      if (this.program !== id) throw Error('Take superseded');
      const visibleAt = this.now();
      // A prepared paused first frame becomes visible before its clock is allowed to advance.
      const result = await this.call(slot, 'take', { instanceId: id });
      this.require(id);
      if (this.program !== id) throw Error('Take superseded');
      this.emit({
        type: 'painted',
        operation: 'take',
        frame: firstFrame,
        instanceId: id,
        codeVersion: slot.pkg.codeVersion,
        epoch: this.epoch,
        showTime: visibleAt,
      });
      if (previous && previous !== id) await this.dispose(previous);
      return { ...result, firstVisibleFrame: firstFrame, observedAtShowTime: visibleAt };
    } catch (error) {
      if (this.slots.has(id)) {
        slot.frame.style.opacity = '0';
        slot.phase = 'preview';
      }
      if (this.program === id) {
        this.program = previous;
        if (old && this.slots.has(old.pkg.instanceId)) old.frame.style.opacity = '1';
      }
      throw error;
    }
  }
  async updateInputs(input: any) {
    const slot = this.require(input.instanceId);
    const result = await this.call(slot, 'patch', input);
    this.emit({
      type: 'painted',
      operation: 'patch',
      instanceId: input.instanceId,
      codeVersion: slot.pkg.codeVersion,
      epoch: this.epoch,
      inputsRevision: result.inputsRevision,
      showTime: this.now(),
    });
    return { ...result, observedAtShowTime: this.now() };
  }
  async renderAt(id: string, frame: number, inputs?: Record<string, unknown>) {
    const slot = this.require(id);
    const value = await this.call(slot, 'renderAt', { instanceId: id, frame, inputs });
    slot.frame.style.opacity = '1';
    slot.phase = 'held';
    this.program = id;
    await paint();
    return value;
  }
  async hold(id: string) {
    const s = this.require(id);
    const value = await this.call(s, 'hold', { instanceId: id });
    s.phase = 'held';
    return { ...value, observedAtShowTime: this.now() };
  }
  async resume(id: string) {
    const s = this.require(id);
    const value = await this.call(s, 'resume', { instanceId: id });
    s.phase = 'program';
    return { ...value, observedAtShowTime: this.now() };
  }
  async dispose(id: string) {
    const s = this.slots.get(id);
    if (!s) return;
    this.slots.delete(id);
    s.cancelLoad();
    for (const p of s.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error('Scene retired'));
    }
    s.pending.clear();
    s.port.close();
    s.frame.remove();
    if (this.program === id) this.program = undefined;
  }
  async inspect() {
    for (const slot of this.slots.values()) await this.call(slot, 'inspect');
    return this.snapshot();
  }
  snapshot() {
    return {
      epoch: this.epoch,
      showTime: this.now(),
      program: this.program,
      scenes: [...this.slots.values()].map((s) => ({
        ...s.state,
        instanceId: s.pkg.instanceId,
        codeVersion: s.pkg.codeVersion,
        phase: s.phase,
      })),
    };
  }
  async close() {
    for (const id of [...this.slots.keys()]) await this.dispose(id);
  }
}
export const createBrowserSceneHost = (root: HTMLElement, emit: (event: Record<string, unknown>) => void) =>
  new IsolatedSceneHost(root, emit);
