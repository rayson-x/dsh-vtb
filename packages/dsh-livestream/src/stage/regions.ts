/**
 * 直播间布局：她能把组件摆到哪些区域。
 *
 * 舞台 1920×1080。右栏（节目单、任务、弹幕）和她自己占的地方不给组件用；
 * 组件都上在展示板（BOARD）里：展示时板铺满左边，杂谈时板在她和弹幕栏之间。
 * 同一张表既给舞台页摆位置，也生成给她看的布局说明（layoutText），两边不会对不上。
 */

import { ELEMENT_IDS, ELEMENT_NAMES } from './canvas';
import type { Scene } from './protocol';
import type { VisualKind } from './visual';

export type StageRegion = 'main' | 'left' | 'right' | 'top' | 'bottom' | 'center' | 'banner' | 'lower';

export interface Box { x: number; y: number; w: number; h: number }

const gap = 20;

/** 展示板（主画面那块框）里的各区域：board 是框的内沿 */
function regionsIn(M: Box): Record<StageRegion, Box> {
  const half = (M.w - gap) / 2;
  return {
    main: M,
    left: { x: M.x, y: M.y, w: half, h: M.h },
    right: { x: M.x + half + gap, y: M.y, w: half, h: M.h },
    top: { x: M.x, y: M.y, w: M.w, h: (M.h - gap) / 2 },
    bottom: { x: M.x, y: M.y + (M.h + gap) / 2, w: M.w, h: (M.h - gap) / 2 },
    center: { x: M.x + Math.round(M.w * 0.12), y: M.y + Math.round(M.h * 0.12), w: Math.round(M.w * 0.76), h: Math.round(M.h * 0.76) },
    banner: { x: M.x, y: M.y, w: M.w, h: Math.min(150, Math.round(M.h * 0.2)) },
    lower: { x: M.x, y: M.y + M.h - 170, w: M.w, h: 170 },
  };
}

/** 展示板的外框（frame-board 那张图）：杂谈时在左边、她身旁，展示时铺满左边（跟 canvas.ts 的摆法对齐） */
export const BOARD: Record<Scene, Box> = {
  chat: { x: 24, y: 176, w: 780, h: 680 },
  watch: { x: 32, y: 32, w: 1420, h: 860 },
};
/** 框图的边（上右下左，原图 1280×800 里内区离四边 180/100/110/100），按框的缩放算 */
export const BOARD_EDGE: Record<Scene, [number, number, number, number]> = {
  chat: [126, 70, 78, 70],
  watch: [144, 80, 88, 80],
};
const inner = (s: Scene): Box => {
  const b = BOARD[s];
  const [t, r, bt, l] = BOARD_EDGE[s];
  return { x: b.x + l, y: b.y + t, w: b.w - l - r, h: b.h - t - bt };
};

/** 每个场景下各区域在舞台上的位置 */
export const REGIONS: Record<Scene, Record<StageRegion, Box>> = {
  watch: regionsIn(inner('watch')),
  chat: regionsIn(inner('chat')),
};

export const REGION_NAMES: Record<StageRegion, string> = {
  main: '主画面整块', left: '主画面左半', right: '主画面右半', top: '主画面上半', bottom: '主画面下半',
  center: '主画面正中（四周留边）', banner: '顶部横幅（标题、一句话）', lower: '底部横条（字幕上方）',
};
export const STAGE_REGIONS = Object.keys(REGION_NAMES) as StageRegion[];

/** 没说放哪时的默认位置：素材默认铺满展示板；一句话的放横幅 */
export const DEFAULT_REGION: Record<VisualKind, StageRegion> = {
  image: 'main', compare: 'main', table: 'main', timeline: 'main', flow: 'main', list: 'main',
  formula: 'center', quiz: 'main', poll: 'main', quote: 'banner', scene: 'main',
  // 讲解组件要地方：默认放主画面
  diagram: 'main', figure: 'main', chart: 'main', number: 'center',
};

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** 两个区域会不会叠在一起（按看片场景算，杂谈时同样成立） */
export function regionsOverlap(a: StageRegion, b: StageRegion): boolean {
  return overlap(REGIONS.watch[a], REGIONS.watch[b]);
}

/** 给她看的布局说明：画布、元素、初始摆法、区域、用法 */
export function layoutText(): string {
  return [
    '直播间是一块 1920×1080 的画布（左上角是原点），整块交给你摆。画布上的元素：',
    ...ELEMENT_IDS.map((id) => `- ${id}：${ELEMENT_NAMES[id]}`),
    '直播间是海底女仆小书房：你站在房间中间，左上挂节目牌，右边弹幕框，底下字幕条；素材都上在展示板上（有素材才出来）。初始摆法有三套：chat（你在中间偏右，展示板从左边出来）、watch（展示板铺满左边，你在右下角、弹幕框缩到右上）、lesson（同 watch）。[[layout 名字]] 整套切换（会走转场）；之后你可以随意挪单个元素：[[place avatar x=1300 y=480 w=520]]、[[place side hide]]、[[place workspace at=left]]，挪动时会滑过去。你自己（avatar）也可以挪到任何地方、放大缩小，用 [[look left]] 之类转视线看向你要讲的东西。',
    '画面内容（字、图、数据、投票、线索……）都画在展示板上（见「画布」写法），画上第一样东西时自动换到 watch 摆法，全擦干净回到 chat。后台交的素材用 [[show 编号]] 画上来。',
    '每次工具回来的舞台情报里有「画布第几页」一行，告诉你画布上有哪些元素和编号。'
  ].join('\n');
}
