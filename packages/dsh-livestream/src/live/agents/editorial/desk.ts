/**
 * 编导席。计划 §2.1、§4.1–§4.2。
 * 没人请求时也可以把夹具候选放进当前 / 下一 / 过场。
 * prepare 只建候选方向。不审批口播，不 take，不签发方向切换。
 * 工具调用只查本岗 session 白名单。制作任务再查 MandateCard，并且不 pump。
 */

import { FIXTURE_ACTORS } from '../../domain/index';
import type { CommandResult, CommandTarget, ShowCommand } from '../../domain/commands';
import type { MemoryAgentHarness } from '../harness';
import { gateAction, type MandateCard } from '../gate';
import { fixtureScenePackage } from '../production/fixture-package';
import type { CandidateShelf } from '../production/shelf';
import { judgeInterest, type InterestInput, type InterestJudgment } from './interest';
import { adoptIntoCurrent, emptyPools, projectPools, type CandidateRef, type ContentPools, type PoolEntry } from './pools';
import { parseRundown, reviseRundown, serializeRundown, type ElasticRundown, type RundownBeat } from './rundown';

export interface SupplyReceipt {
  ok: true;
  audienceCount: number;
  pumped: false;
  pumpCount: number;
  pools: ContentPools;
  rundown: ElasticRundown;
  taskId: string;
  packageIds: { next: string; transition: string };
}

export class EditorialDesk {
  private seq = 0;
  private storedPools: ContentPools;
  private storedRundown: ElasticRundown | null = null;
  private readonly lines: string[] = [];
  private seededEpoch: number | null = null;

  constructor(
    readonly harness: MemoryAgentHarness,
    private readonly mandate: MandateCard,
    readonly shelf: CandidateShelf,
  ) {
    this.storedPools = emptyPools(harness.kernel.epoch());
  }

  /** 只查白名单，不执行工具。 */
  invoke(tool: string): { ok: true; tool: string } | { ok: false; reason: 'tool-denied'; tool: string } {
    const session = this.harness.registry.resident('editorial');
    if (!session.allows(tool)) return { ok: false, reason: 'tool-denied', tool };
    return { ok: true, tool };
  }

  summary(): string {
    return this.lines.join('\n');
  }

  pools(): ContentPools {
    return projectPools(this.storedPools, this.harness.kernel.epoch());
  }

