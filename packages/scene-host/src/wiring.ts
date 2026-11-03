/**
 * 把节目钟、录制宿主、A/B 槽位和测量记录接在一起。计划 §6.2、§6.4、§7.1。
 * 备场不调用 pause。take 在四门闩都是 ok 之前不改在播。
 * 这里没有真实播放器。
 */

import type { CueBinding } from '../../dsh-livestream/src/live/domain/entities';
import type {
  DriftSample,
  LivePatchRequest,
  LivePatchResult,
  ProgrammeClockPort,
  SceneHostPort,
} from '../../dsh-livestream/src/live/domain/ports';
import { InMemoryProgrammeClock } from './clock';
import { SceneHostScaffoldError } from './errors';
import { LatestFrameMailbox } from './frame-mailbox';
import { RecordingSceneHost } from './lifecycle';
import { MeasurementHarness, type GateSample } from './measure';
import { SurfaceStage, type SlotId, type SurfaceReason } from './surfaces';

type LoadInstance = Parameters<SceneHostPort['load']>[0];

export interface TakeDecision {
  ok: boolean;
  reason?: SurfaceReason | 'UNKNOWN_INSTANCE' | 'ILLEGAL_TRANSITION' | 'GATES_NOT_OK';
}

interface ClockFacts {
  now: number;
  pauseCount: number | null;
  running: boolean | null;
}

export class SceneHostWiring implements SceneHostPort {
  readonly clock: ProgrammeClockPort;
  readonly measure: MeasurementHarness;
  readonly host: RecordingSceneHost;
  readonly stage = new SurfaceStage();
  readonly frames = new LatestFrameMailbox();

  constructor(options?: { clock?: ProgrammeClockPort; measure?: MeasurementHarness }) {
    this.measure = options?.measure ?? new MeasurementHarness();
    this.clock = options?.clock ?? new InMemoryProgrammeClock();
    this.host = new RecordingSceneHost(this.measure, this.clock);
  }

  load(instance: LoadInstance): void {
    if (this.host.phase(instance.instanceId)) {
      throw new SceneHostScaffoldError('ILLEGAL_TRANSITION', '同一 instanceId 不能再次 load');
    }
    const slot = this.pickStandby();
    const before = this.clockFacts();
    const placed = this.stage.loadPreview(slot, { instanceId: instance.instanceId, codeVersion: instance.codeVersion });
    if (!placed.ok) throw new SceneHostScaffoldError(placed.reason, '备场槽拒绝装载');
    this.host.load(instance);
    this.callClock('register', instance.instanceId);
    this.assertClockUntouched(before);
  }

  prepare(instanceId: string): void {
    const before = this.clockFacts();
    this.host.prepare(instanceId);
    this.assertClockUntouched(before);
  }

  ready(instanceId: string) {
    return this.host.ready(instanceId);
  }

  /** 门闩不足或备场有故障时不改槽位。成功时旧在播进入待释放，仍要 dispose。 */
  tryTake(instanceId: string): TakeDecision {
    const slot = this.stage.findSlot(instanceId);
    if (!slot || !this.host.phase(instanceId)) return { ok: false, reason: 'UNKNOWN_INSTANCE' };
    if (!this.measure.gatesAllOk(instanceId)) return { ok: false, reason: 'GATES_NOT_OK' };
    const preview = this.stage.snapshot().slots[slot];
    if (preview.fault) return { ok: false, reason: 'PREVIEW_FAULTED' };
    if (preview.role !== 'preview') return { ok: false, reason: 'PREVIEW_NOT_LOADED' };
    if (!this.host.canTake(instanceId)) return { ok: false, reason: 'ILLEGAL_TRANSITION' };
    const previousId = this.stage.snapshot().programSlot
      ? this.stage.snapshot().slots[this.stage.snapshot().programSlot!].instanceId
      : null;
    if (previousId && !this.host.canRetire(previousId)) return { ok: false, reason: 'ILLEGAL_TRANSITION' };
    this.host.take(instanceId);
    const moved = this.stage.take(slot, true);
    if (!moved.ok) throw new SceneHostScaffoldError(moved.reason, '槽位在预检之后拒绝 take');
    if (previousId) this.host.retire(previousId);
    return { ok: true };
  }

  take(instanceId: string): void {
    const decision = this.tryTake(instanceId);
    if (!decision.ok) {
      throw new SceneHostScaffoldError(decision.reason ?? 'GATES_NOT_OK', 'take 被拒绝，在播未改');
    }
  }

  updateInputs(request: LivePatchRequest): LivePatchResult {
    return this.host.updateInputs(request);
  }

  noteProtocolCapability(instanceId: string, supportsInPlaceInputUpdate: boolean): void {
    this.host.noteProtocolCapability(instanceId, supportsInPlaceInputUpdate);
  }

