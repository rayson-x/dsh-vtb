import { afterEach, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop';
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { LlmAdapter, LlmRuntime, createUserMessage, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import Tools, { defineTool } from '@deepseek-ai/dsh-tools';
import { apply as host } from '../src/dsh/index';
import { apply as performer } from '../src/dsh/agent';
import { createLive } from '../src/dsh/live';
import { StageController } from '../src/host/controller';
import { show, stage, liveInput } from '../src/dsh/runtime';

const note = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

async function fixture(tool = false) {
  const ctx = new Context();
  new SessionProjectionRegistry(ctx); new SessionStore(ctx); new AgentRegistry(ctx); new LlmRuntime(ctx);
  new SystemPrompt(ctx, {}); new Tools(ctx); new AgentLoop(ctx, { agents: [], maxParallelToolCalls: { get: () => 10 } });
  const toolState: { signal?: AbortSignal; release?: () => void } = {};
  ctx.tools.register(defineTool({
    name: 'blocked_tool', description: 'controlled tool boundary', parameters: {},
    output: { schema: { type: 'string' }, render: (_, text) => [{ type: 'text', text }] },
    execute: async (_, exec) => {
      toolState.signal = exec.signal;
      await new Promise<void>(resolve => { toolState.release = resolve; });
      return 'tool completed';
    },
  }));
  const calls: GenerateOptions[] = [];
  const callTimes: number[] = [];
  const releases: (() => void)[] = [];
  // Actual SDK driver; model requests block without network or a brain service.
  ctx.llm.registerAdapter(['fixture'], new class extends LlmAdapter {
    async *stream(request: GenerateOptions): AsyncGenerator<StreamChunk> {
      calls.push(request);
      callTimes.push(performance.now());
      if (tool && calls.length === 2) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('blocked-call'), name: 'blocked_tool', arguments: '{}' } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
      if (calls.length <= 2) await new Promise<void>((resolve, reject) => {
        releases.push(resolve);
        request.signal!.addEventListener('abort', () => reject(request.signal!.reason), { once: true });
      });
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }());
  const hostHandle = await ctx.agents.create({ sessionId: SessionId('urgent-host'), agentOptions: { provider: 'fixture', model: 'blocked' } });
  const workerHandle = await ctx.agents.create({ sessionId: SessionId('urgent-worker'), agentOptions: { provider: 'fixture', model: 'blocked' } });
  const { agent } = hostHandle;
  const { agent: worker } = workerHandle;
  const previous = show.sessionId;
  show.sessionId = agent.session.id;
  cleanups.push(async () => {
    agent.cancel({ kind: 'user' }); worker.cancel({ kind: 'user' }); releases.forEach(f => f()); toolState.release?.();
    await Promise.all([hostHandle.dispose(), workerHandle.dispose()]); show.sessionId = previous;
  });
  // Mount only the production stream listener, never the HTTP/stage connection.
  host({ effect: (fn, label) => { if (label === 'dsh-livestream 思考流') cleanups.push(fn()); }, on: ctx.on.bind(ctx) });
  worker.followup(note('worker research'));
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  agent.followup(note('old ordinary draft'));
  await vi.waitFor(() => expect(calls).toHaveLength(2));
  return { ctx, agent, worker, calls, request: calls[1]!, releases, toolState, callTimes };
}

it.each(['owner-soft', 'owner-cut', 'room-gift'] as const)('%s aborts blocked host generation, retains session/inbox and worker', async source => {
  const { ctx, agent, worker, calls, request, callTimes } = await fixture();
  const session = agent.session;
  const workerRequest = calls[0]!;
  agent.inject(note('keep pending context'));
  const audio = new StageController({ tickHz: 0 });
  cleanups.push(() => audio.stop());
  const spoken = '已经交给舞台的第一句话。还有未念完的后续。';
  let settled = false;
  void audio.enqueue(spoken, { ms: 100_000 }).done.then(() => { settled = true; });
  const apply = vi.spyOn(stage, 'apply').mockImplementation(command => audio.apply(command));
  vi.spyOn(stage, 'call').mockImplementation(async (name: string) => {
    if (name === 'speech.break') audio.apply({ type: 'interrupt', soft: true });
    return '' as any;
  });
  const sentAt = performance.now();
  let abortedAt = 0;
  request.signal!.addEventListener('abort', () => { abortedAt = performance.now(); }, { once: true });
  if (source === 'room-gift') {
    vi.spyOn(liveInput, 'hasUrgent').mockReturnValue(true); vi.spyOn(liveInput, 'hasBreak').mockReturnValue(false);
    vi.spyOn(liveInput, 'take').mockResolvedValue({ text: '［礼物］阿圆：小心心', urgent: true });
    performer({ effect: (fn, label) => { if (label === 'dsh-livestream 马上回') cleanups.push(fn()); }, get: ctx.get.bind(ctx) });
  } else await createLive({ get: ctx.get.bind(ctx) }).say('请先回应主人', source === 'owner-cut');
  await vi.waitFor(() => expect(request.signal!.aborted).toBe(true), { timeout: 1500 });
  await vi.waitFor(() => expect(calls.length).toBeGreaterThan(2));
  await agent.whenIdle();
  const text = JSON.stringify(calls.slice(2).map(c => c.messages));
  expect(JSON.stringify(calls[2]!.messages)).toContain(source === 'room-gift' ? '阿圆' : '请先回应主人');
  expect(text).toContain('keep pending context');
  console.info(JSON.stringify({ source, abortMs: +(abortedAt - sentAt).toFixed(2), restartMs: +(callTimes[2]! - sentAt).toFixed(2) }));
  expect(agent.session).toBe(session); expect(worker.status).toBe('running'); expect(workerRequest.signal!.aborted).toBe(false);
  if (source !== 'owner-cut') {
    expect(settled).toBe(false);
    expect(audio.lineup().map(line => line.text).join('')).toBe(spoken);
  }
  expect(apply.mock.calls.map(([command]) => command.type)).toEqual(source === 'owner-cut' ? ['interrupt'] : []);
});


it('ordinary idle nudge steers without aborting a live generation', async () => {
  const { ctx, agent, request, calls, releases } = await fixture();
  vi.spyOn(stage, 'isQuiet').mockReturnValue(false);
  vi.spyOn(stage, 'remainingMs').mockReturnValue(0);
  vi.spyOn(stage, 'call').mockResolvedValue('');
  vi.spyOn(liveInput, 'hasUrgent').mockReturnValue(false);
  vi.spyOn(liveInput, 'hasBreak').mockReturnValue(false);
  vi.spyOn(liveInput, 'take').mockResolvedValue({ text: 'ordinary background material', urgent: false });
  performer({ effect: (fn, label) => { if (label === 'dsh-livestream 推进') cleanups.push(fn()); }, get: ctx.get.bind(ctx) });
  await vi.waitFor(() => expect(JSON.stringify(agent.inbox.nextStep)).toContain('ordinary background material'), { timeout: 1500 });
  expect(request.signal!.aborted).toBe(false);
  releases[1]!();
  await agent.whenIdle();
  expect(JSON.stringify(calls.slice(2))).toContain('ordinary background material');
});

it.each(['idle', 'tool'] as const)('owner urgent during %s delivers without cancelling the turn/tool', async phase => {
  const { ctx, agent, request, calls, releases, toolState } = await fixture(phase === 'tool');
  if (phase === 'idle') { releases[1]!(); await agent.whenIdle(); }
  else await vi.waitFor(() => expect(toolState.signal).toBeDefined());
  vi.spyOn(stage, 'call').mockResolvedValue('');
  await createLive({ get: ctx.get.bind(ctx) }).say('urgent at boundary', false);
  expect(request.signal!.aborted).toBe(false);
  if (phase === 'tool') {
    expect(toolState.signal!.aborted).toBe(false);
    expect(calls).toHaveLength(2);
    toolState.release!();
  }
  await agent.whenIdle();
  expect(JSON.stringify(calls.slice(2))).toContain('urgent at boundary');
});


it('urgent cancellation preserves older queued followups and pending context', async () => {
  const { ctx, agent, calls, request } = await fixture();
  agent.inject(note('pending context must survive'));
  agent.followup(note('older followup must survive'));
  vi.spyOn(stage, 'call').mockResolvedValue('');
  await createLive({ get: ctx.get.bind(ctx) }).say('new urgent input', false);
  await vi.waitFor(() => expect(request.signal!.aborted).toBe(true));
  await agent.whenIdle();
  const delivered = JSON.stringify(calls.slice(2).map(call => call.messages));
  expect(delivered).toContain('pending context must survive');
  expect(delivered).toContain('older followup must survive');
  expect(delivered).toContain('new urgent input');
});
