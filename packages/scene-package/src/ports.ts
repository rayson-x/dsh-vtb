/**
 * pick / scaffold 端口。计划 §5.2、§1.2。
 * 没有私有 SDK 时返回 blocked，sdk 状态为 unavailable。
 * 不导出可调用的空模块，也不把 fixture catalog 当成挑中的候选。
 */

import { PRIVATE_SDK_REF, SDK_BLOCKERS } from './status';

export interface ProductionGoal {
  goal: string;
  directionEpoch: number;
  taskId?: string;
}

export interface BlockedProduction {
  status: 'blocked';
  sdk: 'unavailable';
  path: 'reuse' | 'author';
  operation: 'search' | 'get' | 'pick' | 'scaffold';
  reason: string;
  blockers: readonly string[];
  candidate: null;
  /** 没有模块可加载。保持 null，避免空 shim 被当成包。 */
  module: null;
  package: null;
}

export interface ComponentKitAccess {
  status: 'unavailable';
  sdk: 'unavailable';
  location: string;
  sourceRepo: string;
  sourceCommit: string;
  shares: readonly ['props', 'cues', 'media', 'design', 'text', 'rootMotion'];
  reason: string;
  implementation: null;
}

const REUSE_REASON = '无私有 SDK，effects pick 不可用。快速复用路径没有接通。';
const AUTHOR_REASON = '无私有 SDK，effects scaffold 不可用。临时创作路径没有接通。';

export function searchEffects(goal: ProductionGoal): BlockedProduction {
  return blocked('reuse', 'search', goal, '无私有 SDK，effects search 不可用。');
}

export function getEffect(goal: ProductionGoal): BlockedProduction {
  return blocked('reuse', 'get', goal, '无私有 SDK，effects get 不可用。');
}

export function pick(goal: ProductionGoal): BlockedProduction {
  return blocked('reuse', 'pick', goal, REUSE_REASON);
}

export function scaffold(goal: ProductionGoal): BlockedProduction {
  return blocked('author', 'scaffold', goal, AUTHOR_REASON);
}

export function componentKitAccess(): ComponentKitAccess {
  return {
    status: 'unavailable',
    sdk: 'unavailable',
    location: PRIVATE_SDK_REF.componentKit,
    sourceRepo: PRIVATE_SDK_REF.repo,
    sourceCommit: PRIVATE_SDK_REF.commit,
    shares: ['props', 'cues', 'media', 'design', 'text', 'rootMotion'],
    reason: `${PRIVATE_SDK_REF.componentKit} 在私有 ${PRIVATE_SDK_REF.repo}@${PRIVATE_SDK_REF.commit}，本包没有这份实现。`,
    implementation: null,
  };
}

function blocked(
  path: BlockedProduction['path'],
  operation: BlockedProduction['operation'],
  goal: ProductionGoal,
  reason: string,
): BlockedProduction {
  const goalNote = goal.goal.trim().length === 0 ? '目标为空。' : '';
  return {
    status: 'blocked',
    sdk: 'unavailable',
    path,
    operation,
    reason: `${goalNote}${reason}`,
    blockers: SDK_BLOCKERS,
    candidate: null,
    module: null,
    package: null,
  };
}
