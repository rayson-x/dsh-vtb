/**
 * 制作池统一回报。计划 §3.5 reportProgress，加上队列自己的等待和阻塞。
 * 信封留在制作侧。它不送播，也不改口播。
 */

import { TASK_REPORT_STATUSES, type ReportDecision, type TaskReportEnvelope, type TaskReportStatus } from './ports';

export function acceptReport(
  input: Omit<TaskReportEnvelope, 'candidateOnly'> & { candidateOnly?: true },
  task: { version: number; directionEpoch: number } | undefined,
): ReportDecision {
  if (!(TASK_REPORT_STATUSES as readonly string[]).includes(input.status)) {
    return { ok: false, reason: 'bad-status' };
  }
  const note = input.note.trim();
  if (!note) return { ok: false, reason: 'empty-note' };
  if (!task) return { ok: false, reason: 'unknown-task' };
  if (input.taskVersion !== task.version) return { ok: false, reason: 'stale-version' };
  if (input.directionEpoch !== task.directionEpoch) return { ok: false, reason: 'stale-direction' };
  const envelope: TaskReportEnvelope = {
    taskId: input.taskId,
    taskVersion: input.taskVersion,
    directionEpoch: input.directionEpoch,
    status: input.status as TaskReportStatus,
    note,
    candidateOnly: true,
  };
  return { ok: true, envelope };
}
