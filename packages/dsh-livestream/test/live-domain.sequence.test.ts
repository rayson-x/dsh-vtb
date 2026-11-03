import { describe, expect, it } from 'vitest';
import { READINESS_GATES, type RejectCode } from '../src/live/domain/codes';
import {
  FIXTURE_ACTORS,
  FIXTURE_IDS,
  MATRIX_ROWS,
  READ_MODEL_EXCLUDED_KEYS,
  createDomainFixture,
  type AssetVersion,
  type CommandEnvelope,
  type CommandResult,
  type CommandTarget,
  type DirectorReadModel,
  type DomainFixture,
  type PerformerReadModel,
  type ShowCommand,
} from '../src/live/domain/index';

const proven = new Set<string>();
const covers = (id: string) => proven.add(id);

const A = FIXTURE_ACTORS;
let seq = 0;

function env(
  fx: DomainFixture,
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
    directionEpoch: epoch ?? fx.snapshot().project.currentEpoch,
    expectedRevision: fx.revision(target),
    target,
    payload,
  };
}

function must(result: CommandResult): Extract<CommandResult, { ok: true }> {
  if (!result.ok) throw new Error(`${result.reject}: ${result.message}`);
  return result;
}

function refused(result: CommandResult, code: RejectCode): Extract<CommandResult, { ok: false }> {
  if (result.ok) throw new Error(`应当拒绝 ${code}`);
  expect(result.reject).toBe(code);
  return result;
}

function showTarget(): CommandTarget {
  return { kind: 'show', id: FIXTURE_IDS.show };
}

function directionTarget(fx: DomainFixture): CommandTarget {
  return { kind: 'direction', id: fx.snapshot().project.currentDirectionId };
}

