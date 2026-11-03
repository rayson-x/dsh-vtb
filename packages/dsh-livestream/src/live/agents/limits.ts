/**
 * 现场请求预算。计划 §2.2、§8.3。
 * 主播和导播占用这份额度。制作池、编导不能借走。
 */

import type { AgentRole } from '../domain/codes';
import type { LimitDecision, LiveBudgetPort } from './ports';

export class LiveBudget implements LiveBudgetPort {
  private readonly held = new Map<string, 'performer' | 'director'>();

  constructor(private readonly slots: number) {
    if (!Number.isInteger(slots) || slots < 1) throw new Error('现场请求槽至少为 1');
  }

  acquire(role: AgentRole, requestId: string): LimitDecision {
    if (role !== 'performer' && role !== 'director') {
      return { ok: false, reason: 'not-live-role' };
    }
    if (!requestId) return { ok: false, reason: 'duplicate' };
    if (this.held.has(requestId)) return { ok: false, reason: 'duplicate' };
    if (this.held.size >= this.slots) return { ok: false, reason: 'saturated' };
    this.held.set(requestId, role);
    return { ok: true };
  }

  release(requestId: string): void {
    this.held.delete(requestId);
  }

  liveInUse(): number {
    return this.held.size;
  }
}
