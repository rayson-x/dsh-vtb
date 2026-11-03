/**
 * 备场四门闩与漂移的测量记录。计划 §6.4、§7.1。
 * 只保存调用方交来的样本。不设超时毫秒，不设漂移容限，不把缺测写成成功。
 */

import { READINESS_GATES, type ReadinessGate, type SdkReadySignal } from '../../dsh-livestream/src/live/domain/codes';
import type { DriftSample } from '../../dsh-livestream/src/live/domain/ports';
import type { ReadinessObservation, SdkReadinessSignals, StandbyReadiness } from '../../dsh-livestream/src/live/domain/entities';
import { DRIFT_PROTOCOL, FRAME_BASELINE, STANDBY_READINESS_PROTOCOL } from '../../dsh-livestream/src/live/domain/policy';

export interface GateSample {
  sceneInstanceId: string;
  gate: ReadinessGate;
  status: ReadinessObservation['status'];
  observedAtShowTime?: number;
  detail?: string;
}

export interface SdkSignalSample {
  sceneInstanceId: string;
  signal: SdkReadySignal;
  atShowTime: number;
}

/** 绘制回执单独存放。它不会改写 firstFramePaint。 */
export interface PaintClaim {
  instanceId: string;
  kind: 'painted' | 'failed';
  showTime: number;
  source: 'message';
}

export interface MeasurementSnapshot {
  protocol: typeof STANDBY_READINESS_PROTOCOL;
  driftProtocol: typeof DRIFT_PROTOCOL;
  frameBaseline: typeof FRAME_BASELINE;
}

interface InstanceMeasure {
  gates: StandbyReadiness;
  gateLog: GateSample[];
  sdkSignals: SdkReadinessSignals;
  promiseResolved: boolean;
  paintClaims: PaintClaim[];
}

function pendingObservation(): ReadinessObservation {
  return { status: 'pending', contract: 'pending-p2' };
}

/** 线上的漂移报告没有容限字段。记录时才标上 pending-p2。 */
export function driftSampleFromReport(report: {
  sceneInstanceId: string;
  programmeShowTime: number;
  adapterReportedTime: number;
}): DriftSample {
  return {
    sceneInstanceId: report.sceneInstanceId,
    programmeShowTime: report.programmeShowTime,
    adapterReportedTime: report.adapterReportedTime,
    tolerance: 'pending-p2',
  };
}

function emptyReadiness(): StandbyReadiness {
  return {
    moduleLoad: pendingObservation(),
    schemaAssets: pendingObservation(),
    firstFramePaint: pendingObservation(),
    businessVersionMatch: pendingObservation(),
  };
}

export class MeasurementHarness {
  private instances = new Map<string, InstanceMeasure>();
  private drift: DriftSample[] = [];

  /** 协议标签。没有数值阈值。 */
  readonly snapshot: MeasurementSnapshot = {
    protocol: STANDBY_READINESS_PROTOCOL,
    driftProtocol: DRIFT_PROTOCOL,
    frameBaseline: FRAME_BASELINE,
  };

  recordGate(sample: GateSample): void {
    const row = this.ensure(sample.sceneInstanceId);
    const observation: ReadinessObservation = {
      status: sample.status,
      contract: 'pending-p2',
      ...(sample.observedAtShowTime !== undefined ? { observedAtShowTime: sample.observedAtShowTime } : {}),
      ...(sample.detail !== undefined ? { detail: sample.detail } : {}),
    };
    row.gates[sample.gate] = observation;
    row.gateLog.push({ ...sample });
  }

  recordSdkSignal(sample: SdkSignalSample): void {
    const row = this.ensure(sample.sceneInstanceId);
    row.sdkSignals[sample.signal] = { atShowTime: sample.atShowTime };
  }

  /** Promise 返回只记标志。不把它写成首帧可见。 */
  recordPromiseResolved(sceneInstanceId: string): void {
    this.ensure(sceneInstanceId).promiseResolved = true;
  }

  recordPaintClaim(claim: Omit<PaintClaim, 'source'>): void {
    this.ensure(claim.instanceId).paintClaims.push({ ...claim, source: 'message' });
  }

  /**
   * 留下漂移样本。不 seek，不改节目钟，不改人声速率。
   * 传入的 tolerance 会被写成 pending-p2，调用方给的数字不会被保存。
   */
  recordDrift(sample: DriftSample): DriftSample {
    const stored = driftSampleFromReport(sample);
    this.drift.push(stored);
    return stored;
  }

  readiness(sceneInstanceId: string): StandbyReadiness {
    const row = this.instances.get(sceneInstanceId);
    return structuredClone(row?.gates ?? emptyReadiness());
  }

  gatesAllOk(sceneInstanceId: string): boolean {
    const readiness = this.readiness(sceneInstanceId);
    return READINESS_GATES.every((gate) => readiness[gate].status === 'ok');
  }

  sdkSignals(sceneInstanceId: string): SdkReadinessSignals {
    return structuredClone(this.instances.get(sceneInstanceId)?.sdkSignals ?? {});
  }

  promiseResolved(sceneInstanceId: string): boolean {
    return this.instances.get(sceneInstanceId)?.promiseResolved ?? false;
  }

  paintClaims(sceneInstanceId: string): PaintClaim[] {
    return structuredClone(this.instances.get(sceneInstanceId)?.paintClaims ?? []);
  }

  gateLog(sceneInstanceId: string): GateSample[] {
    return structuredClone(this.instances.get(sceneInstanceId)?.gateLog ?? []);
  }

  driftSamples(): DriftSample[] {
    return structuredClone(this.drift);
  }

  private ensure(sceneInstanceId: string): InstanceMeasure {
    let row = this.instances.get(sceneInstanceId);
    if (!row) {
      row = { gates: emptyReadiness(), gateLog: [], sdkSignals: {}, promiseResolved: false, paintClaims: [] };
      this.instances.set(sceneInstanceId, row);
    }
    return row;
  }
}
