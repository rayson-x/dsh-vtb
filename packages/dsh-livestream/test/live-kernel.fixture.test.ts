/**
 * P3 领域内核夹具。没有 Agent，也没有播放器。
 * 门闩写成 ok 只是夹具声明的观察，不是实测超时，也不是首帧。
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { READINESS_GATES, type RejectCode } from '../src/live/domain/codes';
import {
  FIXTURE_ACTORS,
  FIXTURE_IDS,
  type AssetVersion,
  type CommandEnvelope,
  type CommandResult,
  type CommandTarget,
  type ShowCommand,
} from '../src/live/domain/index';
import {
  EngineeringKernel,
  ManualProgrammeClock,
  MemoryEventLog,
  resolveCue,
  type EventDraft,
  type EventLogPort,
  type ExecutionEffects,
} from '../src/live/index';

const A = FIXTURE_ACTORS;
let seq = 0;

class TracingLog implements EventLogPort {
  historyPageCalls = 0;
  constructor(private readonly inner: MemoryEventLog) {}
  peekNext(): number { return this.inner.peekNext(); }
  has(eventId: string): boolean { return this.inner.has(eventId); }
  get(eventId: string) { return this.inner.get(eventId); }
  append(draft: EventDraft) { return this.inner.append(draft); }
  active() { return this.inner.active(); }
  historyPage(afterSequence: number, limit: number) {
    this.historyPageCalls += 1;
    return this.inner.historyPage(afterSequence, limit);
  }
  archiveThrough(sequence: number): number { return this.inner.archiveThrough(sequence); }
  markCommitted(record: Parameters<EventLogPort['markCommitted']>[0]): void { this.inner.markCommitted(record); }
  committed() { return this.inner.committed(); }
  snapshot() { return this.inner.snapshot(); }
}

function countingEffects(): ExecutionEffects & { cues: string[]; speech: string[]; takes: string[] } {
  const cues: string[] = [];
  const speech: string[] = [];
  const takes: string[] = [];
  return {
    cues,
    speech,
    takes,
    onCueCommitted(cue) { cues.push(cue.cueId); },
    onSpeechCommitted(part) { speech.push(part.partId); },
    onTakeCommitted(scene) { takes.push(scene.instanceId); },
  };
}

function setup() {
  const clock = new ManualProgrammeClock();
  const inner = new MemoryEventLog();
  const log = new TracingLog(inner);
  const fx = countingEffects();
  const kernel = new EngineeringKernel({ log, clock, effects: fx });
  return { kernel, clock, log, inner, fx };
}

function env(
  kernel: EngineeringKernel,
  actorId: string,
  target: CommandTarget,
  payload: ShowCommand,
  epoch?: number,
): CommandEnvelope {
  seq += 1;
  const id = `${payload.type}-${seq}`;
  return {
    commandId: id,
    idempotencyKey: id,
    actorId,
    directionEpoch: epoch ?? kernel.epoch(),
    expectedRevision: kernel.revision(target),
    target,
    payload,
  };
}

function must(result: CommandResult): Extract<CommandResult, { ok: true }> {
  if (!result.ok) throw new Error(`${result.reject}: ${result.message}`);
  return result;
}

function refused(result: CommandResult, code: RejectCode): void {
  if (result.ok) throw new Error(`应当拒绝 ${code}`);
  expect(result.reject).toBe(code);
}

function asset(id: string, patch: Partial<Omit<AssetVersion, 'revision'>> = {}): Omit<AssetVersion, 'revision'> {
  return {
    id,
    hash: `hash-${id}`,
    codeVersion: `code-${id}`,
    dependencyVersions: {},
    schemaVersion: '1',
    verification: 'unverified',
    provenance: 'p3-fixture',
    ...patch,
    capabilities: {
      supportsInPlaceInputUpdate: false,
      requiresStandbyRebuild: true,
      deterministicReplay: false,
      holdLoop: true,
      audioOwnership: 'none',
      realtime: 'unverified',
      ...patch.capabilities,
    },
  };
}

function showTarget(): CommandTarget {
  return { kind: 'show', id: FIXTURE_IDS.show };
}

function directionTarget(kernel: EngineeringKernel): CommandTarget {
  return { kind: 'direction', id: kernel.view().project.currentDirectionId };
}

function speechTarget(partId: string): CommandTarget {
  return { kind: 'speechPart', id: partId };
}

function publishTask(kernel: EngineeringKernel, taskId: string, assetId: string): void {
  const target: CommandTarget = { kind: 'productionTask', id: taskId };
  must(kernel.submit(env(kernel, A.editorial, target, {
    type: 'requestProduction',
    task: { id: taskId, goal: taskId, priority: 1, inputs: [], dependsOn: [] },
  })));
  must(kernel.submit(env(kernel, A.production, target, {
    type: 'publishCandidate',
    taskId,
    asset: asset(assetId),
  })));
}

function markReady(kernel: EngineeringKernel, instanceId: string): void {
  const target: CommandTarget = { kind: 'sceneInstance', id: instanceId };
  for (const gate of READINESS_GATES) {
    must(kernel.submit(env(kernel, A.runtime, target, {
      type: 'noteReadiness',
      instanceId,
      gate,
      observation: { status: 'ok', observedAtShowTime: kernel.clock.now() },
    })));
  }
}

function prepareScene(kernel: EngineeringKernel, instanceId: string, assetVersionId: string, segmentId: string): void {
  must(kernel.submit(env(kernel, A.director, { kind: 'sceneInstance', id: instanceId }, {
    type: 'prepareScene',
    instanceId,
    assetVersionId,
    segmentId,
    label: segmentId,
  })));
}

function switchDirection(kernel: EngineeringKernel, strategy: 'soft' | 'hard'): void {
  const kind = strategy === 'hard' ? 'master-hard' : 'master-soft';
  const authId = `auth-${strategy}-${kernel.epoch()}-${seq}`;
  must(kernel.submit(env(kernel, A.master, directionTarget(kernel), {
    type: 'issueSwitchAuthorization',
    authorizationId: authId,
    kind,
    reason: strategy,
  })));
  must(kernel.submit(env(kernel, A.director, directionTarget(kernel), {
    type: 'switchDirection',
    authorizationId: authId,
    strategy,
    next: { transition: true },
  })));
}

function offerTo(
  kernel: EngineeringKernel,
  partId: string,
  text: string,
  to: 'queued' | 'starting' | 'playing' | 'ended',
  spokenChars = [...text].length,
): void {
  const target = speechTarget(partId);
  must(kernel.submit(env(kernel, A.performer, target, { type: 'offerSpeech', partId, text })));
  must(kernel.submit(env(kernel, A.runtime, target, { type: 'acceptSpeech', partId })));
  must(kernel.submit(env(kernel, A.runtime, target, { type: 'queueSpeech', partId })));
  if (to === 'queued') return;
  must(kernel.submit(env(kernel, A.runtime, target, { type: 'startSpeech', partId })));
  if (to === 'starting') return;
  must(kernel.submit(env(kernel, A.runtime, target, {
    type: 'receiptSpeech',
    partId,
    kind: 'playing',
    spokenChars,
    alignment: 'estimated',
  })));
  if (to === 'playing') return;
  must(kernel.submit(env(kernel, A.runtime, target, {
    type: 'receiptSpeech',
    partId,
    kind: 'ended',
    spokenChars,
    alignment: 'estimated',
  })));
}

describe('事件库', () => {
  it('按种类记下 eventId、sequence、directionEpoch 和 correlation，并可换日志实现', () => {
    const { kernel, inner, log } = setup();
    expect(log).not.toBeInstanceOf(MemoryEventLog);
    const audience = must(kernel.submit(env(kernel, A.input, showTarget(), {
      type: 'ingestAudience',
      eventId: 'aud-1',
      audienceId: 'viewer-1',
      text: '看海',
      kind: 'proposal',
      proposalId: 'wish-1',
      intent: '看海',
    })));
    must(kernel.submit(env(kernel, A.editorial, { kind: 'editorialProposal', id: 'edit-1' }, {
      type: 'publishEditorialProposal',
      proposal: {
        id: 'edit-1',
        segmentIntent: '先看海',
        viewingValue: '安静看一会儿',
        participation: '可以接着提',
        handoff: '海面停留',
        minimumMaterials: [],
        alternatives: [],
      },
    })));
    publishTask(kernel, 'task-1', 'asset-1');
    must(kernel.submit(env(kernel, A.director, { kind: 'timeline', id: FIXTURE_IDS.timeline }, {
      type: 'editFutureTimeline',
      segmentId: 'seg-1',
      label: '海',
    })));
    offerTo(kernel, 'line-1', '海', 'playing', 1);

    const events = kernel.allEvents();
    expect(new Set(events.map((event) => event.type))).toEqual(new Set([
      'audience.input',
      'content.proposal',
      'production.result',
      'show.command',
      'execution.receipt',
    ]));
    const first = events[0];
    expect(first).toEqual(audience.events[0]);
    expect(first?.sequence).toBe(1);
    expect(first?.directionEpoch).toBe(1);
    expect(first?.correlationId).toBeTruthy();
    expect(first?.causationId).toBe(first?.correlationId);
    expect(first?.source).toBe(A.input);
    const sequences = events.map((event) => event.sequence);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(new Set(sequences).size).toBe(sequences.length);
    const again = inner.append({
      eventId: first!.eventId,
      type: 'audience.input',
      source: 'other',
      receivedAt: 99,
      showTime: 0,
      directionEpoch: 9,
      payload: { replayed: true },
    });
    expect(again.sequence).toBe(first?.sequence);
    expect(inner.peekNext()).toBe(events.length + 1);
    expect(kernel.view().project.channel.mode).toBe('neutral');
    expect(kernel.view().scenes).toEqual({});
  });
});

describe('过期 revision、task、scene', () => {
  it('旧 revision 不覆盖；过期任务和场景不能上播；产物还在库里', () => {
    const { kernel, fx } = setup();
    const timeline: CommandTarget = { kind: 'timeline', id: FIXTURE_IDS.timeline };
    const firstEdit = env(kernel, A.director, timeline, { type: 'editFutureTimeline', segmentId: 'seg', label: '第一版' });
    must(kernel.submit(firstEdit));
    refused(kernel.submit({ ...firstEdit, commandId: 'edit-stale', idempotencyKey: 'edit-stale' }), 'REVISION_CONFLICT');
    expect(kernel.view().timeline.segments[0]?.label).toBe('第一版');
    expect(kernel.view().timeline.segments[0]?.status).toBe('future');

    const taskTarget: CommandTarget = { kind: 'productionTask', id: 'task' };
    must(kernel.submit(env(kernel, A.editorial, taskTarget, {
      type: 'requestProduction',
      task: { id: 'task', goal: '做一张海', priority: 1, inputs: [], dependsOn: [] },
    })));
    const stalePublish = env(kernel, A.production, taskTarget, {
      type: 'publishCandidate',
      taskId: 'task',
      asset: asset('asset-a'),
    });
    stalePublish.expectedRevision = 0;
    refused(kernel.submit(stalePublish), 'REVISION_CONFLICT');
    expect(kernel.view().assets['asset-a']).toBeUndefined();
    must(kernel.submit(env(kernel, A.production, taskTarget, {
      type: 'publishCandidate',
      taskId: 'task',
      asset: asset('asset-a'),
    })));

    prepareScene(kernel, 'scene-old', 'asset-a', 'seg');
    const sceneTarget: CommandTarget = { kind: 'sceneInstance', id: 'scene-old' };
    const staleGate = env(kernel, A.runtime, sceneTarget, {
      type: 'noteReadiness',
      instanceId: 'scene-old',
      gate: 'moduleLoad',
      observation: { status: 'ok' },
    });
    staleGate.expectedRevision = 0;
    refused(kernel.submit(staleGate), 'REVISION_CONFLICT');
    expect(kernel.view().scenes['scene-old']?.readiness.moduleLoad.status).toBe('pending');
    markReady(kernel, 'scene-old');
    expect(kernel.view().scenes['scene-old']?.readiness.firstFramePaint.contract).toBe('pending-p2');

    switchDirection(kernel, 'soft');
    refused(kernel.submit(env(kernel, A.director, sceneTarget, { type: 'take', instanceId: 'scene-old' })), 'STALE_DIRECTION');
    expect(kernel.view().scenes['scene-old']?.takenSequence).toBeUndefined();
    expect(kernel.view().assets['asset-a']).toBeTruthy();
    expect(kernel.view().tasks.task?.liveEligible).toBe(false);

    const taskEpoch = kernel.view().tasks.task?.directionEpoch ?? 0;
    must(kernel.submit(env(kernel, A.production, taskTarget, {
      type: 'publishCandidate',
      taskId: 'task',
      asset: asset('asset-late'),
    }, taskEpoch)));
    expect(kernel.view().assets['asset-late']).toBeTruthy();
    expect(kernel.view().tasks.task?.liveEligible).toBe(false);

    prepareScene(kernel, 'scene-new', 'asset-late', 'seg-new');
    markReady(kernel, 'scene-new');
    refused(kernel.submit(env(kernel, A.director, { kind: 'sceneInstance', id: 'scene-new' }, {
      type: 'take',
      instanceId: 'scene-new',
    })), 'STALE_DIRECTION');
    expect(fx.takes).toEqual([]);
    expect(kernel.view().playback.filter((item) => item.kind === 'painted')).toHaveLength(0);
  });
});

describe('方向切换与未来失效', () => {
  it('软切作废未来片段和 cue，已派发的历史不改，持久层还在', () => {
    const { kernel, clock } = setup();
    clock.advance(1000);
    offerTo(kernel, 'said', '已经说完', 'ended');
    offerTo(kernel, 'later', '还没说', 'queued');
    must(kernel.submit(env(kernel, A.director, { kind: 'timeline', id: FIXTURE_IDS.timeline }, {
      type: 'editFutureTimeline',
      segmentId: 'future-seg',
      label: '还没演',
    })));
    must(kernel.submit(env(kernel, A.director, { kind: 'cue', id: 'past' }, {
      type: 'bindCue',
      cue: { cueId: 'past', anchor: { kind: 'showTime', at: 0 }, payload: { shot: 'kept' } },
    })));
    must(kernel.submit(env(kernel, A.runtime, { kind: 'cue', id: 'past' }, { type: 'dispatchCue', cueId: 'past' })));
    must(kernel.submit(env(kernel, A.director, { kind: 'cue', id: 'ahead' }, {
      type: 'bindCue',
      cue: { cueId: 'ahead', anchor: { kind: 'showTime', at: 9_000 }, payload: { shot: 'drop' } },
    })));
    const played = kernel.view().playback.map((item) => item.id);

    switchDirection(kernel, 'soft');
    const view = kernel.view();
    expect(view.timeline.segments.find((segment) => segment.segmentId === 'future-seg')?.status).toBe('invalidated');
    expect(view.cues.ahead?.status).toBe('invalidated');
    expect(view.cues.past?.status).toBe('dispatched');
    expect(view.cues.past?.payload).toEqual({ shot: 'kept' });
    expect(view.speech.later?.state).toBe('cancelled');
    expect(view.speech.said?.state).toBe('ended');
    expect(view.speech.said?.text).toBe('已经说完');
    expect(view.project.channel.mode).toBe('neutral');
    expect(view.project.channel.persistentLayers).toEqual(['caption', 'character', 'base']);
    expect(view.playback.map((item) => item.id)).toEqual(played);
    expect(view.notices.some((notice) => notice.cueId === 'ahead')).toBe(true);
    expect(view.project.currentEpoch).toBe(2);
  });

  it('强切中止正在播出的口播并记下边界，不改已经说出的词', () => {
    const { kernel } = setup();
    offerTo(kernel, 'live', '说到这', 'playing', 2);
    must(kernel.submit(env(kernel, A.director, { kind: 'cue', id: 'tail' }, {
      type: 'bindCue',
      cue: { cueId: 'tail', anchor: { kind: 'speech', partId: 'live', charIndex: 2 }, payload: { shot: 'tail' } },
    })));
    switchDirection(kernel, 'hard');
    const part = kernel.view().speech.live;
    expect(part?.state).toBe('aborted');
    expect(part?.text).toBe('说到这');
    expect(part?.unreadFrom).toBe(2);
    expect(kernel.view().cues.tail?.status).toBe('invalidated');
    expect(kernel.view().playback.some((item) => item.partId === 'live' && item.disposition === 'aborted')).toBe(true);
  });
});

describe('断线重连不重放已提交 cue', () => {
  it('恢复只折叠事实，再次派发被拒绝，提交钩子不再响', () => {
    const { kernel, clock, fx, inner } = setup();
    clock.advance(10);
    must(kernel.submit(env(kernel, A.director, { kind: 'cue', id: 'once' }, {
      type: 'bindCue',
      cue: { cueId: 'once', anchor: { kind: 'showTime', at: 0 }, payload: { shot: 'once' } },
    })));
    const dispatch = env(kernel, A.runtime, { kind: 'cue', id: 'once' }, { type: 'dispatchCue', cueId: 'once' });
    must(kernel.submit(dispatch));
    expect(fx.cues).toEqual(['once']);
    kernel.disconnect();
    refused(kernel.submit(env(kernel, A.runtime, { kind: 'cue', id: 'once' }, { type: 'dispatchCue', cueId: 'once' })), 'DISCONNECTED');
    expect(fx.cues).toEqual(['once']);
    const recovered = must(kernel.submit(env(kernel, A.runtime, showTarget(), { type: 'reconnect' })));
    expect(recovered.events[0]?.type).toBe('session.reconnected');
    expect(kernel.view().recovery?.suppressedCueIds).toEqual(['once']);
    refused(kernel.submit(env(kernel, A.runtime, { kind: 'cue', id: 'once' }, { type: 'dispatchCue', cueId: 'once' })), 'CUE_ALREADY_EXECUTED');
    expect(fx.cues).toEqual(['once']);

    const restoredLog = MemoryEventLog.fromSnapshot(JSON.parse(JSON.stringify(inner.snapshot())));
    const fx2 = countingEffects();
    const kernel2 = EngineeringKernel.hydrate(restoredLog, { effects: fx2, clock: new ManualProgrammeClock() });
    expect(fx2.cues).toEqual([]);
    expect(fx2.speech).toEqual([]);
    expect(fx2.takes).toEqual([]);
    expect(kernel2.view().cues.once?.status).toBe('dispatched');
    expect(restoredLog.committed().some((item) => item.kind === 'cue' && item.id === 'once')).toBe(true);
    refused(kernel2.submit(env(kernel2, A.runtime, { kind: 'cue', id: 'once' }, { type: 'dispatchCue', cueId: 'once' })), 'CUE_ALREADY_EXECUTED');
    expect(fx2.cues).toEqual([]);
  });
});

describe('TOO_LATE 与命令受理', () => {
  it('starting 之后不能改词，take 之后不能改已提交片段；受理本身不是 playing 或 painted', () => {
    const { kernel, fx } = setup();
    publishTask(kernel, 'task', 'asset');
    prepareScene(kernel, 'scene', 'asset', 'seg');
    markReady(kernel, 'scene');
    offerTo(kernel, 'line', '一句', 'starting');
    expect(kernel.view().speech.line?.state).toBe('starting');
    expect(kernel.view().playback).toEqual([]);
    expect(kernel.view().claims).toEqual([]);
    expect(fx.speech).toEqual(['line']);
    const started = kernel.allEvents().filter((event) => event.type === 'show.command');
    expect(started.length).toBeGreaterThan(0);
    refused(kernel.submit(env(kernel, A.performer, speechTarget('line'), { type: 'editSpeech', partId: 'line', text: '改了' })), 'TOO_LATE');
    expect(kernel.view().speech.line?.text).toBe('一句');

    const playing = must(kernel.submit(env(kernel, A.runtime, speechTarget('line'), {
      type: 'receiptSpeech',
      partId: 'line',
      kind: 'playing',
      spokenChars: 1,
      alignment: 'estimated',
    })));
    expect(playing.events[0]?.type).toBe('execution.receipt');
    expect(kernel.view().speech.line?.state).toBe('playing');
    expect(kernel.view().playback.map((item) => item.kind)).toEqual(['spoken']);
    expect(kernel.view().claims).toEqual([{ lane: 'voice', place: 'bus', surface: 'program' }]);

    const take = must(kernel.submit(env(kernel, A.director, { kind: 'sceneInstance', id: 'scene' }, {
      type: 'take',
      instanceId: 'scene',
      outcome: 'painted',
    })));
    expect(take.events[0]?.type).toBe('show.command');
    expect(kernel.view().scenes.scene?.surface).toBe('preview');
    expect(kernel.view().scenes.scene?.audioAllowed).toBe(false);
    expect(kernel.view().playback.filter((item) => item.kind === 'painted')).toHaveLength(0);
    expect(fx.takes).toEqual(['scene']);
    expect(kernel.view().timeline.segments.find((segment) => segment.segmentId === 'seg')?.status).toBe('committed');
    refused(kernel.submit(env(kernel, A.director, { kind: 'timeline', id: FIXTURE_IDS.timeline }, {
      type: 'editFutureTimeline',
      segmentId: 'seg',
      label: '改历史',
    })), 'TOO_LATE');
    refused(kernel.submit(env(kernel, A.runtime, speechTarget('line'), { type: 'startSpeech', partId: 'line' })), 'TOO_LATE');

    must(kernel.submit(env(kernel, A.runtime, { kind: 'sceneInstance', id: 'scene' }, {
      type: 'recordPlayback',
      receipt: { id: 'paint-scene', kind: 'painted', sceneInstanceId: 'scene', assetVersionId: 'asset' },
    })));
    expect(kernel.view().scenes.scene?.surface).toBe('program');
    expect(kernel.view().playback.some((item) => item.kind === 'painted' && !item.orphan)).toBe(true);
  });
});

describe('语义 cue', () => {
  it('未念到的字不能出画面；撤回未念部分只失效未来锚，已派发的不改', () => {
    const { kernel } = setup();
    offerTo(kernel, 'line', '你好世界', 'playing', 1);
    must(kernel.submit(env(kernel, A.director, { kind: 'cue', id: 'heard' }, {
      type: 'bindCue',
      cue: { cueId: 'heard', anchor: { kind: 'speech', partId: 'line', charIndex: 0 }, payload: { shot: 'heard' } },
    })));
    must(kernel.submit(env(kernel, A.director, { kind: 'cue', id: 'unsaid' }, {
      type: 'bindCue',
      cue: { cueId: 'unsaid', anchor: { kind: 'speech', partId: 'line', charIndex: 3 }, payload: { shot: 'unsaid' } },
    })));
    refused(kernel.submit(env(kernel, A.runtime, { kind: 'cue', id: 'unsaid' }, { type: 'dispatchCue', cueId: 'unsaid' })), 'ANCHOR_INVALID');
    must(kernel.submit(env(kernel, A.runtime, { kind: 'cue', id: 'heard' }, { type: 'dispatchCue', cueId: 'heard' })));
    must(kernel.submit(env(kernel, A.runtime, speechTarget('line'), { type: 'abortSpeech', partId: 'line' })));
    expect(kernel.view().cues.unsaid?.status).toBe('invalidated');
    expect(kernel.view().cues.heard?.status).toBe('dispatched');
    expect(kernel.view().cues.heard?.payload).toEqual({ shot: 'heard' });
    refused(kernel.submit(env(kernel, A.director, { kind: 'cue', id: 'heard' }, {
      type: 'editCue',
      cueId: 'heard',
      payload: { shot: 'rewritten' },
    })), 'TOO_LATE');
    expect(kernel.view().speech.line?.text).toBe('你好世界');
    expect(kernel.view().notices.some((notice) => notice.cueId === 'unsaid')).toBe(true);
  });

  it('替换未提交口播后，原来的字位锚失效', () => {
    const { kernel } = setup();
    offerTo(kernel, 'line', '原来的话', 'queued');
    must(kernel.submit(env(kernel, A.director, { kind: 'cue', id: 'bound' }, {
      type: 'bindCue',
      cue: { cueId: 'bound', anchor: { kind: 'speech', partId: 'line', charIndex: 0 }, payload: { shot: 'old' } },
    })));
    must(kernel.submit(env(kernel, A.performer, speechTarget('line'), { type: 'editSpeech', partId: 'line', text: '另一句' })));
    expect(kernel.view().cues.bound?.status).toBe('invalidated');
    refused(kernel.submit(env(kernel, A.runtime, { kind: 'cue', id: 'bound' }, { type: 'dispatchCue', cueId: 'bound' })), 'ANCHOR_INVALID');
  });

  it('相同文本不会落到另一段口播的首次匹配', () => {
    const { kernel } = setup();
    const text = '同一句话';
    offerTo(kernel, 'first', text, 'ended');
    offerTo(kernel, 'second', text, 'queued');
    must(kernel.submit(env(kernel, A.director, { kind: 'cue', id: 'second-cue' }, {
      type: 'bindCue',
      cue: { cueId: 'second-cue', anchor: { kind: 'speech', partId: 'second', charIndex: 0 }, payload: {} },
    })));
    refused(kernel.submit(env(kernel, A.runtime, { kind: 'cue', id: 'second-cue' }, {
      type: 'dispatchCue',
      cueId: 'second-cue',
    })), 'ANCHOR_INVALID');
    const cue = kernel.view().cues['second-cue'];
    expect(cue).toBeTruthy();
    const resolution = resolveCue(cue!, {
      now: 0,
      speech: (partId) => kernel.view().speech[partId],
      hasEvent: () => false,
    });
    expect(resolution.status).toBe('future');
    expect(resolution.realWordTiming).toBe(false);
  });

  it('没有逐字时标不能标成 real，estimated 也不会被升成真实字位', () => {
    const { kernel } = setup();
    offerTo(kernel, 'line', '字', 'starting');
    refused(kernel.submit(env(kernel, A.runtime, speechTarget('line'), {
      type: 'receiptSpeech',
      partId: 'line',
      kind: 'playing',
      alignment: 'real',
    })), 'ILLEGAL_TRANSITION');
    expect(kernel.view().speech.line?.state).toBe('starting');
    must(kernel.submit(env(kernel, A.runtime, speechTarget('line'), {
      type: 'receiptSpeech',
      partId: 'line',
      kind: 'playing',
      spokenChars: 1,
      alignment: 'estimated',
    })));
    const part = kernel.view().speech.line;
    expect(part?.alignment.mode).toBe('estimated');
    expect(part?.alignment.starts).toBeUndefined();
    must(kernel.submit(env(kernel, A.director, { kind: 'cue', id: 'est' }, {
      type: 'bindCue',
      cue: { cueId: 'est', anchor: { kind: 'speech', partId: 'line', charIndex: 0 }, payload: {} },
    })));
    const resolution = resolveCue(kernel.view().cues.est!, {
      now: 0,
      speech: () => kernel.view().speech.line,
      hasEvent: () => false,
    });
    expect(resolution.status).toBe('due');
    expect(resolution.alignment).toBe('estimated');
    expect(resolution.realWordTiming).toBe(false);
  });
});

describe('语音队列与 AudioBus', () => {
  it('同一时刻只有一个主播人声，预备台词不占已提交队列', () => {
    const { kernel } = setup();
    const first = speechTarget('a');
    const second = speechTarget('b');
    offerTo(kernel, 'a', '先说', 'queued');
    must(kernel.submit(env(kernel, A.performer, second, { type: 'offerSpeech', partId: 'b', text: '预备' })));
    must(kernel.submit(env(kernel, A.runtime, second, { type: 'acceptSpeech', partId: 'b' })));
    refused(kernel.submit(env(kernel, A.runtime, second, { type: 'queueSpeech', partId: 'b' })), 'ILLEGAL_TRANSITION');
    expect(kernel.view().speech.b?.state).toBe('accepted');
    must(kernel.submit(env(kernel, A.runtime, first, { type: 'startSpeech', partId: 'a' })));
    must(kernel.submit(env(kernel, A.runtime, first, {
      type: 'receiptSpeech', partId: 'a', kind: 'playing', spokenChars: 2, alignment: 'estimated',
    })));
    must(kernel.submit(env(kernel, A.runtime, first, {
      type: 'receiptSpeech', partId: 'a', kind: 'ended', spokenChars: 2, alignment: 'estimated',
    })));
    must(kernel.submit(env(kernel, A.runtime, second, { type: 'queueSpeech', partId: 'b' })));
    expect(kernel.view().speech.b?.state).toBe('queued');
  });

  it('导播短 cue 不发声；取消未提交生成也不撤掉正在播的人声', () => {
    const { kernel } = setup();
    offerTo(kernel, 'line', '继续', 'playing');
    const before = kernel.view().speech.line;
    must(kernel.submit(env(kernel, A.director, showTarget(), { type: 'sendPerformerCue', cueId: 'hold', text: '先停在这' })));
    must(kernel.submit(env(kernel, A.runtime, showTarget(), { type: 'cancelGeneration', generationId: 'gen', attemptId: 'try' })));
    expect(kernel.view().speech.line).toEqual(before);
    expect(kernel.view().performerCues.map((cue) => cue.text)).toEqual(['先停在这']);
    expect(kernel.view().claims).toEqual([{ lane: 'voice', place: 'bus', surface: 'program' }]);
    expect(kernel.view().speech.hold).toBeUndefined();
  });

  it('预览不能发声，人声速率不被漂移补偿改掉，同一声道不能两处一起响', () => {
    const { kernel, clock } = setup();
    refused(kernel.submit(env(kernel, A.director, showTarget(), { type: 'previewAudio', instanceId: 'none' })), 'PREVIEW_AUDIO_FORBIDDEN');
    refused(kernel.submit(env(kernel, A.runtime, showTarget(), { type: 'compensateVoiceForDrift' })), 'VOICE_DRIFT_COMPENSATION_FORBIDDEN');
    expect(kernel.appliedVoiceRate()).toBe(1);
    clock.observeDrift({ sceneInstanceId: 'none', programmeShowTime: 1, adapterReportedTime: 5, tolerance: 'pending-p2' });
    expect(clock.drift[0]?.tolerance).toBe('pending-p2');
    refused(kernel.claimLane(A.runtime, { lane: 'voice', place: 'scene', surface: 'preview', instanceId: 'none' }), 'PREVIEW_AUDIO_FORBIDDEN');

    publishTask(kernel, 'task', 'asset');
    prepareScene(kernel, 'scene', 'asset', 'seg');
    markReady(kernel, 'scene');
    must(kernel.submit(env(kernel, A.director, { kind: 'sceneInstance', id: 'scene' }, { type: 'take', instanceId: 'scene' })));
    refused(kernel.claimLane(A.director, { lane: 'voice', place: 'scene', surface: 'program', instanceId: 'scene' }), 'PREVIEW_AUDIO_FORBIDDEN');
    must(kernel.submit(env(kernel, A.runtime, { kind: 'sceneInstance', id: 'scene' }, {
      type: 'recordPlayback',
      receipt: { id: 'paint', kind: 'painted', sceneInstanceId: 'scene', assetVersionId: 'asset' },
    })));
    must(kernel.claimLane(A.director, { lane: 'voice', place: 'scene', surface: 'program', instanceId: 'scene' }));
    refused(kernel.claimLane(A.runtime, { lane: 'voice', place: 'bus', surface: 'program' }), 'ILLEGAL_TRANSITION');
    must(kernel.recordMedia(A.runtime, { id: 'tick', lane: 'voice', observation: 'timeupdate', showTime: 1, rate: 1.25 }));
    expect(kernel.view().media[0]?.rate).toBe(1.25);
    expect(kernel.appliedVoiceRate()).toBe(1);
  });
});

describe('没有真实播放器时仍能拒绝的事', () => {
  it('输入更新不会被记成已应用，Promise 和 SDK 信号也不能打开就绪门闩', () => {
    const { kernel } = setup();
    publishTask(kernel, 'task', 'asset');
    prepareScene(kernel, 'scene', 'asset', 'seg');
    const before = kernel.view().scenes.scene;
    refused(kernel.submit(env(kernel, A.director, { kind: 'sceneInstance', id: 'scene' }, {
      type: 'updateInputs',
      instanceId: 'scene',
      inputsRevision: 1,
      inputs: { votes: 3 },
    })), 'UNSUPPORTED_LIVE_PATCH');
    expect(kernel.view().scenes.scene?.inputsRevision).toBe(0);
    expect(kernel.view().scenes.scene?.inputs).toEqual({});
    expect(kernel.view().scenes.scene?.codeVersion).toBe(before?.codeVersion);
    must(kernel.submit(env(kernel, A.runtime, { kind: 'sceneInstance', id: 'scene' }, { type: 'notePromiseResolved', instanceId: 'scene' })));
    must(kernel.submit(env(kernel, A.runtime, { kind: 'sceneInstance', id: 'scene' }, {
      type: 'noteSdkSignal',
      instanceId: 'scene',
      signal: 'painted',
    })));
    expect(kernel.view().scenes.scene?.promiseResolved).toBe(true);
    expect(kernel.view().scenes.scene?.readiness.firstFramePaint.status).toBe('pending');
    expect(kernel.view().scenes.scene?.sdkSignals.painted).toBeTruthy();
    refused(kernel.submit(env(kernel, A.director, { kind: 'sceneInstance', id: 'scene' }, { type: 'take', instanceId: 'scene' })), 'SCENE_NOT_READY');
  });

  it('迟到的绘制回执标成孤儿，不把已撤下的场景写回在播', () => {
    const { kernel } = setup();
    publishTask(kernel, 'task', 'asset');
    prepareScene(kernel, 'scene', 'asset', 'seg');
    markReady(kernel, 'scene');
    must(kernel.submit(env(kernel, A.director, { kind: 'sceneInstance', id: 'scene' }, { type: 'take', instanceId: 'scene' })));
    must(kernel.submit(env(kernel, A.runtime, { kind: 'sceneInstance', id: 'scene' }, {
      type: 'recordPlayback',
      receipt: { id: 'paint', kind: 'painted', sceneInstanceId: 'scene', assetVersionId: 'asset' },
    })));
    switchDirection(kernel, 'soft');
    must(kernel.submit(env(kernel, A.runtime, { kind: 'sceneInstance', id: 'scene' }, {
      type: 'recordPlayback',
      receipt: { id: 'late-paint', kind: 'painted', sceneInstanceId: 'scene', assetVersionId: 'asset' },
    })));
    const view = kernel.view();
    expect(view.playback.find((item) => item.id === 'late-paint')?.orphan).toBe(true);
    expect(view.project.channel.mode).toBe('neutral');
    expect(view.project.channel.programSceneInstanceId).toBeUndefined();
    expect(view.project.channel.persistentLayers).toEqual(['caption', 'character', 'base']);
    expect(view.scenes.scene?.surface).toBe('retired');
  });

  it('制作超时不新开方向；登记候选也不是送播', () => {
    const { kernel } = setup();
    publishTask(kernel, 'slow', 'asset');
    const epochs = Object.keys(kernel.view().directions).length;
    must(kernel.submit(env(kernel, A.editorial, { kind: 'productionTask', id: 'slow' }, {
      type: 'noteProductionTimeout',
      taskId: 'slow',
      alternative: '先停在已有画面',
    })));
    expect(kernel.epoch()).toBe(1);
    expect(Object.keys(kernel.view().directions)).toHaveLength(epochs);
    expect(kernel.view().directions[FIXTURE_IDS.direction]?.contentPool.some((item) => item.summary === '先停在已有画面')).toBe(true);
    expect(kernel.view().project.channel.mode).toBe('neutral');
    expect(kernel.view().scenes).toEqual({});
  });
});

describe('活动集与历史', () => {
  it('tick 只看活动 cue，历史页要另外翻；未执行锚点还引用的口播不能删', () => {
    const { kernel, log, clock } = setup();
    for (let index = 0; index < 20; index += 1) {
      must(kernel.submit(env(kernel, A.input, showTarget(), {
        type: 'ingestAudience',
        eventId: `aud-${index}`,
        audienceId: `viewer-${index}`,
        text: '在',
        kind: 'silence',
      })));
    }
    const archivedThrough = kernel.allEvents().at(-1)?.sequence ?? 0;
    expect(kernel.archiveEventsBefore(archivedThrough)).toBe(20);
    clock.advance(5);
    must(kernel.submit(env(kernel, A.director, { kind: 'cue', id: 'live-cue' }, {
      type: 'bindCue',
      cue: { cueId: 'live-cue', anchor: { kind: 'showTime', at: 0 }, payload: {} },
    })));
    const scan = kernel.tick();
    expect(log.historyPageCalls).toBe(0);
    expect(scan.historyEventsScanned).toBe(0);
    expect(scan.scanned.map((item) => item.cueId)).toEqual(['live-cue']);
    expect(kernel.view().cues['live-cue']?.status).toBe('future');
    expect(log.historyPage(0, 50)).toHaveLength(20);
    expect(log.active().some((event) => event.type === 'audience.input')).toBe(false);

    offerTo(kernel, 'kept', '留下', 'ended');
    must(kernel.submit(env(kernel, A.director, { kind: 'cue', id: 'pin' }, {
      type: 'bindCue',
      cue: { cueId: 'pin', anchor: { kind: 'speech', partId: 'kept', charIndex: 0 }, payload: {} },
    })));
    expect(kernel.forgetSpeech('kept')).toEqual({ ok: false, reason: 'pinned' });
    const held = kernel.archiveSettled();
    expect(held.archivedSpeechIds).not.toContain('kept');
    expect(held.retainedSpeechIds).toContain('kept');
    expect(kernel.view().speech.kept?.text).toBe('留下');
    must(kernel.submit(env(kernel, A.runtime, { kind: 'cue', id: 'pin' }, { type: 'dispatchCue', cueId: 'pin' })));
    expect(kernel.forgetSpeech('kept')).toEqual({ ok: false, reason: 'pinned' });
    must(kernel.submit(env(kernel, A.runtime, showTarget(), {
      type: 'recordPlayback',
      receipt: { id: 'cue-done', kind: 'ended', cueId: 'pin' },
    })));
    expect(kernel.view().cues.pin?.status).toBe('executed');
    const archived = kernel.archiveSettled();
    expect(archived.archivedCueIds).toContain('pin');
    expect(archived.archivedSpeechIds).toContain('kept');
    expect(kernel.tick().scanned.map((item) => item.cueId)).not.toContain('pin');
    expect(kernel.view().speech.kept).toBeUndefined();
    expect(kernel.view().speechArchive.kept?.text).toBe('留下');
  });
});

describe('权限与来源', () => {
  it('导播写未来，Runtime 写提交；制作和主播不能上播或改轨', () => {
    const { kernel } = setup();
    refused(kernel.submit(env(kernel, A.performer, { kind: 'timeline', id: FIXTURE_IDS.timeline }, {
      type: 'editFutureTimeline',
      segmentId: 'nope',
      label: '主播改轨',
    })), 'NOT_AUTHORIZED');
    must(kernel.submit(env(kernel, A.director, { kind: 'timeline', id: FIXTURE_IDS.timeline }, {
      type: 'editFutureTimeline',
      segmentId: 'future',
      label: '以后',
    })));
    expect(kernel.view().timeline.segments[0]?.status).toBe('future');
    offerTo(kernel, 'line', '话', 'queued');
    refused(kernel.submit(env(kernel, A.director, speechTarget('line'), { type: 'startSpeech', partId: 'line' })), 'NOT_AUTHORIZED');
    must(kernel.submit(env(kernel, A.runtime, speechTarget('line'), { type: 'startSpeech', partId: 'line' })));
    expect(kernel.view().speech.line?.state).toBe('starting');
    refused(kernel.submit(env(kernel, A.controller, directionTarget(kernel), {
      type: 'issueSwitchAuthorization',
      authorizationId: 'veto',
      kind: 'group-veto',
      reason: '反对',
    })), 'POLICY_REJECTED');
    refused(kernel.submit(env(kernel, A.untrustedMaster, directionTarget(kernel), {
      type: 'issueSwitchAuthorization',
      authorizationId: 'spoof',
      kind: 'master-soft',
      reason: '我是 master',
    })), 'NOT_AUTHORIZED');
  });

  it('重复提交同一条命令不会把片段写两次', () => {
    const { kernel } = setup();
    const command = env(kernel, A.director, { kind: 'timeline', id: FIXTURE_IDS.timeline }, {
      type: 'editFutureTimeline',
      segmentId: 'once',
      label: '一次',
    });
    must(kernel.submit(command));
    must(kernel.submit(command));
    expect(kernel.view().timeline.segments).toHaveLength(1);
    expect(kernel.allEvents().filter((event) => event.correlationId === command.commandId)).toHaveLength(1);
  });

  it('领域内核源码不接私有 SDK、旧 agent 或假播放器', async () => {
    const root = fileURLToPath(new URL('../src/live/', import.meta.url));
    const files = (await walk(root)).filter((file) => !file.includes(`${join('live', 'domain')}`));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      expect(text, file).not.toMatch(/@reelmorph/);
      expect(text, file).not.toMatch(/dsh\/agent/);
      expect(text, file).not.toMatch(/<iframe|contentWindow|HTMLIFrameElement/);
      expect(text, file).not.toMatch(/tolerance:\s*\d/);
      expect(text, file).not.toMatch(/toleranceMs/);
    }
  });
});

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}