  /**
   * 无观众请求也可以填三池。候选 onAir 固定为 false。
   * 不 pump 制作队列，也不 take。
   */
  supplyWithoutRequest(): SupplyReceipt | { ok: false; reason: string } {
    const epoch = this.harness.kernel.epoch();
    const beforePumps = this.harness.pumpCount();
    if (this.seededEpoch === epoch && this.storedRundown) {
      return {
        ok: true,
        audienceCount: this.harness.kernel.view().audience.length,
        pumped: false,
        pumpCount: beforePumps,
        pools: this.pools(),
        rundown: this.storedRundown,
        taskId: `p6-current-e${epoch}`,
        packageIds: { next: `p6-next-pkg-e${epoch}`, transition: `p6-transition-e${epoch}` },
      };
    }
    if (this.mandate.scope.directionEpoch !== epoch) return { ok: false, reason: 'stale-mandate' };

    const taskId = `p6-current-e${epoch}`;
    const requested = this.requestProduction({ taskId, goal: '无请求时的当前段候选', priority: 1 });
    if (!requested.ok) return requested;

    const directionId = `p6-next-e${epoch}`;
    const prepared = this.prepareNext({
      directionId,
      commitment: '下一方向预备，未提交',
      coreQuestion: '观众还没选定',
    });
    if (!prepared.ok) return prepared;

    const nextPackage = fixtureScenePackage({
      id: `p6-next-pkg-e${epoch}`,
      codeVersion: `fixture-next-${epoch}`,
      provenance: 'P6 下一方向夹具。不是私有 SDK，也没有能力认证。',
      sourceRef: `p6:next:${epoch}`,
    });
    const transitionPackage = fixtureScenePackage({
      id: `p6-transition-e${epoch}`,
      codeVersion: `fixture-transition-${epoch}`,
      provenance: 'P6 过场夹具。不是私有 SDK，也没有能力认证。',
      sourceRef: `p6:transition:${epoch}`,
    });
    const nextStored = this.shelf.put({
      raw: nextPackage,
      directionEpoch: 0,
      projected: false,
      withholdReason: '下一方向预备包不投影成当前资产',
    });
    if (!nextStored.ok) return nextStored;
    const transitionStored = this.shelf.put({
      raw: transitionPackage,
      directionEpoch: epoch,
      projected: false,
      withholdReason: '过场夹具未声明音频归属，不能投影成域资产',
    });
    if (!transitionStored.ok) return transitionStored;

    const currentRef: CandidateRef = { kind: 'task', taskId, directionEpoch: epoch };
    const nextRef: CandidateRef = {
      kind: 'scene-package',
      packageId: nextPackage.id,
      codeVersion: nextPackage.codeVersion,
      directionEpoch: 0,
    };
    const transitionRef: CandidateRef = {
      kind: 'scene-package',
      packageId: transitionPackage.id,
      codeVersion: transitionPackage.codeVersion,
      directionEpoch: epoch,
    };
    const pools: ContentPools = {
      revision: this.storedPools.revision + 1,
      directionEpoch: epoch,
      current: [entry('current', '当前方向的下一段', currentRef)],
      next: [entry('next', '下一方向预备，未上播', nextRef)],
      transition: [entry('transition', '过场，可以安静停留', transitionRef)],
    };
    const rundown: ElasticRundown = {
      id: `rundown-e${epoch}`,
      revision: 1,
      directionEpoch: epoch,
      beats: [
        { id: 'current', intent: '当前方向里的下一段', candidateRefs: [currentRef] },
        { id: 'next', intent: '下一方向预备，未提交', candidateRefs: [nextRef] },
        { id: 'transition', intent: '过场，可以安静停留', candidateRefs: [transitionRef] },
      ],
    };
    this.storedPools = pools;
    this.storedRundown = rundown;
    this.seededEpoch = epoch;
    this.lines.push('没有观众请求，已放入当前、下一和过场候选');
    if (this.harness.pumpCount() !== beforePumps) {
      throw new Error('主动供给不能 pump 制作队列');
    }
    return {
      ok: true,
      audienceCount: this.harness.kernel.view().audience.length,
      pumped: false,
      pumpCount: this.harness.pumpCount(),
      pools: this.pools(),
      rundown,
      taskId,
      packageIds: { next: nextPackage.id, transition: transitionPackage.id },
    };
  }

  noteInterest(input: InterestInput): {
    judgment: InterestJudgment;
    summary: string;
    epoch: number;
    authorizations: number;
  } {
    const judgment = judgeInterest(input);
    this.lines.push(judgment.summary);
    const view = this.harness.kernel.view();
    return {
      judgment,
      summary: this.summary(),
      epoch: view.project.currentEpoch,
      authorizations: Object.keys(view.authorizations).length,
    };
  }

  /**
   * 越权切方向。白名单里没有切换和 take。
   * 就算换一张把禁止项掏空的卡，底线仍然拒绝。
   */
  requestDirectionSwitch(card: MandateCard = this.mandate): { ok: false; reason: 'tool-denied' | 'mandate-denied' | 'role-mismatch'; epoch: number } {
    const epoch = this.harness.kernel.epoch();
    const issue = this.invoke('issueSwitchAuthorization');
    const switched = this.invoke('switchDirection');
    const take = this.invoke('take');
    if (!issue.ok || !switched.ok || !take.ok) return { ok: false, reason: 'tool-denied', epoch };
    const gated = gateAction({ role: 'editorial', action: 'switchDirection', card, toolAllowed: true });
    return { ok: false, reason: gated.ok ? 'mandate-denied' : gated.reason, epoch };
  }

  approveSpeech(): { ok: false; reason: 'tool-denied'; speechParts: number } {
    this.invoke('offerSpeech');
    return { ok: false, reason: 'tool-denied', speechParts: Object.keys(this.harness.kernel.view().speech).length };
  }

  requestProduction(input: { taskId: string; goal: string; priority: number }): { ok: true; pumped: false } | { ok: false; reason: string } {
    const session = this.harness.registry.resident('editorial');
    const gated = gateAction({
      role: 'editorial',
      action: 'requestProduction',
      card: this.mandate,
      toolAllowed: session.allows('requestProduction'),
    });
    if (!gated.ok) return gated;
    if (this.mandate.scope.directionEpoch !== this.harness.kernel.epoch()) {
      return { ok: false, reason: 'stale-mandate' };
    }
    if (this.harness.kernel.view().tasks[input.taskId]) return { ok: true, pumped: false };
    const pumps = this.harness.pumpCount();
    this.harness.enqueueProduction({ taskId: input.taskId, goal: input.goal, priority: input.priority });
    if (this.harness.pumpCount() !== pumps) throw new Error('派发制作任务不能 pump');
    return { ok: true, pumped: false };
  }

