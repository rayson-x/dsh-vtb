/**
 * 画布：舞台就是一块画布，她边说边在上面搭画面——放一个字、一张图、一组对比，圈出来、连起来、换掉、擦掉、翻页。
 *
 * 画布上每样东西是一个元素（Item）：编号、种类、内容、在画布上的格子、出场方式、最近一次被做的动作。
 * 元素一直留着，直到她擦掉或翻页。位置用 12×8 的格子（layout.ts 自动找空位），她只说「左边」「挨着 egg」。
 *
 * 这个文件只放数据的样子和种类表；怎么改在 reduce.ts，台词里怎么写在 cue.ts，长什么样在 src/page/draw/。
 */

/** 元素种类 */
export type ItemKind =
  | 'text'    // 一句话、一个词、一个标题
  | 'number'  // 大数字，下面一行说明
  | 'image'   // 图片（后台找的，assets 地址）
  | 'sticker' // 贴纸：一个 emoji 或主题贴纸
  | 'card'    // 小卡片：标题 + 一两行
  | 'list'    // 几条要点，一条条出来
  | 'versus'  // 左右对比，中间 VS
  | 'bars'    // 柱状图
  | 'line'    // 折线图
  | 'ratio'   // N 个小人里亮 M 个
  | 'ring'    // 百分比环
  | 'link'    // 两个元素之间的箭头（带标签）；两头都是线索时画成红线
  | 'group'   // 把几样东西框起来起个名字（不占格子，框跟着成员走）
  | 'clue'    // 线索：钉在板上的便签（红图钉），线索之间连红线
  | 'timer'   // 倒计时：一圈环倒数，最后三秒抖
  | 'wall'    // 弹幕上墙：观众原话放大，带名字
  | 'timeline'// 横向时间线：一个个节点依次亮
  | 'flow'    // 流程链：方块加箭头，从左到右（后台交的图解也画成它）
  | 'race'    // 排名条：横条按数值排，数值变了重新排序
  // 观众参与的：弹幕直接改它们
  | 'poll'    // 投票：发 1/2/3 或选项
  | 'tier'    // 夯到拉：她拿出一样东西，观众发「夯」「拉完了」，她再放进某一档
  | 'score'   // 打分：发 1–10
  | 'guess'   // 猜数字：全场一起猜，分布当场画出来，揭晓真答案
  | 'soup';   // 海龟汤：汤面在上，观众问「是不是……」，她答是/不是/不重要，翻过来是汤底

/** 出场方式 */
export type Enter = 'pop' | 'slide' | 'type' | 'slam' | 'draw' | 'fade' | 'decode' | 'words';
export const ENTERS: Enter[] = ['pop', 'slide', 'type', 'slam', 'draw', 'fade', 'decode', 'words'];

/** 对已经在画布上的元素做的动作 */
export type Fx =
  | 'circle' | 'highlight' | 'underline' | 'grow' | 'shake' | 'pulse' | 'arrow' // 强调
  | 'swap' | 'count' | 'flip' | 'check' | 'cross' | 'strike' | 'spotlight' | 'stamp' // 变化
  | 'dim' | 'undim';                                                             // 退后、回来
export const FXS: Fx[] = ['circle', 'highlight', 'underline', 'grow', 'shake', 'pulse', 'arrow', 'swap', 'count', 'flip', 'check', 'cross', 'strike', 'spotlight', 'stamp', 'dim', 'undim'];

/** 字号档：s 注释、m 正文、l 标题、xl 砸出来的主题词 */
export type TextSize = 's' | 'm' | 'l' | 'xl';

export interface Cell { col: number; row: number; w: number; h: number }

export interface Item {
  id: string;
  kind: ItemKind;
  /** 主内容：字、数字、图片地址、emoji…（按种类解释） */
  text: string;
  /** 次要内容：说明、出处、单位、标签…… */
  note?: string;
  /** 结构化内容：列表项、对比两边、图表数据 */
  rows?: { label: string; value?: number; note?: string }[];
  size?: TextSize;
  /** link 的两头 */
  from?: string;
  to?: string;
  cell: Cell;
  /** 翻页后缩在右上角，原尺寸用于主持人揭晓 */
  docked?: Cell;
  enter: Enter;
  born: number;
  /** 最近一次动作（同一个动作再做一次，at 变了，舞台页重播） */
  fx?: { kind: Fx; at: number; arg?: string };
  /** 打上的章：✓、✗ */
  mark?: 'check' | 'cross';
  /** 退后变淡（讲到下一个点了） */
  dim?: boolean;
  /** 放大了一档 */
  big?: boolean;
  /** 翻过来了 */
  flipped?: boolean;
  /** swap / count 之前的样子，舞台页做过渡用 */
  prev?: string;
  /** 被划掉了 */
  struck?: boolean;
  /** 观众参与（poll/tier/score/guess）：还在收弹幕 */
  open?: boolean;
  /** 投票、排档的票：选项 → 票数（排档是当前这样东西的票） */
  votes?: Record<string, number>;
  /** 投过的人（一人一票，按「平台:名字」认） */
  voters?: string[];
  /** 打分、猜数字收到的数（猜数字带名字，揭晓时报最近的人） */
  values?: { who: string; v: number }[];
  /** 猜数字的真答案（揭晓前不上屏） */
  answer?: number;
  /** 盖的章（「真」「假」「有争议」「鉴定为：××」） */
  stamp?: string;
  /** 归组框的成员 */
  members?: string[];
  /** 弹幕上墙：谁说的、哪个平台 */
  who?: string;
  /** 海龟汤：观众问的问题和她的回答 */
  asks?: { who: string; q: string; a?: '是' | '不是' | '不重要' }[];
  /** 夯到拉：正在评的那样东西、已经放好的 */
  judging?: string;
  placed?: { label: string; tier: string }[];
  /** 揭晓了（投票标最高票、打分出平均、猜数字亮答案） */
  result?: boolean;
}

