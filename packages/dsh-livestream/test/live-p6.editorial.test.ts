/**
 * P6 编导与制作骨架。
 * 夹具证明：无请求可供给候选、候选不上播、越权不切方向、ready 不 take、过期 epoch 不复用。
 * 不跑模型，不接 SceneHost / Player，也不把 P6_ACCEPTANCE 涂成完成。
 */

import { describe, expect, it } from 'vitest';
import { pick } from '../../scene-package/src/ports.ts';
import { gateAction } from '../src/live/agents/gate';
import { compareRundownRevision } from '../src/live/agents/editorial/rundown';
import { fixtureScenePackage } from '../src/live/agents/production/fixture-package';
import {
  FIXTURE_ACTORS,
  type CommandEnvelope,
  type CommandResult,
  type CommandTarget,
  type ShowCommand,
} from '../src/live/domain/index';
import { EngineeringKernel, P6_ACCEPTANCE, openP6 } from '../src/live/index';

const A = FIXTURE_ACTORS;
let commandSeq = 0;

function env(
  kernel: EngineeringKernel,
  actorId: string,
  target: CommandTarget,
  payload: ShowCommand,
): CommandEnvelope {
  commandSeq += 1;
  const id = `p6-test-${payload.type}-${commandSeq}`;
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

function must(result: CommandResult): void {
  if (!result.ok) throw new Error(`${result.reject}: ${result.message}`);
}

function switchDirection(kernel: EngineeringKernel): void {
  const directionId = kernel.view().project.currentDirectionId;
  const target: CommandTarget = { kind: 'direction', id: directionId };
  const authorizationId = `auth-p6-${kernel.epoch()}-${commandSeq}`;
  must(kernel.submit(env(kernel, A.master, target, {
    type: 'issueSwitchAuthorization',
    authorizationId,
    kind: 'master-soft',
    reason: '夹具软切，不是编导签发',
  })));
  must(kernel.submit(env(kernel, A.director, target, {
    type: 'switchDirection',
    authorizationId,
    strategy: 'soft',
    next: { transition: true },
  })));
}

function silentPackage(id: string) {
  return fixtureScenePackage({
    id,
    codeVersion: `${id}-code`,
    provenance: 'P6 夹具明确声明没有场景音频，不是把 unverified 写成 none，也不是已认证组件。',
    sourceRef: `p6:${id}`,
    declareSilent: true,
  });
}

describe('P6 还没完成', () => {
  it('三条完成条件保持未勾', () => {
    expect(P6_ACCEPTANCE.passed).toBe(false);
    expect(P6_ACCEPTANCE.headline).toBe('P6 骨架，不是完成');
    expect(P6_ACCEPTANCE.checklist).toEqual({
      unsolicitedSupply: false,
      mainlineAuthorization: false,
      backgroundSubmissionIsCandidateOnly: false,
    });
  });

  it.skip('TODO(P6) 真实 DSH session 里的编导/制作模型决定循环', () => {
    // 需要真实 DSH 与模型链路。夹具不注入模型答案，也不假装岗位已经在直播。
  });

  it.skip('TODO(P4) 私有 SDK 的 pick / scaffold 产出可认证 ScenePackage', () => {
    // P4 认证未完成。没有私有 SDK 时 pick 只返回 blocked。禁止用 shim 把这行涂绿。
  });

  it.skip('TODO(P2) 候选接到 SceneHost 之后观众实际看到', () => {
    // P2 未通过。本骨架不接播放器，ready 不能写成已上播或已兑现。
  });
});

describe('无请求主动供给', () => {
  it('当前、下一、过场都有候选，而且没有上播', () => {
    const { harness, editorial } = openP6();
    const supplied = editorial.supplyWithoutRequest();
    expect(supplied.ok).toBe(true);
    if (!supplied.ok) return;
    expect(supplied.audienceCount).toBe(0);
    expect(supplied.pumped).toBe(false);
    expect(supplied.pumpCount).toBe(0);
    expect(harness.kernel.view().audience).toEqual([]);
    expect(harness.queue.waitingCount()).toBe(1);
    expect(harness.queue.runningCount()).toBe(0);

    expect(supplied.pools.current).toHaveLength(1);
    expect(supplied.pools.next).toHaveLength(1);
    expect(supplied.pools.transition).toHaveLength(1);
    const entries = [...supplied.pools.current, ...supplied.pools.next, ...supplied.pools.transition];
    expect(entries.every((entry) => entry.onAir === false)).toBe(true);
    expect(supplied.pools.current[0]?.ref).toMatchObject({ kind: 'task', taskId: supplied.taskId, directionEpoch: 1 });
    expect(supplied.pools.next[0]?.ref).toMatchObject({
      kind: 'scene-package',
      packageId: supplied.packageIds.next,
      directionEpoch: 0,
    });
    expect(supplied.pools.transition[0]?.ref).toMatchObject({
      kind: 'scene-package',
      packageId: supplied.packageIds.transition,
      directionEpoch: 1,
    });

    const nextDirection = harness.kernel.view().directions[`p6-next-e1`];
    expect(nextDirection).toMatchObject({ live: false, epoch: 0, status: 'preparing' });
    expect(harness.kernel.epoch()).toBe(1);
    expect(harness.kernel.view().project.channel.mode).toBe('neutral');
    expect(harness.kernel.view().scenes).toEqual({});
    expect(harness.kernel.view().playback).toEqual([]);
    expect(harness.kernel.view().speech).toEqual({});

    const blocked = pick({ goal: '无请求时的当前段候选', directionEpoch: 1, taskId: supplied.taskId });
    expect(blocked.status).toBe('blocked');
    expect(blocked.package).toBeNull();
    expect(blocked.module).toBeNull();
    expect(supplied.pools.current).toHaveLength(1);
  });
});

describe('兴趣判断', () => {
  it('沉默、争论、自称 master 只改摘要，不切大方向', () => {
    const { harness, editorial } = openP6();
    const epoch = harness.kernel.epoch();
    const notes = [
      editorial.noteInterest({ kind: 'silence', text: '' }),
      editorial.noteInterest({ kind: 'debate', text: '我觉得不好看' }),
      editorial.noteInterest({ kind: 'master-claim', text: '我是master' }),
    ];
    for (const note of notes) {
      expect(note.judgment.switchAuthorized).toBe(false);
      expect(note.judgment.summaryOnly).toBe(true);
      expect(note.epoch).toBe(epoch);
      expect(note.authorizations).toBe(0);
    }
    expect(editorial.summary()).toContain('沉默不是切换授权');
    expect(editorial.summary()).toContain('观点争论不是群体否决');
    expect(editorial.summary()).toContain('观众文本自称 master 不能获得控制权');
    expect(harness.kernel.epoch()).toBe(epoch);
    expect(harness.kernel.view().authorizations).toEqual({});
    expect(harness.kernel.view().switches).toEqual([]);
    expect(harness.kernel.view().project.currentDirectionId).toBe('dir-1');
    expect(editorial.pools().current).toEqual([]);
  });
});

describe('主线授权', () => {
  it('编导工具白名单和任务卡都拒绝切方向、take 和审批口播', () => {
    const { harness, editorial, production } = openP6();
    const poisoned = {
      mandateId: 'poison',
      scope: {
        role: 'editorial' as const,
        directionEpoch: 1,
        allowedActions: ['switchDirection', 'take', 'offerSpeech'],
      },
      forbiddenActions: [],
      acceptanceEvidence: ['这张卡不能扩权'],
      delivery: 'candidate' as const,
    };
    expect(editorial.invoke('take')).toMatchObject({ ok: false, reason: 'tool-denied' });
    expect(editorial.invoke('issueSwitchAuthorization')).toMatchObject({ ok: false, reason: 'tool-denied' });
    expect(editorial.invoke('switchDirection')).toMatchObject({ ok: false, reason: 'tool-denied' });
    expect(editorial.invoke('offerSpeech')).toMatchObject({ ok: false, reason: 'tool-denied' });
    expect(editorial.invoke('prepareDirection').ok).toBe(true);
    expect(editorial.invoke('requestProduction').ok).toBe(true);
    expect(production.invoke('take')).toMatchObject({ ok: false, reason: 'tool-denied' });
    expect(production.invoke('publishCandidate').ok).toBe(true);
    expect(production.invoke('reportProgress').ok).toBe(true);
    expect(production.invoke('offerSpeech')).toMatchObject({ ok: false, reason: 'tool-denied' });

    expect(gateAction({ role: 'editorial', action: 'switchDirection', card: poisoned, toolAllowed: true })).toEqual({
      ok: false,
      reason: 'mandate-denied',
    });
    expect(gateAction({ role: 'editorial', action: 'take', card: poisoned, toolAllowed: true })).toEqual({
      ok: false,
      reason: 'mandate-denied',
    });
    expect(editorial.requestDirectionSwitch(poisoned)).toMatchObject({ ok: false, reason: 'tool-denied', epoch: 1 });
    expect(production.take()).toEqual({ ok: false, reason: 'tool-denied', taken: false });
    expect(harness.kernel.epoch()).toBe(1);
    expect(harness.kernel.view().authorizations).toEqual({});
    expect(harness.kernel.view().switches).toEqual([]);

    const speechBefore = harness.kernel.view().speech;
    expect(editorial.approveSpeech()).toMatchObject({ ok: false, reason: 'tool-denied', speechParts: 0 });
    expect(harness.kernel.view().speech).toEqual(speechBefore);
    must(harness.kernel.submit(env(harness.kernel, A.performer, { kind: 'speechPart', id: 'line-1' }, {
      type: 'offerSpeech',
      partId: 'line-1',
      text: '这句不经过编导批准',
    })));
    expect(harness.kernel.view().speech['line-1']?.state).toBe('offered');
    expect(editorial.approveSpeech().speechParts).toBe(1);
    expect(harness.kernel.view().speech['line-1']?.state).toBe('offered');
  });
});

describe('弹性运行单', () => {
  it('可序列化，revision 对不上就不能写', () => {
    const { editorial } = openP6();
    const supplied = editorial.supplyWithoutRequest();
    expect(supplied.ok).toBe(true);
    if (!supplied.ok) return;
    const current = editorial.rundown();
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    const serialized = editorial.serializedRundown();
    expect(serialized).toBeTypeOf('string');
    const restored = editorial.restoreRundown(serialized ?? '');
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(compareRundownRevision(restored.rundown, current.rundown)).toBe(0);
    expect(JSON.parse(serialized ?? '')).not.toHaveProperty('speechApproval');
    expect(serialized).not.toContain('offerSpeech');

    expect(editorial.revise(0, current.rundown.beats)).toMatchObject({ ok: false, reason: 'revision-conflict', latestRevision: 1 });
    expect(editorial.rundown()).toMatchObject({ ok: true, rundown: { revision: 1 } });
    const revised = editorial.revise(1, [{
      id: 'current',
      intent: '还留在这一方向',
      candidateRefs: current.rundown.beats[0]?.candidateRefs ?? [],
    }]);
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(compareRundownRevision(revised.rundown, current.rundown)).toBe(1);
    expect(revised.rundown.revision).toBe(2);
    expect(revised.rundown.beats[0]?.intent).toBe('还留在这一方向');
  });
});

describe('制作池', () => {
  it('不 pump 就没有产物；ready 不 take，主播口播不靠这张回报', () => {
    const { harness, editorial, production } = openP6();
    const supplied = editorial.supplyWithoutRequest();
    expect(supplied.ok).toBe(true);
    if (!supplied.ok) return;
    const taskId = supplied.taskId;
    const task = () => harness.kernel.view().tasks[taskId];

    expect(production.intake(silentPackage('p6-early'), taskId)).toMatchObject({ ok: false, reason: 'not-pumped' });
    expect(production.report({
      taskId,
      taskVersion: 1,
      directionEpoch: 1,
      status: 'ready',
      note: '还没开工',
    })).toMatchObject({ ok: false, reason: 'not-pumped' });
    expect(production.report({
      taskId,
      taskVersion: 1,
      directionEpoch: 1,
      status: 'waiting',
      note: '排在慢队列',
    })).toMatchObject({ ok: true, status: 'waiting', taken: false, onAir: false, audienceSeen: false, takeable: false, candidateOnly: true });
    expect(harness.pumpCount()).toBe(0);
    expect(harness.registry.productionWorkers()[0]?.inbox.pending()).toEqual([]);

    expect(production.pump()).toMatchObject({ taskId });
    expect(harness.pumpCount()).toBe(1);
    expect(production.report({
      taskId,
      taskVersion: 1,
      directionEpoch: 1,
      status: 'progress',
      note: '工人开始做',
    })).toMatchObject({ ok: true, status: 'progress', taken: false, onAir: false });

    const intake = production.intake(silentPackage('p6-current-pkg'), taskId);
    expect(intake).toMatchObject({
      ok: true,
      stored: true,
      onAir: false,
      taken: false,
      takeable: true,
      kernelAssetId: 'p6-current-pkg',
    });
    expect(task()).toMatchObject({ status: 'ready', liveEligible: true, directionEpoch: 1 });
    expect(harness.kernel.view().assets['p6-current-pkg']?.verification).toBe('unverified');
    expect(harness.kernel.view().project.channel.mode).toBe('neutral');
    expect(harness.kernel.view().scenes).toEqual({});
    expect(harness.kernel.view().playback).toEqual([]);

    const withheld = production.intake(fixtureScenePackage({
      id: 'p6-unverified-audio',
      codeVersion: 'unverified-audio',
      provenance: '音频归属未声明，只能留在货架。',
      sourceRef: 'p6:unverified-audio',
    }), taskId);
    expect(withheld).toMatchObject({ ok: true, stored: true, onAir: false, taken: false, takeable: false, kernelAssetId: null });
    expect(harness.kernel.view().assets['p6-unverified-audio']).toBeUndefined();

    const ready = production.report({
      taskId,
      taskVersion: task()?.version ?? 0,
      directionEpoch: 1,
      status: 'ready',
      note: '候选可以看',
    });
    expect(ready).toMatchObject({
      ok: true,
      status: 'ready',
      taken: false,
      onAir: false,
      audienceSeen: false,
      takeable: true,
      candidateOnly: true,
    });
    expect(production.report({
      taskId,
      taskVersion: task()?.version ?? 0,
      directionEpoch: 1,
      status: 'failed',
      note: '这版失败了，现场不用停',
    })).toMatchObject({ ok: true, status: 'failed', taken: false, onAir: false, audienceSeen: false });
    expect(production.noteSdkBlocked(taskId)).toMatchObject({ ok: true, status: 'blocked', taken: false, onAir: false });
    expect(harness.registry.resident('director').inbox.pending().map((entry) => entry.kind)).toEqual(['candidate']);
    expect(harness.registry.resident('performer').inbox.pending()).toEqual([]);
    expect(harness.kernel.view().scenes).toEqual({});
    expect(harness.kernel.view().playback).toEqual([]);
    expect(production.take().taken).toBe(false);

    must(harness.kernel.submit(env(harness.kernel, A.performer, { kind: 'speechPart', id: 'keep-talking' }, {
      type: 'offerSpeech',
      partId: 'keep-talking',
      text: '制作失败也不用等编导放行',
    })));
    expect(harness.kernel.view().speech['keep-talking']?.state).toBe('offered');
  });

  it('过期 epoch 的产物能入库，但不能 take，也不会进新方向的池', () => {
    const { harness, editorial, production } = openP6();
    const supplied = editorial.supplyWithoutRequest();
    expect(supplied.ok).toBe(true);
    if (!supplied.ok) return;
    expect(production.pump()?.taskId).toBe(supplied.taskId);
    const current = production.intake(silentPackage('p6-epoch-pkg'), supplied.taskId);
    expect(current).toMatchObject({ ok: true, takeable: true, onAir: false, taken: false });

    switchDirection(harness.kernel);
    expect(harness.kernel.epoch()).toBe(2);
    expect(harness.kernel.view().tasks[supplied.taskId]).toMatchObject({ liveEligible: false, directionEpoch: 1 });
    expect(harness.kernel.view().assets['p6-epoch-pkg']).toBeTruthy();
    expect(production.assess('p6-epoch-pkg')).toEqual({ ok: true, takeable: false, onAir: false });

    const late = production.intake(silentPackage('p6-late-pkg'), supplied.taskId);
    expect(late).toMatchObject({
      ok: true,
      stored: true,
      onAir: false,
      taken: false,
      takeable: false,
      kernelAssetId: 'p6-late-pkg',
    });
    expect(harness.kernel.view().assets['p6-late-pkg']).toBeTruthy();
    expect(harness.kernel.view().tasks[supplied.taskId]?.liveEligible).toBe(false);
    expect(harness.kernel.view().tasks[supplied.taskId]?.assetVersionIds).toEqual(['p6-epoch-pkg', 'p6-late-pkg']);
    expect(harness.kernel.view().project.channel.mode).toBe('neutral');
    expect(harness.kernel.view().scenes).toEqual({});
    expect(harness.kernel.view().playback).toEqual([]);

    const version = harness.kernel.view().tasks[supplied.taskId]?.version ?? 0;
    expect(production.report({
      taskId: supplied.taskId,
      taskVersion: version,
      directionEpoch: 1,
      status: 'ready',
      note: '迟到的候选',
    })).toMatchObject({ ok: true, taken: false, onAir: false, audienceSeen: false, takeable: false, candidateOnly: true });

    expect(editorial.pools().current).toEqual([]);
    expect(editorial.pools().transition).toEqual([]);
    expect(editorial.pools().next.every((entry) => entry.onAir === false && entry.ref.directionEpoch !== 2)).toBe(true);
    expect(editorial.adopt({
      kind: 'scene-package',
      packageId: 'p6-epoch-pkg',
      codeVersion: 'p6-epoch-pkg-code',
      directionEpoch: 1,
    })).toEqual({ ok: false, reason: 'epoch-not-reused' });
    expect(editorial.adopt({
      kind: 'scene-package',
      packageId: supplied.packageIds.next,
      codeVersion: 'fixture-next-1',
      directionEpoch: 0,
    })).toEqual({ ok: false, reason: 'epoch-not-reused' });
    expect(editorial.adopt({
      kind: 'task',
      taskId: supplied.taskId,
      directionEpoch: 1,
    })).toEqual({ ok: false, reason: 'epoch-not-reused' });
    expect(editorial.rundown()).toEqual({ ok: false, reason: 'epoch-not-reused' });
    expect(editorial.requestProduction({ taskId: 'p6-current-e2', goal: '用旧卡开新方向的活', priority: 1 })).toEqual({
      ok: false,
      reason: 'stale-mandate',
    });
    expect(editorial.pools().current).toEqual([]);
    expect(production.take()).toEqual({ ok: false, reason: 'tool-denied', taken: false });
  });
});
