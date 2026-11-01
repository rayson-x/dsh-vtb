/**
 * P8 薄适配骨架。
 * 夹具证明：同一舞台只有一条控制路径；切到 v2 会停掉旧 loop 和订阅；可以切回；
 * 双路径同时 active 被拒；常见旧命令能映射，不能映射的返回 unsupported；切换不删素材。
 * 默认仍是 legacy。不接真实控制台，也不做全量切流。
 */

import { describe, expect, it } from 'vitest';
import { FIXTURE_ACTORS } from '../src/live/domain/index';
import { LIVE2D_CHARACTER } from '../src/page/live2d/logic';
import {
  ControlPathRegistry,
  EngineeringKernel,
  FIXTURE_CHARACTER_ID,
  LegacyControlLoop,
  P8_ACCEPTANCE,
  P8_MATRIX,
  ROLLBACK_POLICY,
  SWITCH_TO_V2_POLICY,
  StageControl,
  adaptLegacyCommand,
  fixtureInventory,
  inventoryFingerprint,
  openStageControl,
  refuseDestructiveMigration,
  type AdaptContext,
  type DanmakuBatch,
} from '../src/live/index';

const OWNER = { actorId: 'owner-1', reason: '演练切换', at: 1_700_000_000_000 };

function batch(batchId: string, text: string): DanmakuBatch {
  return {
    batchId,
    items: [
      {
        platform: 'bilibili',
        externalId: batchId,
        audienceId: 'viewer-1',
        text,
        receivedAt: 20,
      },
    ],
  };
}

function adaptCtx(kernel: EngineeringKernel, commandId: string, expectedRevision: number): AdaptContext {
  return {
    showId: kernel.view().project.id,
    directionEpoch: kernel.epoch(),
    expectedRevision,
    receivedAt: 30,
    commandId,
  };
}

describe('P8 还没完成', () => {
  it('三条完成条件保持未勾，表格里的真实链路是 skip', () => {
    expect(P8_ACCEPTANCE.passed).toBe(false);
    expect(P8_ACCEPTANCE.headline).toBe('P8 薄适配骨架，默认仍可不切 v2');
    expect(P8_ACCEPTANCE.defaultMode).toBe('legacy');
    expect(P8_ACCEPTANCE.checklist).toEqual({
      singleControlPath: false,
      userDataAndAssetsKept: false,
      rollbackPolicy: false,
    });
    expect(P8_MATRIX).toEqual([
      { scene: '单路径互斥', result: 'pass' },
      { scene: '切 v2 停旧订阅', result: 'pass' },
      { scene: '切回 legacy', result: 'pass' },
      { scene: '双路径同时 active 被拒', result: 'pass' },
      { scene: '旧命令映射', result: 'pass' },
      { scene: '无法映射返回 unsupported', result: 'pass' },
      { scene: '素材清单保留', result: 'pass' },
      { scene: '真实控制台 UI 接线', result: 'skip' },
      { scene: '全量切流', result: 'skip' },
    ]);
  });

  it.skip('TODO(P8) 真实控制台 UI 接到 legacy/v2 切换', () => {
    // 本骨架不改控制台页面，也不把切换接进现有舞台宿主。
  });

  it.skip('TODO(P8) 全量切流：停掉现有主持人主路径并改默认', () => {
    // 默认仍是 legacy。不改 agent.ts 主路径。
  });
});

