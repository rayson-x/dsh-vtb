/**
 * 包装（动画图形）目录：Agent 用一个名字加几个字段就能上一段动画。
 *
 * 动画本体是 HyperFrames 组件（Apache-2.0，从 reelmorph-agent 效果库挑来，见 scripts/import-graphics.mjs），
 * 每个是一段 HTML + 一条暂停的 GSAP 时间线。舞台页把它放进 iframe，按舞台时钟逐帧 seek，
 * 所以中途打开页面也落在同一帧上。
 *
 * 这里只描述 Agent 能填什么：字段名、中文含义、长度上限；源组件的其余变量固定。
 */

export type GraphicSlot = 'full' | 'center' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type FieldKind = 'text' | 'number' | 'list';

export interface GraphicField {
  /** Agent 填的字段名 */
  key: string;
  /** 源组件的变量名 */
  to: string;
  label: string;
  kind: FieldKind;
  max?: number;
  required?: boolean;
}

export interface GraphicTemplate {
  /** 源组件（assets/graphics/<source>.html） */
  source: string;
  title: string;
  use: string;
  fields: GraphicField[];
  /** 源组件里固定下来的变量 */
  fixed?: Record<string, string | number | boolean>;
  /** 动画本身多长（秒）；之后停在最后一帧 */
  seconds: number;
  slot: GraphicSlot;
  /** 调试台和演示用的示例 */
  sample: Record<string, string>;
}

const text = (key: string, label: string, max: number, to = key, required = false): GraphicField => ({ key, to, label, kind: 'text', max, ...(required ? { required } : {}) });
const list = (key: string, label: string, max: number, to = key): GraphicField => ({ key, to, label, kind: 'list', max });
const num = (key: string, label: string, to = key): GraphicField => ({ key, to, label, kind: 'number' });

