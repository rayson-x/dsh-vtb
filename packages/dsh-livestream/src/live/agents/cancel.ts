/**
 * 急件取消端口的内存实现。计划 §8.2。
 *
 * 只有真实急件、且该 session 正在生成旧回复时，才先 cancel 再 steer。
 * 正在跑工具，或只是闲时补料，不取消工具，只 steer。
 * 不先 steer 后 cancel，也不等 whenIdle。
 *
 * 已排音频只作为只读快照返回。这个函数没有 abort 回调，
 * 舞台 enqueue 也不接在这里。取消未提交生成不等于停已排音频。
 *
 * TODO(P5-wire)：换成 DSH `cancel(cause, {keepInbox:true})` 后同步 `steer(message)`。
 * 要用 assistant-stream 的 instance / attemptId 替换下面的相位字段。
 * 真实接入时还要核对 worker 没有被父 exec.signal 连带取消。
 */

import type { SpeechPart } from '../domain/entities';
import type { EngineeringState } from '../state';
import type { CancelSteerRequest, CancelSteerResult, ScheduledAudio } from './ports';
import type { RoleSession } from './registry';

const SCHEDULED = new Set<SpeechPart['state']>(['queued', 'starting', 'playing']);

export function readScheduledAudio(state: EngineeringState): ScheduledAudio[] {
  const scheduled: ScheduledAudio[] = [];
  for (const part of Object.values(state.speech)) {
    if (!SCHEDULED.has(part.state)) continue;
    if (part.state !== 'queued' && part.state !== 'starting' && part.state !== 'playing') continue;
    scheduled.push({
      partId: part.partId,
      state: part.state,
      text: part.text,
      ...(part.audioRef ? { audioRef: part.audioRef } : {}),
    });
  }
  scheduled.sort((left, right) => left.partId.localeCompare(right.partId));
  return scheduled;
}

export function cancelThenSteer(
  session: RoleSession,
  request: CancelSteerRequest,
  scheduledAudio: readonly ScheduledAudio[],
  entry: { id: string; at: number },
): CancelSteerResult {
  const phase = session.context.phase;
  const generating = phase === 'generating';
  const inTool = phase === 'tool';
  const shouldCancel = request.urgent && generating && !inTool;
  const steps: Array<'cancel' | 'steer'> = [];
  let cancelledAttempt: CancelSteerResult['cancelledAttempt'] = null;
  if (shouldCancel) {
    const generationId = session.context.generationId;
    const attemptId = session.context.attemptId;
    if (!generationId || !attemptId) throw new Error('正在生成但没有 attemptId');
    steps.push('cancel');
    cancelledAttempt = { generationId, attemptId };
    session.setPhase('idle');
  }
  steps.push('steer');
  session.inbox.push({
    id: entry.id,
    kind: 'steer',
    role: session.role,
    priority: request.urgent ? 'urgent' : 'live',
    wake: true,
    at: entry.at,
    summary: request.message,
    eventIds: [],
    audienceIds: [],
    count: 1,
  });
  return {
    sessionId: session.sessionId,
    role: session.role,
    keptInbox: true,
    keptSession: true,
    workerAborted: session.workerAborted,
    steps,
    cancelledGeneration: shouldCancel,
    cancelledAttempt,
    steered: true,
    toolLeftRunning: inTool,
    scheduledAudio: scheduledAudio.map((item) => ({ ...item })),
  };
}
