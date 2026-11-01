/**
 * 制作席。计划 §2.1、§3.5、§8.3。
 * 工具调用只查本岗 session 白名单。派发和入库再查 MandateCard。
 * 慢队列要显式 pump。ready 是候选通知，不是 take，也不是观众已经看到。
 * 不接 SceneHost / Player。
 */

import { pick } from '../../../../../scene-package/src/ports.ts';
import { projectAssetVersion, type DomainAssetDraft } from '../../../../../scene-package/src/project.ts';
import { parseScenePackage } from '../../../../../scene-package/src/schema.ts';
import { FIXTURE_ACTORS } from '../../domain/index';
import type { CommandResult } from '../../domain/commands';
import type { ProductionTask } from '../../domain/entities';
import type { MemoryAgentHarness } from '../harness';
import { gateAction, type MandateCard } from '../gate';
import type { TaskReportEnvelope, TaskReportStatus } from '../ports';
import { assessTakeable, type CandidateShelf, type ShelfRecord } from './shelf';

export interface IntakeOk {
  ok: true;
  stored: true;
  onAir: false;
  taken: false;
  record: ShelfRecord;
  /** 当前 epoch 是否还允许将来考虑 take。这次调用没有 take。 */
  takeable: boolean;
  kernelAssetId: string | null;
}

export type IntakeResult =
  | IntakeOk
  | { ok: false; reason: string; message?: string };

export interface ReportOk {
  ok: true;
  status: TaskReportStatus;
  onAir: boolean;
  audienceSeen: boolean;
  /** 本回报没有执行 take。 */
  taken: false;
  takeable: boolean;
  candidateOnly: true;
}

export class ProductionDesk {
  private seq = 0;

  constructor(
    readonly harness: MemoryAgentHarness,
    private readonly mandate: MandateCard,
    readonly shelf: CandidateShelf,
  ) {}

  /** 只查白名单，不执行工具。 */
  invoke(tool: string): { ok: true; tool: string } | { ok: false; reason: 'tool-denied'; tool: string } {
    const session = this.harness.registry.productionWorkers()[0];
    if (!session?.allows(tool)) return { ok: false, reason: 'tool-denied', tool };
    return { ok: true, tool };
  }

  pump() {
    return this.harness.pumpProduction();
  }

  take(): { ok: false; reason: 'tool-denied'; taken: false } {
    this.invoke('take');
    return { ok: false, reason: 'tool-denied', taken: false };
  }

  /**
   * 把 ScenePackage 登记到任务上。
   * 任务还在等待、没人 pump 时拒绝。过期 epoch 可以入库，takeable 为 false。
   */
  intake(raw: unknown, taskId: string): IntakeResult {
    const session = this.harness.registry.productionWorkers()[0];
    const gated = gateAction({
      role: 'production',
      action: 'publishCandidate',
      card: this.mandate,
      toolAllowed: session?.allows('publishCandidate') ?? false,
    });
    if (!gated.ok) return gated;
    if (this.mandate.scope.taskId && this.mandate.scope.taskId !== taskId) {
      return { ok: false, reason: 'mandate-denied' };
    }
    const task = this.harness.kernel.view().tasks[taskId];
    if (!task) return { ok: false, reason: 'unknown-task' };
    if (this.mandate.scope.directionEpoch !== task.directionEpoch) {
      return { ok: false, reason: 'stale-mandate' };
    }
    const job = this.harness.queue.snapshot().find((item) => item.taskId === taskId);
    if (!job || (job.state !== 'running' && job.state !== 'done')) {
      return { ok: false, reason: 'not-pumped' };
    }

    const parsed = parseScenePackage(raw);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    const projected = projectAssetVersion(parsed.value);
    if (!projected.ok) {
      const stored = this.shelf.put({
        raw: parsed.value,
        directionEpoch: task.directionEpoch,
        taskId,
        projected: false,
        withholdReason: projected.reason,
      });
      if (!stored.ok) return stored;
      return {
        ok: true,
        stored: true,
        onAir: false,
        taken: false,
        record: stored.record,
        takeable: false,
        kernelAssetId: null,
      };
    }

    const submitted = this.submitPublish(task, projected.asset);
    if (!submitted.ok) return { ok: false, reason: submitted.reject, message: submitted.message };
    const updated = this.harness.kernel.view().tasks[taskId];
    const stored = this.shelf.put({
      raw: parsed.value,
      directionEpoch: task.directionEpoch,
      taskId,
      projected: true,
    });
    if (!stored.ok) return stored;
    return {
      ok: true,
      stored: true,
      onAir: false,
      taken: false,
      record: stored.record,
      takeable: assessTakeable(stored.record, this.harness.kernel.epoch(), updated),
      kernelAssetId: projected.asset.id,
    };
  }