export const GRAPHICS: Record<string, GraphicTemplate> = {
  notice: {
    source: 'native-notification-pop', title: '系统通知', use: '弹一条通知：任务完成、有人关注、提醒',
    fields: [text('title', '标题', 24, 'title', true), text('body', '正文', 40), text('app', '来源名', 12, 'app_label')],
    fixed: { os: 'ios', at: 0.2, exit: 'none' }, seconds: 3, slot: 'full', sample: { title: '导出完成', body: '30 秒竖版已经渲好了', app: '剪辑台' },
  },
  notices: {
    source: 'notification-stack', title: '通知堆叠', use: '一连串事件叠成一摞：流程走到哪了',
    fields: [list('titles', '标题，逗号分隔（1–5 条）', 80), list('bodies', '正文，逗号分隔，和标题一一对应', 160)],
    fixed: { expand: -1, exit: 'none' }, seconds: 4, slot: 'full', sample: { titles: '素材已读,粗剪完成,开始渲染', bodies: '12 段素材全部入库,时长 2 分 14 秒,预计还要 40 秒' },
  },
  quote: {
    source: 'testimonial-card', title: '观众留言卡', use: '把一条弹幕或评价上墙，带名字',
    fields: [text('quote', '留言原文', 40, 'quote', true), text('author', '观众名', 16), text('handle', '小字（平台或身份）', 16)],
    fixed: { rating: 5 }, seconds: 4, slot: 'center', sample: { quote: '这段转场太丝滑了，求教程', author: '小鲸鱼', handle: '抖音观众' },
  },
  headline: {
    source: 'per-word-rise', title: '大标题', use: '逐字模糊升起的大标题：开新话题、章节名',
    fields: [text('text', '标题', 16, 'text', true)],
    fixed: { split: 'word', exit: 'none' }, seconds: 3.5, slot: 'center', sample: { text: '今天 来剪 一条 预告片' },
  },
  slam: {
    source: 'shutter-slam', title: '拍击大字', use: '一两个字砸到屏上：高能、名场面、惊呼',
    fields: [text('text', '字（越短越好）', 6, 'text', true)],
    fixed: { blur: 'shutter', exit: 'none' }, seconds: 6, slot: 'center', sample: { text: '绝了' },
  },
  decode: {
    source: 'scramble-reveal', title: '乱码解码', use: '乱码逐字锁定成一行：揭晓答案、亮出关键词',
    fields: [text('text', '揭晓的字', 16, 'text', true)],
    fixed: { style: 'terminal', exit: 'none' }, seconds: 3, slot: 'center', sample: { text: '深海成片' },
  },
  badge: {
    source: 'spring-pop', title: '弹出徽标', use: '弹出一个小标签：NEW、已完成、+1',
    fields: [text('text', '标签文字', 8, 'text', true)],
    seconds: 2, slot: 'top-left', sample: { text: '新功能' },
  },
  swap: {
    source: 'line-swap', title: '整行替换', use: '先说一句，再换成反转的一句，下划线点出关键词',
    fields: [text('from', '第一句', 24, 'line_a', true), text('to', '换成的句子', 24, 'line_b', true), text('word', '要划线的词（得在第二句里）', 8, 'underline_word')],
    fixed: { swap_at: 1.5, exit: 'none' }, seconds: 3.5, slot: 'bottom', sample: { from: '大家都说剪辑很难', to: '其实只差一个好节奏', word: '节奏' },
  },
  highlight: {
    source: 'marker-highlight', title: '划重点', use: '一句话里用马克笔划出一个词',
    fields: [text('text', '整句', 24, 'text', true), text('word', '要划的词（得在句子里）', 8, 'emphasis_word', true)],
    fixed: { style: 'highlight', draw_at: 0.9, exit: 'none' }, seconds: 3.5, slot: 'bottom', sample: { text: '好剪辑的关键是节奏', word: '节奏' },
  },
  annotate: {
    source: 'vox-annotate', title: '手绘批注', use: 'Vox 式批注：划词再拉一条手写旁注',
    fields: [text('text', '整句', 24, 'text', true), text('word', '要圈的词（得在句子里）', 8, 'keyword', true), text('note', '旁注', 12)],
    fixed: { style: 'highlight', draw_at: 0.9, exit: 'none' }, seconds: 4, slot: 'center', sample: { text: '这一刀切在呼吸上', word: '呼吸', note: '换气点' },
  },
  count: {
    source: 'count-up', title: '数字滚动', use: '大数字从起点滚到终点：礼物数、播放量、进度',
    fields: [num('to', '终点数字', 'end'), num('from', '起点数字（默认 0）', 'start'), text('prefix', '前缀', 4), text('suffix', '后缀（单位）', 4)],
    fixed: { glow: false, exit: 'none' }, seconds: 3, slot: 'center', sample: { to: '1314', from: '0', prefix: '', suffix: '赞' },
  },
  ring: {
    source: 'conic-progress-ring', title: '进度环', use: '环形进度：完成了百分之多少',
    fields: [num('progress', '进度 0–100'), text('label', '环中间的字', 6)],
    fixed: { thickness: 12 }, seconds: 4, slot: 'top-right', sample: { progress: '72', label: '72%' },
  },
  chart: {
    source: 'chart-story', title: '柱状图', use: '几根柱子说明一组数字，突出其中一根',
    fields: [list('data', '数字，逗号分隔（2–8 个）', 60), list('labels', '每根柱子的名字，逗号分隔', 80), text('unit', '单位', 4), num('emphasize', '突出第几根（从 1 数）')],
    fixed: { type: 'bars', exit: 'none' }, seconds: 5, slot: 'center', sample: { data: '12, 28, 45, 64', labels: '周一, 周二, 周三, 周四', unit: '万', emphasize: '4' },
  },
  steps: {
    source: 'state-chip-rail', title: '状态进度轨', use: '一排状态依次点亮：任务走到哪一步',
    fields: [list('states', '步骤名，逗号分隔（2–6 个）', 60)],
    fixed: { exit: 'none' }, seconds: 5, slot: 'bottom', sample: { states: '读素材,粗剪,配乐,导出' },
  },
  typing: {
    source: 'typed-prompt', title: '打字提示词', use: '在输入框里打出一句提示词：她要让工具做什么',
    fields: [text('text', '提示词', 40, 'text', true), text('fix', '打错后改成的结尾（可空）', 12, 'correction')],
    fixed: { cadence: 'human', caret: 'blink', prompt_glyph: '>', exit: 'none' }, seconds: 4, slot: 'bottom', sample: { text: '把第二段剪到 15 秒，配一段鼓点', fix: '' },
  },
  ticker: {
    source: 'ticker-takeover', title: '滚词定格', use: '一串候选词滚动，最后停在一个上：抽签、选答案',
    fields: [list('options', '候选词，逗号分隔', 60), text('pick', '最后停的词（得在候选里）', 8, 'final_word', true)],
    seconds: 4.5, slot: 'center', sample: { options: '赛博朋克,胶片感,极简,复古港风', pick: '胶片感' },
  },
};

