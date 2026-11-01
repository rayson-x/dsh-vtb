import { describe, expect, it } from 'vitest';
import { MeasurementHarness } from '../src/measure';
import { InMemoryProgrammeClock } from '../src/clock';
import { RecordingSceneHost } from '../src/lifecycle';
import { SceneHostScaffoldError } from '../src/errors';
import { DISPOSE_PROOF, DISPOSE_RESOURCE_NAMES, P2_ACCEPTANCE } from '../src/status';
import { cue, loadBody, patch } from './support';

function host() {
  const measure = new MeasurementHarness();
  const clock = new InMemoryProgrammeClock();
  return { measure, clock, host: new RecordingSceneHost(measure, clock) };
}

describe('生命周期录制', () => {
  it('未准备不能 take，ready 不把缺测填成成功', () => {
    const { host: scene, measure } = host();
    expect(() => scene.prepare('scene-a')).toThrow(SceneHostScaffoldError);
    scene.load(loadBody('scene-a'));
    expect(scene.ready('scene-a').firstFramePaint.status).toBe('pending');
    expect(measure.gatesAllOk('scene-a')).toBe(false);
    expect(() => scene.take('scene-a')).toThrow(/ILLEGAL_TRANSITION/);
    expect(scene.takeCount('scene-a')).toBe(0);
  });

  it('100 次协议记录不是 live patch：applied 不带绘制回执，代数不变', () => {
    const { host: scene, measure } = host();
    scene.load(loadBody('scene-a', 'code-7'));
    scene.prepare('scene-a');
    const blocked = scene.updateInputs(patch('scene-a', 'code-7', 1));
    expect(blocked.status).toBe('unsupported');
    expect(scene.inputsRevision('scene-a')).toBe(0);
    expect(scene.memoryGeneration('scene-a')).toBe(1);

    scene.noteProtocolCapability('scene-a', true);
    for (let revision = 1; revision <= 100; revision += 1) {
      const result = scene.updateInputs(patch('scene-a', 'code-7', revision));
      expect(result.status).toBe('applied');
    }
    const history = scene.inputHistory('scene-a');
    expect(history).toHaveLength(101);
    expect(history.at(-1)).toMatchObject({
      status: 'applied',
      inputsRevision: 100,
      memoryGeneration: 1,
      paintReceipt: null,
      acceptance: 'protocol-only',
    });
    expect(history.map((item) => item.requestedRevision)).toEqual([1, ...Array.from({ length: 100 }, (_, i) => i + 1)]);
    expect(scene.ops('scene-a').filter((op) => op === 'load')).toEqual(['load']);
    expect(measure.readiness('scene-a').firstFramePaint.status).toBe('pending');
    expect(P2_ACCEPTANCE.passed).toBe(false);

    const mismatch = scene.updateInputs(patch('scene-a', 'code-8', 101));
    expect(mismatch).toMatchObject({ status: 'rejected', codeVersion: 'code-7', inputsRevision: 100 });
    expect(scene.memoryGeneration('scene-a')).toBe(1);
  });

  it('cue 只记录派发，hold 不暂停节目钟，dispose 不声称资源已测', () => {
    const { host: scene, clock } = host();
    clock.register('scene-a');
    scene.load(loadBody('scene-a'));
    scene.prepare('scene-a');
    clock.advance(1_000);
    scene.hold('scene-a');
    clock.advance(1_000);
    expect(clock.now()).toBe(2_000);
    expect(clock.pauseCount).toBe(0);
    expect(clock.running).toBe(true);
    expect(clock.mapScene('scene-a')).toMatchObject({ localMs: 1_000, hold: true, rate: 1 });
    scene.resume('scene-a');
    scene.cue(cue('cue-1', 'scene-a'));
    scene.cue(cue('cue-1', 'scene-a'));
    const cues = scene.log.filter((entry) => entry.op === 'cue');
    expect(cues.map((entry) => entry.op === 'cue' && entry.executed)).toEqual([false, false]);
    expect(cues[1]).toMatchObject({ duplicateDispatch: true, executed: false });

    expect(() => scene.dispose('scene-a')).toThrow(/ILLEGAL_TRANSITION/);
    scene.retire('scene-a');
    scene.dispose('scene-a');
    const disposed = scene.log.find((entry) => entry.op === 'dispose');
    expect(disposed).toMatchObject({ resources: DISPOSE_RESOURCE_NAMES, proof: DISPOSE_PROOF });
    expect('seek' in clock).toBe(false);
    expect('setRate' in clock).toBe(false);
  });
});
