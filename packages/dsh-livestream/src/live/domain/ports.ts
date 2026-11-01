/**
 * ProgrammeClock 与 SceneHost 端口。计划 §6.2、§6.4、§7.1。
 * 这是项目端口，将来由真实 SDK 方法适配。
 * 不表示 Remotion / HyperFrames 已经有同名全栈 API，本模块也不提供那些 adapter。
 */

import type { CueBinding, SceneInstance, StandbyReadiness } from './entities';

export interface DriftSample {
  sceneInstanceId: string;
  programmeShowTime: number;
  adapterReportedTime: number;
  /** 待 P2 冻结。P1 拒绝把数值容限写进端口。 */
  tolerance: 'pending-p2';
}

export interface SceneLocalTime {
  sceneInstanceId: string;
  showTime: number;
  localMs: number;
  rate: number;
  hold: boolean;
}

export interface ProgrammeClockPort {
  /** 实际演出时间（毫秒）。 */
  now(): number;
  play(): void;
  pause(): void;
  resume(): void;
  holdScene(sceneInstanceId: string): void;
  resumeScene(sceneInstanceId: string): void;
  mapScene(sceneInstanceId: string, showTime?: number): SceneLocalTime;
  /**
   * 只留下漂移样本。不 seek，不改节目时钟，不改人声速率。
   * 容限待 P2 冻结。
   */
  observeDrift(sample: DriftSample): void;
}

export interface LivePatchRequest {
  instanceId: string;
  codeVersion: string;
  inputsRevision: number;
  appliedAtShowTime: number;
  inputs: Record<string, unknown>;
}

export interface LivePatchResult {
  status: 'applied' | 'unsupported' | 'rejected';
  /** 受理或拒绝都不是绘制回执。绘制要另记 PlaybackEvent painted。 */
  instanceId: string;
  codeVersion: string;
  inputsRevision: number;
}

export interface SceneHostPort {
  /** 统一生命周期。计划 §6.2。load 与 prepare 在此端口分成两步，对外仍是同一套生命周期。 */
  load(instance: Pick<SceneInstance, 'instanceId' | 'assetVersionId' | 'codeVersion' | 'directionEpoch'>): void;
  prepare(instanceId: string): void;
  /** 读取四项测量。不把缺测的门闩填成成功。 */
  ready(instanceId: string): StandbyReadiness;
  take(instanceId: string): void;
  updateInputs(request: LivePatchRequest): LivePatchResult;
  cue(cue: CueBinding): void;
  hold(instanceId: string): void;
  resume(instanceId: string): void;
  retire(instanceId: string): void;
  dispose(instanceId: string): void;
}