  cue(cue: CueBinding): void {
    this.host.cue(cue);
  }

  hold(instanceId: string): void {
    this.host.hold(instanceId);
  }

  resume(instanceId: string): void {
    this.host.resume(instanceId);
  }

  retire(instanceId: string): void {
    const slot = this.stage.findSlot(instanceId);
    const role = slot ? this.stage.snapshot().slots[slot].role : null;
    if (role !== 'program' && role !== 'preview') {
      throw new SceneHostScaffoldError('NOT_RELEASABLE', '槽位不能退出');
    }
    this.host.retire(instanceId);
    const moved = this.stage.markPendingRelease(instanceId);
    if (!moved.ok) throw new SceneHostScaffoldError(moved.reason, '槽位不能退出');
  }

  dispose(instanceId: string): void {
    const slot = this.stage.findSlot(instanceId);
    const role = slot ? this.stage.snapshot().slots[slot].role : null;
    if (role !== 'pending-release') {
      throw new SceneHostScaffoldError('NOT_RELEASABLE', '槽位尚未退出，不能清掉');
    }
    this.host.dispose(instanceId);
    const cleared = this.stage.clearSlot(instanceId);
    if (!cleared.ok) throw new SceneHostScaffoldError(cleared.reason, '槽位尚未退出，不能清掉');
    this.callClock('drop', instanceId);
  }

  recordGate(sample: GateSample): void {
    this.measure.recordGate(sample);
  }

  /** 故障记在槽位上，不自动写成某一扇门闩的成功或超时。 */
  failPreview(instanceId: string, fault: 'failed' | 'timedOut'): void {
    const slot = this.stage.findSlot(instanceId);
    if (!slot) throw new SceneHostScaffoldError('UNKNOWN_INSTANCE', '没有这块备场');
    const before = this.clockFacts();
    const failed = this.stage.failPreview(slot, fault);
    if (!failed.ok) throw new SceneHostScaffoldError(failed.reason, '不能把非备场标成失败');
    this.assertClockUntouched(before);
  }

  observeDrift(sample: DriftSample): DriftSample {
    const before = this.clock.now();
    const stored = this.measure.recordDrift(sample);
    this.clock.observeDrift(stored);
    if (this.clock.now() !== before) {
      throw new SceneHostScaffoldError('CLOCK_MOVED', '记录漂移时节目钟被改写');
    }
    return stored;
  }

  submitFrame(showTime: number): void {
    const before = this.clock.now();
    this.frames.submit(showTime);
    if (this.clock.now() !== before) {
      throw new SceneHostScaffoldError('CLOCK_MOVED', '帧背压改写了节目钟');
    }
  }

  rejectPreviewAudio(): { ok: false; code: 'PREVIEW_AUDIO_FORBIDDEN' } {
    return { ok: false, code: 'PREVIEW_AUDIO_FORBIDDEN' };
  }

  rejectVoiceDriftCompensation(): { ok: false; code: 'VOICE_DRIFT_COMPENSATION_FORBIDDEN' } {
    return { ok: false, code: 'VOICE_DRIFT_COMPENSATION_FORBIDDEN' };
  }

  private pickStandby(): SlotId {
    const snap = this.stage.snapshot();
    const order: SlotId[] = snap.programSlot === 'A' ? ['B'] : snap.programSlot === 'B' ? ['A'] : ['A', 'B'];
    const found = order.find((slot) => snap.slots[slot].role === 'empty');
    if (!found) throw new SceneHostScaffoldError('SLOT_FULL', '没有空的备场槽');
    return found;
  }

  private callClock(method: 'register' | 'drop', instanceId: string): void {
    const clock = this.clock as ProgrammeClockPort & Partial<Record<'register' | 'drop', (id: string) => void>>;
    const fn = clock[method];
    if (typeof fn === 'function') fn.call(clock, instanceId);
  }

  private clockFacts(): ClockFacts {
    const clock = this.clock as ProgrammeClockPort & { pauseCount?: number; running?: boolean };
    return {
      now: clock.now(),
      pauseCount: typeof clock.pauseCount === 'number' ? clock.pauseCount : null,
      running: typeof clock.running === 'boolean' ? clock.running : null,
    };
  }

  private assertClockUntouched(before: ClockFacts): void {
    const after = this.clockFacts();
    if (after.now !== before.now || after.pauseCount !== before.pauseCount || after.running !== before.running) {
      throw new SceneHostScaffoldError('CLOCK_PAUSED', '备场不能暂停或拨动节目钟');
    }
  }
}

export function createSceneHostWiring(options?: { clock?: ProgrammeClockPort; measure?: MeasurementHarness }): SceneHostWiring {
  return new SceneHostWiring(options);
}
