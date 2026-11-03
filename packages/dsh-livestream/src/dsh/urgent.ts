import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-livestream': { kind: 'dsh-livestream' };
    'dsh-livestream-owner': { kind: 'dsh-livestream-owner' };
  }
}

// Session ids can outlive/refer to replacement Agents; only the exact live instance owns an attempt.
const generating = new WeakMap<Agent, AssistantStreamFrame['attemptId']>();

export function observeGeneration(agent: Agent, frame: AssistantStreamFrame): void {
  if (frame.type === 'start') generating.set(agent, frame.attemptId);
  else if (frame.type === 'end' && generating.get(agent) === frame.attemptId) generating.delete(agent);
}

/** Keep queued work and the session; never cancel a tool step or wait for the old turn. */
export function steerHost(agent: Agent, message: UserMessage, urgent = false): void {
  if (urgent && generating.has(agent)) {
    agent.cancel({ kind: 'hook', reason: 'dsh-livestream/urgent' }, { keepInbox: true });
  }
  agent.steer(message);
}
