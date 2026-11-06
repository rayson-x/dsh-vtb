/**
 * 制作任务与不可变产物。计划 §3.1、§3.2。
 * 登记候选不是送播。过时方向可以留下产物，liveEligible 必须关掉。
 * 就绪门闩的超时数值不在这里，仍是 pending-p2。
 */

import type { AssetVersion, ProductionTask } from '../domain/entities';

export function openTask(
  task: Omit<ProductionTask, 'revision' | 'version' | 'cancelled' | 'liveEligible' | 'status' | 'assetVersionIds' | 'directionEpoch'>,
  directionEpoch: number,
  liveEligible = true,
): ProductionTask {
  return {
    ...task,
    revision: 1,
    version: 1,
    directionEpoch,
    cancelled: false,
    liveEligible,
    status: 'open',
    assetVersionIds: [],
  };
}

export function publishOntoTask(
  task: ProductionTask,
  asset: Omit<AssetVersion, 'revision'>,
  currentEpoch: number,
): { task: ProductionTask; asset: AssetVersion } {
  const stored: AssetVersion = { ...asset, revision: 1 };
  const validEpoch = task.directionEpoch === currentEpoch && !task.cancelled;
  const eligible = validEpoch && task.liveEligible;
  const next: ProductionTask = {
    ...task,
    assetVersionIds: [...task.assetVersionIds, stored.id],
    version: task.version + 1,
    liveEligible: eligible,
    status: (eligible||(validEpoch&&!!task.intendedDirectionId)) ? 'ready' : task.status === 'cancelled' ? 'cancelled' : 'archived',
    revision: task.revision + 1,
  };
  return { task: next, asset: stored };
}

/** 方向关掉之后：产物还在，但不能凭旧任务的 ready 上播。 */
export function closeTaskForEpoch(task: ProductionTask): ProductionTask {
  let status = task.status;
  if (status === 'open') status = 'cancelled';
  else if (status === 'ready') status = 'archived';
  return {
    ...task,
    liveEligible: false,
    cancelled: status === 'cancelled' ? true : task.cancelled,
    status,
    revision: task.revision + 1,
  };
}

/** Legacy WAL may contain named priorities; new commands store numeric ranks. */
export function productionPriority(value: unknown): number {
  if(typeof value==='number'&&Number.isFinite(value))return value;
  return ({high:80,normal:50,low:20} as Record<string,number>)[String(value)]??0;
}
export function unmetProductionDependencies(task:ProductionTask,tasks:Record<string,ProductionTask>):string[]{
  return task.dependsOn.filter(id=>!tasks[id]||tasks[id].cancelled||tasks[id].status!=='ready'||tasks[id].directionEpoch!==task.directionEpoch);
}
