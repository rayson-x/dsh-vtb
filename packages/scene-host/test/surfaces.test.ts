import { describe, expect, it } from 'vitest';
import { PERSISTENT_LAYERS, SurfaceStage, assertPersistentStable } from '../src/surfaces';

describe('A/B 与常驻层', () => {
  it('B 的失败和未就绪 take 都不换掉 A，常驻层不动', () => {
    const stage = new SurfaceStage();
    const placedA = stage.loadPreview('A', { instanceId: 'scene-a', codeVersion: 'code-a' });
    expect(placedA.ok).toBe(true);
    const denied = stage.take('A', false);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.reason).toBe('GATES_NOT_OK');
    expect(stage.snapshot().mode).toBe('neutral');
    expect(stage.snapshot().slots.A.role).toBe('preview');

    expect(stage.take('A', true).ok).toBe(true);
    const onAir = stage.snapshot();
    expect(onAir.programSlot).toBe('A');
    expect(onAir.slots.A.visible).toBe(true);
    expect(onAir.audio).toMatchObject({
      owner: 'audio-bus',
      programInstanceId: 'scene-a',
      previewEmitsAudio: false,
      sceneIframeEmitsAudio: false,
    });

    expect(stage.loadPreview('B', { instanceId: 'scene-b', codeVersion: 'code-b' }).ok).toBe(true);
    const failed = stage.failPreview('B', 'timedOut');
    expect(failed.ok).toBe(true);
    const afterFault = stage.snapshot();
    assertPersistentStable(onAir, afterFault);
    expect(afterFault.programSlot).toBe('A');
    expect(afterFault.slots.A).toMatchObject({ instanceId: 'scene-a', visible: true, role: 'program' });
    expect(afterFault.slots.B).toMatchObject({ instanceId: 'scene-b', visible: false, fault: 'timedOut', role: 'preview' });
    expect(afterFault.audio.previewEmitsAudio).toBe(false);

    const refused = stage.take('B', true);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe('PREVIEW_FAULTED');
    expect(stage.snapshot().programSlot).toBe('A');
    expect(stage.loadPreview('A', { instanceId: 'scene-c', codeVersion: 'code-c' }).ok).toBe(false);
  });

  it('take 成功后旧槽待释放，清槽不改常驻层代数', () => {
    const stage = new SurfaceStage();
    stage.loadPreview('A', { instanceId: 'scene-a', codeVersion: 'code-a' });
    stage.take('A', true);
    stage.loadPreview('B', { instanceId: 'scene-b', codeVersion: 'code-b' });
    const taken = stage.take('B', true);
    expect(taken.ok).toBe(true);
    if (taken.ok) expect(taken.previousInstanceId).toBe('scene-a');
    const mid = stage.snapshot();
    expect(mid.slots.A.role).toBe('pending-release');
    expect(mid.slots.A.instanceId).toBe('scene-a');
    expect(mid.slots.B).toMatchObject({ role: 'program', visible: true, instanceId: 'scene-b' });
    expect(mid.persistentGeneration).toBe(1);
    expect([...mid.persistentLayers]).toEqual([...PERSISTENT_LAYERS]);

    expect(stage.clearSlot('scene-b').ok).toBe(false);
    expect(stage.clearSlot('scene-a').ok).toBe(true);
    const done = stage.snapshot();
    expect(done.slots.A.role).toBe('empty');
    expect(done.programSlot).toBe('B');
    expect(done.persistentGeneration).toBe(1);
    const copy = stage.snapshot();
    copy.slots.B.role = 'empty';
    expect(stage.snapshot().slots.B.role).toBe('program');
  });
});
