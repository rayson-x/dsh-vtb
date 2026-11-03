/**
 * 编导 / 制作的动作门。计划 §3.5、§2.1。
 * 工具名先过 P5 session 白名单。任务卡不能把白名单外面的动作放进来。
 * MandateCard 的禁止项之外，MANDATE_FLOOR 仍然有效。上下文和评论不参与判断。
 */

import { mandatePermits, MANDATE_FLOOR, type MandateCard } from '../domain/mandate';
import { boundaryDenied } from '../domain/permissions';

export type { MandateCard };

export type DeskRole = 'editorial' | 'production';

export type GateReason = 'tool-denied' | 'mandate-denied' | 'role-mismatch';

export type GateResult = { ok: true } | { ok: false; reason: GateReason };

export function editorialMandate(directionEpoch: number): MandateCard {
  return {
    mandateId: `p6-editorial-e${directionEpoch}`,
    scope: {
      role: 'editorial',
      directionEpoch,
      allowedActions: [
        'readShow',
        'readAudienceSummary',
        'publishEditorialProposal',
        'requestProduction',
        'prepareDirection',
      ],
    },
    forbiddenActions: [...MANDATE_FLOOR.editorial, 'issueSwitchAuthorization', 'abortPlayback'],
    acceptanceEvidence: ['候选未上播', '编导没有改当前 epoch'],
    delivery: 'candidate',
  };
}

export function productionMandate(directionEpoch: number, taskId?: string): MandateCard {
  return {
    mandateId: `p6-production-e${directionEpoch}`,
    scope: {
      role: 'production',
      directionEpoch,
      ...(taskId ? { taskId } : {}),
      allowedActions: ['readTask', 'publishCandidate', 'reportProgress'],
    },
    forbiddenActions: [...MANDATE_FLOOR.production, 'abortPlayback', 'updateInputs'],
    acceptanceEvidence: ['产物入库', 'ready 不是 take', '观众还没有看到'],
    delivery: 'candidate',
  };
}

/**
 * 白名单没过就停。过了再看任务卡和角色底线。
 * toolAllowed 来自 session.allows，不来自调用方自报角色。
 */
export function gateAction(input: {
  role: DeskRole;
  action: string;
  card: MandateCard;
  toolAllowed: boolean;
}): GateResult {
  if (!input.toolAllowed) return { ok: false, reason: 'tool-denied' };
  if (input.card.scope.role && input.card.scope.role !== input.role) {
    return { ok: false, reason: 'role-mismatch' };
  }
  const floor = MANDATE_FLOOR[input.role];
  if ((floor as readonly string[]).includes(input.action) || boundaryDenied(input.role, input.action)) {
    return { ok: false, reason: 'mandate-denied' };
  }
  if (!mandatePermits(input.card, input.action)) return { ok: false, reason: 'mandate-denied' };
  return { ok: true };
}
