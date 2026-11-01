import { describe, expect, it } from 'vitest';
import { READINESS_GATES, SDK_READY_SIGNALS } from '../../dsh-livestream/src/live/domain/codes';
import { DRIFT_PROTOCOL, STANDBY_READINESS_PROTOCOL } from '../../dsh-livestream/src/live/domain/policy';
import { MeasurementHarness, driftSampleFromReport } from '../src/measure';

describe('测量 harness', () => {
  it('缺测保持 pending，超时不会被收成成功', () => {
    const harness = new MeasurementHarness();
    expect(harness.snapshot.protocol).toBe(STANDBY_READINESS_PROTOCOL);
    expect(harness.snapshot.driftProtocol).toBe(DRIFT_PROTOCOL);
    expect(harness.snapshot.protocol.label).toBe('待 P2 冻结');
    const initial = harness.readiness('scene-a');
    for (const gate of READINESS_GATES) {
      expect(initial[gate]).toEqual({ status: 'pending', contract: 'pending-p2' });
    }
    expect(harness.gatesAllOk('scene-a')).toBe(false);

    harness.recordGate({ sceneInstanceId: 'scene-a', gate: 'schemaAssets', status: 'timedOut', detail: '调用方报告超时' });
    expect(harness.readiness('scene-a').schemaAssets.status).toBe('timedOut');
    expect(harness.gatesAllOk('scene-a')).toBe(false);
    expect(harness.gateLog('scene-a')).toHaveLength(1);
    expect(Object.keys(harness.readiness('scene-a').schemaAssets)).not.toContain('timeoutMs');
  });

  it('SDK 信号、Promise 返回和绘制消息都不写成首帧', () => {
    const harness = new MeasurementHarness();
    for (const signal of SDK_READY_SIGNALS) {
      harness.recordSdkSignal({ sceneInstanceId: 'scene-a', signal, atShowTime: 3 });
    }
    harness.recordPromiseResolved('scene-a');
    harness.recordPaintClaim({ instanceId: 'scene-a', kind: 'painted', showTime: 4 });
    const readiness = harness.readiness('scene-a');
    expect(readiness.firstFramePaint.status).toBe('pending');
    expect(harness.promiseResolved('scene-a')).toBe(true);
    expect(harness.gatesAllOk('scene-a')).toBe(false);
    expect(Object.keys(harness.sdkSignals('scene-a')).sort()).toEqual([...SDK_READY_SIGNALS].sort());
    expect(harness.paintClaims('scene-a')[0]?.source).toBe('message');
  });

  it('漂移只留样本，容限固定为 pending-p2', () => {
    const harness = new MeasurementHarness();
    const stored = harness.recordDrift({
      sceneInstanceId: 'scene-a',
      programmeShowTime: 20,
      adapterReportedTime: 27,
      tolerance: 8 as unknown as 'pending-p2',
    });
    expect(stored).toEqual(driftSampleFromReport({
      sceneInstanceId: 'scene-a',
      programmeShowTime: 20,
      adapterReportedTime: 27,
    }));
    expect(harness.driftSamples()).toEqual([stored]);
    expect(Object.keys(stored).sort()).toEqual([
      'adapterReportedTime',
      'programmeShowTime',
      'sceneInstanceId',
      'tolerance',
    ]);
  });
});