function asset(id: string, patch: Partial<Omit<AssetVersion, 'revision'>> = {}): Omit<AssetVersion, 'revision'> {
  return {
    id,
    hash: `hash-${id}`,
    codeVersion: `code-${id}`,
    dependencyVersions: {},
    schemaVersion: '1',
    verification: 'unverified',
    provenance: 'p1-fixture',
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

function task(fx: DomainFixture, taskId: string, assetId: string, patch?: Partial<Omit<AssetVersion, 'revision'>>, proposalId?: string) {
  const target: CommandTarget = { kind: 'productionTask', id: taskId };
  must(fx.submit(env(fx, A.editorial, target, {
    type: 'requestProduction',
    ...(proposalId ? { proposalId } : {}),
    task: { id: taskId, goal: taskId, priority: 1, inputs: [`brief-${taskId}`], dependsOn: [] },
  })));
  must(fx.submit(env(fx, A.production, target, { type: 'publishCandidate', taskId, asset: asset(assetId, patch) })));
}

function markReady(fx: DomainFixture, instanceId: string) {
  const target: CommandTarget = { kind: 'sceneInstance', id: instanceId };
  for (const gate of READINESS_GATES) {
    must(fx.submit(env(fx, A.runtime, target, {
      type: 'noteReadiness',
      instanceId,
      gate,
      observation: { status: 'ok', observedAtShowTime: fx.clock.now() },
    })));
  }
}

function prepare(fx: DomainFixture, instanceId: string, assetVersionId: string, segmentId: string) {
  const target: CommandTarget = { kind: 'sceneInstance', id: instanceId };
  must(fx.submit(env(fx, A.director, target, {
    type: 'prepareScene',
    instanceId,
    assetVersionId,
    segmentId,
    label: segmentId,
  })));
}

function speechTo(
  fx: DomainFixture,
  partId: string,
  text: string,
  to: 'offered' | 'queued' | 'starting' | 'playing' | 'ended',
  spokenChars = [...text].length,
) {
  const target: CommandTarget = { kind: 'speechPart', id: partId };
  must(fx.submit(env(fx, A.performer, target, { type: 'offerSpeech', partId, text })));
  if (to === 'offered') return;
  must(fx.submit(env(fx, A.runtime, target, { type: 'acceptSpeech', partId })));
  must(fx.submit(env(fx, A.runtime, target, { type: 'queueSpeech', partId })));
  if (to === 'queued') return;
  must(fx.submit(env(fx, A.runtime, target, { type: 'startSpeech', partId })));
  if (to === 'starting') return;
  must(fx.submit(env(fx, A.runtime, target, {
    type: 'receiptSpeech',
    partId,
    kind: 'playing',
    spokenChars,
    alignment: 'estimated',
    starts: [0],
  })));
  if (to === 'playing') return;
  must(fx.submit(env(fx, A.runtime, target, { type: 'receiptSpeech', partId, kind: 'ended', spokenChars: [...text].length })));
}

describe('§9.3 编导无内容/暂停，制作慢', () => {
  it('主播和导播照常口播、留白，不生成垫话', () => {
    covers('editorial-gap');
    const fx = createDomainFixture();
    must(fx.submit(env(fx, A.runtime, showTarget(), { type: 'setEditorialPresence', online: false })));
    const taskTarget: CommandTarget = { kind: 'productionTask', id: 'slow' };
    must(fx.submit(env(fx, A.editorial, taskTarget, {
      type: 'requestProduction',
      task: { id: 'slow', goal: '慢制作', priority: 1, inputs: [], dependsOn: [] },
    })));
    speechTo(fx, 'live-line', '先接一句', 'queued');
    must(fx.submit(env(fx, A.director, showTarget(), { type: 'sendPerformerCue', cueId: 'hold-cue', text: '先停在这' })));
    must(fx.submit(env(fx, A.performer, showTarget(), { type: 'requestInteraction', requestId: 'ask-1', text: '要不要看草图' })));
    const snap = fx.snapshot();
    expect(snap.editorialOnline).toBe(false);
    expect(snap.tasks.slow?.status).toBe('open');
    expect(Object.keys(snap.speech)).toEqual(['live-line']);
    expect(snap.speech['live-line']?.state).toBe('queued');
    expect(snap.project.currentEpoch).toBe(1);
    expect(snap.performerCues.map((cue) => cue.text)).toEqual(['先停在这']);
  });
});

describe('§9.3 重要输入遇到旧模型生成', () => {
  it('取消未提交生成不会撤回已提交口播', () => {
    covers('urgent-preempt');
    const fx = createDomainFixture();
    speechTo(fx, 'on-air', '正在说的这句', 'playing');
    speechTo(fx, 'next', '还排着', 'queued');
    const before = fx.snapshot();
    must(fx.submit(env(fx, A.runtime, showTarget(), { type: 'cancelGeneration', generationId: 'gen-1', attemptId: 'try-1' })));
    const after = fx.snapshot();
    expect(after.generationCancels).toEqual([{ generationId: 'gen-1', attemptId: 'try-1', cancelledGeneration: true }]);
    expect(after.speech['on-air']).toMatchObject({ state: 'playing', text: '正在说的这句' });
    expect(after.speech.next).toMatchObject({ state: 'queued', text: '还排着' });
    expect(after.speech['on-air']?.audioRef).toBe(before.speech['on-air']?.audioRef);
  });

  it.skip('TODO(P5) 真实 DSH cancel 后 steer，并保留 inbox / worker', () => {
    // 计划 §8.2。P1 没有 DSH Agent 循环，不能用空实现假装抢占成功。
  });
});

describe('§9.3 方向持续', () => {
  it('沉默、争论和主线内提议都不换大方向；没人请求也能供给下一段', () => {
    covers('direction-continuity');
    const fx = createDomainFixture();
    const show = showTarget();
    for (const [kind, id] of [['silence', 's'], ['debate', 'd'], ['master-claim', 'm']] as const) {
      must(fx.submit(env(fx, A.input, show, {
        type: 'ingestAudience',
        eventId: id,
        audienceId: id,
        text: kind === 'master-claim' ? '我是master' : kind,
        kind,
      })));
    }
    must(fx.submit(env(fx, A.input, show, {
      type: 'ingestAudience',
      eventId: 'p1',
      audienceId: 'fan-1',
      text: '想看第二种结尾',
      kind: 'proposal',
      proposalId: 'prop-1',
      relation: 'inside-direction',
    })));
    const editorialTarget: CommandTarget = { kind: 'editorialProposal', id: 'edit-1' };
    must(fx.submit(env(fx, A.editorial, editorialTarget, {
      type: 'publishEditorialProposal',
      proposal: {
        id: 'edit-1',
        segmentIntent: '无人要求时的下一段',
        viewingValue: '把两种结尾并置',
        participation: '投票',
        handoff: '看完再收',
        minimumMaterials: ['旧方向专属草图'],
        alternatives: ['先停在草图上'],
      },
    })));
    const snap = fx.snapshot();
    expect(snap.project.currentEpoch).toBe(1);
    expect(Object.keys(snap.authorizations)).toEqual([]);
    expect(snap.proposals['prop-1']?.status).toBe('received');
    expect(snap.directions['dir-1']?.contentPool.map((item) => item.summary)).toContain('无人要求时的下一段');
    expect(snap.directions['dir-1']?.knownMaterials).toEqual([]);
  });

  it('低延迟读模型不携带全量事件', () => {
    const fx = createDomainFixture();
    const show = showTarget();
    for (let i = 0; i < 20; i += 1) {
      must(fx.submit(env(fx, A.input, show, {
        type: 'ingestAudience', eventId: `e-${i}`, audienceId: `u-${i}`, text: `消息${i}`, kind: 'debate',
      })));
    }
    const performer = mustRead(fx.read(A.performer, 'readLiveBrief')) as PerformerReadModel;
    const director = mustRead(fx.read(A.director, 'readProgramme')) as DirectorReadModel;
    expect(performer.recentInteractions).toHaveLength(8);
    expect(director.audienceBrief.inputs).toBe(20);
    expect(director.audienceBrief.recent).toHaveLength(5);
    expect(fx.snapshot().events.length).toBeGreaterThan(8);
    for (const key of READ_MODEL_EXCLUDED_KEYS) {
      expect(key in performer).toBe(false);
      expect(key in director).toBe(false);
    }
    expect(fx.read(A.performer, 'readShow').ok).toBe(false);
  });
});

describe('§9.3 方向切换', () => {
  it('软切使未来动作失效，已在说的口播可收束，迟到旧任务不能上播', () => {
    covers('direction-switch');
    const fx = createDomainFixture();
    speechTo(fx, 'speaking', '正在收的一句', 'playing');
    speechTo(fx, 'later', '还没说的旧题', 'queued');
    const cueTarget: CommandTarget = { kind: 'cue', id: 'future-cue' };
    must(fx.submit(env(fx, A.director, cueTarget, {
      type: 'bindCue',
      cue: { cueId: 'future-cue', anchor: { kind: 'speech', partId: 'later', charIndex: 0 }, payload: { go: true } },
    })));
    task(fx, 'old-task', 'asset-old');
    prepare(fx, 'old-scene', 'asset-old', 'old-seg');
    markReady(fx, 'old-scene');
    const auth: CommandTarget = directionTarget(fx);
    must(fx.submit(env(fx, A.master, auth, {
      type: 'issueSwitchAuthorization', authorizationId: 'auth-soft', kind: 'master-soft', reason: '主人软切',
    })));
    must(fx.submit(env(fx, A.director, auth, {
      type: 'switchDirection', authorizationId: 'auth-soft', strategy: 'soft', next: { transition: true },
    })));
    const mid = fx.snapshot();
    expect(mid.project.currentEpoch).toBe(2);
    expect(mid.project.channel.mode).toBe('neutral');
    expect(mid.project.channel.programSceneInstanceId).toBeUndefined();
    expect(mid.speech.later?.state).toBe('cancelled');
    expect(mid.speech.speaking?.state).toBe('playing');
    expect(mid.cues['future-cue']?.status).toBe('invalidated');
    expect(mid.tasks['old-task']?.liveEligible).toBe(false);
    expect(mid.directions['dir-2']?.contentPool).toEqual([]);
    expect(mid.directions['dir-2']?.knownMaterials).toEqual([]);
    expect(mid.project.channel.persistentLayers).toEqual(['caption', 'character', 'base']);
    refused(fx.submit(env(fx, A.performer, { kind: 'speechPart', id: 'stale-line' }, {
      type: 'offerSpeech', partId: 'stale-line', text: '还想说旧题',
    }, 1)), 'STALE_DIRECTION');
    must(fx.submit(env(fx, A.performer, { kind: 'speechPart', id: 'new-line' }, {
      type: 'offerSpeech', partId: 'new-line', text: '新方向先开口',
    })));
    must(fx.submit(env(fx, A.runtime, { kind: 'speechPart', id: 'speaking' }, {
      type: 'receiptSpeech', partId: 'speaking', kind: 'ended', spokenChars: [...'正在收的一句'].length,
    })));
    expect(fx.snapshot().speech.speaking?.text).toBe('正在收的一句');
    refused(fx.submit(env(fx, A.director, { kind: 'sceneInstance', id: 'old-scene' }, {
      type: 'take', instanceId: 'old-scene',
    })), 'STALE_DIRECTION');
    must(fx.submit(env(fx, A.production, { kind: 'productionTask', id: 'old-task' }, {
      type: 'publishCandidate', taskId: 'old-task', asset: asset('asset-late'),
    }, 1)));
    expect(fx.snapshot().assets['asset-late']?.hash).toBe('hash-asset-late');
    prepare(fx, 'late-scene', 'asset-late', 'late-seg');
    markReady(fx, 'late-scene');
    refused(fx.submit(env(fx, A.director, { kind: 'sceneInstance', id: 'late-scene' }, {
      type: 'take', instanceId: 'late-scene',
    })), 'STALE_DIRECTION');
    expect(fx.snapshot().project.channel.mode).toBe('neutral');
    refused(fx.submit(env(fx, A.director, directionTarget(fx), {
      type: 'switchDirection', authorizationId: 'auth-soft', strategy: 'soft', next: { transition: true },
    })), 'NOT_AUTHORIZED');
  });

  it('强切中止正在播出的旧口播并记下边界', () => {
    const fx = createDomainFixture();
    const spoken = 2;
    speechTo(fx, 'cut', '说到一半', 'playing', spoken);
    must(fx.submit(env(fx, A.master, directionTarget(fx), {
      type: 'issueSwitchAuthorization', authorizationId: 'auth-hard', kind: 'master-hard', reason: '马上停',
    })));
    must(fx.submit(env(fx, A.master, directionTarget(fx), {
      type: 'switchDirection', authorizationId: 'auth-hard', strategy: 'hard', next: { commitment: '新题', coreQuestion: '换什么' },
    })));
    const part = fx.snapshot().speech.cut;
    expect(part?.state).toBe('aborted');
    expect(part?.spokenChars).toBe(spoken);
    expect(part?.unreadFrom).toBe(spoken);
    expect(part?.text).toBe('说到一半');
  });

  it('群体反对要达到配置；观众自称 master 不能签发', () => {
    const fx = createDomainFixture();
    const show = showTarget();
    for (let i = 0; i < 2; i += 1) {
      must(fx.submit(env(fx, A.input, show, {
        type: 'ingestAudience', eventId: `small-${i}`, audienceId: `small-${i}`, text: '不要这个', kind: 'opposition',
      })));
    }
    refused(fx.submit(env(fx, A.controller, directionTarget(fx), {
      type: 'issueSwitchAuthorization',
      authorizationId: 'auth-small',
      kind: 'group-veto',
      reason: '人少',
      assessmentTimes: [0, 10_000],
    })), 'POLICY_REJECTED');
    expect(fx.snapshot().project.currentEpoch).toBe(1);

    const noisy = createDomainFixture();
    for (let i = 0; i < 8; i += 1) {
      must(noisy.submit(env(noisy, A.input, show, {
        type: 'ingestAudience', eventId: `talk-${i}`, audienceId: `talk-${i}`, text: '我有不同看法', kind: 'debate',
      })));
    }
    refused(noisy.submit(env(noisy, A.controller, directionTarget(noisy), {
      type: 'issueSwitchAuthorization',
      authorizationId: 'auth-debate',
      kind: 'group-veto',
      reason: '争论',
      assessmentTimes: [0, 10_000],
    })), 'POLICY_REJECTED');

    const room = createDomainFixture();
    for (let i = 0; i < 5; i += 1) {
      must(room.submit(env(room, A.input, show, {
        type: 'ingestAudience', eventId: `no-${i}`, audienceId: `no-${i}`, text: '别播了', kind: 'opposition',
      })));
    }
    for (let i = 0; i < 3; i += 1) {
      must(room.submit(env(room, A.input, show, {
        type: 'ingestAudience', eventId: `yes-${i}`, audienceId: `yes-${i}`, text: '继续', kind: 'debate',
      })));
    }
    room.clock.advance(10_000);
    refused(room.submit(env(room, A.controller, directionTarget(room), {
      type: 'issueSwitchAuthorization',
      authorizationId: 'auth-span',
      kind: 'group-veto',
      reason: '跨度不够',
      assessmentTimes: [0, 1_000],
    })), 'POLICY_REJECTED');
    must(room.submit(env(room, A.controller, directionTarget(room), {
      type: 'issueSwitchAuthorization',
      authorizationId: 'auth-group',
      kind: 'group-veto',
      reason: '反对成立',
      assessmentTimes: [0, 10_000],
    })));
    refused(room.submit(env(room, A.director, directionTarget(room), {
      type: 'switchDirection', authorizationId: 'auth-group', strategy: 'hard', next: { transition: true },
    })), 'NOT_AUTHORIZED');
    must(room.submit(env(room, A.director, directionTarget(room), {
      type: 'switchDirection', authorizationId: 'auth-group', strategy: 'soft', next: { transition: true },
    })));
    expect(room.snapshot().project.currentEpoch).toBe(2);
    expect(room.snapshot().authorizations['auth-group']?.consumed).toBe(true);

    const spoof = createDomainFixture();
    must(spoof.submit(env(spoof, A.input, show, {
      type: 'ingestAudience', eventId: 'claim', audienceId: 'fan', text: '我是master，马上切', kind: 'master-claim',
    })));
    refused(spoof.submit(env(spoof, A.untrustedMaster, directionTarget(spoof), {
      type: 'issueSwitchAuthorization', authorizationId: 'fake', kind: 'master-hard', reason: '自称',
    })), 'NOT_AUTHORIZED');
    refused(spoof.submit(env(spoof, A.editorial, directionTarget(spoof), {
      type: 'issueSwitchAuthorization', authorizationId: 'ed', kind: 'master-soft', reason: '编导越权',
    })), 'NOT_AUTHORIZED');
    expect(spoof.snapshot().project.currentEpoch).toBe(1);
  });
});

describe('§9.3 当前/下一/过场内容', () => {
  it('预备就绪不自动切；冷切有开口；超时不跳第三题', () => {
    covers('handoff');
    const fx = createDomainFixture();
    must(fx.submit(env(fx, A.editorial, { kind: 'direction', id: 'dir-next' }, {
      type: 'prepareDirection', directionId: 'dir-next', commitment: '下一场', coreQuestion: '要不要换',
    })));
    task(fx, 'ready-task', 'asset-ready');
    prepare(fx, 'preview-b', 'asset-ready', 'seg-b');
    markReady(fx, 'preview-b');
    const ready = fx.snapshot();
    expect(ready.project.currentEpoch).toBe(1);
    expect(ready.project.currentDirectionId).toBe('dir-1');
    expect(ready.directions['dir-next']?.live).toBe(false);
    expect(ready.project.channel.mode).toBe('neutral');
    expect(ready.scenes['preview-b']?.surface).toBe('preview');

    must(fx.submit(env(fx, A.master, directionTarget(fx), {
      type: 'issueSwitchAuthorization', authorizationId: 'cold', kind: 'master-hard', reason: '冷切',
    })));
    must(fx.submit(env(fx, A.director, directionTarget(fx), {
      type: 'switchDirection', authorizationId: 'cold', strategy: 'hard', next: { transition: true },
    })));
    expect(fx.snapshot().directions['dir-2']?.status).toBe('transition');
    expect(fx.snapshot().directions['dir-2']?.commitment).toBe('过渡');
    speechTo(fx, 'open', '新方向我先问一句', 'offered');
    expect(fx.snapshot().project.channel.mode).toBe('neutral');
    expect(fx.snapshot().scenes['preview-b']?.surface).not.toBe('program');

    const slow = createDomainFixture();
    const before = Object.keys(slow.snapshot().directions).length;
    task(slow, 'too-slow', 'asset-slow');
    must(slow.submit(env(slow, A.editorial, { kind: 'productionTask', id: 'too-slow' }, {
      type: 'noteProductionTimeout', taskId: 'too-slow', alternative: '先看已经做好的局部',
    })));
    const after = slow.snapshot();
    expect(Object.keys(after.directions)).toHaveLength(before);
    expect(after.project.currentEpoch).toBe(1);
    expect(after.tasks['too-slow']?.status).toBe('timedOut');
    expect(after.directions['dir-1']?.contentPool.some((item) => item.summary === '先看已经做好的局部')).toBe(true);
  });
});

describe('§9.3 真实共创', () => {
  it('入队和制作完成都不是兑现；上场后的反馈才进入下一版', () => {
    covers('cocreation');
    const fx = createDomainFixture();
    must(fx.submit(env(fx, A.input, showTarget(), {
      type: 'ingestAudience',
      eventId: 'wish',
      audienceId: 'fan-9',
      text: '把结局改成白天',
      kind: 'proposal',
      proposalId: 'wish-1',
      relation: 'inside-direction',
    })));
    const proposal: CommandTarget = { kind: 'audienceProposal', id: 'wish-1' };
    must(fx.submit(env(fx, A.editorial, proposal, { type: 'setProposalStatus', proposalId: 'wish-1', status: 'accepted' })));
    task(fx, 'make-v2', 'asset-v2', { hash: 'hash-v2' }, 'wish-1');
    speechTo(fx, 'mention', '我先口头接一下', 'queued');
    expect(fx.snapshot().proposals['wish-1']?.status).toBe('ready');
    expect(fx.snapshot().proposals['wish-1']?.fulfillment).toBeUndefined();
    refused(fx.submit(env(fx, A.editorial, proposal, { type: 'setProposalStatus', proposalId: 'wish-1', status: 'presented' })), 'NOT_AUTHORIZED');
    refused(fx.submit(env(fx, A.runtime, proposal, { type: 'setProposalStatus', proposalId: 'wish-1', status: 'presented' })), 'FULFILLMENT_UNPROVEN');

    prepare(fx, 'scene-v2', 'asset-v2', 'seg-v2');
    markReady(fx, 'scene-v2');
    must(fx.submit(env(fx, A.director, { kind: 'sceneInstance', id: 'scene-v2' }, { type: 'take', instanceId: 'scene-v2' })));
    const painted = fx.snapshot().playback.find((item) => item.kind === 'painted' && item.sceneInstanceId === 'scene-v2');
    expect(painted?.assetVersionId).toBe('asset-v2');
    expect(painted && 'acceptSequence' in painted).toBe(false);
    must(fx.submit(env(fx, A.runtime, proposal, {
      type: 'setProposalStatus', proposalId: 'wish-1', status: 'presented', evidencePlaybackId: painted?.id,
    })));
    expect(fx.snapshot().proposals['wish-1']?.status).toBe('presented');
    expect(fx.snapshot().proposals['wish-1']?.fulfillment?.playbackEventId).toBe(painted?.id);

    refused(fx.submit(env(fx, A.production, { kind: 'productionTask', id: 'make-v2' }, {
      type: 'publishCandidate',
      taskId: 'make-v2',
      asset: asset('asset-v2', { hash: 'mutated' }),
    })), 'IMMUTABLE_VERSION');
    expect(fx.snapshot().assets['asset-v2']?.hash).toBe('hash-v2');

    must(fx.submit(env(fx, A.input, showTarget(), {
      type: 'ingestAudience',
      eventId: 'wish-2',
      audienceId: 'fan-9',
      text: '白天再亮一点',
      kind: 'proposal',
      proposalId: 'wish-2',
    })));
    must(fx.submit(env(fx, A.editorial, { kind: 'audienceProposal', id: 'wish-2' }, {
      type: 'setProposalStatus', proposalId: 'wish-2', status: 'accepted',
    })));
    task(fx, 'make-v3', 'asset-v3', { hash: 'hash-v3' }, 'wish-2');
    const done = fx.snapshot();
    expect(done.assets['asset-v2']?.hash).toBe('hash-v2');
    expect(done.assets['asset-v3']?.hash).toBe('hash-v3');
    expect(done.proposals['wish-1']?.status).toBe('presented');
    expect(done.proposals['wish-2']?.status).toBe('ready');
    expect(done.project.contributionIds).toContain('fan-9');
  });
});

describe('§9.3 Live patch', () => {
  it('未验证能力不能原地更新；已验证更新不换实例、不换代码版本', () => {
    covers('live-patch');
    const fx = createDomainFixture();
    task(fx, 'unverified', 'asset-unverified', {
      verification: 'unverified',
      capabilities: { supportsInPlaceInputUpdate: true, requiresStandbyRebuild: false, deterministicReplay: false, holdLoop: false, audioOwnership: 'none', realtime: 'unverified' },
    });
    prepare(fx, 'scene-u', 'asset-unverified', 'seg-u');
    const before = fx.snapshot().scenes['scene-u'];
    refused(fx.submit(env(fx, A.director, { kind: 'sceneInstance', id: 'scene-u' }, {
      type: 'updateInputs', instanceId: 'scene-u', inputsRevision: 1, inputs: { votes: 1 },
    })), 'UNSUPPORTED_LIVE_PATCH');
    expect(fx.snapshot().scenes['scene-u']).toMatchObject({
      instanceId: before?.instanceId,
      codeVersion: before?.codeVersion,
      inputsRevision: 0,
      requiresStandbyRebuild: true,
    });
    expect(Object.keys(fx.snapshot().scenes)).toEqual(['scene-u']);

    const live = createDomainFixture();
    task(live, 'verified', 'asset-live', {
      verification: 'passed',
      capabilities: { supportsInPlaceInputUpdate: true, requiresStandbyRebuild: false, deterministicReplay: true, holdLoop: true, audioOwnership: 'bus', realtime: 'player' },
    });
    prepare(live, 'scene-live', 'asset-live', 'seg-live');
    const codeVersion = live.snapshot().scenes['scene-live']?.codeVersion;
    for (let i = 1; i <= 100; i += 1) {
      must(live.submit(env(live, A.director, { kind: 'sceneInstance', id: 'scene-live' }, {
        type: 'updateInputs', instanceId: 'scene-live', inputsRevision: i, inputs: { votes: i },
      })));
    }
    const scene = live.snapshot().scenes['scene-live'];
    expect(scene).toMatchObject({ instanceId: 'scene-live', codeVersion, inputsRevision: 100, inputs: { votes: 100 } });
    expect(Object.keys(live.snapshot().scenes)).toEqual(['scene-live']);
    const loads = live.snapshot().hostCalls.filter((call) => call.op === 'load' && call.instanceId === 'scene-live');
    expect(loads).toHaveLength(1);
  });

  it.skip('TODO(P2) Remotion 与 HTML/GSAP 连续 100 次输入更新不重载 iframe、不归零、不重播入场', () => {
    // 阻塞未解除。脚手架在 packages/scene-host，adapter 仍是 skip。禁止用空 shim 把这行涂绿。
  });
});

describe('§9.3 Program/Preview', () => {
  it('备场不暂停节目时钟，预览不能发声，take 失败保持 A', () => {
    covers('program-preview');
    const fx = createDomainFixture();
    task(fx, 'task-a', 'asset-a');
    task(fx, 'task-b', 'asset-b');
    const before = fx.clock.now();
    prepare(fx, 'scene-a', 'asset-a', 'seg-a');
    fx.clock.advance(1_000);
    expect(fx.clock.running).toBe(true);
    expect(fx.clock.now()).toBe(before + 1_000);
    expect(fx.snapshot().scenes['scene-a']?.audioAllowed).toBe(false);
    refused(fx.submit(env(fx, A.director, { kind: 'sceneInstance', id: 'scene-a' }, { type: 'previewAudio', instanceId: 'scene-a' })), 'PREVIEW_AUDIO_FORBIDDEN');
    refused(fx.submit(env(fx, A.runtime, showTarget(), { type: 'compensateVoiceForDrift' })), 'VOICE_DRIFT_COMPENSATION_FORBIDDEN');
    markReady(fx, 'scene-a');
    expect(fx.snapshot().project.channel.mode).toBe('neutral');
    must(fx.submit(env(fx, A.director, { kind: 'sceneInstance', id: 'scene-a' }, { type: 'take', instanceId: 'scene-a', outcome: 'painted' })));
    expect(fx.snapshot().project.channel).toMatchObject({ mode: 'program', programSceneInstanceId: 'scene-a' });
    expect(fx.snapshot().project.channel.persistentLayers).toEqual(['caption', 'character', 'base']);

    prepare(fx, 'scene-b', 'asset-b', 'seg-b');
    speechTo(fx, 'while-b', 'B 在加载我也能说', 'offered');
    const targetB: CommandTarget = { kind: 'sceneInstance', id: 'scene-b' };
    must(fx.submit(env(fx, A.runtime, targetB, {
      type: 'noteReadiness', instanceId: 'scene-b', gate: 'moduleLoad', observation: { status: 'timedOut' },
    })));
    for (const gate of READINESS_GATES.filter((item) => item !== 'moduleLoad')) {
      must(fx.submit(env(fx, A.runtime, targetB, {
        type: 'noteReadiness', instanceId: 'scene-b', gate, observation: { status: 'ok' },
      })));
    }
    expect(fx.snapshot().scenes['scene-b']?.readiness.moduleLoad.status).toBe('timedOut');
    refused(fx.submit(env(fx, A.director, targetB, { type: 'take', instanceId: 'scene-b' })), 'SCENE_NOT_READY');
    expect(fx.snapshot().project.channel.programSceneInstanceId).toBe('scene-a');
    expect(fx.clock.running).toBe(true);

    const retry = createDomainFixture();
    task(retry, 'task-a2', 'asset-a2');
    task(retry, 'task-b2', 'asset-b2');
    prepare(retry, 'scene-a2', 'asset-a2', 'seg-a2');
    markReady(retry, 'scene-a2');
    must(retry.submit(env(retry, A.director, { kind: 'sceneInstance', id: 'scene-a2' }, { type: 'take', instanceId: 'scene-a2' })));
    prepare(retry, 'scene-b2', 'asset-b2', 'seg-b2');
    markReady(retry, 'scene-b2');
    must(retry.submit(env(retry, A.director, { kind: 'sceneInstance', id: 'scene-b2' }, { type: 'take', instanceId: 'scene-b2', outcome: 'failed' })));
    expect(retry.snapshot().project.channel.programSceneInstanceId).toBe('scene-a2');
    expect(retry.snapshot().playback.some((item) => item.sceneInstanceId === 'scene-b2' && item.kind === 'failed')).toBe(true);
    refused(retry.submit(env(retry, A.director, { kind: 'timeline', id: FIXTURE_IDS.timeline }, {
      type: 'editFutureTimeline', segmentId: 'seg-b2', label: '假装没切过',
    })), 'TOO_LATE');

    const held = fx.clock.mapScene('scene-a').localMs;
    must(fx.submit(env(fx, A.director, { kind: 'sceneInstance', id: 'scene-a' }, { type: 'holdScene', instanceId: 'scene-a' })));
    const frozen = fx.clock.mapScene('scene-a').localMs;
    const showTime = fx.clock.now();
    fx.clock.advance(2_000);
    expect(fx.clock.mapScene('scene-a').hold).toBe(true);
    expect(fx.clock.mapScene('scene-a').localMs).toBe(frozen);
    expect(fx.clock.now()).toBe(showTime + 2_000);
    expect(fx.clock.running).toBe(true);
    expect(frozen).toBeGreaterThanOrEqual(held);
  });

  it.skip('TODO(P2) 真实备场 B 的加载、失败、超时、无声和 take 后释放 GPU/监听', () => {
    // P1 的四项门闩没有冻结超时数字。离屏节流和资源释放要等独立 React 19 宿主。
  });
});

describe('§9.3 Cue/语音', () => {
  it('未念到的锚点不能出画面；已派发的历史不能改；estimated 不是 real', () => {
    covers('cue-speech');
    const fx = createDomainFixture();
    speechTo(fx, 'line', '一二三', 'queued');
    const cue: CommandTarget = { kind: 'cue', id: 'ghost' };
    must(fx.submit(env(fx, A.director, cue, {
      type: 'bindCue',
      cue: { cueId: 'ghost', anchor: { kind: 'speech', partId: 'line', charIndex: 0 }, payload: { shot: 'wide' } },
    })));
    refused(fx.submit(env(fx, A.runtime, cue, { type: 'dispatchCue', cueId: 'ghost' })), 'ANCHOR_INVALID');
    expect(fx.snapshot().cues.ghost?.status).toBe('future');
    must(fx.submit(env(fx, A.performer, { kind: 'speechPart', id: 'line' }, { type: 'yieldSpeech', partId: 'line' })));
    expect(fx.snapshot().cues.ghost?.status).toBe('invalidated');

    const played = createDomainFixture();
    speechTo(played, 'est', '一二三', 'playing');
    expect(played.snapshot().speech.est?.alignment.mode).toBe('estimated');
    speechTo(played, 'said', '一二三', 'starting');
    const said: CommandTarget = { kind: 'speechPart', id: 'said' };
    refused(played.submit(env(played, A.runtime, said, { type: 'receiptSpeech', partId: 'said', kind: 'playing', alignment: 'real' })), 'ILLEGAL_TRANSITION');
    expect(played.snapshot().speech.said?.alignment.mode).toBe('absent');
    must(played.submit(env(played, A.runtime, said, {
      type: 'receiptSpeech', partId: 'said', kind: 'playing', alignment: 'real', starts: [0, 40, 80], spokenChars: 3,
    })));
    expect(played.snapshot().speech.said?.alignment.mode).toBe('real');
    const bound: CommandTarget = { kind: 'cue', id: 'hit' };
    must(played.submit(env(played, A.director, bound, {
      type: 'bindCue',
      cue: { cueId: 'hit', anchor: { kind: 'speech', partId: 'said', charIndex: 1 }, payload: { shot: 'close' } },
    })));
    must(played.submit(env(played, A.runtime, bound, { type: 'dispatchCue', cueId: 'hit' })));
    const payload = played.snapshot().cues.hit?.payload;
    refused(played.submit(env(played, A.director, bound, { type: 'editCue', cueId: 'hit', payload: { shot: 'rewritten' } })), 'TOO_LATE');
    expect(played.snapshot().cues.hit?.payload).toEqual(payload);
    refused(played.submit(env(played, A.runtime, bound, { type: 'dispatchCue', cueId: 'hit' })), 'CUE_ALREADY_EXECUTED');
    must(played.submit(env(played, A.runtime, said, { type: 'receiptSpeech', partId: 'said', kind: 'ended', spokenChars: 3 })));
    const text = played.snapshot().speech.said?.text;
    refused(played.submit(env(played, A.performer, said, { type: 'editSpeech', partId: 'said', text: '改历史' })), 'TOO_LATE');
    expect(played.snapshot().speech.said?.text).toBe(text);
  });

  it.skip('TODO(P3) 真实逐字时标和媒体回放证据', () => {
    // alignment.mode = real 只是契约字段。没有音频文件和播放回执不能当成已证明。
  });
});

describe('§9.3 并发冲突', () => {
  it('过期 revision 被拒；断线重连不重放已提交 cue；starting 之后 TOO_LATE', () => {
    covers('concurrency');
    const fx = createDomainFixture();
    task(fx, 'patch-task', 'asset-patch', {
      verification: 'passed',
      capabilities: { supportsInPlaceInputUpdate: true, requiresStandbyRebuild: false, deterministicReplay: true, holdLoop: true, audioOwnership: 'bus', realtime: 'player' },
    });
    prepare(fx, 'scene-p', 'asset-patch', 'seg-p');
    const sceneTarget: CommandTarget = { kind: 'sceneInstance', id: 'scene-p' };
    const speechTarget: CommandTarget = { kind: 'speechPart', id: 'aside' };
    const sceneRevision = fx.revision(sceneTarget);
    must(fx.submit(env(fx, A.performer, speechTarget, { type: 'offerSpeech', partId: 'aside', text: '口播不该挡住画面' })));
    expect(fx.revision(sceneTarget)).toBe(sceneRevision);
    must(fx.submit(env(fx, A.director, sceneTarget, {
      type: 'updateInputs', instanceId: 'scene-p', inputsRevision: 1, inputs: { votes: 1 },
    })));
    expect(fx.snapshot().speech.aside?.revision).toBe(1);
    const stale = env(fx, A.director, sceneTarget, {
      type: 'updateInputs', instanceId: 'scene-p', inputsRevision: 2, inputs: { votes: 2 },
    });
    stale.expectedRevision = sceneRevision;
    refused(fx.submit(stale), 'REVISION_CONFLICT');
    expect(fx.snapshot().scenes['scene-p']?.inputs).toEqual({ votes: 1 });
    const again = { ...stale, commandId: 'replay', idempotencyKey: stale.idempotencyKey };
    refused(fx.submit(again), 'REVISION_CONFLICT');
    expect(fx.snapshot().scenes['scene-p']?.inputsRevision).toBe(1);

    const spoken = createDomainFixture();
    speechTo(spoken, 'part', '已经开播', 'starting');
    expect(spoken.snapshot().playback.filter((item) => item.partId === 'part' && item.kind === 'spoken')).toHaveLength(0);
    const text = spoken.snapshot().speech.part?.text;
    refused(spoken.submit(env(spoken, A.performer, { kind: 'speechPart', id: 'part' }, {
      type: 'editSpeech', partId: 'part', text: '太晚了',
    })), 'TOO_LATE');
    refused(spoken.submit(env(spoken, A.performer, { kind: 'speechPart', id: 'part' }, {
      type: 'yieldSpeech', partId: 'part',
    })), 'TOO_LATE');
    expect(spoken.snapshot().speech.part?.text).toBe(text);
    expect(spoken.snapshot().speech.part?.state).toBe('starting');

    const cueFx = createDomainFixture();
    speechTo(cueFx, 'anchor', '念到了', 'playing');
    const cueTarget: CommandTarget = { kind: 'cue', id: 'once' };
    must(cueFx.submit(env(cueFx, A.director, cueTarget, {
      type: 'bindCue',
      cue: { cueId: 'once', anchor: { kind: 'speech', partId: 'anchor', charIndex: 0 }, payload: { n: 1 } },
    })));
    must(cueFx.submit(env(cueFx, A.runtime, cueTarget, { type: 'dispatchCue', cueId: 'once' })));
    const dispatched = cueFx.snapshot().events.filter((event) => {
      const payload = event.payload as { cueId?: string; status?: string };
      return payload.cueId === 'once' && payload.status === 'dispatched';
    });
    cueFx.disconnect();
    refused(cueFx.submit(env(cueFx, A.runtime, cueTarget, { type: 'dispatchCue', cueId: 'once' })), 'DISCONNECTED');
    must(cueFx.submit(env(cueFx, A.runtime, showTarget(), { type: 'reconnect' })));
    refused(cueFx.submit(env(cueFx, A.runtime, cueTarget, { type: 'dispatchCue', cueId: 'once' })), 'CUE_ALREADY_EXECUTED');
    const after = cueFx.snapshot().events.filter((event) => {
      const payload = event.payload as { cueId?: string; status?: string };
      return payload.cueId === 'once' && payload.status === 'dispatched';
    });
    expect(after).toHaveLength(dispatched.length);
    expect(cueFx.snapshot().committedCueIds).toEqual(['once']);

    refused(fx.submit(env(fx, A.production, sceneTarget, { type: 'take', instanceId: 'scene-p' })), 'NOT_AUTHORIZED');
    refused(fx.submit(env(fx, A.performer, { kind: 'timeline', id: FIXTURE_IDS.timeline }, {
      type: 'editFutureTimeline', segmentId: 'nope', label: '主播改轨',
    })), 'NOT_AUTHORIZED');
    expect(() => fx.sceneHost.take('scene-p')).toThrow(/SceneHost/);
  });
});

describe('§9.3 生命周期与历史', () => {
  it('重连不重放，dispose 清掉该实例的域级订阅，迟到回执不写进新实例', () => {
    covers('lifecycle');
    const fx = createDomainFixture();
    task(fx, 'life-a', 'asset-life-a');
    task(fx, 'life-b', 'asset-life-b');
    prepare(fx, 'old', 'asset-life-a', 'seg-old');
    markReady(fx, 'old');
    must(fx.submit(env(fx, A.director, { kind: 'sceneInstance', id: 'old' }, { type: 'take', instanceId: 'old', outcome: 'started' })));
    expect(fx.snapshot().playback.some((item) => item.kind === 'painted')).toBe(false);
    must(fx.submit(env(fx, A.runtime, { kind: 'sceneInstance', id: 'old' }, {
      type: 'recordPlayback',
      receipt: { id: 'paint-old', kind: 'painted', sceneInstanceId: 'old', assetVersionId: 'asset-life-a' },
    })));
    expect(fx.snapshot().project.channel.programSceneInstanceId).toBe('old');
    must(fx.submit(env(fx, A.runtime, { kind: 'sceneInstance', id: 'old' }, { type: 'disposeScene', instanceId: 'old' })));
    expect(fx.snapshot().scenes.old).toMatchObject({ subscriptions: 0, surface: 'disposed' });
    prepare(fx, 'fresh', 'asset-life-b', 'seg-fresh');
    const freshBefore = fx.snapshot().scenes.fresh;
    must(fx.submit(env(fx, A.runtime, { kind: 'sceneInstance', id: 'old' }, {
      type: 'recordPlayback',
      receipt: { id: 'late-paint', kind: 'painted', sceneInstanceId: 'old', assetVersionId: 'asset-life-a' },
    })));
    const freshAfter = fx.snapshot().scenes.fresh;
    expect(fx.snapshot().playback.find((item) => item.id === 'late-paint')?.orphan).toBe(true);
    expect(freshAfter?.inputsRevision).toBe(freshBefore?.inputsRevision);
    expect(freshAfter?.readiness).toEqual(freshBefore?.readiness);
    expect(freshAfter?.instanceId).toBe('fresh');
  });

  it.skip('TODO(P2/P9) 连续切场和长时间运行后的资源曲线', () => {
    // 域级订阅归零不是 GPU、音频或 30 分钟趋势证明。
  });
});

describe('§9.3 留给后续阶段的行', () => {
  it.skip('TODO(P2/P4) SDK 代表场景：Remotion、HF/GSAP、D3、轻量 Three 的真实能力认证', () => {
    // 不 vendor 私有 SDK，也不写同名空接口冒充复用。
  });

  it.skip('TODO(P8) 常驻 UI：长消息、礼物、两套布景和无半卡', () => {
    // 现有舞台测试覆盖旧 UI。本契约夹具不假装验收了布局。
  });

  it.skip('TODO(P3/P9) 回放导出：用实际输入、语音、hold 和场景版本重建播出区间', () => {
    // PlaybackEvent 只作为将来的重建输入，这里不生成 Film。
  });
});

describe('矩阵归属', () => {
  it('§9.3 每一行要么有 P1 事件序列，要么写明后续阶段', () => {
    for (const row of MATRIX_ROWS) {
      if (row.domain === 'deferred') {
        expect(row.todo, row.row).toMatch(/TODO\(P[2-9]/);
        expect(proven.has(row.id), row.row).toBe(false);
      } else {
        expect(proven.has(row.id), row.row).toBe(true);
        if (row.domain === 'partial') expect(row.todo, row.row).toMatch(/TODO\(P[2-9]/);
      }
    }
  });
});

function mustRead(result: ReturnType<DomainFixture['read']>): PerformerReadModel | DirectorReadModel {
  if (!result.ok) throw new Error(result.message);
  return result.value as PerformerReadModel | DirectorReadModel;
}
