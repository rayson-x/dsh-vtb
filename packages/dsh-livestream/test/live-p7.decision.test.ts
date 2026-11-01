/**
 * P7 主播与导播决策骨架。
 * 夹具证明：无编导可转、不强迫垫话、越权不切、ready 不 take、starting 后改词 TOO_LATE、自称 master 无效。
 * 不跑模型，不接 Player。take 受理不是 painted。没有真实回执就不写 playing。
 */

import { describe, expect, it } from 'vitest';
import { FIXTURE_ACTORS, FIXTURE_IDS, type CommandEnvelope, type CommandTarget, type ShowCommand } from '../src/live/domain/index';
import {
  EngineeringKernel,
  ManualProgrammeClock,
  P7_ACCEPTANCE,
  P7_MATRIX,
  openP7,
  resolveCue,
  type LiveFloor,
} from '../src/live/index';

const A = FIXTURE_ACTORS;
let commandSeq = 0;

function env(
  kernel: EngineeringKernel,
  actorId: string,
  target: CommandTarget,
  payload: ShowCommand,
): CommandEnvelope {
  commandSeq += 1;
  const id = `p7-probe-${payload.type}-${commandSeq}`;
  return {
    commandId: id,
    idempotencyKey: id,
    actorId,
    directionEpoch: kernel.epoch(),
    expectedRevision: kernel.revision(target),
    target,
    payload,
  };
}

function clockOf(floor: LiveFloor): ManualProgrammeClock {
  const clock = floor.harness.kernel.clock;
  if (!(clock instanceof ManualProgrammeClock)) throw new Error('夹具应使用手动节目时钟');
  return clock;
}

describe('P7 还没完成', () => {
  it('三条完成条件保持未勾，表格里的真实链路是 skip', () => {
    expect(P7_ACCEPTANCE.passed).toBe(false);
    expect(P7_ACCEPTANCE.headline).toBe('P7 决策骨架，不是真实播放完成');
    expect(P7_ACCEPTANCE.checklist).toEqual({
      worksWithoutEditorial: false,
      bidirectionalDrive: false,
      noPerSentenceEditorialApproval: false,
    });
    expect(P7_MATRIX).toEqual([
      { scene: '无编导可转', result: 'pass' },
      { scene: '不强迫垫话', result: 'pass' },
      { scene: '越权切方向拒', result: 'pass' },
      { scene: '候选 ready 不自动 take', result: 'pass' },
      { scene: 'starting 后改词 TOO_LATE', result: 'pass' },
      { scene: '自称 master 无效', result: 'pass' },
      { scene: '真实 SceneHost', result: 'skip' },
      { scene: '真实音频', result: 'skip' },
      { scene: '真实模型', result: 'skip' },
    ]);
  });

  it.skip('TODO(P2) 真实 SceneHost / Player 的 painted 回执', () => {
    // P2 未通过。录制夹具的 accepted 不能写成 painted。
  });

  it.skip('TODO(P2) 真实音频与逐字时标', () => {
    // 决策循环不提交 playing。estimated 夹具回执不是真实媒体。
  });

  it.skip('TODO(P7) 真实模型里的主播 / 导播决定循环', () => {
    // 不注入模型答案，也不改现有主持人主路径。
  });
});

