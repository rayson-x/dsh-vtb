/**
 * 导播决定。计划 §2.1、§4.4、§4.5。
 * 候选 ready 不自动 take。画面停留不加效果。不替主播写垫话。
 * 冷切不在这里签发授权；没有授权就留在当前方向。
 */

export interface DirectorObservation {
  editorialInboxEmpty: boolean;
  editorialPaused: boolean;
  suggestion: string | null;
  candidateReady: boolean;
  /** 观察值。策略里没有「画面不变就加效果」的阈值。 */
  pictureUnchangedMs: number;
  /** 只有调用方点名 take 才为 true。ready 本身不会把它设上。 */
  explicitTake: boolean;
}

export type DirectorDecision =
  | { action: 'take'; autoTake: false; waitedForEditorial: false }
  | {
      action: 'dwell';
      autoTake: false;
      addedEffect: false;
      forcedSpeech: false;
      reason: 'ready-is-not-take' | 'hold';
      waitedForEditorial: false;
    };

export function decideDirector(observation: DirectorObservation): DirectorDecision {
  if (observation.explicitTake) {
    return { action: 'take', autoTake: false, waitedForEditorial: false };
  }
  return {
    action: 'dwell',
    autoTake: false,
    addedEffect: false,
    forcedSpeech: false,
    reason: observation.candidateReady ? 'ready-is-not-take' : 'hold',
    waitedForEditorial: false,
  };
}
