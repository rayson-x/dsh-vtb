import{mergeSceneInputs}from'../inputs';
import { AUDIO_POLICY_SCRIPT } from './audio-policy';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Player, type PlayerRef } from '@remotion/player';
import { HyperframesPlayer } from '@hyperframes/player';

export interface LiveScenePackage {
  instanceId: string;
  codeVersion: string;
  directionEpoch: number;
  moduleUrl: string;
  props: Record<string, unknown>;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
}
interface NativeScene {
  clock?: 'frame' | 'virtual';
  adapter?: { kind: string };
  liveHtml?: string;
  liveChannel?: string;
  Component?: React.ComponentType<any>;
  setup(root: HTMLElement, props: any): any;
}
interface Mounted {
  pkg: LiveScenePackage;
  layer: HTMLDivElement;
  phase: 'preview' | 'program' | 'held' | 'retired';
  inputsRevision: number;
  frame: number;
  origin: number;
  pausedAt: number;
  disposed: boolean;
  react?: Root;
  player?: PlayerRef;
  hf?: HyperframesPlayer;
  hfChannel?: string;
  instance?: { render(frame: number): any; patch?(props: any): any; dispose(): any };
  failure?: Error;
  pendingFrame?: number;
  rendering: boolean;
  chain: Promise<unknown>;
}
const afterPaint = () =>
  new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
