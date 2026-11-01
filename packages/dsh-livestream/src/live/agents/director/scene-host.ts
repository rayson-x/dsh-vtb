/**
 * SceneHost 录制夹具。计划 §6.2、§10。
 * P2 运行验收未过，这里不接 Player，也不接 iframe。
 * 命令可以记成 accepted 或 blocked。paintReceipt / playing 固定为 null。
 * 没有另外的真实回执时，不能把它们写成已绘制或已发声。
 */

import type { CueBinding, SceneInstance, StandbyReadiness } from '../../domain/entities';
import type { LivePatchRequest, LivePatchResult, SceneHostPort } from '../../domain/ports';
import { pendingReadiness } from '../../timeline/programme';

export type HostOp =
  | 'load'
  | 'prepare'
  | 'ready'
  | 'take'
  | 'updateInputs'
  | 'cue'
  | 'hold'
  | 'resume'
  | 'retire'
  | 'dispose';

export interface RecordedHostCall {
  op: HostOp;
  instanceId: string;
  disposition: 'accepted' | 'blocked';
  /** 受理不是绘制。本夹具不制造 painted 回执。 */
  paintReceipt: null;
  /** 受理不是发声。本夹具不制造 playing。 */
  playing: null;
}

export class BlockedSceneHost implements SceneHostPort {
  readonly calls: RecordedHostCall[] = [];

  load(instance: Pick<SceneInstance, 'instanceId' | 'assetVersionId' | 'codeVersion' | 'directionEpoch'>): void {
    this.record('load', instance.instanceId, 'accepted');
  }

  prepare(instanceId: string): void {
    this.record('prepare', instanceId, 'accepted');
  }

  /** 不把缺测的门闩填成成功。 */
  ready(instanceId: string): StandbyReadiness {
    this.record('ready', instanceId, 'blocked');
    return pendingReadiness();
  }

  take(instanceId: string): void {
    this.record('take', instanceId, 'accepted');
  }

  updateInputs(request: LivePatchRequest): LivePatchResult {
    this.record('updateInputs', request.instanceId, 'blocked');
    return {
      status: 'unsupported',
      instanceId: request.instanceId,
      codeVersion: request.codeVersion,
      inputsRevision: request.inputsRevision,
    };
  }

  cue(cue: CueBinding): void {
    this.record('cue', cue.cueId, 'accepted');
  }

  hold(instanceId: string): void {
    this.record('hold', instanceId, 'blocked');
  }

  resume(instanceId: string): void {
    this.record('resume', instanceId, 'blocked');
  }

  retire(instanceId: string): void {
    this.record('retire', instanceId, 'blocked');
  }

  dispose(instanceId: string): void {
    this.record('dispose', instanceId, 'blocked');
  }

  paintedCount(): 0 {
    return 0;
  }

  private record(op: HostOp, instanceId: string, disposition: RecordedHostCall['disposition']): void {
    this.calls.push(Object.freeze({
      op,
      instanceId,
      disposition,
      paintReceipt: null,
      playing: null,
    }));
  }
}
