/**
 * 展示板有没有东西：板子要不要出来、墙上的便签要不要让开。只看 StageState。
 */

import { GRAPHIC_OUT_MS } from '../stage/graphics';
import type { StageState } from '../stage/protocol';

/** 主画面有东西：素材、在播的包装、工位上的片子或翻资料（代码条、B-roll 也算工位） */
export function mainOccupied(state: StageState, now: number): boolean {
  if (state.panels.length || state.draw.items.length) return true;
  if (state.clip || state.broll) return true;
  return state.mode === 'code' && !!state.code;
}

/** 有节目、主画面又空着，才挂牌子 */
export function programCard(state: StageState, now: number): { title?: string; topic?: string } | null {
  if (mainOccupied(state, now)) return null;
  const { title, topic } = state.program;
  if (!title && !topic) return null;
  return { ...(title ? { title } : {}), ...(topic ? { topic } : {}) };
}