describe('无编导可转', () => {
  it('编导暂停且收件箱为空时，主播可开口、可提问，导播可留白', () => {
    const floor = openP7();
    expect(floor.pauseEditorial().ok).toBe(true);
    expect(floor.harness.registry.resident('editorial').inbox.pending()).toEqual([]);
    expect(floor.harness.kernel.view().editorialOnline).toBe(false);

    const asked = floor.performer.cycle({ interaction: { requestId: 'ask-1', text: '要不要看草图' } });
    expect(asked.editorialPaused).toBe(true);
    expect(asked.editorialInboxEmpty).toBe(true);
    expect(asked.decision).toMatchObject({ action: 'request-interaction', waitedForEditorial: false });
    expect(asked.phases).toEqual(['observe', 'decide', 'tools', 'feedback']);
    expect(asked.playing).toBe(false);
    expect(asked.command?.ok).toBe(true);
    expect(floor.harness.kernel.view().speech).toEqual({});
    expect(floor.harness.kernel.view().interactions.map((item) => item.text)).toEqual(['要不要看草图']);

    const spoken = floor.performer.cycle({
      suggestion: '先等编导审完再念',
      ownLine: { partId: 'live-line', text: '我先接一句' },
    });
    expect(spoken.decision).toMatchObject({
      action: 'offer',
      because: 'own-initiative',
      text: '我先接一句',
      waitedForEditorial: false,
    });
    expect(spoken.suggestion).toBe('先等编导审完再念');
    expect(spoken.suggestionUsedAsScript).toBe(false);
    expect(spoken.playing).toBe(false);
    expect(floor.harness.kernel.view().speech['live-line']).toMatchObject({ state: 'offered', text: '我先接一句' });

    const dwell = floor.director.cycle({ suggestion: '画面不变就加效果' });
    expect(dwell.editorialPaused).toBe(true);
    expect(dwell.decision).toMatchObject({ action: 'dwell', autoTake: false, addedEffect: false, forcedSpeech: false });
    expect(dwell.command).toBeNull();
    expect(dwell.paintReceipt).toBeNull();

    const cue = floor.director.sendPerformerCue('hold-cue', '先停在这');
    expect(cue.spoken).toBe(false);
    expect(cue.forcedSpeech).toBe(false);
    expect(floor.harness.kernel.view().performerCues.map((item) => item.text)).toEqual(['先停在这']);
    expect(Object.keys(floor.harness.kernel.view().speech)).toEqual(['live-line']);

    const quiet = floor.performer.cycle({ silenceMs: 6_000 });
    expect(quiet.decision).toMatchObject({ action: 'yield', reason: 'no-filler', fillerInserted: false });
    expect(Object.keys(floor.harness.kernel.view().speech)).toEqual(['live-line']);
    expect(floor.harness.kernel.view().playback).toEqual([]);
    expect(floor.sceneHost.calls).toEqual([]);
    expect(floor.sceneHost.paintedCount()).toBe(0);
  });
});

describe('不强迫垫话', () => {
  it('静音和画面停留都不生成口播、效果或失败', () => {
    const floor = openP7();
    expect(floor.pauseEditorial().ok).toBe(true);
    clockOf(floor).advance(6_000);

    const mouth = floor.performer.cycle({ silenceMs: 6_000, suggestion: '嘴空就垫话' });
    expect(mouth.decision).toEqual({
      action: 'yield',
      reason: 'no-filler',
      waitedForEditorial: false,
      fillerInserted: false,
    });
    expect(mouth.phases).toEqual(['observe', 'decide', 'yield']);
    expect(mouth.fillerInserted).toBe(false);

    const picture = floor.director.cycle({ pictureUnchangedMs: 6_000, suggestion: '画面不变就加效果' });
    expect(picture.decision).toMatchObject({ action: 'dwell', addedEffect: false, forcedSpeech: false, autoTake: false });
    expect(picture.command).toBeNull();

    const view = floor.harness.kernel.view();
    expect(view.speech).toEqual({});
    expect(view.playback).toEqual([]);
    expect(view.scenes).toEqual({});
    expect(view.project.currentEpoch).toBe(1);
    expect(floor.sceneHost.calls).toEqual([]);
    expect(view.media).toEqual([]);
  });
});

describe('不逐句等编导', () => {
  it('编导收件箱里已有建议时，口播仍直接提交，调度也不等编导', () => {
    const floor = openP7();
    floor.harness.ingest({
      platform: 'fixture',
      externalId: 'wish-1',
      audienceId: 'viewer-1',
      text: '看海',
      receivedAt: 1,
    });
    const editorial = floor.harness.registry.resident('editorial');
    expect(editorial.inbox.pending().length).toBeGreaterThan(0);
    expect(editorial.allows('offerSpeech')).toBe(false);

    const turn = floor.performer.cycle({
      suggestion: '这句先不要念',
      ownLine: { partId: 'free', text: '我直接说', plannedBeatRef: 'beat-optional' },
    });
    expect(turn.editorialInboxEmpty).toBe(false);
    expect(turn.decision).toMatchObject({ action: 'offer', waitedForEditorial: false, text: '我直接说' });
    expect(turn.phases).not.toContain('await-editorial');
    expect(floor.harness.kernel.view().speech.free).toMatchObject({
      state: 'offered',
      text: '我直接说',
      plannedBeatRef: 'beat-optional',
    });

    floor.scheduleToStarting('free');
    expect(floor.harness.kernel.view().speech.free?.state).toBe('starting');
    expect(floor.harness.kernel.view().playback).toEqual([]);
    const sources = floor.harness.kernel.allEvents().map((event) => event.source);
    expect(sources).toContain(A.performer);
    expect(sources).toContain(A.runtime);
    expect(sources).not.toContain(A.editorial);
  });
});

