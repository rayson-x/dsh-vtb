/**
 * 直播间画布：舞台上的每样东西都是画布上的一个元素，位置大小由她（DSH）管。
 *
 * 我们只给一份初始布局（PRESETS：杂谈、看片、讲课三套摆法）和几个命名区域；开播后她可以
 * 整套切换（[[layout watch]]），也可以单独挪任何元素（[[place avatar x=1300 y=480 w=520]]、[[place side hide]]）。
 * 画布 1920×1080，左上角是原点。元素的框挪动时舞台页会滑过去。
 */

import type { Scene } from './protocol';

export interface Box { x: number; y: number; w: number; h: number }
export interface Element extends Box { visible: boolean; z: number }

/** 画布上的固定元素；她摆的组件（素材、代码场景）另算，见 protocol 的 panels */
export type ElementId = 'avatar' | 'workspace' | 'subtitle' | 'side' | 'onair' | 'alerts';

export const ELEMENT_NAMES: Record<ElementId, string> = {
  avatar: '你自己（Live2D，宽高比固定 780:1010，给宽度就行）',
  workspace: '工位（查资料时是翻资料的画面，没东西时不显示；内容按 1400:900 缩放）',
  subtitle: '口播字幕条',
  side: '弹幕栏（右边一整条面板，观众的弹幕、礼物、关注都在这；[[place side hide]] 收起，show 放回来）',
  onair: '「直播中」角标和时间',
  alerts: '礼物、醒目留言提示',
};
export const ELEMENT_IDS = Object.keys(ELEMENT_NAMES) as ElementId[];

/** 工位、人物的原始尺寸：框按这个比例缩放内容 */
export const WORKSPACE_BASE = { w: 1400, h: 900 };
export const AVATAR_BASE = { w: 780, h: 1010 };

const el = (x: number, y: number, w: number, h: number, z: number, visible = true): Element => ({ x, y, w, h, z, visible });

export type LayoutName = 'chat' | 'watch' | 'lesson';

const WATCH: Record<ElementId, Element> = {
  workspace: el(112, 176, 1260, 628, 1),
  avatar: el(1480, 590, 420, 544, 3),
  subtitle: el(160, 884, 1180, 180, 5),
  side: el(1500, 138, 392, 452, 4),
  onair: el(1500, 40, 392, 84, 6),
  alerts: el(800, 30, 600, 300, 9),
};

/** 初始布局配置：三套摆法。lesson 和看片同一套位置 */
export const PRESETS: Record<LayoutName, { scene: Scene; elements: Record<ElementId, Element> }> = {
  // 杂谈：她站在房间中间偏右（舷窗和书架之间），左上节目牌，右边弹幕框，底下字幕条；上了素材展示板从左边出来
  chat: {
    scene: 'chat',
    elements: {
      workspace: el(94, 302, 640, 411, 1),
      avatar: el(700, -150, 840, 1088, 3),
      subtitle: el(300, 884, 1180, 180, 5),
      side: el(1500, 138, 392, 870, 4),
      onair: el(1500, 40, 392, 84, 6),
      alerts: el(670, 26, 600, 300, 9),
    },
  },
  // 展示：展示板铺满左边，她缩到右下角，弹幕框缩到右上
  watch: {
    scene: 'watch',
    elements: WATCH,
  },
  lesson: {
    scene: 'watch',
    elements: WATCH,
  },
};
export const LAYOUT_NAMES = Object.keys(PRESETS) as LayoutName[];

export function presetCanvas(name: LayoutName): Record<ElementId, Element> {
  return Object.fromEntries(ELEMENT_IDS.map((id) => [id, { ...PRESETS[name].elements[id] }])) as Record<ElementId, Element>;
}

/** 挪一个元素：给几个改几个；人物锁宽高比；框至少露一半在画布里，宽高有下限 */
export function placeBox(id: ElementId, prev: Element, patch: Partial<Box>): Element {
  const next = { ...prev, ...patch };
  next.w = Math.max(id === 'avatar' ? 160 : 120, Math.min(1920, next.w));
  next.h = id === 'avatar' ? Math.round((next.w * AVATAR_BASE.h) / AVATAR_BASE.w) : Math.max(40, Math.min(1080, next.h));
  if (id === 'workspace' && patch.w !== undefined && patch.h === undefined) next.h = Math.round((next.w * WORKSPACE_BASE.h) / WORKSPACE_BASE.w);
  next.x = Math.round(Math.max(-next.w / 2, Math.min(1920 - next.w / 2, next.x)));
  next.y = Math.round(Math.max(-next.h / 2, Math.min(1080 - next.h / 2, next.y)));
  next.w = Math.round(next.w);
  return next;
}

/** 给她看的一行：每个元素现在在哪 */
export function canvasLine(canvas: Record<ElementId, Element>): string {
  return ELEMENT_IDS.map((id) => {
    const e = canvas[id];
    return `${id} ${e.visible ? `(${e.x},${e.y}) ${e.w}×${e.h}` : '隐藏'}`;
  }).join('；');
}
