/**
 * P5 角色运行端口。计划 §2.2、§3.5、§8.2、§8.3。
 *
 * 这些名字对齐将来要接的 DSH AgentRegistry，以及
 * `cancel(cause, {keepInbox:true})` 之后同步 `steer(message)`。
 * 它们不是 @deepseek-ai/dsh-tools 的类型，本目录也不调用那个包。
 *
 * 遗留：
 * - TODO(P5-wire)：真实 DSH 0.2.1-rc.2 的 cancel / steer、assistant-stream 的
 *   instance 与 attemptId。这里只用内存相位。
 * - TODO(P5-wire)：核对真实 worker 没有挂在父 exec.signal 上。夹具没有父信号，
 *   workerAborted 保持 false。
 * - 急件取消不保证云端模型时延。§9.2 的 200/500ms 要在真实链路上测。
 * - 编导 / 制作的决定循环在 editorial 与 production。主播 / 导播的决定循环在 performer 与 director。
 *   那些循环仍是夹具，不是模型。这里的工具调用只查白名单。
 */

import type { AgentRole, SpeechPartState } from '../domain/codes';
import type { AudienceInputRecord } from '../domain/entities';
import type { AgentToolName } from '../domain/permissions';
import type { RoutePriority } from '../events/aggregate';

export const RESIDENT_ROLES = ['editorial', 'director', 'performer'] as const;
export type ResidentRole = (typeof RESIDENT_ROLES)[number];

/** 计划 §2.1：制作池默认一个，最多两个并行。 */
export const PRODUCTION_POOL_DEFAULT = 1;
export const PRODUCTION_POOL_MAX = 2;

export type GenerationPhase = 'idle' | 'generating' | 'tool';

export type InboxKind = 'audience' | 'steer' | 'candidate' | 'task';

/** 角色收件箱里的一条。观众内容和内部控制消息分开，日志不能装成弹幕。 */
export interface InboxEntry {
  id: string;
  kind: InboxKind;
  role: AgentRole;
  priority: RoutePriority;
  wake: boolean;
  at: number;
  summary: string;
  eventIds: string[];
  audienceIds: string[];
  inputKind?: AudienceInputRecord['kind'];
  count: number;
  taskId?: string;
}

export interface RoleContext {
  /** 最近一次裁剪后的简报。完整事件库不在这里。 */
  brief: unknown;
  phase: GenerationPhase;
  generationId: string | null;
  attemptId: string | null;
}

/**
 * 注册记录。岗位在绑定 session 时写死。
 * 没有 prompt，也没有可串行切换的共享 conversation。
 */
export interface RoleRegistration {
  role: AgentRole;
  sessionId: string;
  contextId: string;
  workerIndex: number;
}

export interface RoleInboxPort {
  push(entry: InboxEntry): void;
  update(id: string, patch: Pick<InboxEntry, 'summary' | 'eventIds' | 'audienceIds' | 'count'>): void;
  pending(): readonly InboxEntry[];
}

export interface RoleSessionPort extends RoleRegistration {
  readonly tools: readonly AgentToolName[];
  readonly inbox: RoleInboxPort;
  readonly context: RoleContext;
  /** 字面量 false。取消端口不允许把它改成 true。 */
  readonly workerAborted: false;
  allows(tool: string): boolean;
}

/** 已排队或已开播的口播。取消未提交生成时只许读，不许停。 */
export interface ScheduledAudio {
  partId: string;
  state: Extract<SpeechPartState, 'queued' | 'starting' | 'playing'>;
  text: string;
  audioRef?: string;
}

export interface CancelSteerRequest {
  urgent: boolean;
  message: string;
  cause: string;
}

export interface CancelSteerResult {
  sessionId: string;
  role: AgentRole;
  keptInbox: true;
  keptSession: true;
  workerAborted: false;
  /** 先 cancel 再 steer。不满足 §8.2 条件时只有 steer。 */
  steps: Array<'cancel' | 'steer'>;
  cancelledGeneration: boolean;
  cancelledAttempt: { generationId: string; attemptId: string } | null;
  steered: boolean;
  toolLeftRunning: boolean;
  scheduledAudio: ScheduledAudio[];
}

export interface LiveBudgetPort {
  acquire(role: AgentRole, requestId: string): LimitDecision;
  release(requestId: string): void;
  liveInUse(): number;
}

export type LimitDecision =
  | { ok: true }
  | { ok: false; reason: 'saturated' | 'not-live-role' | 'duplicate' };

export interface ProductionJob {
  taskId: string;
  goal: string;
  /** 数字大的先做。 */
  priority: number;
  version: number;
  directionEpoch: number;
  deadlineShowTime?: number;
  enqueuedAt: number;
  state: 'waiting' | 'running' | 'done' | 'cancelled';
}

export interface ProductionQueuePort {
  enqueue(job: ProductionJob): void;
  peekNext(): ProductionJob | undefined;
  markRunning(taskId: string): void;
  complete(taskId: string): void;
  cancel(taskId: string): ProductionJob | undefined;
  waitingCount(): number;
  runningCount(): number;
}

export const TASK_REPORT_STATUSES = ['progress', 'waiting', 'ready', 'blocked', 'failed'] as const;
export type TaskReportStatus = (typeof TASK_REPORT_STATUSES)[number];

/**
 * 制作池回报。ready 只表示候选可讨论，不是 take，也不是观众已看到。
 * failed 不是取消任务，更不是停已排音频。
 */
export interface TaskReportEnvelope {
  taskId: string;
  taskVersion: number;
  directionEpoch: number;
  status: TaskReportStatus;
  note: string;
  candidateOnly: true;
}

export type ReportDecision =
  | { ok: true; envelope: TaskReportEnvelope }
  | { ok: false; reason: 'bad-status' | 'empty-note' | 'unknown-task' | 'stale-version' | 'stale-direction' };