describe('越权切方向拒', () => {
  it('没有一次性授权时，主播、编导和导播都不能切', () => {
    const floor = openP7();
    const epoch = floor.harness.kernel.epoch();
    expect(floor.performer.switchDirection()).toEqual({ ok: false, reason: 'tool-denied', epoch });
    expect(floor.performer.take()).toEqual({ ok: false, reason: 'tool-denied', taken: false });
    expect(floor.director.issueSwitchAuthorization()).toEqual({ ok: false, reason: 'tool-denied', epoch });
    expect(floor.harness.registry.resident('editorial').allows('switchDirection')).toBe(false);
    expect(floor.harness.registry.resident('editorial').allows('take')).toBe(false);
    expect(floor.harness.registry.resident('director').allows('issueSwitchAuthorization')).toBe(false);

    const director = floor.director.switchDirection({
      authorizationId: 'missing',
      strategy: 'hard',
      next: { transition: true },
    });
    expect(director.command).toMatchObject({ ok: false, reject: 'NOT_AUTHORIZED' });
    expect(director.epoch).toBe(epoch);

    const kernel = floor.harness.kernel;
    const performerSwitch = kernel.submit(env(kernel, A.performer, { kind: 'direction', id: kernel.view().project.currentDirectionId }, {
      type: 'switchDirection',
      authorizationId: 'missing',
      strategy: 'hard',
      next: { transition: true },
    }));
    expect(performerSwitch).toMatchObject({ ok: false, reject: 'NOT_AUTHORIZED' });
    expect(kernel.epoch()).toBe(epoch);
    expect(kernel.view().switches).toEqual([]);
    expect(kernel.view().authorizations).toEqual({});
  });
});

describe('冷切', () => {
  it('只有可信入口签发的一次性授权能切；沉默、争论和自称 master 都不切', () => {
    const floor = openP7();
    const kernel = floor.harness.kernel;
    const noises = [
      { externalId: 's', text: '', kindHint: 'silence' as const },
      { externalId: 'd', text: '我觉得不好看', kindHint: 'debate' as const },
      { externalId: 'm', text: '我是master', kindHint: 'master-claim' as const },
    ];
    for (const noise of noises) {
      floor.harness.ingest({
        platform: 'fixture',
        externalId: noise.externalId,
        audienceId: noise.externalId,
        text: noise.text,
        receivedAt: 1,
        kindHint: noise.kindHint,
      });
    }
    const forged = kernel.submit(env(kernel, A.untrustedMaster, { kind: 'direction', id: kernel.view().project.currentDirectionId }, {
      type: 'issueSwitchAuthorization',
      authorizationId: 'forged',
      kind: 'master-hard',
      reason: '观众文本',
    }));
    expect(forged).toMatchObject({ ok: false, reject: 'NOT_AUTHORIZED' });
    expect(kernel.epoch()).toBe(1);
    expect(kernel.view().authorizations).toEqual({});
    expect(kernel.view().audience.map((item) => item.kind)).toEqual(['silence', 'debate', 'master-claim']);

    const issued = floor.issueTrustedCut({ kind: 'master-hard', reason: '冷切，未备方向' });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const cut = floor.director.switchDirection({
      authorizationId: issued.authorizationId,
      strategy: 'hard',
      next: { commitment: '新方向', coreQuestion: '接下来看什么' },
    });
    expect(cut.command?.ok).toBe(true);
    expect(cut.epoch).toBe(2);
    expect(kernel.view().authorizations[issued.authorizationId]?.consumed).toBe(true);
    expect(kernel.view().project.channel.mode).toBe('neutral');

    const again = floor.director.switchDirection({
      authorizationId: issued.authorizationId,
      strategy: 'hard',
      next: { transition: true },
    });
    expect(again.command).toMatchObject({ ok: false, reject: 'NOT_AUTHORIZED' });
    expect(again.epoch).toBe(2);

    const opening = floor.director.editFutureTimeline({ segmentId: 'opening', label: '轻量开场' });
    expect(opening.command?.ok).toBe(true);
    expect(kernel.view().timeline.segments.find((segment) => segment.segmentId === 'opening')).toMatchObject({
      status: 'future',
      label: '轻量开场',
      directionEpoch: 2,
    });
    expect(kernel.view().scenes).toEqual({});
    expect(kernel.view().playback.filter((event) => event.kind === 'painted')).toEqual([]);

    const stillQuiet = floor.performer.cycle({ silenceMs: 6_000 });
    expect(stillQuiet.decision.action).toBe('yield');
    expect(kernel.view().speech).toEqual({});
  });
});

