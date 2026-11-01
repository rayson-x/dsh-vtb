/**
 * A/B Program、Preview 与常驻层。计划 §6.4。
 * 只转移槽位状态。没有 iframe，不发声，也不测量首帧。
 */

import { SceneHostScaffoldError } from './errors';

export type SlotId = 'A' | 'B';

export const PERSISTENT_LAYERS = Object.freeze(['caption', 'character', 'base'] as const);

export type SlotRole = 'empty' | 'preview' | 'program' | 'pending-release';

export interface SlotState {
  id: SlotId;
  role: SlotRole;
  instanceId: string | null;
  codeVersion: string | null;
  visible: boolean;
  fault: 'failed' | 'timedOut' | null;
}

export interface AudioOwnership {
  owner: 'none' | 'audio-bus';
  programInstanceId: string | null;
  /** 备场不能发声。本状态机没有把这项打开的路径。 */
  previewEmitsAudio: false;
  /** 没有真实 iframe 音频图。这项保持关闭，不是“已证明无重复发声”。 */
  sceneIframeEmitsAudio: false;
}

export interface StageSnapshot {
  slots: { A: SlotState; B: SlotState };
  programSlot: SlotId | null;
  mode: 'neutral' | 'program';
  persistentLayers: readonly ['caption', 'character', 'base'];
  persistentGeneration: 1;
  audio: AudioOwnership;
}

export type SurfaceReason =
  | 'SLOT_NOT_STANDBY'
  | 'SLOT_OCCUPIED'
  | 'PREVIEW_NOT_LOADED'
  | 'PREVIEW_FAULTED'
  | 'GATES_NOT_OK'
  | 'NOT_RELEASABLE';

export type SurfaceResult =
  | { ok: true; snapshot: StageSnapshot; previousInstanceId: string | null }
  | { ok: false; reason: SurfaceReason; snapshot: StageSnapshot };

function emptySlot(id: SlotId): SlotState {
  return { id, role: 'empty', instanceId: null, codeVersion: null, visible: false, fault: null };
}

function silentAudio(): AudioOwnership {
  return { owner: 'none', programInstanceId: null, previewEmitsAudio: false, sceneIframeEmitsAudio: false };
}

export class SurfaceStage {
  private slots: { A: SlotState; B: SlotState } = { A: emptySlot('A'), B: emptySlot('B') };
  private programSlot: SlotId | null = null;
  private mode: 'neutral' | 'program' = 'neutral';
  private audio: AudioOwnership = silentAudio();
  /** 没有递增路径。候选加载不能换掉常驻层。 */
  private readonly persistentGeneration = 1 as const;

  snapshot(): StageSnapshot {
    return {
      slots: { A: { ...this.slots.A }, B: { ...this.slots.B } },
      programSlot: this.programSlot,
      mode: this.mode,
      persistentLayers: PERSISTENT_LAYERS,
      persistentGeneration: this.persistentGeneration,
      audio: { ...this.audio },
    };
  }

  findSlot(instanceId: string): SlotId | null {
    if (this.slots.A.instanceId === instanceId) return 'A';
    if (this.slots.B.instanceId === instanceId) return 'B';
    return null;
  }

  loadPreview(slotId: SlotId, instance: { instanceId: string; codeVersion: string }): SurfaceResult {
    const slot = this.slots[slotId];
    if (slot.role === 'program' || slot.role === 'pending-release') return this.refuse('SLOT_NOT_STANDBY');
    if (slot.role === 'preview') return this.refuse('SLOT_OCCUPIED');
    slot.role = 'preview';
    slot.instanceId = instance.instanceId;
    slot.codeVersion = instance.codeVersion;
    slot.visible = false;
    slot.fault = null;
    this.audio = { ...this.audio, previewEmitsAudio: false, sceneIframeEmitsAudio: false };
    return this.accept(null);
  }

  failPreview(slotId: SlotId, fault: 'failed' | 'timedOut'): SurfaceResult {
    const slot = this.slots[slotId];
    if (slot.role !== 'preview') return this.refuse('PREVIEW_NOT_LOADED');
    slot.fault = fault;
    slot.visible = false;
    return this.accept(null);
  }

  take(slotId: SlotId, gatesOk: boolean): SurfaceResult {
    if (!gatesOk) return this.refuse('GATES_NOT_OK');
    const slot = this.slots[slotId];
    if (slot.role !== 'preview' || !slot.instanceId) return this.refuse('PREVIEW_NOT_LOADED');
    if (slot.fault) return this.refuse('PREVIEW_FAULTED');
    const previousInstanceId = this.programSlot ? this.slots[this.programSlot].instanceId : null;
    if (this.programSlot) {
      const current = this.slots[this.programSlot];
      current.role = 'pending-release';
      current.visible = false;
    }
    slot.role = 'program';
    slot.visible = true;
    slot.fault = null;
    this.programSlot = slotId;
    this.mode = 'program';
    this.audio = {
      owner: 'audio-bus',
      programInstanceId: slot.instanceId,
      previewEmitsAudio: false,
      sceneIframeEmitsAudio: false,
    };
    return this.accept(previousInstanceId);
  }

  /** 在播或备场退出可见/候选身份，实例 id 仍留着，等 dispose 清槽。 */
  markPendingRelease(instanceId: string): SurfaceResult {
    const slotId = this.findSlot(instanceId);
    if (!slotId) return this.refuse('NOT_RELEASABLE');
    const slot = this.slots[slotId];
    if (slot.role !== 'program' && slot.role !== 'preview') return this.refuse('NOT_RELEASABLE');
    const wasProgram = slot.role === 'program';
    slot.role = 'pending-release';
    slot.visible = false;
    if (wasProgram) {
      this.programSlot = null;
      this.mode = 'neutral';
      this.audio = silentAudio();
    }
    return this.accept(null);
  }

  clearSlot(instanceId: string): SurfaceResult {
    const slotId = this.findSlot(instanceId);
    if (!slotId) return this.refuse('NOT_RELEASABLE');
    const slot = this.slots[slotId];
    if (slot.role !== 'pending-release') return this.refuse('NOT_RELEASABLE');
    this.slots[slotId] = emptySlot(slotId);
    return this.accept(null);
  }

  private accept(previousInstanceId: string | null): SurfaceResult {
    return { ok: true, snapshot: this.snapshot(), previousInstanceId };
  }

  private refuse(reason: SurfaceReason): SurfaceResult {
    return { ok: false, reason, snapshot: this.snapshot() };
  }
}

export function assertPersistentStable(before: StageSnapshot, after: StageSnapshot): void {
  if (before.persistentGeneration !== 1 || after.persistentGeneration !== 1) {
    throw new SceneHostScaffoldError('PERSISTENT_RESET', '常驻层代数被改写');
  }
  if (before.persistentLayers.join(',') !== after.persistentLayers.join(',')) {
    throw new SceneHostScaffoldError('PERSISTENT_RESET', '常驻层被候选加载改写');
  }
}
