/** Real independent DSH sessions. No model call waits for another role's generation. */
import { randomUUID } from 'node:crypto';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import type { AgentRole } from '../domain/codes';

export interface DshAgentPort {
  session: { id: string };
  status?: string;
  steer(message: unknown): unknown;
  followup(message: unknown): unknown;
  cancel(cause: unknown, options?: { keepInbox: boolean }): unknown;
  whenIdle?(): Promise<unknown>;
}
interface TeamContext {
  get?(name: string): any;
  [name: string]: any;
}
interface Resident {
  role: AgentRole;
  agent: DshAgentPort;
  phase: 'idle' | 'generating' | 'tool';
  attemptId?: string;
  activeAttempt?: string;
  tools: Set<string>;
  paused?: boolean;
  ready: boolean;
  queue: { text: string; urgent: boolean }[];
  disposed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
export interface RoleRuntime {
  brief(role: AgentRole): unknown;
  invoke(role: AgentRole, tool: string, args: Record<string, unknown>): Promise<unknown>;
}
export const ROLES: AgentRole[] = ['performer', 'director', 'editorial', 'production'];
const INTERVAL: Record<AgentRole, number> = {
  performer: 6000,
  director: 3500,
  editorial: 18000,
  production: 10000,
};
const msg = (text: string) =>
  Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'aivtb-v2' },
  });