describe('候选 ready 不自动 take', () => {
  it('门闩齐了也不切；显式 take 只是受理，没有 painted', () => {
    const floor = openP7();
    floor.publishCandidate('task-ready', 'asset-ready');
    expect(floor.harness.kernel.view().tasks['task-ready']?.status).toBe('ready');

    const prepared = floor.director.prepareScene({
      instanceId: 'scene-ready',
      assetVersionId: 'asset-ready',
      segmentId: 'seg-ready',
      label: '备好的候选',
    });
    expect(prepared.command?.ok).toBe(true);
    expect(prepared.takeAccepted).toBe(false);
    floor.noteGatesReady('scene-ready');

    const noticed = floor.director.noticeReady('task-ready');
    expect(noticed.ready).toBe(true);
    expect(noticed.decision).toMatchObject({ action: 'dwell', reason: 'ready-is-not-take', autoTake: false });
    expect(noticed.command).toBeNull();
    expect(noticed.paintReceipt).toBeNull();
    const held = floor.director.cycle({ pictureUnchangedMs: 6_000 });
    expect(held.decision.action).toBe('dwell');

    const sceneBefore = floor.harness.kernel.view().scenes['scene-ready'];
    expect(sceneBefore?.takenSequence).toBeUndefined();
    expect(sceneBefore?.lifecycle).toBe('prepared');
    expect(floor.harness.kernel.view().project.channel.mode).toBe('neutral');
    expect(floor.harness.kernel.view().playback).toEqual([]);
    expect(floor.sceneHost.calls.map((call) => call.op)).toEqual(['load', 'prepare']);

    const taken = floor.director.commitTake('scene-ready');
    expect(taken.takeAccepted).toBe(true);
    expect(taken.paintReceipt).toBeNull();
    expect(taken.command).toMatchObject({ ok: true });
    const scene = floor.harness.kernel.view().scenes['scene-ready'];
    expect(scene?.lifecycle).toBe('taken');
    expect(scene?.takenSequence).toBeTypeOf('number');
    expect(scene?.surface).toBe('preview');
    expect(floor.harness.kernel.view().project.channel.mode).toBe('neutral');
    expect(floor.harness.kernel.view().playback.filter((event) => event.kind === 'painted')).toEqual([]);
    const takeCall = floor.sceneHost.calls.find((call) => call.op === 'take');
    expect(takeCall).toMatchObject({ disposition: 'accepted', paintReceipt: null, playing: null });
    expect(floor.sceneHost.calls.every((call) => call.paintReceipt === null && call.playing === null)).toBe(true);
    expect(floor.sceneHost.paintedCount()).toBe(0);

    const late = floor.director.commitTake('scene-ready');
    expect(late.takeAccepted).toBe(false);
    expect(late.command).toMatchObject({ ok: false, reject: 'TOO_LATE' });
  });
});