export class BrowserSceneHost {
  private readonly scenes = new Map<string, Mounted>();
  private program?: string;
  private raf = 0;
  private epoch = 0;
  private startedAt = performance.now();
  constructor(
    private readonly root: HTMLElement,
    private readonly emit: (event: Record<string, unknown>) => void,
  ) {
    if (getComputedStyle(root).position === 'static') root.style.position = 'relative';
    root.style.overflow = 'hidden';
    this.raf = requestAnimationFrame(this.tick);
  }
  now() {
    return performance.now() - this.startedAt;
  }
  async setEpoch(epoch: number) {
    if (!Number.isSafeInteger(epoch) || epoch < this.epoch) throw Error('Stale direction');
    this.epoch = epoch;
    for (const row of [...this.scenes.values()])
      if (row.pkg.directionEpoch !== epoch) await this.dispose(row.pkg.instanceId);
  }
  async prepare(pkg: LiveScenePackage) {
    if (pkg.directionEpoch !== this.epoch) throw Error('Stale direction');
    if (this.scenes.has(pkg.instanceId)) throw Error('Duplicate instance');
    if ([...this.scenes.values()].filter((s) => s.phase !== 'retired').length >= 2)
      throw Error('No standby slot');
    if (
      ![pkg.fps, pkg.width, pkg.height, pkg.durationInFrames].every((n) => Number.isFinite(n) && n > 0) ||
      !Number.isInteger(pkg.durationInFrames)
    )
      throw Error('Invalid scene dimensions/duration');
    if (new URL(pkg.moduleUrl, location.href).origin !== new URL(import.meta.url).origin)
      throw Error('Unregistered scene origin');
    const layer = document.createElement('div');
    layer.style.cssText = `position:absolute;inset:0;width:${pkg.width}px;height:${pkg.height}px;opacity:0;pointer-events:none;transform-origin:top left;`;
    this.root.append(layer);
    const row: Mounted = {
      pkg,
      layer,
      phase: 'preview',
      inputsRevision: 0,
      frame: 0,
      origin: this.now(),
      pausedAt: 0,
      disposed: false,
      rendering: false,
      chain: Promise.resolve(),
    };
    this.scenes.set(pkg.instanceId, row);
    try {
      const scene = (await import(/* @vite-ignore */ pkg.moduleUrl)).default as NativeScene;
      if (row.disposed) throw Error('Scene disposed during import');
      if (scene.adapter?.kind === 'remotion') {
        if (!scene.Component) throw Error('SDK Remotion declaration has no Component');
        row.react = createRoot(layer);
        await new Promise<void>((done, reject) => {
          const timeout = setTimeout(() => reject(Error('Remotion mount timeout')), 15000);
          flushSync(() =>
            row.react!.render(
              <Player
                ref={(ref) => {
                  if (ref) {
                    row.player = ref;
                    clearTimeout(timeout);
                    done();
                  }
                }}
                component={scene.Component!}
                inputProps={pkg.props}
                durationInFrames={pkg.durationInFrames}
                compositionWidth={pkg.width}
                compositionHeight={pkg.height}
                fps={pkg.fps}
                renderLoading={() => <div data-scene-pending="true" />}
                errorFallback={({ error }) => {
                  row.failure = error;
                  return <div />;
                }}
                controls={false}
                autoPlay={false}
                loop={false}
                moveToBeginningWhenEnded={false}
                initiallyMuted
                numberOfSharedAudioTags={0}
                style={{ width: '100%', height: '100%' }}
              />,
            ),
          );
        });
      } else if (scene.adapter?.kind === 'hyperframes') {
        if (typeof scene.liveHtml !== 'string')
          throw Error('HyperFrames capture Scene requires liveHtml to run natively');
        const player = new HyperframesPlayer();
        row.hf = player;
        row.hfChannel = scene.liveChannel;
        player.setAttribute('runtime-src', '/hf-runtime.js');
        player.setAttribute('muted', '');
        player.setAttribute('assets-loading-ui', 'none');
        player.style.cssText = 'width:100%;height:100%;display:block';
        const guard=`<script>(${AUDIO_POLICY_SCRIPT})(message=>parent.postMessage({source:'aivtb-scene-audio-policy',error:message},'*'))</script>`;
        player.setAttribute('srcdoc', /<head[^>]*>/i.test(scene.liveHtml)?scene.liveHtml.replace(/<head[^>]*>/i,match=>match+guard):guard+scene.liveHtml);
        layer.append(player);
        const deadline = performance.now() + 15000;
        while (!player.ready || !player.painted) {
          if (row.disposed || performance.now() > deadline) throw Error('HyperFrames readiness timeout');
          await new Promise((done) => setTimeout(done, 20));
        }
        player.pause();
      } else {
        if (scene.clock === 'virtual' || typeof scene.setup !== 'function')
          throw Error('Unsupported real-time Scene');
        row.instance = await scene.setup(layer, pkg.props);
        if (row.disposed) {
          await row.instance?.dispose();
          throw Error('Scene disposed during setup');
        }
        await row.instance!.render(0);
      }
      await document.fonts.ready;
      const deadline = performance.now() + 15000;
      await afterPaint();
      while (layer.querySelector('[data-scene-pending]')) {
        if (performance.now() > deadline) throw Error('Remotion assets/buffering timeout');
        await afterPaint();
      }
      if (row.failure) throw row.failure;
      const media = [...layer.querySelectorAll('audio,video')] as HTMLMediaElement[];
      for (const item of media) {
        item.muted = true;
        item.pause();
      }
      const images = [...layer.querySelectorAll('img')];
      await Promise.all(images.map((img) => img.decode()));
      const geometryDeadline = performance.now() + 2000;
      for (;;) {
        this.layout(row);
        await afterPaint();
        const box = layer.getBoundingClientRect();
        if (this.root.clientWidth > 0 && this.root.clientHeight > 0 && box.width > 0 && box.height > 0) break;
        if (row.disposed || performance.now() > geometryDeadline)
          throw Error(
            `Scene viewport has no visible geometry (root ${this.root.clientWidth}x${this.root.clientHeight}, layer ${box.width}x${box.height})`,
          );
      }
      if (row.disposed || pkg.directionEpoch !== this.epoch) throw Error('Stale preparation');
      this.emit({
        type: 'prepared',
        instanceId: pkg.instanceId,
        codeVersion: pkg.codeVersion,
        epoch: this.epoch,
        showTime: this.now(),
        capabilities: { livePatch: !!row.player || !!row.hfChannel || !!row.instance?.patch },
      });
      return this.snapshotOne(row);
    } catch (error) {
      await this.dispose(pkg.instanceId);
      throw error;
    }
  }
  private require(id: string) {
    const row = this.scenes.get(id);
    if (!row || row.disposed || row.pkg.directionEpoch !== this.epoch) throw Error('Unknown or stale scene');
    return row;
  }
  async take(id: string) {
    const row = this.require(id);
    const previous = this.program ? this.scenes.get(this.program) : undefined;
    if (row.phase !== 'preview') throw Error('Scene is not standby');
    row.origin = this.now();
    row.phase = 'program';
    row.layer.style.opacity = '1';
    this.program = id;
    row.player?.play();
    row.hf?.play();
    await afterPaint();
    if (row.disposed || this.program !== id) throw Error('Take superseded');
    this.emit({
      type: 'painted',
      operation: 'take',
      instanceId: id,
      codeVersion: row.pkg.codeVersion,
      epoch: this.epoch,
      showTime: this.now(),
    });
    if (previous && previous !== row) await this.dispose(previous.pkg.instanceId);
    return this.snapshotOne(row);
  }
  async updateInputs(input: {
    instanceId: string;
    codeVersion: string;
    inputsRevision: number;
    inputs: Record<string, unknown>;
  }) {
    const row = this.require(input.instanceId);
    // Serialize patches with frame rendering; stale updates can never overtake newer state.
    const operation = row.chain.then(async () => {
      this.require(input.instanceId);
      if (
        input.codeVersion !== row.pkg.codeVersion ||
        !Number.isSafeInteger(input.inputsRevision) ||
        input.inputsRevision <= row.inputsRevision
      )
        throw Error('Stale inputs/version');
      const props = mergeSceneInputs(row.pkg.props,input.inputs);
      if (row.player && row.react) {
        const scene = (await import(row.pkg.moduleUrl)).default as NativeScene;
        flushSync(() =>
          row.react!.render(
            <Player
              ref={(ref) => {
                if (ref) row.player = ref;
              }}
              component={scene.Component!}
              inputProps={props}
              durationInFrames={row.pkg.durationInFrames}
              compositionWidth={row.pkg.width}
              compositionHeight={row.pkg.height}
              fps={row.pkg.fps}
              renderLoading={() => <div data-scene-pending="true" />}
              errorFallback={({ error }) => {
                row.failure = error;
                return <div />;
              }}
              controls={false}
              autoPlay={false}
              loop={false}
              moveToBeginningWhenEnded={false}
              initiallyMuted
              numberOfSharedAudioTags={0}
              style={{ width: '100%', height: '100%' }}
            />,
          ),
        );
      } else if (row.hf && row.hfChannel) {
        await new Promise<void>((done, reject) => {
          const player = row.hf!;
          const channel = row.hfChannel!;
          const cleanup = () => {
            clearTimeout(timer);
            player.removeEventListener('runtimedataapplied', applied);
            player.removeEventListener('runtimedataerror', failed);
          };
          const applied = (event: Event) => {
            if ((event as CustomEvent).detail?.channel === channel) {
              cleanup();
              done();
            }
          };
          const failed = (event: Event) => {
            if ((event as CustomEvent).detail?.channel === channel) {
              cleanup();
              reject(Error('HF runtime data consumer failed'));
            }
          };
          const timer = setTimeout(() => {
            cleanup();
            reject(Error('HF runtime data acknowledgement timeout'));
          }, 5000);
          player.addEventListener('runtimedataapplied', applied);
          player.addEventListener('runtimedataerror', failed);
          try {
            player.setRuntimeData(channel, props);
          } catch (error) {
            cleanup();
            reject(error);
          }
        });
      } else if (row.instance?.patch) {
        if (!(await row.instance.patch(props)))
          throw Error('UNSUPPORTED_LIVE_PATCH: standby rebuild required');
        await row.instance.render(row.frame);
      } else throw Error('UNSUPPORTED_LIVE_PATCH: standby rebuild required');
      row.pkg.props = props;
      row.inputsRevision = input.inputsRevision;
      await afterPaint();
      if (row.disposed) throw Error('Scene retired before patch paint');
      if (row.failure) throw row.failure;
      this.emit({
        type: 'painted',
        operation: 'patch',
        instanceId: input.instanceId,
        codeVersion: row.pkg.codeVersion,
        inputsRevision: row.inputsRevision,
        epoch: this.epoch,
        showTime: this.now(),
      });
      return this.snapshotOne(row);
    });
    row.chain = operation.catch(() => {});
    return operation;
  }
  hold(id: string) {
    const r = this.require(id);
    if (r.phase !== 'program') throw Error('Not program');
    r.pausedAt = this.now();
    r.phase = 'held';
    r.player?.pause();
    r.hf?.pause();
    return this.snapshotOne(r);
  }
  resume(id: string) {
    const r = this.require(id);
    if (r.phase !== 'held') throw Error('Not held');
    r.origin += this.now() - r.pausedAt;
    r.phase = 'program';
    r.player?.play();
    r.hf?.play();
    return this.snapshotOne(r);
  }
  /** Offline rendering only; normal playback never seeks per frame. */
  async renderAt(id: string, frame: number, inputs?: Record<string, unknown>) {
    const row = this.require(id);
    if (!Number.isSafeInteger(frame) || frame < 0 || frame >= row.pkg.durationInFrames)
      throw Error('Replay frame is outside scene');
    row.player?.pause();
    row.hf?.pause();
    row.phase = 'held';
    row.layer.style.opacity = '1';
    if (inputs)
      await this.updateInputs({
        instanceId: id,
        codeVersion: row.pkg.codeVersion,
        inputsRevision: row.inputsRevision + 1,
        inputs,
      });
    if (row.player) {
      row.player.seekTo(frame);
    } else if (row.instance) {
      await row.instance.render(frame);
    } else throw Error('This adapter has not been certified for offline seek');
    row.frame = frame;
    await afterPaint();
    if (row.failure) throw row.failure;
    return this.snapshotOne(row);
  }
  async dispose(id: string) {
    const r = this.scenes.get(id);
    if (!r) return;
    r.disposed = true;
    r.phase = 'retired';
    r.pendingFrame = undefined;
    r.player?.pause();
    r.hf?.pause();
    r.react?.unmount();
    await r.chain.catch(() => {});
    await r.instance?.dispose();
    r.hf?.remove();
    r.layer.remove();
    this.scenes.delete(id);
    if (this.program === id) this.program = undefined;
  }
  private layout(row: Mounted) {
    const scale = Math.min(this.root.clientWidth / row.pkg.width, this.root.clientHeight / row.pkg.height);
    row.layer.style.transform = `translate(${Math.max(0, (this.root.clientWidth - row.pkg.width * scale) / 2)}px,${Math.max(0, (this.root.clientHeight - row.pkg.height * scale) / 2)}px) scale(${scale})`;
  }
  private tick = () => {
    for (const row of this.scenes.values()) {
      this.layout(row);
      if (row.phase !== 'program' || row.disposed) continue;
      const frame = Math.min(
        row.pkg.durationInFrames - 1,
        Math.floor(((this.now() - row.origin) * row.pkg.fps) / 1000),
      );
      if (row.instance && frame !== row.frame) {
        row.pendingFrame = frame;
        void this.drainFrames(row);
      }
      if (row.player) row.frame = row.player.getCurrentFrame();
      if (row.hf) row.frame = Math.floor(row.hf.currentTime * row.pkg.fps);
    }
    this.raf = requestAnimationFrame(this.tick);
  };
  private async drainFrames(row: Mounted) {
    if (row.rendering) return;
    row.rendering = true;
    try {
      while (!row.disposed && row.pendingFrame !== undefined) {
        const frame = row.pendingFrame;
        row.pendingFrame = undefined;
        const render = row.chain.then(async () => {
          if (!row.disposed) {
            await row.instance!.render(frame);
            row.frame = frame;
          }
        });
        row.chain = render.catch(() => {});
        await render;
      }
    } catch (error) {
      this.emit({ type: 'error', instanceId: row.pkg.instanceId, epoch: this.epoch, error: String(error) });
      this.hold(row.pkg.instanceId);
    } finally {
      row.rendering = false;
    }
  }
  private snapshotOne(r: Mounted) {
    return {
      instanceId: r.pkg.instanceId,
      codeVersion: r.pkg.codeVersion,
      epoch: r.pkg.directionEpoch,
      inputsRevision: r.inputsRevision,
      supportsInPlaceInputUpdate: !!r.player || !!r.hfChannel || !!r.instance?.patch,
      phase: r.phase,
      frame: r.player?.getCurrentFrame() ?? r.frame,
    };
  }
  snapshot() {
    return {
      epoch: this.epoch,
      showTime: this.now(),
      program: this.program,
      scenes: [...this.scenes.values()].map((r) => this.snapshotOne(r)),
    };
  }
  async close() {
    cancelAnimationFrame(this.raf);
    for (const id of [...this.scenes.keys()]) await this.dispose(id);
  }
}
export const createBrowserSceneHost = (root: HTMLElement, emit: (event: Record<string, unknown>) => void) =>
  new BrowserSceneHost(root, emit);
