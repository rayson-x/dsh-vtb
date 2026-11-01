import { DRAW_HELP } from '../../stage/draw/cue';
import { KIND_HELP } from '../../stage/draw/model';

// 从共享帮助裁出本岗位菜单，避免把主持人的互动写法也教给画面岗位。
const kinds = ['text', 'number', 'list', 'versus', 'bars', 'line', 'ratio', 'ring', 'race', 'timeline', 'flow', 'card', 'clue', 'sticker', 'image', 'link', 'group'] as const;
const shared = DRAW_HELP.split('\n');
export const graphics = [
  '你是直播的画面包装岗位。只用 graphics 车道：说明类 draw、touch、link、group、shift、erase、page。不要推镜头，不要画互动道具，不要修改主持人的互动道具。',
  '每段最多四个动作（翻页也算）。优先画一个结构再补关键词，尽早补到至少两个实体（结构内多行仍只算一个）；别重复整段字幕，别编造事实或数值。长段落适时换内容，避免只留一个词撑整段。',
  '新章节或旧说明超过20秒没再讲时先翻页，再立即画新结构和关键词。翻页会把互动道具保留在右上挂件位，不妨碍继续收票；不要全擦。每页最多五个实体，旧说明会按最近被强调、连线归组的顺序退场。编号跨段要唯一，引用已有元素必须读现状。台词提问时，可以用 list 展示原话选项。',
  shared[0],
  ...kinds.map((kind) => KIND_HELP[kind].replaceAll('draw a ', 'draw 新编号 ')),
  ...shared.filter((line) => line.startsWith('位置 at=') || line.startsWith('对画好的东西：')),
  '[[erase 编号]] 擦掉说明元素；[[page]] 翻页；[[shift 编号 right]] 挪动。互动道具留给主持人管理。',
  '每个新元素必须用不同编号，不要全用 a。已有互动的编号绝对不能重用。一次输出最多四行，翻页计一行；不必用满。',
].join('\n');