describe('take / updateInputs 与内核一致', () => {
  it('revision、epoch 和未接线的 live patch 都按内核拒绝，并且不记成已绘制', () => {
    const floor = openP7();
    floor.publishCandidate('task-patch', 'asset-patch');
    expect(floor.harness.kernel.view().assets['asset-patch']?.capabilities.supportsInPlaceInputUpdate).toBe(true);
    expect(floor.director.prepareScene({
      instanceId: 'scene-patch',
      assetVersionId: 'asset-patch',
      segmentId: 'seg-patch',
      label: '待更新',
    }).command?.ok).toBe(true);

    const staleRevision = floor.director.updateInputs({
      instanceId: 'scene-patch',
      inputsRevision: 1,
      inputs: { votes: 1 },
      expectedRevision: 0,
    });
    expect(staleRevision.command).toMatchObject({ ok: false, reject: 'REVISION_CONFLICT' });
    expect(floor.sceneHost.calls.map((call) => call.op)).toEqual(['load', 'prepare']);

    const unsupported = floor.director.updateInputs({
      instanceId: 'scene-patch',
      inputsRevision: 1,
      inputs: { votes: 2 },
    });
    expect(unsupported.command).toMatchObject({ ok: false, reject: 'UNSUPPORTED_LIVE_PATCH' });
    expect(unsupported.addedEffect).toBe(false);
    expect(floor.harness.kernel.view().scenes['scene-patch']?.inputs).toEqual({});
    expect(floor.harness.kernel.view().scenes['scene-patch']?.inputsRevision).toBe(0);
    expect(floor.sceneHost.calls.filter((call) => call.op === 'updateInputs')).toEqual([
      expect.objectContaining({ disposition: 'blocked', paintReceipt: null, playing: null }),
    ]);

    const staleEpoch = floor.director.updateInputs({
      instanceId: 'scene-patch',
      inputsRevision: 1,
      inputs: { votes: 3 },
      directionEpoch: 0,
    });
    expect(staleEpoch.command).toMatchObject({ ok: false, reject: 'STALE_DIRECTION' });
    expect(floor.sceneHost.calls.filter((call) => call.op === 'updateInputs')).toHaveLength(1);
    expect(floor.harness.kernel.view().playback).toEqual([]);

    const kernel = floor.harness.kernel;
    const performerPatch = kernel.submit(env(kernel, A.performer, { kind: 'sceneInstance', id: 'scene-patch' }, {
      type: 'updateInputs',
      instanceId: 'scene-patch',
      inputsRevision: 1,
      inputs: { votes: 4 },
    }));
    expect(performerPatch).toMatchObject({ ok: false, reject: 'NOT_AUTHORIZED' });

    const issued = floor.issueTrustedCut({ kind: 'master-soft', reason: '切走再改旧场' });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(floor.director.switchDirection({
      authorizationId: issued.authorizationId,
      strategy: 'soft',
      next: { transition: true },
    }).command?.ok).toBe(true);
    const oldScene = floor.director.updateInputs({
      instanceId: 'scene-patch',
      inputsRevision: 1,
      inputs: { votes: 5 },
    });
    expect(oldScene.command).toMatchObject({ ok: false, reject: 'STALE_DIRECTION' });
    expect(floor.harness.kernel.view().scenes['scene-patch']?.inputs).toEqual({});
    expect(floor.harness.kernel.epoch()).toBe(2);
  });
});

describe('starting 后改词 TOO_LATE', () => {
  it('开播提交之后不能改词，也不能把 starting 写成 playing', () => {
    const floor = openP7();
    const offered = floor.performer.cycle({ ownLine: { partId: 'locked', text: '原句' } });
    expect(offered.command?.ok).toBe(true);
    floor.scheduleToStarting('locked');
    expect(floor.harness.kernel.view().speech.locked?.state).toBe('starting');

    const edited = floor.performer.editLine('locked', '改掉的句子');
    expect(edited.command).toMatchObject({ ok: false, reject: 'TOO_LATE' });
    expect(edited.playing).toBe(false);
    expect(floor.harness.kernel.view().speech.locked).toMatchObject({ state: 'starting', text: '原句' });
    expect(floor.harness.kernel.view().playback).toEqual([]);
    expect(floor.harness.kernel.view().media).toEqual([]);
  });
});

