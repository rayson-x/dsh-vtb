/**
 * 任务与产物登记。计划 §2.3 的 live/production：登记、取消、候选。
 * 放在独立包里，避免改 agent.ts 和公共 schema。
 * 候选 ready 只表示登记完成，不是能力认证，也不是 take。
 */

import { deepFreeze } from './json';
import { parseScenePackage, type ScenePackage } from './schema';

export type ProductionTaskStatus = 'open' | 'ready' | 'archived' | 'timedOut' | 'cancelled';

/** 与 P1 ProductionTask 同形。多出来的诚实标记放在登记结果上，不塞进这条记录。 */
export interface ProductionTaskRecord {
  id: string;
  revision: number;
  version: number;
  goal: string;
  directionEpoch: number;
  priority: number;
  inputs: string[];
  dependsOn: string[];
  deadlineShowTime?: number;
  cancelled: boolean;
  /**
   * 只表示方向是否还允许考虑这份产物。
   * true 不是能力认证，也不是已经送播。
   */
  liveEligible: boolean;
  status: ProductionTaskStatus;
  assetVersionIds: string[];
  progressNote?: string;
}

export interface OpenTaskInput {
  id: string;
  goal: string;
  directionEpoch: number;
  priority: number;
  inputs?: string[];
  dependsOn?: string[];
  deadlineShowTime?: number;
}

export type LedgerResult<T> = { ok: true; value: T } | { ok: false; code: 'IMMUTABLE_VERSION' | 'UNKNOWN_TARGET' | 'REVISION_CONFLICT' | 'INVALID'; reason: string };

export interface AttachValue {
  task: ProductionTaskRecord;
  package: ScenePackage;
  /** 登记候选。调用方不能把它当成送播。 */
  onAir: false;
  certification: 'unverified';
}

export class ProductionLedger {
  private readonly tasks = new Map<string, ProductionTaskRecord>();
  private readonly packages = new Map<string, ScenePackage>();

  open(input: OpenTaskInput): LedgerResult<ProductionTaskRecord> {
    if (input.id.length === 0 || input.goal.length === 0) return reject('INVALID', '任务 id 或目标为空');
    if (this.tasks.has(input.id)) return reject('REVISION_CONFLICT', '任务编号已存在');
    const task: ProductionTaskRecord = {
      id: input.id,
      revision: 1,
      version: 1,
      goal: input.goal,
      directionEpoch: input.directionEpoch,
      priority: input.priority,
      inputs: [...(input.inputs ?? [])],
      dependsOn: [...(input.dependsOn ?? [])],
      ...(input.deadlineShowTime !== undefined ? { deadlineShowTime: input.deadlineShowTime } : {}),
      cancelled: false,
      liveEligible: true,
      status: 'open',
      assetVersionIds: [],
    };
    const stored = cloneTask(task);
    this.tasks.set(task.id, stored);
    return { ok: true, value: cloneTask(stored) };
  }

  cancel(taskId: string): LedgerResult<ProductionTaskRecord> {
    const task = this.tasks.get(taskId);
    if (!task) return reject('UNKNOWN_TARGET', '没有这个制作任务');
    task.cancelled = true;
    task.liveEligible = false;
    task.status = 'cancelled';
    task.revision += 1;
    return { ok: true, value: cloneTask(task) };
  }

  noteTimeout(taskId: string): LedgerResult<ProductionTaskRecord> {
    const task = this.tasks.get(taskId);
    if (!task) return reject('UNKNOWN_TARGET', '没有这个制作任务');
    if (task.cancelled) return reject('REVISION_CONFLICT', '任务已取消');
    task.status = 'timedOut';
    task.liveEligible = false;
    task.revision += 1;
    return { ok: true, value: cloneTask(task) };
  }

  /**
   * 把一份 ScenePackage 登记到任务上。
   * 同一 id 不能改内容。过时或已取消的任务可以留着产物，但不能标成可上播。
   */
  attach(taskId: string, raw: unknown): LedgerResult<AttachValue> {
    const task = this.tasks.get(taskId);
    if (!task) return reject('UNKNOWN_TARGET', '没有这个制作任务');
    const parsed = parseScenePackage(raw);
    if (!parsed.ok) return reject('INVALID', parsed.reason);
    const existing = this.packages.get(parsed.value.id);
    if (existing) return reject('IMMUTABLE_VERSION', '产物版本不可变，新内容要用新编号');
    const stored = deepFreeze(structuredClone(parsed.value));
    this.packages.set(stored.id, stored);
    task.assetVersionIds.push(stored.id);
    task.version += 1;
    task.revision += 1;
    if (task.cancelled) {
      task.status = 'cancelled';
      task.liveEligible = false;
    } else if (task.status === 'timedOut') {
      task.liveEligible = false;
    } else {
      task.status = 'ready';
      task.liveEligible = true;
    }
    return {
      ok: true,
      value: {
        task: cloneTask(task),
        package: stored,
        onAir: false,
        certification: 'unverified',
      },
    };
  }

  getPackage(id: string): ScenePackage | undefined {
    const stored = this.packages.get(id);
    return stored ? deepFreeze(structuredClone(stored)) : undefined;
  }

  getTask(id: string): ProductionTaskRecord | undefined {
    const task = this.tasks.get(id);
    return task ? cloneTask(task) : undefined;
  }
}

function cloneTask(task: ProductionTaskRecord): ProductionTaskRecord {
  return {
    ...task,
    inputs: [...task.inputs],
    dependsOn: [...task.dependsOn],
    assetVersionIds: [...task.assetVersionIds],
  };
}

function reject(
  code: 'IMMUTABLE_VERSION' | 'UNKNOWN_TARGET' | 'REVISION_CONFLICT' | 'INVALID',
  reason: string,
): LedgerResult<never> {
  return { ok: false, code, reason };
}
