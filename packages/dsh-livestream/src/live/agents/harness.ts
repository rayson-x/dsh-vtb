/**
 * P5 内存夹具。计划 §2.2、§8、§10。
 * 同一进程里挂四个岗位的独立 session。快链只做归一、路由和读模型；
 * 制作任务停在慢队列里，直到显式 pump。
 *
 * 不跑 LLM 循环，不改现有主持人主路径，不接播放器。
 * 真实 DSH cancel 见 cancel.ts 的 TODO(P5-wire)。
 */

import type { AgentRole } from '../domain/codes';
import type { CommandResult, CommandTarget, ShowCommand } from '../domain/commands';
import { FIXTURE_ACTORS, FIXTURE_IDS } from '../domain/index';
import { aggregateSummary, InputAggregator, type AggregatedInput } from '../events/aggregate';
import { normalizeInput, type RawPlatformInput } from '../events/normalize';
import { routeAggregate } from '../events/route';
import { EngineeringKernel } from '../kernel';
import { projectRoleBriefs, type RoleBriefs } from './briefs';
import { cancelThenSteer, readScheduledAudio } from './cancel';
import { LiveBudget } from './limits';
import {
  PRODUCTION_POOL_DEFAULT,
  PRODUCTION_POOL_MAX,
  type CancelSteerRequest,
  type CancelSteerResult,
  type InboxEntry,
  type LimitDecision,
  type ReportDecision,
  type ResidentRole,
  type ScheduledAudio,
  type TaskReportEnvelope,
} from './ports';
import { ProductionQueue } from './queue';
import { RoleRegistry, type RoleSession } from './registry';
import { acceptReport } from './reports';

export interface HarnessOptions {
  kernel?: EngineeringKernel;
  coalesceWindowMs?: number;
  liveSlots?: number;
  /** 默认 1，超过 2 的请求会夹到 2。 */
  productionSlots?: number;
}

export interface IngestReceipt {
  eventId: string;
  merged: boolean;
  duplicateEvent: boolean;
  woken: AgentRole[];
  priority: AggregatedInput['priority'];
  /** 归一和路由不会去泵制作队列。 */
  productionPumped: false;
}

export interface ProductionAssignment {
  taskId: string;
  sessionId: string;
  workerIndex: number;
}

const ACTOR = FIXTURE_ACTORS;

export class MemoryAgentHarness {
  readonly kernel: EngineeringKernel;
  readonly registry: RoleRegistry;
  readonly limits: LiveBudget;
  readonly queue: ProductionQueue;
  readonly productionSlots: number;
  private readonly aggregator: InputAggregator;
  private readonly bucketEntries = new Map<string, InboxEntry['id'][]>();
  private readonly busyWorkers = new Set<number>();
  private readonly runningWorkers = new Map<string, number>();
  private readonly reports: TaskReportEnvelope[] = [];
  private seq = 0;
  private pumps = 0;

  constructor(options: HarnessOptions = {}) {
    this.kernel = options.kernel ?? new EngineeringKernel();
    this.registry = new RoleRegistry();
    this.registry.bindResident('editorial');
    this.registry.bindResident('director');
    this.registry.bindResident('performer');
    this.registry.bindProduction();
    this.limits = new LiveBudget(options.liveSlots ?? 2);
    this.productionSlots = clampSlots(options.productionSlots);
    this.queue = new ProductionQueue();
    this.aggregator = new InputAggregator(options.coalesceWindowMs ?? 2_000);
  }

  ingest(raw: RawPlatformInput): IngestReceipt {
    const input = normalizeInput(raw, this.kernel.epoch());
    const checkpoint = this.aggregator.checkpoint();
    const decision = this.aggregator.accept(input);
    if (decision.duplicateEvent) {
      return {
        eventId: input.eventId,
        merged: true,
        duplicateEvent: true,
        woken: [],
        priority: decision.item.priority,
        productionPumped: false,
      };
    }
    // 每条原始输入仍写入工程日志。收件箱只在新聚合桶时投递一次。
    // 窗内后来的观众留在收件箱的 audienceIds。现有 ingest 不会给已存在的提议追加观众，P5 不改这个契约。
    const committed = this.submit(ACTOR.input, { kind: 'show', id: this.kernel.view().project.id || FIXTURE_IDS.show }, {
      type: 'ingestAudience',
      eventId: input.eventId,
      audienceId: input.audienceId,
      text: input.text || input.kind,
      kind: input.kind,
      ...(input.kind === 'proposal' ? { proposalId: `proposal-${decision.item.bucketId}`, intent: input.text } : {}),
    });
    if (!committed.ok) { this.aggregator.restore(checkpoint); this.must(committed); }
    if (!decision.deliver) {
      this.rewriteBucket(decision.item);
      return {
        eventId: input.eventId,
        merged: true,
        duplicateEvent: false,
        woken: [],
        priority: decision.item.priority,
        productionPumped: false,
      };
    }
    const woken = this.deliver(decision.item);
    return {
      eventId: input.eventId,
      merged: false,
      duplicateEvent: false,
      woken,
      priority: decision.item.priority,
      productionPumped: false,
    };
  }