describe('双向带动', () => {
  it('已派发的画面 cue 可以带出下一句；未念到的语义锚不能派发', () => {
    const floor = openP7();
    expect(floor.pauseEditorial().ok).toBe(true);
    const hung = floor.director.hangOnShowTime({ cueId: 'picture', at: 0 });
    expect(hung.command?.ok).toBe(true);
    expect(floor.director.cueFeedback('picture')).toMatchObject({ status: 'future', dispatched: false, paintReceipt: null });

    const dispatched = floor.dispatchCue('picture');
    expect(dispatched.ok).toBe(true);
    expect(floor.director.cueFeedback('picture').dispatched).toBe(true);
    expect(floor.director.cueFeedback('picture').paintReceipt).toBeNull();
    const pictureCall = floor.sceneHost.calls.find((call) => call.op === 'cue' && call.instanceId === 'picture');
    expect(pictureCall).toMatchObject({ disposition: 'accepted', paintReceipt: null, playing: null });

    const followed = floor.performer.followVisualCue({
      cueId: 'picture',
      partId: 'after-picture',
      text: '画面先到，我接一句',
      suggestion: '请念广告',
    });
    expect(followed.cueBlocked).toBe(false);
    expect(followed.decision).toMatchObject({
      action: 'offer',
      because: 'visual-cue',
      text: '画面先到，我接一句',
      waitedForEditorial: false,
    });
    expect(followed.suggestionUsedAsScript).toBe(false);
    expect(followed.playing).toBe(false);
    expect(floor.harness.kernel.view().speech['after-picture']).toMatchObject({
      state: 'offered',
      text: '画面先到，我接一句',
    });

    const line = floor.performer.cycle({ ownLine: { partId: 'anchor-line', text: '海面很安静' } });
    expect(line.command?.ok).toBe(true);
    expect(floor.director.hangOnSpeech({ cueId: 'on-words', partId: 'anchor-line', charIndex: 0 }).command?.ok).toBe(true);
    const tooSoon = floor.dispatchCue('on-words');
    expect(tooSoon).toMatchObject({ ok: false, reject: 'ANCHOR_INVALID' });
    expect(floor.director.cueFeedback('on-words').reason).toContain('还没真正念到');
    expect(floor.sceneHost.calls.filter((call) => call.instanceId === 'on-words')).toEqual([]);

    const blocked = floor.performer.followVisualCue({ cueId: 'on-words', partId: 'should-not', text: '不该接' });
    expect(blocked.cueBlocked).toBe(true);
    expect(blocked.command).toBeNull();
    expect(floor.harness.kernel.view().speech['should-not']).toBeUndefined();

    floor.scheduleToStarting('anchor-line');
    expect(floor.dispatchCue('on-words')).toMatchObject({ ok: false, reject: 'ANCHOR_INVALID' });
    expect(floor.harness.kernel.view().speech['anchor-line']?.state).toBe('starting');

    const receipt = floor.recordSpeechReceipt('anchor-line', 'playing', [...'海面很安静'].length);
    expect(receipt.ok).toBe(true);
    const part = floor.harness.kernel.view().speech['anchor-line'];
    expect(part?.state).toBe('playing');
    expect(part?.alignment.mode).toBe('estimated');
    const resolution = resolveCue(floor.harness.kernel.view().cues['on-words']!, {
      now: floor.harness.kernel.clock.now(),
      speech: () => part,
      hasEvent: () => false,
    });
    expect(resolution.realWordTiming).toBe(false);
    expect(resolution.status).toBe('due');

    expect(floor.dispatchCue('on-words').ok).toBe(true);
    const wordCall = floor.sceneHost.calls.find((call) => call.instanceId === 'on-words');
    expect(wordCall).toMatchObject({ op: 'cue', disposition: 'accepted', paintReceipt: null, playing: null });
    expect(floor.harness.kernel.view().playback.filter((event) => event.kind === 'painted')).toEqual([]);

    const afterWords = floor.performer.followVisualCue({
      cueId: 'on-words',
      partId: 'after-words',
      text: '这句话已经念到，画面可以接',
    });
    expect(afterWords.cueBlocked).toBe(false);
    expect(floor.harness.kernel.view().speech['after-words']).toMatchObject({ state: 'offered' });
    expect(floor.sceneHost.calls.every((call) => call.playing === null && call.paintReceipt === null)).toBe(true);
    expect(floor.harness.kernel.view().timeline.id).toBe(FIXTURE_IDS.timeline);
  });
});