describe('单路径互斥', () => {
  it('打开舞台时只有 legacy 是 active，再次打开不会再起一个控制器', () => {
    const stage = openStageControl('stage-exclusive');
    expect(stage.flag()).toEqual({
      stageId: 'stage-exclusive',
      mode: 'legacy',
      explicit: true,
      siteDefault: 'legacy',
    });
    expect(stage.mode()).toBe('legacy');
    expect(stage.activePaths()).toEqual(['legacy']);
    expect(stage.legacy.running).toBe(true);
    expect(stage.legacy.subscriptionActive).toBe(true);
    expect(stage.v2.active).toBe(false);
    expect(stage.v2.subscriptionActive).toBe(false);
    expect(openStageControl('stage-exclusive')).toBe(stage);
    expect(() => new StageControl('stage-exclusive')).toThrow(/已经有控制器/);

    const registry = new ControlPathRegistry();
    expect(registry.open('stage-exclusive')).toBe(stage);
    const other = openStageControl('stage-exclusive-other');
    expect(registry.bind('stage-exclusive', other)).toEqual({
      ok: false,
      code: 'stage-already-controlled',
      active: 'legacy',
    });
    expect(registry.get('stage-exclusive')).toBe(stage);
    expect(other.activePaths()).toEqual(['legacy']);
    other.switchTo('v2', { ...OWNER, at: 2, reason: '另一舞台试切' });
    expect(stage.mode()).toBe('legacy');
    expect(stage.legacy.subscriptionActive).toBe(true);
    expect(other.mode()).toBe('v2');
  });
});

describe('切到 v2 停掉旧订阅', () => {
  it('停 loop 和订阅，而不是只丢弃输出继续烧模型调用', () => {
    const stage = openStageControl('stage-stop-legacy');
    stage.legacy.tick();
    expect(stage.legacy.modelCalls).toBe(1);
    expect(stage.legacy.subscriptionActive).toBe(true);

    const bare = new LegacyControlLoop();
    bare.start();
    bare.discardOutputOnly();
    bare.tick();
    expect(bare.subscriptionActive).toBe(true);
    expect(bare.modelCalls).toBe(1);
    expect(bare.discarded).toBe(1);
    bare.tick();
    expect(bare.modelCalls).toBe(2);

    expect(() => stage.legacy.discardOutputOnly()).toThrow(/只丢输出/);
    const calls = stage.legacy.modelCalls;
    const switched = stage.switchTo('v2', { ...OWNER, at: 10, reason: '试切 v2' });
    expect(switched.ok).toBe(true);
    if (!switched.ok) return;
    expect(switched.audit).toMatchObject({
      stageId: 'stage-stop-legacy',
      actorId: 'owner-1',
      reason: '试切 v2',
      at: 10,
      from: 'legacy',
      to: 'v2',
      policy: SWITCH_TO_V2_POLICY,
      outputDiscardedOnly: false,
      stopped: { path: 'legacy', loop: true, subscription: true },
      started: 'v2',
      legacyModelCalls: calls,
    });
    expect(stage.audit).toEqual([switched.audit]);
    expect(stage.legacy.running).toBe(false);
    expect(stage.legacy.subscriptionActive).toBe(false);
    expect(stage.legacy.stopReason).toBe('switch-to-v2');
    stage.legacy.tick();
    expect(stage.legacy.modelCalls).toBe(calls);
    expect(stage.legacy.start()).toBe(false);
    expect(stage.v2.active).toBe(true);
    expect(stage.v2.subscriptionActive).toBe(true);
    expect(stage.activePaths()).toEqual(['v2']);
    expect(stage.flag().mode).toBe('v2');
    expect(stage.flag().siteDefault).toBe('legacy');

    const same = stage.switchTo('v2', { ...OWNER, at: 11, reason: '重复切' });
    expect(same).toEqual({ ok: false, code: 'same-mode', mode: 'v2' });
    expect(stage.audit).toHaveLength(1);
  });

  it('缺少审计字段时不切换', () => {
    const stage = openStageControl('stage-audit');
    expect(stage.switchTo('v2', { actorId: ' ', reason: '试切', at: 1 })).toEqual({
      ok: false,
      code: 'missing-audit',
      mode: 'legacy',
    });
    expect(stage.switchTo('v2', { actorId: 'owner-1', reason: ' ', at: 1 })).toEqual({
      ok: false,
      code: 'missing-audit',
      mode: 'legacy',
    });
    expect(stage.switchTo('v2', { actorId: 'owner-1', reason: '试切', at: Number.NaN })).toEqual({
      ok: false,
      code: 'invalid-time',
      mode: 'legacy',
    });
    expect(stage.mode()).toBe('legacy');
    expect(stage.legacy.subscriptionActive).toBe(true);
    expect(stage.audit).toEqual([]);
  });
});