  /** 现场读模型。不泵制作队列，也不压缩全场上下文。 */
  briefs(): RoleBriefs {
    return projectRoleBriefs(this.kernel.view());
  }

  /** 把简报抄进各 session 自己的 context。对象不共享。 */
  refreshContexts(): RoleBriefs {
    const briefs = this.briefs();
    this.registry.resident('performer').context.brief = structuredClone(briefs.performer);
    this.registry.resident('director').context.brief = structuredClone(briefs.director);
    this.registry.resident('editorial').context.brief = structuredClone(briefs.editorial);
    const production = structuredClone(briefs.production);
    for (const worker of this.registry.productionWorkers()) {
      worker.context.brief = structuredClone(production);
    }
    return briefs;
  }

  acquireRequest(role: AgentRole, requestId: string): LimitDecision {
    return this.limits.acquire(role, requestId);
  }

  releaseRequest(requestId: string): void {
    this.limits.release(requestId);
  }

  enqueueProduction(input: {
    taskId: string;
    goal: string;
    priority: number;
    deadlineShowTime?: number;
    directionEpoch?: number;
  }): void {
    const existing = this.kernel.view().tasks[input.taskId];
    if (!existing) {
      this.must(this.submit(ACTOR.editorial, { kind: 'productionTask', id: input.taskId }, {
        type: 'requestProduction',
        task: {
          id: input.taskId,
          goal: input.goal,
          priority: input.priority,
          inputs: [],
          dependsOn: [],
          ...(input.deadlineShowTime !== undefined ? { deadlineShowTime: input.deadlineShowTime } : {}),
        },
      }));
    }
    const task = this.kernel.view().tasks[input.taskId];
    if (!task) throw new Error(`内核没有任务 ${input.taskId}`);
    this.queue.enqueue({
      taskId: task.id,
      goal: task.goal,
      priority: input.priority,
      version: task.version,
      directionEpoch: input.directionEpoch ?? task.directionEpoch,
      enqueuedAt: this.seq++,
      state: 'waiting',
      ...(input.deadlineShowTime !== undefined ? { deadlineShowTime: input.deadlineShowTime } : {}),
    });
  }

  /**
   * 慢链的一步。ingest 和 briefs 不会调用它。
   * 工人开始任务不等于候选上播。
   */
  pumpProduction(): ProductionAssignment | undefined {
    if (this.queue.runningCount() >= this.productionSlots) return undefined;
    const job = this.queue.peekNext();
    if (!job) return undefined;
    const worker = this.registry.productionWorkers().find((session) => !this.busyWorkers.has(session.workerIndex));
    if (!worker) return undefined;
    this.pumps += 1;
    this.queue.markRunning(job.taskId);
    this.busyWorkers.add(worker.workerIndex);
    this.runningWorkers.set(job.taskId, worker.workerIndex);
    worker.inbox.push(this.entry({
      kind: 'task',
      role: 'production',
      priority: 'live',
      wake: true,
      summary: job.goal,
      taskId: job.taskId,
    }));
    return { taskId: job.taskId, sessionId: worker.sessionId, workerIndex: worker.workerIndex };
  }

  completeProduction(taskId: string): void {
    this.queue.complete(taskId);
    this.releaseWorker(taskId);
  }

  /**
   * 取消队列里的制作任务，并把内核任务标成 cancelled。
   * 不调用 abortSpeech，也不碰已排音频。
   */
  cancelProduction(taskId: string): boolean {
    const queued = this.queue.cancel(taskId);
    if (!queued) return false;
    this.releaseWorker(taskId);
    const task = this.kernel.view().tasks[taskId];
    if (task && !task.cancelled) {
      this.must(this.submit(ACTOR.editorial, { kind: 'productionTask', id: taskId }, {
        type: 'cancelTask',
        taskId,
      }));
    }
    return true;
  }

  /** 方向已经过去的队列任务可以取消。现场口播不动。 */
  cancelStaleProduction(): string[] {
    const epoch = this.kernel.epoch();
    const ids = this.queue.snapshot()
      .filter((job) => (job.state === 'waiting' || job.state === 'running') && job.directionEpoch !== epoch)
      .map((job) => job.taskId);
    for (const taskId of ids) this.cancelProduction(taskId);
    return ids;
  }

  report(input: Omit<TaskReportEnvelope, 'candidateOnly'>): ReportDecision {
    const task = this.kernel.view().tasks[input.taskId];
    const decision = acceptReport(input, task ? { version: task.version, directionEpoch: task.directionEpoch } : undefined);
    if (!decision.ok) return decision;
    this.must(this.submit(ACTOR.production, { kind: 'productionTask', id: input.taskId }, {
      type: 'reportProgress',
      taskId: input.taskId,
      note: `${decision.envelope.status}: ${decision.envelope.note}`,
    }));
    this.reports.push(decision.envelope);
    if (decision.envelope.status === 'ready') {
      this.registry.resident('director').inbox.push(this.entry({
        kind: 'candidate',
        role: 'director',
        priority: 'live',
        wake: true,
        summary: decision.envelope.note,
        taskId: decision.envelope.taskId,
      }));
    }
    return decision;
  }

