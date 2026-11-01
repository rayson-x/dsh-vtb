/**
 * 工位里的细看：放大到画面的哪一块。人物、工位在画布上的位置见 stage/canvas.ts。
 */

import type { Region } from '../stage/protocol';

/** 人物 Live2D 画布的原始尺寸（跟 canvas.ts 的 AVATAR_BASE 一致） */
export const AVATAR = { w: 780, h: 1010 };

/** 细看：放大到画面的哪一块（归一化的中心点） */
export const regionCenter: Record<Region, [number, number]> = {
  center: [0.5, 0.5],
  left: [0.22, 0.5],
  right: [0.78, 0.5],
  top: [0.5, 0.22],
  bottom: [0.5, 0.78],
  'top-left': [0.22, 0.22],
  'top-right': [0.78, 0.22],
  'bottom-left': [0.22, 0.78],
  'bottom-right': [0.78, 0.78],
};

export const FOCUS_ZOOM = 1.8;