describe('切回 legacy', () => {
  it('先停 v2 订阅，再恢复旧 loop', () => {
    const stage = openStageControl('stage-rollback');
    expect(stage.switchTo('v2', { ...OWNER, at: 20, reason: '切到 v2' }).ok).toBe(true);
    stage.v2.noteDelivery();
    expect(stage.v2.deliveries).toBe(1);

    const back = stage.switchTo('legacy', { ...OWNER, at: 21, reason: '切回 legacy' });
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.audit.policy).toBe(ROLLBACK_POLICY);
    expect(back.audit.stopped).toEqual({ path: 'v2', loop: true, subscription: true });
    expect(back.audit.started).toBe('legacy');
    expect(back.audit.outputDiscardedOnly).toBe(false);
    expect(stage.v2.active).toBe(false);
    expect(stage.v2.subscriptionActive).toBe(false);
    expect(stage.v2.stopReason).toBe('rollback-to-legacy');
    expect(stage.v2.noteDelivery()).toBe(false);
    expect(stage.v2.deliveries).toBe(1);
    expect(stage.legacy.running).toBe(true);
    expect(stage.legacy.subscriptionActive).toBe(true);
    expect(stage.activePaths()).toEqual(['legacy']);
    expect(stage.mode()).toBe('legacy');
    const calls = stage.legacy.modelCalls;
    stage.legacy.tick();
    expect(stage.legacy.modelCalls).toBe(calls + 1);
    expect(stage.audit.map((event) => event.to)).toEqual(['v2', 'legacy']);
  });
});

describe('双路径同时 active 被拒', () => {
  it('activate 不会在另一条还活着时把第二条点亮', () => {
    const stage = openStageControl('stage-dual');
    expect(stage.activate('v2')).toEqual({ ok: false, code: 'other-path-active', active: 'legacy' });
    expect(stage.activate('legacy')).toEqual({ ok: false, code: 'already-active', active: 'legacy' });
    expect(stage.activePaths()).toEqual(['legacy']);
    expect(stage.v2.active).toBe(false);
    expect(stage.audit).toEqual([]);

    expect(stage.switchTo('v2', { ...OWNER, at: 30, reason: '只留 v2' }).ok).toBe(true);
    expect(stage.activate('legacy')).toEqual({ ok: false, code: 'other-path-active', active: 'v2' });
    expect(stage.legacy.running).toBe(false);
    expect(stage.legacy.subscriptionActive).toBe(false);
    expect(stage.activePaths()).toEqual(['v2']);
  });
});

