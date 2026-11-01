/**
 * 任务级授权边界卡。协作约定第 3 条。
 * 写清可改范围、禁止动作、验收证据、交付去向。
 * 与 TOOL_BOUNDARIES 互补：那边是角色工具端口，这里是一张任务卡。
 * 不签发方向切换。换 epoch 仍走 issueSwitchAuthorization → SwitchAuthorization。
 * 扩大范围必须发新卡（supersedesMandateId）。上下文和评论不能扩权。
 */

import type { AgentRole } from './codes';

export const MANDATE_DELIVERIES = [
  'candidate',
  'proposal',
  'speech',
  'timeline-edit',
  'direction-candidate',
] as const;
export type MandateDelivery = (typeof MANDATE_DELIVERIES)[number];

/**
 * 卡上至少要能写下的禁止项，不是工具总表。
 * 编导备料 ≠ take/换方向；制作候选 ≠ 在播替换；主播即兴 ≠ 切大方向。
 */
export const MANDATE_FLOOR = {
  editorial: ['take', 'switchDirection'],
  production: ['take', 'replaceOnAir'],
  performer: ['switchDirection'],
} as const satisfies Record<'editorial' | 'production' | 'performer', readonly string[]>;

export interface MandateScope {
  role?: AgentRole;
  taskId?: string;
  /** 只在这个 epoch 内有效。过期后不能凭本卡上播，拒绝码 STALE_DIRECTION。 */
  directionEpoch: number;
  allowedPaths?: string[];
  allowedActions: string[];
}

export interface MandateCard {
  mandateId: string;
  scope: MandateScope;
  /** 禁止优先于 scope.allowedActions。 */
  forbiddenActions: string[];
  acceptanceEvidence: string[];
  delivery: MandateDelivery;
  /** 新卡替换旧卡。没有这个字段就不能把旧卡的范围扩大。 */
  supersedesMandateId?: string;
}

/** 动作必须在允许列表里，且不在禁止列表里。评论、上下文不参与判断。 */
export function mandatePermits(card: MandateCard, action: string): boolean {
  return card.scope.allowedActions.includes(action) && !card.forbiddenActions.includes(action);
}