export const GRAPHIC_NAMES = Object.keys(GRAPHICS);

/** 舞台上的放置框（1920×1080 里）；都是 16:9，组件按框自适应 */
/** 包装的位置框。底下一条（y ≥ 890）留给字幕，除了 full 谁都不压进去 */
export const SLOT_BOX: Record<GraphicSlot, { x: number; y: number; w: number; h: number }> = {
  full: { x: 0, y: 0, w: 1920, h: 1080 },
  center: { x: 400, y: 160, w: 1120, h: 630 },
  top: { x: 560, y: 24, w: 800, h: 450 },
  bottom: { x: 480, y: 340, w: 960, h: 540 },
  'top-left': { x: 32, y: 32, w: 640, h: 360 },
  'top-right': { x: 1248, y: 32, w: 640, h: 360 },
  'bottom-left': { x: 32, y: 520, w: 640, h: 360 },
  'bottom-right': { x: 1248, y: 520, w: 640, h: 360 },
};
export const GRAPHIC_SLOTS = Object.keys(SLOT_BOX) as GraphicSlot[];

/**
 * 杂谈时她坐在左边舷窗前，左半和下半都是人：放在中间和下面的包装挪到舷窗和右栏之间那块空地，整体缩小。
 * 只平移缩放、不改框的尺寸：组件按容器排版，改尺寸会重排。看片时照 SLOT_BOX 放。
 */
const CHAT_PLACE: Partial<Record<GraphicSlot, { x: number; y: number; scale: number }>> = {
  center: { x: 830, y: 70, scale: 0.6 },
  bottom: { x: 830, y: 450, scale: 0.6 },
  top: { x: 860, y: 24, scale: 0.78 },
  'top-left': { x: 860, y: 40, scale: 0.95 },
  'bottom-left': { x: 860, y: 640, scale: 0.95 },
};

export function slotPlacement(slot: GraphicSlot, scene: 'chat' | 'watch'): { x: number; y: number; w: number; h: number; scale: number } {
  const box = SLOT_BOX[slot];
  const moved = scene === 'chat' ? CHAT_PLACE[slot] : undefined;
  return moved ? { ...box, ...moved } : { ...box, scale: 1 };
}

/** 停在最后一帧之后再留多久（默认） */
export const GRAPHIC_HOLD_MS = 3_000;
/** 退场淡出 */
export const GRAPHIC_OUT_MS = 400;

/** 一行目录：给 Agent 的工具说明 */
export function graphicMenu(): string {
  return GRAPHIC_NAMES.map((name) => {
    const t = GRAPHICS[name]!;
    const fields = t.fields.map((f) => `${f.key}${f.required ? '*' : ''}=${f.label}`).join('；');
    return `- ${name}（${t.title}）：${t.use}。字段：${fields}`;
  }).join('\n');
}