describe('旧命令映射', () => {
  it('say、enqueue、danmaku 映射成 CommandEnvelope，不写成播放回执', () => {
    const kernel = new EngineeringKernel();
    const say = adaptLegacyCommand(
      { type: 'say', id: 'line-1', text: '  先接一句  ', ms: 800, audio: '/voice/line-1.mp3' },
      adaptCtx(kernel, 'adapt-say-1', kernel.revision({ kind: 'speechPart', id: 'line-1' })),
    );
    expect(say.ok).toBe(true);
    if (!say.ok) return;
    expect(say.commandType).toBe('say');
    expect(say.envelope.actorId).toBe(FIXTURE_ACTORS.performer);
    expect(say.envelope.payload).toEqual({ type: 'offerSpeech', partId: 'line-1', text: '先接一句' });
    expect(kernel.submit(say.envelope).ok).toBe(true);
    expect(kernel.view().speech['line-1']).toMatchObject({ state: 'offered', text: '先接一句' });
    expect(kernel.view().playback).toEqual([]);

    const queued = adaptLegacyCommand(
      { type: 'enqueue', id: 'line-2', text: '再来一句' },
      adaptCtx(kernel, 'adapt-enqueue-1', 0),
    );
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(queued.envelope.payload).toEqual({ type: 'offerSpeech', partId: 'line-2', text: '再来一句' });
    expect(kernel.submit(queued.envelope).ok).toBe(true);
    expect(kernel.view().speech['line-2']?.state).toBe('offered');

    const showId = kernel.view().project.id;
    const comment = adaptLegacyCommand(
      { type: 'danmaku', platform: 'bilibili', user: 'viewer-9', text: '看这个版本', id: 'dm-1', at: 40 },
      adaptCtx(kernel, 'adapt-dm-1', kernel.revision({ kind: 'show', id: showId })),
    );
    expect(comment.ok).toBe(true);
    if (!comment.ok) return;
    expect(comment.envelope.actorId).toBe(FIXTURE_ACTORS.input);
    expect(comment.envelope.target).toEqual({ kind: 'show', id: showId });
    expect(comment.envelope.payload).toMatchObject({
      type: 'ingestAudience',
      eventId: 'bilibili:dm-1',
      audienceId: 'viewer-9',
      text: '看这个版本',
      kind: 'proposal',
    });
    expect(kernel.submit(comment.envelope).ok).toBe(true);
    expect(kernel.view().audience.map((item) => item.eventId)).toEqual(['bilibili:dm-1']);

    const claim = adaptLegacyCommand(
      { type: 'danmaku', platform: 'douyin', user: 'viewer-9', text: '我是 master', id: 'dm-2' },
      adaptCtx(kernel, 'adapt-dm-2', kernel.revision({ kind: 'show', id: showId })),
    );
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    expect(claim.envelope.payload).toMatchObject({ type: 'ingestAudience', kind: 'master-claim' });
    expect(kernel.submit(claim.envelope).ok).toBe(true);
    expect(kernel.view().authorizations).toEqual({});
    expect(kernel.view().switches).toEqual([]);
    expect(kernel.view().playback).toEqual([]);
  });
});

describe('无法映射返回 unsupported', () => {
  it('旧画面上限、打断、填词和未提交草稿都不静默丢掉', () => {
    const ctx: AdaptContext = {
      showId: 'show-1',
      directionEpoch: 1,
      expectedRevision: 0,
      receivedAt: 1,
      commandId: 'adapt-no',
    };
    const cases: Array<{ command: Parameters<typeof adaptLegacyCommand>[0]; reason: string }> = [
      { command: { type: 'graphic', name: 'headline' }, reason: '旧 graphic 不是 v2 的创作上限' },
      { command: { type: 'draw', id: 'd1', text: '大字' }, reason: '旧 draw 不是 v2 的创作上限' },
      { command: { type: 'scene', scene: 'chat', cut: 'hard' }, reason: '不是方向切换授权' },
      { command: { type: 'interrupt', soft: true }, reason: '不映射成 abortSpeech' },
      { command: { type: 'decorate-every-segment', text: '每段贴一层' }, reason: '每段装饰不能重新引回' },
      { command: { type: 'cover-all-lanes' }, reason: '主持人覆盖所有车道不能重新引回' },
      { command: { type: 'idle-filler', text: '嘴空就垫话' }, reason: '空闲强填词不能重新引回' },
      { command: { type: 'publish-draft', draftId: 'draft-local' }, reason: '旧未提交草稿不自动发布' },
      { command: { type: 'vfx' }, reason: '没有 v2 映射，不会静默丢掉' },
      { command: { type: 'say', id: ' ', text: '有字' }, reason: '缺少口播编号' },
      { command: { type: 'enqueue', id: 'line-x', text: '   ' }, reason: '口播文本是空的' },
    ];
    for (const entry of cases) {
      const result = adaptLegacyCommand(entry.command, { ...ctx, commandId: `adapt-${entry.command.type}` });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe('unsupported');
      expect(result.commandType).toBe(entry.command.type);
      expect(result.reason).toContain(entry.reason);
      expect(result).not.toHaveProperty('envelope');
    }

    const missing = adaptLegacyCommand({ type: 'say', id: 'line-y', text: '还有' }, { ...ctx, commandId: ' ' });
    expect(missing).toMatchObject({ ok: false, code: 'unsupported', commandType: 'say' });
  });
});

