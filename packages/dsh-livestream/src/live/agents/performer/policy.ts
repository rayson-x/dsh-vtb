/**
 * 主播决定。计划 §2.1、§4.5、§8.1。
 * 纯函数：编导建议只是输入。嘴空、沉默、画面没变都不生成垫话。
 * 没有「等编导批准」这一支。
 */

export interface PerformerObservation {
  editorialInboxEmpty: boolean;
  editorialPaused: boolean;
  /** 编导文本。可以出现，但不能变成必须照念的稿，也不能挡住开口。 */
  suggestion: string | null;
  /** 调用方显式要开口时才有。缺省就是留白。 */
  ownLine: { partId: string; text: string; plannedBeatRef?: string } | null;
  /** 已经派发的画面 cue。只有调用方同时给了后续台词，才接着 offer。 */
  visualCue: { cueId: string; partId: string; text: string } | null;
  interaction: { requestId: string; text: string } | null;
  /** 观察值。策略里没有「静音超过 N 毫秒就开口」的阈值。 */
  silenceMs: number;
}

export type PerformerDecision =
  | {
      action: 'offer';
      partId: string;
      text: string;
      plannedBeatRef?: string;
      because: 'own-initiative' | 'visual-cue';
      waitedForEditorial: false;
    }
  | { action: 'request-interaction'; requestId: string; text: string; waitedForEditorial: false }
  | { action: 'yield'; reason: 'no-filler'; waitedForEditorial: false; fillerInserted: false };

export function decidePerformer(observation: PerformerObservation): PerformerDecision {
  if (observation.ownLine && observation.ownLine.text.trim()) {
    return {
      action: 'offer',
      partId: observation.ownLine.partId,
      text: observation.ownLine.text,
      ...(observation.ownLine.plannedBeatRef ? { plannedBeatRef: observation.ownLine.plannedBeatRef } : {}),
      because: 'own-initiative',
      waitedForEditorial: false,
    };
  }
  if (observation.visualCue) {
    return {
      action: 'offer',
      partId: observation.visualCue.partId,
      text: observation.visualCue.text,
      because: 'visual-cue',
      waitedForEditorial: false,
    };
  }
  if (observation.interaction && observation.interaction.text.trim()) {
    return {
      action: 'request-interaction',
      requestId: observation.interaction.requestId,
      text: observation.interaction.text,
      waitedForEditorial: false,
    };
  }
  return { action: 'yield', reason: 'no-filler', waitedForEditorial: false, fillerInserted: false };
}