  assess(packageId: string): { ok: true; takeable: boolean; onAir: false } | { ok: false; reason: 'unknown-package' } {
    const record = this.shelf.get(packageId);
    if (!record) return { ok: false, reason: 'unknown-package' };
    const task = record.taskId ? this.harness.kernel.view().tasks[record.taskId] : undefined;
    return {
      ok: true,
      takeable: assessTakeable(record, this.harness.kernel.epoch(), task),
      onAir: false,
    };
  }

  /** pick 仍是 blocked。把这个事实记成 blocked，不造候选模块。 */
  noteSdkBlocked(taskId: string): ReportOk | { ok: false; reason: string } {
    const task = this.harness.kernel.view().tasks[taskId];
    if (!task) return { ok: false, reason: 'unknown-task' };
    const blocked = pick({ goal: task.goal, directionEpoch: task.directionEpoch, taskId });
    if (blocked.package !== null || blocked.module !== null || blocked.status !== 'blocked') {
      return { ok: false, reason: 'sdk-not-blocked' };
    }
    return this.report({
      taskId,
      taskVersion: task.version,
      directionEpoch: task.directionEpoch,
      status: 'blocked',
      note: blocked.reason,
    });
  }

  report(input: Omit<TaskReportEnvelope, 'candidateOnly'>): ReportOk | { ok: false; reason: string } {
    const session = this.harness.registry.productionWorkers()[0];
    const gated = gateAction({
      role: 'production',
      action: 'reportProgress',
      card: this.mandate,
      toolAllowed: session?.allows('reportProgress') ?? false,
    });
    if (!gated.ok) return gated;
    const job = this.harness.queue.snapshot().find((item) => item.taskId === input.taskId);
    if (input.status === 'waiting') {
      if (!job || (job.state !== 'waiting' && job.state !== 'running')) {
        return { ok: false, reason: 'not-waiting' };
      }
    } else if (!job || (job.state !== 'running' && job.state !== 'done')) {
      return { ok: false, reason: 'not-pumped' };
    }
    const decision = this.harness.report(input);
    if (!decision.ok) return { ok: false, reason: decision.reason };
    const view = this.harness.kernel.view();
    const task = view.tasks[input.taskId];
    const onAir = view.project.channel.mode === 'program'
      || Object.values(view.scenes).some((scene) => scene.surface === 'program' || scene.lifecycle === 'taken');
    const audienceSeen = view.playback.length > 0
      || Object.values(view.proposals).some((proposal) => proposal.status === 'presented');
    const epochOpen = !!task
      && task.status === 'ready'
      && task.assetVersionIds.length > 0
      && task.liveEligible
      && !task.cancelled
      && task.directionEpoch === view.project.currentEpoch;
    const takeable = input.status === 'ready' && epochOpen;
    return {
      ok: true,
      status: decision.envelope.status,
      onAir,
      audienceSeen,
      taken: false,
      takeable,
      candidateOnly: true,
    };
  }

  private submitPublish(task: ProductionTask, asset: DomainAssetDraft): CommandResult {
    const kernel = this.harness.kernel;
    this.seq += 1;
    const commandId = `p6-publish-${task.id}-${this.seq}`;
    return kernel.submit({
      commandId,
      idempotencyKey: commandId,
      actorId: FIXTURE_ACTORS.production,
      directionEpoch: task.directionEpoch,
      expectedRevision: kernel.revision({ kind: 'productionTask', id: task.id }),
      target: { kind: 'productionTask', id: task.id },
      payload: { type: 'publishCandidate', taskId: task.id, asset },
    });
  }
}