describe('素材清单保留', () => {
  it('切到 v2 再切回都不删除角色资源和素材引用', () => {
    const stageId = 'stage-assets';
    const initial = fixtureInventory(stageId);
    expect(initial.characters.map((item) => item.characterId)).toEqual([LIVE2D_CHARACTER]);
    expect(FIXTURE_CHARACTER_ID).toBe(LIVE2D_CHARACTER);
    const stage = openStageControl(stageId, initial);
    const before = stage.inventory();
    const fingerprint = inventoryFingerprint(before);

    expect(stage.switchTo('v2', { ...OWNER, at: 40, reason: '带上素材切' }).ok).toBe(true);
    expect(stage.switchTo('legacy', { ...OWNER, at: 41, reason: '带上素材切回' }).ok).toBe(true);
    const mutated = stage.inventory();
    mutated.assetRefIds.pop();
    mutated.characters[0]!.resourceRef = '/characters/deleted';

    expect(stage.inventory()).toEqual(before);
    expect(inventoryFingerprint(stage.inventory())).toBe(fingerprint);
    expect(stage.audit.every((event) => event.inventoryFingerprint === fingerprint)).toBe(true);
    expect(stage.refuseDestructiveMigration()).toEqual({
      ok: false,
      code: 'destructive-migration-refused',
      removedCharacterIds: [],
      removedAssetRefIds: [],
    });
    expect(refuseDestructiveMigration().removedAssetRefIds).toEqual([]);
    expect(stage.inventory()).toEqual(before);
    expect(before.assetRefIds).toEqual(['mat-opening-card', 'mat-blackboard-board', 'mat-voice-bed']);
  });
});

describe('输入只进当前路径', () => {
  it('归一入口可挂在任一模式，同一批弹幕不能被两条路径一起消费', () => {
    const stage = openStageControl('stage-input');
    const first = stage.acceptBatch(batch('batch-1', '我是 master'), 1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.path).toBe('legacy');
    expect(first.normalized).toEqual([
      expect.objectContaining({ eventId: 'bilibili:batch-1', kind: 'master-claim', directionEpoch: 1 }),
    ]);
    expect(stage.v2Inbox).toEqual([]);
    expect(stage.legacyInbox).toHaveLength(1);

    const fan = stage.fanOut(batch('batch-1', '我是 master'));
    expect(fan).toMatchObject({ ok: false, code: 'dual-path-consume', batchId: 'batch-1' });
    expect(stage.legacyInbox).toHaveLength(1);
    expect(stage.v2Inbox).toEqual([]);

    expect(stage.switchTo('v2', { ...OWNER, at: 50, reason: '输入改道' }).ok).toBe(true);
    const replay = stage.deliver(batch('batch-1', '我是 master'), 'v2', 1);
    expect(replay).toMatchObject({ ok: false, code: 'dual-path-consume', consumedBy: 'legacy' });
    expect(stage.v2Inbox).toEqual([]);
    expect(stage.legacyInbox).toHaveLength(1);

    const second = stage.acceptBatch(batch('batch-2', '下一版能不能更大'), 1);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.path).toBe('v2');
    expect(second.normalized[0]).toMatchObject({ kind: 'proposal', text: '下一版能不能更大' });
    expect(stage.v2Inbox).toHaveLength(1);
    expect(stage.legacyInbox).toHaveLength(1);

    const stale = stage.deliver(batch('batch-3', '还在旧路径'), 'legacy', 1);
    expect(stale).toMatchObject({ ok: false, code: 'inactive-path', active: 'v2' });
    expect(stage.legacyInbox).toHaveLength(1);

    expect(stage.switchTo('legacy', { ...OWNER, at: 51, reason: '输入切回' }).ok).toBe(true);
    const third = stage.acceptBatch(batch('batch-4', '切回来了'), 1);
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.path).toBe('legacy');
    expect(stage.v2Inbox).toHaveLength(1);
    expect(stage.legacyInbox.map((item) => item.batchId)).toEqual(['batch-1', 'batch-4']);
    expect(stage.v2.subscriptionActive).toBe(false);
  });
});
