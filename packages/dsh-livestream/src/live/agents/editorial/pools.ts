/**
 * 当前 / 下一 / 过场内容池。计划 §4.1、§4.3。
 * 条目引用 ScenePackage 版本或仍在生产的任务。入池不是上播。
 * 不同 directionEpoch 的素材不默认进当前池。
 */

export const POOL_LANES = ['current', 'next', 'transition'] as const;
export type PoolLane = (typeof POOL_LANES)[number];

export type CandidateRef =
  | { kind: 'scene-package'; packageId: string; codeVersion: string; directionEpoch: number }
  | { kind: 'task'; taskId: string; directionEpoch: number };

export interface PoolEntry {
  id: string;
  lane: PoolLane;
  summary: string;
  ref: CandidateRef;
  onAir: false;
  source: 'fixture' | 'production';
}

export interface ContentPools {
  revision: number;
  /** 这份池写下来时的节目 epoch。读的时候再按当前 epoch 过滤。 */
  directionEpoch: number;
  current: PoolEntry[];
  next: PoolEntry[];
  transition: PoolEntry[];
}

export function emptyPools(directionEpoch: number): ContentPools {
  return { revision: 0, directionEpoch, current: [], next: [], transition: [] };
}

export function refEpoch(ref: CandidateRef): number {
  return ref.directionEpoch;
}

export function sameEpoch(ref: CandidateRef, epoch: number): boolean {
  return ref.directionEpoch === epoch;
}

/**
 * 给当前节目看的池。
 * 当前和过场只留同一 epoch。下一方向预备包留在 next，不抄进 current。
 */
export function projectPools(pools: ContentPools, showEpoch: number): ContentPools {
  return {
    revision: pools.revision,
    directionEpoch: showEpoch,
    current: pools.current.filter((entry) => sameEpoch(entry.ref, showEpoch)),
    next: pools.next.filter((entry) => entry.ref.directionEpoch !== showEpoch),
    transition: pools.transition.filter((entry) => sameEpoch(entry.ref, showEpoch)),
  };
}

export function adoptIntoCurrent(
  pools: ContentPools,
  ref: CandidateRef,
  showEpoch: number,
): { ok: true; pools: ContentPools } | { ok: false; reason: 'epoch-not-reused' } {
  if (!sameEpoch(ref, showEpoch)) return { ok: false, reason: 'epoch-not-reused' };
  const id = ref.kind === 'task' ? ref.taskId : ref.packageId;
  const entry: PoolEntry = {
    id: `adopt-${id}`,
    lane: 'current',
    summary: '显式纳入当前池',
    ref,
    onAir: false,
    source: 'production',
  };
  return {
    ok: true,
    pools: {
      ...pools,
      revision: pools.revision + 1,
      directionEpoch: showEpoch,
      current: [...pools.current.filter((item) => sameEpoch(item.ref, showEpoch)), entry],
    },
  };
}
