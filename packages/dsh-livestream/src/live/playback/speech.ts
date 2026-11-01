/**
 * SpeechScheduler 的状态转移。计划 §3.5、§7.2。
 * 这里只判断口播能不能进下一态。真正的序号和事件由内核写入。
 * starting 是已提交，不是 playing。
 */

import type { SpeechPartState } from '../domain/codes';
import type { SpeechPart } from '../domain/entities';

export const SPEECH_OPEN = new Set<SpeechPartState>(['offered', 'accepted', 'queued']);
export const SPEECH_LIVE = new Set<SpeechPartState>(['starting', 'playing']);
export const SPEECH_TERMINAL = new Set<SpeechPartState>(['ended', 'rejected', 'cancelled', 'aborted', 'failed']);

/** 与 domain SPEECH_COMMITTED_STATES 一致：过了 starting 就不能当没发生。 */
export function speechCommitted(state: SpeechPartState): boolean {
  return state === 'starting' || state === 'playing' || state === 'ended' || state === 'aborted' || state === 'failed';
}

/** 占用单一人声队列的状态。offered/accepted 仍是预备，不算已提交队列。 */
export function occupiesVoice(state: SpeechPartState): boolean {
  return state === 'queued' || state === 'starting' || state === 'playing';
}

export function voiceOccupant(parts: Iterable<SpeechPart>): SpeechPart | undefined {
  for (const part of parts) {
    if (occupiesVoice(part.state)) return part;
  }
  return undefined;
}

export function reviseSpeech(part: SpeechPart, patch: Partial<Omit<SpeechPart, 'partId' | 'revision'>>): SpeechPart {
  return { ...part, ...patch, revision: part.revision + 1 };
}