  prepareNext(input: { directionId: string; commitment: string; coreQuestion: string }): { ok: true; live: false; epoch: 0 } | { ok: false; reason: string } {
    const session = this.harness.registry.resident('editorial');
    const gated = gateAction({
      role: 'editorial',
      action: 'prepareDirection',
      card: this.mandate,
      toolAllowed: session.allows('prepareDirection'),
    });
    if (!gated.ok) return gated;
    if (this.mandate.scope.directionEpoch !== this.harness.kernel.epoch()) {
      return { ok: false, reason: 'stale-mandate' };
    }
    const existing = this.harness.kernel.view().directions[input.directionId];
    if (existing) {
      if (existing.live || existing.epoch !== 0) return { ok: false, reason: 'prepare-not-candidate' };
      return { ok: true, live: false, epoch: 0 };
    }
    const showEpoch = this.harness.kernel.epoch();
    const submitted = this.submit(
      FIXTURE_ACTORS.editorial,
      { kind: 'direction', id: input.directionId },
      { type: 'prepareDirection', directionId: input.directionId, commitment: input.commitment, coreQuestion: input.coreQuestion },
    );
    if (!submitted.ok) return { ok: false, reason: submitted.reject };
    const direction = this.harness.kernel.view().directions[input.directionId];
    if (!direction || direction.live || direction.epoch !== 0) return { ok: false, reason: 'prepare-not-candidate' };
    if (this.harness.kernel.epoch() !== showEpoch) return { ok: false, reason: 'epoch-changed' };
    return { ok: true, live: false, epoch: 0 };
  }

  adopt(ref: CandidateRef): { ok: true; pools: ContentPools } | { ok: false; reason: 'epoch-not-reused' } {
    const adopted = adoptIntoCurrent(this.storedPools, ref, this.harness.kernel.epoch());
    if (!adopted.ok) return adopted;
    this.storedPools = adopted.pools;
    return { ok: true, pools: this.pools() };
  }

  rundown(): { ok: true; rundown: ElasticRundown } | { ok: false; reason: 'epoch-not-reused' | 'missing' } {
    if (!this.storedRundown) return { ok: false, reason: 'missing' };
    if (this.storedRundown.directionEpoch !== this.harness.kernel.epoch()) {
      return { ok: false, reason: 'epoch-not-reused' };
    }
    return { ok: true, rundown: this.storedRundown };
  }

  serializedRundown(): string | null {
    return this.storedRundown ? serializeRundown(this.storedRundown) : null;
  }

  revise(expectedRevision: number, beats: RundownBeat[]): ReturnType<typeof reviseRundown> | { ok: false; reason: 'epoch-not-reused' | 'missing' } {
    if (!this.storedRundown) return { ok: false, reason: 'missing' };
    if (this.storedRundown.directionEpoch !== this.harness.kernel.epoch()) {
      return { ok: false, reason: 'epoch-not-reused' };
    }
    const revised = reviseRundown(this.storedRundown, expectedRevision, beats);
    if (revised.ok) this.storedRundown = revised.rundown;
    return revised;
  }

  restoreRundown(serialized: string): ReturnType<typeof parseRundown> {
    return parseRundown(serialized);
  }

  private submit(actorId: string, target: CommandTarget, payload: ShowCommand): CommandResult {
    const kernel = this.harness.kernel;
    this.seq += 1;
    const commandId = `p6-${payload.type}-${this.seq}`;
    return kernel.submit({
      commandId,
      idempotencyKey: commandId,
      actorId,
      directionEpoch: kernel.epoch(),
      expectedRevision: kernel.revision(target),
      target,
      payload,
    });
  }
}

function entry(lane: PoolEntry['lane'], summary: string, ref: CandidateRef): PoolEntry {
  const id = ref.kind === 'task' ? ref.taskId : ref.packageId;
  return { id: `${lane}-${id}`, lane, summary, ref, onAir: false, source: 'fixture' };
}
