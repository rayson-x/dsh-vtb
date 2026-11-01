/**
 * 角色注册表。计划 §2.2。
 * 一个 session 只属于一个岗位。不能把同一段对话改个提示词再当成另一个角色。
 */

import type { AgentRole } from '../domain/codes';
import { TOOL_PERMISSIONS, type AgentToolName } from '../domain/permissions';
import { MemoryInbox } from './inbox';
import {
  PRODUCTION_POOL_MAX,
  RESIDENT_ROLES,
  type GenerationPhase,
  type ResidentRole,
  type RoleContext,
  type RoleRegistration,
  type RoleSessionPort,
} from './ports';

export class RoleSession implements RoleSessionPort {
  readonly inbox = new MemoryInbox();
  readonly context: RoleContext = {
    brief: null,
    phase: 'idle',
    generationId: null,
    attemptId: null,
  };
  readonly workerAborted = false as const;
  readonly tools: readonly AgentToolName[];
  private readonly allowed: ReadonlySet<string>;

  constructor(
    readonly role: AgentRole,
    readonly sessionId: string,
    readonly contextId: string,
    readonly workerIndex: number,
  ) {
    this.tools = Object.freeze([...TOOL_PERMISSIONS[role]]);
    this.allowed = new Set(this.tools);
  }

  registration(): RoleRegistration {
    return {
      role: this.role,
      sessionId: this.sessionId,
      contextId: this.contextId,
      workerIndex: this.workerIndex,
    };
  }

  allows(tool: string): boolean {
    return this.allowed.has(tool);
  }

  setPhase(phase: GenerationPhase, attempt?: { generationId: string; attemptId: string }): void {
    if (phase === 'idle') {
      this.context.phase = 'idle';
      this.context.generationId = null;
      this.context.attemptId = null;
      return;
    }
    if (!attempt?.generationId || !attempt.attemptId) {
      throw new Error('生成或工具相位要带 generationId 和 attemptId');
    }
    this.context.phase = phase;
    this.context.generationId = attempt.generationId;
    this.context.attemptId = attempt.attemptId;
  }
}

export class RoleRegistry {
  private readonly sessions = new Map<string, RoleSession>();
  private readonly residents = new Map<ResidentRole, RoleSession>();
  private readonly production: RoleSession[] = [];

  bindResident(role: ResidentRole, sessionId = `session-${role}`): RoleSession {
    if (this.residents.has(role)) {
      throw new Error(`role-bound: ${role} 已有独立 session，不能改挂到另一段对话`);
    }
    const session = this.create(role, sessionId, 0);
    this.residents.set(role, session);
    return session;
  }

  bindProduction(sessionId?: string): RoleSession {
    if (this.production.length >= PRODUCTION_POOL_MAX) {
      throw new Error(`pool-full: 制作池最多 ${PRODUCTION_POOL_MAX} 个并行 session`);
    }
    const workerIndex = this.production.length;
    const session = this.create('production', sessionId ?? `session-production-${workerIndex}`, workerIndex);
    this.production.push(session);
    return session;
  }

  resident(role: ResidentRole): RoleSession {
    const session = this.residents.get(role);
    if (!session) throw new Error(`role-missing: ${role}`);
    return session;
  }

  productionWorkers(): readonly RoleSession[] {
    return [...this.production];
  }

  all(): readonly RoleSession[] {
    return [...this.sessions.values()];
  }

  private create(role: AgentRole, sessionId: string, workerIndex: number): RoleSession {
    if (this.sessions.has(sessionId)) {
      throw new Error(`session-collision: ${sessionId} 已经绑定岗位，不能再串成 ${role}`);
    }
    const session = new RoleSession(role, sessionId, `ctx-${sessionId}`, workerIndex);
    this.sessions.set(sessionId, session);
    return session;
  }
}

export function residentRoles(): readonly ResidentRole[] {
  return RESIDENT_ROLES;
}
