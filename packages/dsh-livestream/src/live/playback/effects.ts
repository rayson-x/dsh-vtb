/**
 * 提交钩子。给恢复测试计数用。
 * 这些回调表示「已经受理」，不是播放器绘制，也不是人声正在响。
 * hydrate 不得调用它们。
 */

import type { CueBinding, SceneInstance, SpeechPart } from '../domain/entities';

export interface ExecutionEffects {
  onCueCommitted(cue: CueBinding): void;
  onSpeechCommitted(part: SpeechPart): void;
  onTakeCommitted(scene: SceneInstance): void;
}

export const NO_EFFECTS: ExecutionEffects = {
  onCueCommitted() {},
  onSpeechCommitted() {},
  onTakeCommitted() {},
};