  reportLog(): readonly TaskReportEnvelope[] {
    return this.reports.map((item) => ({ ...item }));
  }

  preempt(role: ResidentRole | 'production', request: CancelSteerRequest, workerIndex = 0): CancelSteerResult {
    const session = role === 'production'
      ? this.registry.productionWorkers()[workerIndex]
      : this.registry.resident(role);
    if (!session) throw new Error(`没有 ${role} session`);
    const before = readScheduledAudio(this.kernel.view());
    const result = cancelThenSteer(session, request, before, {
      id: `steer-${this.seq++}`,
      at: this.seq,
    });
    if (result.cancelledGeneration && result.cancelledAttempt) {
      this.must(this.submit(ACTOR.runtime, { kind: 'show', id: this.kernel.view().project.id }, {
        type: 'cancelGeneration',
        generationId: result.cancelledAttempt.generationId,
        attemptId: result.cancelledAttempt.attemptId,
      }));
    }
    const after = readScheduledAudio(this.kernel.view());
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('取消未提交生成改动了已排音频');
    }
    return { ...result, scheduledAudio: after };
  }

  scheduledAudio(): ScheduledAudio[] {
    return readScheduledAudio(this.kernel.view());
  }

  pumpCount(): number {
    return this.pumps;
  }

  private deliver(item: AggregatedInput): AgentRole[] {
    const woken: AgentRole[] = [];
    const ids: string[] = [];
    for (const delivery of routeAggregate(item)) {
      const session = this.sessionFor(delivery.role);
      const entry = this.entry({
        kind: 'audience',
        role: delivery.role,
        priority: delivery.priority,
        wake: delivery.wake,
        summary: aggregateSummary(item),
        eventIds: item.eventIds,
        audienceIds: item.audienceIds,
        inputKind: item.kind,
        count: item.count,
      });
      session.inbox.push(entry);
      ids.push(entry.id);
      if (delivery.wake) woken.push(delivery.role);
    }
    this.bucketEntries.set(item.bucketId, ids);
    return woken;
  }

  private rewriteBucket(item: AggregatedInput): void {
    const ids = this.bucketEntries.get(item.bucketId) ?? [];
    const patch = {
      summary: aggregateSummary(item),
      eventIds: item.eventIds,
      audienceIds: item.audienceIds,
      count: item.count,
    };
    for (const id of ids) {
      const owner = this.registry.all().find((session) => session.inbox.pending().some((entry) => entry.id === id));
      if (!owner) throw new Error(`聚合桶 ${item.bucketId} 的收件箱条目 ${id} 丢了`);
      owner.inbox.update(id, patch);
    }
  }

  private sessionFor(role: AgentRole): RoleSession {
    if (role === 'production') throw new Error('制作池不接收观众输入');
    return this.registry.resident(role);
  }

  private entry(input: {
    kind: InboxEntry['kind'];
    role: AgentRole;
    priority: InboxEntry['priority'];
    wake: boolean;
    summary: string;
    eventIds?: string[];
    audienceIds?: string[];
    inputKind?: InboxEntry['inputKind'];
    count?: number;
    taskId?: string;
  }): InboxEntry {
    this.seq += 1;
    return {
      id: `in-${this.seq}`,
      kind: input.kind,
      role: input.role,
      priority: input.priority,
      wake: input.wake,
      at: this.seq,
      summary: input.summary,
      eventIds: input.eventIds ?? [],
      audienceIds: input.audienceIds ?? [],
      count: input.count ?? 1,
      ...(input.inputKind ? { inputKind: input.inputKind } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
    };
  }

  private submit(actorId: string, target: CommandTarget, payload: ShowCommand): CommandResult {
    const commandId = `p5-${payload.type}-${this.seq++}`;
    return this.kernel.submit({
      commandId,
      idempotencyKey: commandId,
      actorId,
      directionEpoch: this.kernel.epoch(),
      expectedRevision: this.kernel.revision(target),
      target,
      payload,
    });
  }

  private releaseWorker(taskId: string): void {
    const workerIndex = this.runningWorkers.get(taskId);
    this.runningWorkers.delete(taskId);
    if (workerIndex !== undefined) this.busyWorkers.delete(workerIndex);
  }

  private must(result: CommandResult): void {
    if (!result.ok) throw new Error(`${result.reject}: ${result.message}`);
  }
}

function clampSlots(requested: number | undefined): number {
  const value = requested ?? PRODUCTION_POOL_DEFAULT;
  if (!Number.isInteger(value) || value < 1) throw new Error('制作池并行度至少为 1');
  return Math.min(value, PRODUCTION_POOL_MAX);
}
