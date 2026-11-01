/**
 * 候选 ScenePackage 货架。计划 §3.2、§5.2。
 * 入库不是 take，也不是观众已经看到。
 * takeable 要当场对照节目 epoch 和任务的 liveEligible，不把旧的 true 留到新方向。
 */

import { parseScenePackage, type ScenePackage } from '../../../../../scene-package/src/schema.ts';
import type { ProductionTask } from '../../domain/entities';

export interface ShelfRecord {
  packageId: string;
  codeVersion: string;
  hash: string;
  directionEpoch: number;
  taskId?: string;
  projected: boolean;
  withholdReason?: string;
}

export class CandidateShelf {
  private readonly packages = new Map<string, ScenePackage>();
  private readonly records = new Map<string, ShelfRecord>();

  get(packageId: string): ShelfRecord | undefined {
    const record = this.records.get(packageId);
    return record ? { ...record } : undefined;
  }

  package(packageId: string): ScenePackage | undefined {
    return this.packages.get(packageId);
  }

  /**
   * 保存一份已经解析过的包。同一 id 不能换内容。
   * 这里不计算 takeable，避免把写入当时的 epoch 冻成永久可上播。
   */
  put(input: {
    raw: unknown;
    directionEpoch: number;
    taskId?: string;
    projected: boolean;
    withholdReason?: string;
  }): { ok: true; record: ShelfRecord } | { ok: false; reason: string } {
    const parsed = parseScenePackage(input.raw);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    const existing = this.packages.get(parsed.value.id);
    if (existing) return { ok: false, reason: 'immutable' };
    const record: ShelfRecord = {
      packageId: parsed.value.id,
      codeVersion: parsed.value.codeVersion,
      hash: parsed.value.hash,
      directionEpoch: input.directionEpoch,
      projected: input.projected,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.withholdReason ? { withholdReason: input.withholdReason } : {}),
    };
    this.packages.set(parsed.value.id, parsed.value);
    this.records.set(parsed.value.id, record);
    return { ok: true, record: { ...record } };
  }
}

/**
 * 过期 epoch、未投影、已取消或 liveEligible 关掉时，都不能标成可 take。
 * true 只表示 Runtime 的 epoch 门还开着。调用方仍然没有 take。
 */
export function assessTakeable(record: ShelfRecord, showEpoch: number, task: ProductionTask | undefined): boolean {
  if (!record.projected) return false;
  if (record.directionEpoch !== showEpoch) return false;
  if (!task) return false;
  if (task.cancelled || !task.liveEligible) return false;
  if (task.directionEpoch !== showEpoch) return false;
  if (task.assetVersionIds.includes(record.packageId) === false) return false;
  return true;
}