export class DshLiveTeam {
  private readonly residents = new Map<AgentRole, Resident>();
  private readonly bySession = new Map<string, Resident>();
  private opening?: Promise<void>;
  private stopped = false;
  private readonly roleErrors = new Map<AgentRole, string>();
  constructor(
    private readonly ctx: TeamContext,
    readonly runtime: RoleRuntime,
    private readonly cwd: string,
  ) {}
  start(): Promise<void> {
    if (this.opening) return this.opening;
    this.stopped = false;
    this.opening = this.openAll().catch(async (error) => {
      await this.stop();
      throw error;
    });
    return this.opening;
  }
  private async openAll() {
    const registry = this.ctx.get?.('agents');
    const selection = this.ctx.get?.('agentDefaultModel')?.currentSelection?.();
    if (!registry?.create || !selection) throw new Error('DSH AgentRegistry/model not ready');
    // Each ready seat can act immediately; slow background setup is not a live gate.
    for (const role of ROLES) {
      if (this.stopped) throw new Error('Team stopped during setup');
      try {
        await this.openRole(role);
      } catch (error) {
        if (this.stopped) throw error;
        this.roleErrors.set(role, error instanceof Error ? error.message : String(error));
        this.ctx.logger?.warn?.(`live-v2 ${role}: ${this.roleErrors.get(role)}`);
      }
    }
  }
  private async openRole(role: AgentRole) {
    const registry = this.ctx.get?.('agents');
    const selection = this.ctx.get?.('agentDefaultModel')?.currentSelection?.();
    if (!registry?.create || !selection || !this.ctx.get?.('agentPresets')?.select)
      throw Error('DSH AgentRegistry/model/preset registry not ready');
    const sessionId = `live-v2-${role}-${randomUUID()}`;
    const selected = { ...selection, reasoningEffort: 'low' };
    const { agent } = await registry.create({
      sessionId,
      meta: { cwd: this.cwd, agentPreset: `live-v2-${role}` },
      agentOptions: { provider: selected.provider, model: selected.model },
      setup: (agentCtx: unknown) => {
        installModelSelection(agentCtx as never, { current: selected, assembled: undefined } as never);
      },
    });
    const resident: Resident = {
      role,
      agent,
      phase: 'idle',
      tools: new Set(),
      ready: false,
      queue: [],
      disposed: false,
    };
    this.residents.set(role, resident);
    this.bySession.set(sessionId, resident);
    try {
      if (this.stopped) throw Error('Team stopped during setup');
      await this.ctx.get?.('agentPresets')?.select?.(agent, `live-v2-${role}`);
      await agent.whenIdle?.();
      if (this.stopped) throw Error('Team stopped during setup');
      resident.ready = true;
      this.roleErrors.delete(role);
      this.wake(role, '开始工作。先读取本岗位简报；允许观察与停留，不要求每轮发声或换画面。');
      const pending = resident.queue.splice(0);
      if (pending.length)
        this.wake(
          role,
          '初始化期间的新消息，以当前简报为准：\n' +
            pending
              .slice(-8)
              .map((m) => m.text)
              .join('\n'),
          pending.some((m) => m.urgent),
        );
    } catch (error) {
      agent.cancel({ kind: 'user', reason: 'role-setup-failed' }, { keepInbox: true });
      this.residents.delete(role);
      this.bySession.delete(sessionId);
      throw error;
    }
  }
  errors() {
    return Object.fromEntries(this.roleErrors);
  }
  roleForSession(id?: string): AgentRole | undefined {
    return id ? this.bySession.get(id)?.role : undefined;
  }
  hasSession(id?: string) {
    return !!id && this.bySession.has(id);
  }
  async invoke(sessionId: string | undefined, role: AgentRole, tool: string, args: Record<string, unknown>) {
    if (
      !sessionId ||
      this.roleForSession(sessionId) !== role ||
      !this.bySession.get(sessionId)?.ready ||
      this.bySession.get(sessionId)?.paused ||
      this.stopped
    )
      throw new Error('Unbound role session');
    return this.runtime.invoke(role, tool, args);
  }
  wake(role: AgentRole, text: string, urgent = false) {
    const r = this.residents.get(role);
    if (!r || r.disposed || r.paused || this.stopped) return;
    if (!r.ready) {
      r.queue.push({ text, urgent });
      if (r.queue.length > 64) r.queue.shift();
      return;
    }
    if (r.timer) {
      clearTimeout(r.timer);
      r.timer = undefined;
    }
    const message = msg(text);
    if (urgent && r.phase === 'generating') {
      // Official DSH ordering: cancel the old generation, preserving inbox, then steer synchronously.
      r.agent.cancel({ kind: 'user', reason: 'live-urgent' }, { keepInbox: true });
      r.agent.steer(message);
    } else if (r.phase === 'idle' && r.agent.status === 'idle') r.agent.followup(message);
    else r.agent.steer(message);
  }
  observeStream(agent: any, frame: any) {
    const r = this.bySession.get(agent?.session?.id);
    if (!r || r.disposed || r.agent !== agent) return;
    if (frame?.type === 'start') {
      r.activeAttempt = String(frame.attemptId);
      r.phase = 'generating';
      r.attemptId = String(frame.attemptId ?? '');
    }
    if (frame?.type === 'end' && r.activeAttempt === String(frame.attemptId)) {
      r.activeAttempt = undefined;
      r.phase = r.tools.size ? 'tool' : 'idle';
    }
  }
  observeEvent(session: any, event: any) {
    const r = this.bySession.get(session?.id);
    if (!r || r.disposed) return;
    if (event.type === 'tool/call') {
      r.tools.add(String(event.data?.callId));
      r.phase = 'tool';
    }
    if (event.type === 'tool/result') {
      r.tools.delete(String(event.data?.message?.source?.callId));
      r.phase = r.tools.size ? 'tool' : r.activeAttempt ? 'generating' : 'idle';
    }
  }
  /** Called from actual idle hook/poll; timers never force utterances or replace scene content. */
  poll() {
    for (const r of this.residents.values()) {
      if (!r.ready || r.disposed || r.paused || this.stopped || r.agent.status !== 'idle' || r.timer)
        continue;
      r.phase = 'idle';
      r.timer = setTimeout(() => {
        r.timer = undefined;
        if (r.agent.status !== 'idle' || r.disposed || this.stopped) return;
        this.wake(r.role, '现场观察点：读取最新简报，决定是否有必要行动；有明确等待条件时继续停留。');
      }, INTERVAL[r.role]);
      r.timer.unref?.();
    }
  }
  async setOnline(role: AgentRole, online: boolean) {
    const r = this.residents.get(role);
    if (!r) {
      if (online) {
        await this.openRole(role);
        return;
      }
      throw new Error('Role not started');
    }
    r.paused = !online;
    if (!online) {
      if (r.timer) {
        clearTimeout(r.timer);
        r.timer = undefined;
      }
      r.agent.cancel({ kind: 'user', reason: 'role-pause' }, { keepInbox: true });
    } else this.wake(role, '岗位恢复，先读最新简报。');
  }
  snapshot() {
    return [...this.residents.values()].map((r) => ({
      role: r.role,
      sessionId: r.agent.session.id,
      phase: r.phase,
      ready: r.ready,
      paused: r.paused ?? false,
      status: r.agent.status,
      attemptId: r.attemptId,
    }));
  }
  async stop() {
    this.stopped = true;
    const running = [...this.residents.values()];
    for (const r of running) {
      r.disposed = true;
      if (r.timer) clearTimeout(r.timer);
      r.agent.cancel({ kind: 'user', reason: 'live-team-stop' }, { keepInbox: true });
    }
    await Promise.all(
      running.map(async (r) => {
        await r.agent.whenIdle?.();
      }),
    );
    this.residents.clear();
    this.bySession.clear();
    this.opening = undefined;
  }
}
