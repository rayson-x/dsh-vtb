/**
 * 语义 cue 运行时 resolver。计划 §7.3。
 * 锚点只认 SpeechPartId + Unicode 字位置、节目时间，或明确的节目事件。
 * 不按重复文本做首次匹配，也不用字数比例估时冒充逐字时标。
 */

import type { CueBinding, SpeechPart } from '../domain/entities';

export type CueResolutionStatus = 'future' | 'due' | 'invalid' | 'executed';

export interface CueResolution {
  status: CueResolutionStatus;
  /** speech 锚点沿用口播的 alignment；节目时间/事件不是逐字时标。 */
  alignment: SpeechPart['alignment']['mode'] | 'programme';
  /** 只有 real 且 starts 覆盖到该字，才算真实逐字证据。estimated 不会被升成 real。 */
  realWordTiming: boolean;
  reason: string;
}

export interface CueResolveContext {
  now: number;
  speech: (partId: string) => SpeechPart | undefined;
  hasEvent: (eventId: string) => boolean;
}

export function codePoints(text: string): number {
  return [...text].length;
}

export function hasRealWordTiming(part: SpeechPart, charIndex: number): boolean {
  return part.alignment.mode === 'real' && (part.alignment.starts?.length ?? 0) > charIndex;
}

export function resolveCue(cue: CueBinding, ctx: CueResolveContext): CueResolution {
  if (cue.status === 'dispatched' || cue.status === 'executed') {
    return { status: 'executed', alignment: 'programme', realWordTiming: false, reason: '已执行的 cue 不改写、不重放' };
  }
  if (cue.status === 'invalidated') {
    return { status: 'invalid', alignment: 'absent', realWordTiming: false, reason: 'cue 已失效' };
  }
  const anchor = cue.anchor;
  if (anchor.kind === 'showTime') {
    const due = ctx.now >= anchor.at;
    return {
      status: due ? 'due' : 'future',
      alignment: 'programme',
      realWordTiming: false,
      reason: due ? '节目时间已到' : '节目时间未到',
    };
  }
  if (anchor.kind === 'programmeEvent') {
    const due = ctx.hasEvent(anchor.eventId);
    return {
      status: due ? 'due' : 'future',
      alignment: 'programme',
      realWordTiming: false,
      reason: due ? '节目事件已记录' : '节目事件尚未出现',
    };
  }
  const part = ctx.speech(anchor.partId);
  if (!part) {
    return { status: 'invalid', alignment: 'absent', realWordTiming: false, reason: '锚点口播不存在' };
  }
  const length = codePoints(part.text);
  if (!Number.isInteger(anchor.charIndex) || anchor.charIndex < 0 || anchor.charIndex >= length) {
    return { status: 'invalid', alignment: part.alignment.mode, realWordTiming: false, reason: '字位置不是这段口播里的有效 Unicode 下标' };
  }
  const withdrawn = part.state === 'cancelled' || part.state === 'rejected' || part.state === 'aborted' || part.state === 'failed';
  if (withdrawn && anchor.charIndex >= part.spokenChars) {
    return { status: 'invalid', alignment: part.alignment.mode, realWordTiming: false, reason: '依赖的未念话已撤回' };
  }
  const spoken = (part.state === 'playing' || part.state === 'ended') && anchor.charIndex < part.spokenChars;
  if (!spoken) {
    return { status: 'future', alignment: part.alignment.mode, realWordTiming: false, reason: '锚点还没真正念到' };
  }
  const realWordTiming = hasRealWordTiming(part, anchor.charIndex);
  return {
    status: 'due',
    alignment: part.alignment.mode,
    realWordTiming,
    reason: realWordTiming ? '真实逐字时标已覆盖该字' : '已有发声进度，但没有真实逐字时标',
  };
}

/**
 * 未执行、且锚在这段口播上的未来 cue。
 * tail：只失效未念到的字（charIndex >= unreadFrom）。
 * replaced：整段替换后字位置不再可信，未来锚全部失效。
 * 已派发/已执行的不在这里，调用方不能靠返回值去改历史。
 */
export function cuesBrokenBySpeech(
  cues: Iterable<CueBinding>,
  partId: string,
  unreadFrom: number,
  mode: 'tail' | 'replaced',
): CueBinding[] {
  const broken: CueBinding[] = [];
  for (const cue of cues) {
    if (cue.status !== 'future') continue;
    if (cue.anchor.kind !== 'speech' || cue.anchor.partId !== partId) continue;
    if (mode === 'replaced' || cue.anchor.charIndex >= unreadFrom) broken.push(cue);
  }
  return broken;
}