/** 夯到拉的五档，从上到下 */
export const TIERS = ['夯', '顶级', '人上人', 'NPC', '拉完了'] as const;

export interface DrawState {
  items: Item[];
  /** 第几页：翻页时加一，舞台页做整页滑走 */
  page: number;
  pageAt: number;
  /** 镜头推近的元素；null 是自动取景，'all' 是拉远看全貌 */
  zoom: string | null;
  /** 上一次翻页的样子：slide 滑走，wipe 擦黑板 */
  pageKind?: 'slide' | 'wipe';
  /** 上一次画东西时被挤掉的（回执里告诉她） */
  evicted?: string[];
}

export const emptyDraw = (): DrawState => ({ items: [], page: 0, pageAt: 0, zoom: null });

/** 画布内容区：展示布局里那块展示板的内区（regions.ts 的 BOARD.watch 减去框边）；她在右下角，弹幕在右上，字幕在 y≥884 */
export const AREA = { x: 120, y: 196, w: 1244, h: 600 } as const;
export const COLS = 12;
export const ROWS = 8;

/** 每种元素默认占几格（宽×高） */
export const KIND_SIZE: Record<Exclude<ItemKind, 'link'>, [number, number]> = {
  // 默认尺寸偏小：一两样时自动取景会放大，三四样也装得下（12×8 的格子）
  text: [6, 1], number: [3, 2], image: [4, 3], sticker: [2, 2], card: [3, 2], list: [5, 3],
  versus: [9, 3], bars: [5, 3], line: [5, 3], ratio: [4, 3], ring: [3, 3],
  poll: [6, 4], tier: [12, 8], score: [4, 4], guess: [7, 4],
  group: [0, 0], clue: [3, 2], timer: [3, 3], wall: [6, 2], timeline: [10, 3], flow: [10, 2], race: [6, 4], soup: [12, 8],
};
export const TEXT_SIZE: Record<TextSize, [number, number]> = { s: [4, 1], m: [6, 1], l: [8, 2], xl: [10, 2] };

/** 种类的中文名和一句用法（给她看的） */
export const KIND_HELP: Record<ItemKind, string> = {
  text: '一句话/一个词：[[draw a text 内容 size=l]]（size：s 注释、m 正文、l 标题、xl 这一页的主题词）',
  number: '大数字：[[draw a number 数字 note=它说明什么]]',
  image: '图片（后台交的图片）：[[draw a image 图片地址 note=说明]]',
  sticker: '贴纸：[[draw a sticker 一个emoji]]',
  card: '便利贴：[[draw a card 标题 note=一两句]]（可以 [[flip a]] 翻到背面看 note）',
  list: '要点，一条条出：[[draw a list 第一条 | 第二条 | 第三条]]',
  versus: '左右对比：[[draw a versus 左边 | 说明 || 右边 | 说明]]',
  bars: '柱状图（真数字，note 写出处）：[[draw a bars 名字:数 | 名字:数 unit=单位 note=出处]]',
  line: '折线图：[[draw a line 时间:数 | 时间:数 unit=单位 note=出处]]',
  ratio: '比例小人：[[draw a ratio 3/10 note=说明]]',
  ring: '百分比环：[[draw a ring 72 note=说明]]',
  link: '箭头连线：[[link a b 关系]]（两头都是线索 clue 时画成红线）',
  group: '归组框：[[group 编号 a b c 名字]]（把几样东西框起来做小结）',
  clue: '线索便签（钉在板上）：[[draw a clue 线索 note=背面的答案]]，线索之间 [[link a b]] 连红线，[[flip a]] 翻出背面',
  timer: '倒计时：[[draw a timer 20 note=在等什么]]（秒数，最后三秒抖）',
  wall: '弹幕上墙：[[draw a wall 用户名]] 把这个人最近一条弹幕放大挂上来（不写名字就挂最新一条）',
  timeline: '横向时间线：[[draw a timeline 时间:事件 | 时间:事件 | 时间:事件]]，节点依次亮',
  flow: '流程链：[[draw a flow 第一步 | 第二步 | 第三步]]（从左到右带箭头）',
  race: '排名条：[[draw a race 名字:数 | 名字:数 unit=单位]]，[[count a 名字:新数 | 名字:新数]] 数值变了重新排名',
  poll: '投票（观众发 1/2/3 或选项）：[[draw a poll 问题 | 选项 | 选项]]，[[result a]] 停票、亮出最高票',
  tier: '排档榜（夯 / 顶级 / 人上人 / NPC / 拉完了）：[[draw a tier 榜单标题]]；[[judge a 一样东西]] 拿出来让观众投档，[[rank a 一样东西 夯]] 放进某一档（不写档就按观众票最多的）',
  score: '打分（观众发 1–10）：[[draw a score 问题]]，[[result a]] 停收、亮平均分',
  guess: '猜数字（观众发一个数）：[[draw a guess 问题 answer=真答案]]，[[result a]] 亮答案和猜得最近的人',
  soup: '问答板（海龟汤一类）：[[draw a soup 题面 note=谜底]]；观众发「是不是……」的问题会排进来，你用 [[ans a 是]] / 不是 / 不重要 回答最早那个没答的，[[flip a]] 翻出谜底',
};

/** 主持人的互动层：说明编排不能淘汰或改内容。 */
export const INTERACTIVE = new Set<string>(['poll', 'tier', 'score', 'guess', 'soup', 'timer', 'wall']);
export const DOCK: Cell = { col: 9, row: 0, w: 3, h: 3 };
