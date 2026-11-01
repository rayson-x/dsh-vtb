/**
 * SceneHostPort 的内存录制实现。计划 §6.2。
 * 记录调用和输入历史。applied 只表示协议受理，不是绘制回执，也不是 iframe 保实例。
 */

import type { CueBinding } from '../../dsh-livestream/src/live/domain/entities';
import type { LivePatchRequest, LivePatchResult, ProgrammeClockPort, SceneHostPort } from '../../dsh-livestream/src/live/domain/ports';
import { SceneHostScaffoldError } from './errors';
import type { MeasurementHarness } from './measure';
import { DISPOSE_PROOF, DISPOSE_RESOURCE_NAMES, type LifecycleOp } from './status';

export type MemoryPhase = 'loaded' | 'prepared' | 'holding' | 'retired' | 'disposed';

export interface PatchRecord {
  instanceId: string;
  status: LivePatchResult['status'];
  codeVersion: string;
  inputsRevision: number;
  requestedRevision: number;
  memoryGeneration: number;
  paintReceipt: null;
  acceptance: 'protocol-only';
}

export interface CueRecord {
  cueId: string;
  instanceId: string;
  duplicateDispatch: boolean;
  executed: false;
}

export interface DisposeRecord {
  instanceId: string;
  resources: typeof DISPOSE_RESOURCE_NAMES;
  proof: typeof DISPOSE_PROOF;
}

interface MemoryInstance {
  instanceId: string;
  assetVersionId: string;
  codeVersion: string;
  directionEpoch: number;
  phase: MemoryPhase;
  memoryGeneration: number;
  inputsRevision: number;
  inputs: Record<string, unknown>;
  takeCount: number;
  supportsInPlaceInputUpdate: boolean;
  inputHistory: PatchRecord[];
}

export type HostLogEntry =
  | { op: 'load'; instanceId: string; memoryGeneration: number }
  | { op: 'prepare'; instanceId: string }
  | { op: 'ready'; instanceId: string }
  | { op: 'take'; instanceId: string }
  | ({ op: 'updateInputs' } & PatchRecord)
  | ({ op: 'cue' } & CueRecord)
  | { op: 'hold'; instanceId: string }
  | { op: 'resume'; instanceId: string }
  | { op: 'retire'; instanceId: string }
  | ({ op: 'dispose' } & DisposeRecord);

export class RecordingSceneHost implements SceneHostPort {
  private instances = new Map<string, MemoryInstance>();
  private seenCues = new Set<string>();
  readonly log: HostLogEntry[] = [];

  constructor(
    private readonly measure: MeasurementHarness,
    private readonly clock: ProgrammeClockPort,
  ) {}

  load(instance: Pick<MemoryInstance, 'instanceId' | 'assetVersionId' | 'codeVersion' | 'directionEpoch'>): void {
    if (this.instances.has(instance.instanceId)) {
      throw new SceneHostScaffoldError('ILLEGAL_TRANSITION', '同一 instanceId 不能再次 load');
    }
    const row: MemoryInstance = {
      instanceId: instance.instanceId,
      assetVersionId: instance.assetVersionId,
      codeVersion: instance.codeVersion,
      directionEpoch: instance.directionEpoch,
      phase: 'loaded',
      memoryGeneration: 1,
      inputsRevision: 0,
      inputs: {},
      takeCount: 0,
      supportsInPlaceInputUpdate: false,
      inputHistory: [],
    };
    this.instances.set(instance.instanceId, row);
    this.log.push({ op: 'load', instanceId: instance.instanceId, memoryGeneration: row.memoryGeneration });
  }

  /**
   * 协议测试开关。未调用时，updateInputs 返回 unsupported。
   * 这不是 SDK 能力认证。
   */
  noteProtocolCapability(instanceId: string, supportsInPlaceInputUpdate: boolean): void {
    this.require(instanceId).supportsInPlaceInputUpdate = supportsInPlaceInputUpdate;
  }

  prepare(instanceId: string): void {
    const row = this.require(instanceId);
    this.assertPhase(row, ['loaded'], 'prepare');
    row.phase = 'prepared';
    this.log.push({ op: 'prepare', instanceId });
  }

  ready(instanceId: string): ReturnType<SceneHostPort['ready']> {
    const row = this.require(instanceId);
    if (row.phase === 'disposed') {
      throw new SceneHostScaffoldError('ILLEGAL_TRANSITION', 'dispose 之后不能 ready');
    }
    this.log.push({ op: 'ready', instanceId });
    return this.measure.readiness(instanceId);
  }

  canTake(instanceId: string): boolean {
    const row = this.instances.get(instanceId);
    return !!row && (row.phase === 'prepared' || row.phase === 'holding');
  }

