import { describe, expect, it } from 'vitest';
import type { ProgrammeClockPort, SceneHostPort } from '../../dsh-livestream/src/live/domain/ports';
import { InMemoryProgrammeClock } from '../src/clock';
import { SceneHostScaffoldError } from '../src/errors';
import { LIFECYCLE_OPS } from '../src/status';
import { createSceneHostWiring } from '../src/wiring';
import { loadBody, markGates, patch } from './support';

describe('端口接线', () => {
  it('内存钟和接线对象满足 P1 端口', () => {
    const clock: ProgrammeClockPort = new InMemoryProgrammeClock();
    const wiring: SceneHostPort = createSceneHostWiring({ clock });
    expect(clock.now()).toBe(0);
    for (const op of LIFECYCLE_OPS) expect(typeof wiring[op]).toBe('function');
  });

  it('装 B、B 超时都不暂停 A，门闩未齐不能 take', () => {
    const clock = new InMemoryProgrammeClock();
    const wiring = createSceneHostWiring({ clock });
    wiring.load(loadBody('scene-a', 'code-a'));
    wiring.prepare('scene-a');
    markGates(wiring, 'scene-a');
    expect(wiring.tryTake('scene-a')).toEqual({ ok: true });
    clock.advance(1_000);
    expect(clock.mapScene('scene-a')).toMatchObject({ localMs: 1_000, hold: false, rate: 1 });

    const before = wiring.stage.snapshot();
    wiring.load(loadBody('scene-b', 'code-b'));
    wiring.prepare('scene-b');
    expect(clock.pauseCount).toBe(0);
    expect(clock.running).toBe(true);
    expect(clock.now()).toBe(1_000);
    expect(wiring.stage.snapshot().slots.A).toEqual(before.slots.A);
    expect(wiring.stage.snapshot().persistentGeneration).toBe(before.persistentGeneration);

    wiring.failPreview('scene-b', 'timedOut');
    expect(wiring.ready('scene-b').moduleLoad.status).toBe('pending');
    expect(wiring.tryTake('scene-b')).toEqual({ ok: false, reason: 'GATES_NOT_OK' });
    markGates(wiring, 'scene-b', 'ok', { gate: 'moduleLoad', status: 'timedOut' });
    expect(wiring.tryTake('scene-b')).toEqual({ ok: false, reason: 'GATES_NOT_OK' });
    expect(wiring.stage.snapshot().programSlot).toBe('A');
    expect(clock.pauseCount).toBe(0);

    markGates(wiring, 'scene-b');
    expect(wiring.tryTake('scene-b')).toEqual({ ok: false, reason: 'PREVIEW_FAULTED' });
    expect(wiring.stage.snapshot().slots.A.visible).toBe(true);
    expect(() => wiring.load(loadBody('scene-c'))).toThrow(SceneHostScaffoldError);
  });

  it('四门闩齐了才换到 B，旧实例要另 dispose，预览不能发声', () => {
    const clock = new InMemoryProgrammeClock();
    const wiring = createSceneHostWiring({ clock });
    wiring.load(loadBody('scene-a', 'code-a'));
    markGates(wiring, 'scene-a');
    expect(wiring.tryTake('scene-a')).toEqual({ ok: false, reason: 'ILLEGAL_TRANSITION' });
    expect(wiring.stage.snapshot().mode).toBe('neutral');

    wiring.prepare('scene-a');
    expect(wiring.tryTake('scene-a').ok).toBe(true);
    wiring.load(loadBody('scene-b', 'code-b'));
    wiring.prepare('scene-b');
    markGates(wiring, 'scene-b');
    expect(wiring.tryTake('scene-b')).toEqual({ ok: true });
    expect(wiring.host.phase('scene-a')).toBe('retired');
    expect(wiring.host.phase('scene-b')).toBe('prepared');
    expect(wiring.stage.snapshot().slots.A.role).toBe('pending-release');
    expect(wiring.host.log.some((entry) => entry.op === 'dispose')).toBe(false);

    clock.advance(400);
    expect(clock.mapScene('scene-a')).toMatchObject({ localMs: 400, hold: false });
    wiring.dispose('scene-a');
    expect(clock.mapScene('scene-a')).toMatchObject({ localMs: 0, hold: false });
    const disposed = wiring.host.log.find((entry) => entry.op === 'dispose');
    expect(disposed).toMatchObject({ proof: 'not-measured' });
    expect(wiring.stage.snapshot()).toMatchObject({
      programSlot: 'B',
      mode: 'program',
      persistentGeneration: 1,
      persistentLayers: ['caption', 'character', 'base'],
    });
    expect(wiring.rejectPreviewAudio().code).toBe('PREVIEW_AUDIO_FORBIDDEN');
    expect(wiring.stage.snapshot().audio.previewEmitsAudio).toBe(false);
    expect(wiring.stage.snapshot().audio.sceneIframeEmitsAudio).toBe(false);
  });

  it('协议层保留每次输入，漂移记录不拨钟，过时帧被丢掉', () => {
    const clock = new InMemoryProgrammeClock();
    const wiring = createSceneHostWiring({ clock });
    wiring.load(loadBody('scene-a', 'code-a'));
    wiring.prepare('scene-a');
    const unsupported = wiring.updateInputs(patch('scene-a', 'code-a', 1));
    expect(unsupported.status).toBe('unsupported');
    wiring.noteProtocolCapability('scene-a', true);
    wiring.updateInputs(patch('scene-a', 'code-a', 2));
    expect(wiring.host.inputHistory('scene-a').map((item) => item.requestedRevision)).toEqual([1, 2]);
    expect(wiring.host.memoryGeneration('scene-a')).toBe(1);
    expect(wiring.host.ops('scene-a').filter((op) => op === 'load')).toEqual(['load']);

    const before = clock.now();
    const sample = wiring.observeDrift({
      sceneInstanceId: 'scene-a',
      programmeShowTime: before,
      adapterReportedTime: 4,
      tolerance: 'pending-p2',
    });
    expect(clock.now()).toBe(before);
    expect(sample.tolerance).toBe('pending-p2');
    expect(clock.drift).toEqual([sample]);
    expect(wiring.rejectVoiceDriftCompensation().code).toBe('VOICE_DRIFT_COMPENSATION_FORBIDDEN');
    expect(clock.mapScene('scene-a').rate).toBe(1);

    wiring.submitFrame(1);
    wiring.submitFrame(2);
    wiring.submitFrame(3);
    expect(wiring.frames.dropped).toBe(2);
    expect(wiring.frames.poll()).toMatchObject({ showTime: 3 });
    expect(clock.now()).toBe(before);
    expect(wiring.measure.readiness('scene-a').firstFramePaint.status).toBe('pending');
  });

  it('退出唯一在播后回到中性，常驻层还在', () => {
    const wiring = createSceneHostWiring();
    wiring.load(loadBody('scene-a'));
    wiring.prepare('scene-a');
    markGates(wiring, 'scene-a');
    wiring.take('scene-a');
    wiring.retire('scene-a');
    expect(wiring.stage.snapshot()).toMatchObject({
      mode: 'neutral',
      programSlot: null,
      persistentLayers: ['caption', 'character', 'base'],
      persistentGeneration: 1,
    });
    expect(wiring.stage.snapshot().audio.owner).toBe('none');
  });
});