  canRetire(instanceId: string): boolean {
    const row = this.instances.get(instanceId);
    return !!row && (row.phase === 'loaded' || row.phase === 'prepared' || row.phase === 'holding');
  }

  take(instanceId: string): void {
    const row = this.require(instanceId);
    this.assertPhase(row, ['prepared', 'holding'], 'take');
    row.takeCount += 1;
    this.log.push({ op: 'take', instanceId });
  }

  updateInputs(request: LivePatchRequest): LivePatchResult {
    const row = this.require(request.instanceId);
    this.assertPhase(row, ['loaded', 'prepared', 'holding'], 'updateInputs');
    const generation = row.memoryGeneration;
    if (request.codeVersion !== row.codeVersion) {
      return this.finishPatch(row, request, 'rejected', generation);
    }
    if (!row.supportsInPlaceInputUpdate) {
      return this.finishPatch(row, request, 'unsupported', generation);
    }
    row.inputsRevision = request.inputsRevision;
    row.inputs = structuredClone(request.inputs);
    return this.finishPatch(row, request, 'applied', generation);
  }

  cue(cue: CueBinding): void {
    const instanceId = cue.sceneInstanceId ?? '';
    if (instanceId) {
      const row = this.require(instanceId);
      this.assertPhase(row, ['loaded', 'prepared', 'holding'], 'cue');
    }
    const duplicateDispatch = this.seenCues.has(cue.cueId);
    this.seenCues.add(cue.cueId);
    this.log.push({ op: 'cue', cueId: cue.cueId, instanceId, duplicateDispatch, executed: false });
  }

  hold(instanceId: string): void {
    const row = this.require(instanceId);
    this.assertPhase(row, ['prepared'], 'hold');
    this.clock.holdScene(instanceId);
    row.phase = 'holding';
    this.log.push({ op: 'hold', instanceId });
  }

  resume(instanceId: string): void {
    const row = this.require(instanceId);
    this.assertPhase(row, ['holding'], 'resume');
    this.clock.resumeScene(instanceId);
    row.phase = 'prepared';
    this.log.push({ op: 'resume', instanceId });
  }

  retire(instanceId: string): void {
    const row = this.require(instanceId);
    this.assertPhase(row, ['loaded', 'prepared', 'holding'], 'retire');
    row.phase = 'retired';
    this.log.push({ op: 'retire', instanceId });
  }

  dispose(instanceId: string): void {
    const row = this.require(instanceId);
    this.assertPhase(row, ['retired'], 'dispose');
    row.phase = 'disposed';
    this.log.push({
      op: 'dispose',
      instanceId,
      resources: DISPOSE_RESOURCE_NAMES,
      proof: DISPOSE_PROOF,
    });
  }

  phase(instanceId: string): MemoryPhase | null {
    return this.instances.get(instanceId)?.phase ?? null;
  }

  memoryGeneration(instanceId: string): number | null {
    return this.instances.get(instanceId)?.memoryGeneration ?? null;
  }

  inputsRevision(instanceId: string): number | null {
    return this.instances.get(instanceId)?.inputsRevision ?? null;
  }

  inputHistory(instanceId: string): PatchRecord[] {
    return structuredClone(this.instances.get(instanceId)?.inputHistory ?? []);
  }

  takeCount(instanceId: string): number {
    return this.instances.get(instanceId)?.takeCount ?? 0;
  }

  ops(instanceId: string): LifecycleOp[] {
    return this.log.filter((entry) => 'instanceId' in entry && entry.instanceId === instanceId).map((entry) => entry.op);
  }

  private finishPatch(
    row: MemoryInstance,
    request: LivePatchRequest,
    status: LivePatchResult['status'],
    memoryGeneration: number,
  ): LivePatchResult {
    const record: PatchRecord = {
      instanceId: row.instanceId,
      status,
      codeVersion: row.codeVersion,
      inputsRevision: row.inputsRevision,
      requestedRevision: request.inputsRevision,
      memoryGeneration,
      paintReceipt: null,
      acceptance: 'protocol-only',
    };
    row.inputHistory.push(record);
    this.log.push({ op: 'updateInputs', ...record });
    return {
      status,
      instanceId: row.instanceId,
      codeVersion: row.codeVersion,
      inputsRevision: row.inputsRevision,
    };
  }

  private require(instanceId: string): MemoryInstance {
    const row = this.instances.get(instanceId);
    if (!row) throw new SceneHostScaffoldError('UNKNOWN_INSTANCE', `未知场景 ${instanceId}`);
    return row;
  }

  private assertPhase(row: MemoryInstance, allowed: readonly MemoryPhase[], op: LifecycleOp): void {
    if (!allowed.includes(row.phase)) {
      throw new SceneHostScaffoldError('ILLEGAL_TRANSITION', `${op} 不能从 ${row.phase} 发生`);
    }
  }
}
