/**
 * 舞台协议：舞台状态、能下的指令、上屏前的脱敏。
 *
 * 舞台是无脑渲染页：所有状态都在宿主端（StageController），页面只按状态画。
 * 宿主、DSH 工具、舞台页都只认这里的类型；除了包装目录没有任何依赖，浏览器和 Node 都能用。
 */

import { presetCanvas, type Box, type Element, type ElementId, type LayoutName } from './canvas';
import type { GraphicSlot } from './graphics';
import type { StageRegion } from './regions';
import type { SceneValue, Visual } from './visual';
import { emptyDraw, type DrawState } from './draw/model';
import { DEFAULT_SET, SETS } from './sets';
import type { DrawCommand } from './draw/reduce';

export type Scene = 'chat' | 'watch';
/** 工位模式：看片、剪辑、写代码、写特效、讲课（黑板） */
export type WorkMode = 'watch' | 'edit' | 'code' | 'fx' | 'lesson';
/** Agent 只说软切或硬切，具体用哪种转场由导播定 */
export type Cut = 'soft' | 'hard';
export type TransitionKind = 'cut' | 'fade' | 'slide' | 'wipe';
export type Mood = 'neutral' | 'happy' | 'surprised' | 'thinking' | 'sad';
export type Look = 'camera' | 'left' | 'right';
export type Platform = 'douyin' | 'bilibili' | 'tiktok' | 'owner' | 'sim';
/** 谁下的切换：主人不受频率上限和锁镜头限制 */
export type Actor = 'owner' | 'agent' | 'auto';
export type Region = 'center' | 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
export type TaskKind = 'generate' | 'export' | 'render' | 'sandbox';
export type TaskStatus = 'running' | 'done' | 'failed';
export type FxStatus = 'draft' | 'rendering' | 'ready' | 'failed';
export type AlertKind = 'gift' | 'superchat' | 'guard';

export interface Transition {
  kind: TransitionKind;
  from: Scene;
  to: Scene;
  startedAt: number;
  ms: number;
}

export interface Clip {
  id: string;
  title: string;
  /** 可播地址；没有就由舞台画一段假片子 */
  src?: string;
  durationSec: number;
  playing: boolean;
  /** since 那一刻的播放位置（秒）；播放中的当前位置用 playhead() 算 */
  pos: number;
  since: number;
}

export interface Mark { id: string; at: number; label: string }
export interface Range { from: number; to: number; label?: string }
export interface Focus { region: Region; label?: string }
export interface CodeExcerpt { title: string; lang: string; lines: string[]; highlight?: number; at: number }
export interface FxBlock { id: string; name: string; from: number; to: number; status: FxStatus; at: number }
export interface Task { id: string; kind: TaskKind; title: string; progress: number; status: TaskStatus; startedAt: number; endedAt?: number }
export interface Broll { id: string; title: string; caption?: string; src?: string; startedAt: number; ms: number }
/**
 * 这一段话的语气：她只标语气和重音，字幕怎么演由字幕轨道自己定（同一时刻只有一条字幕）。
 * plain 平常、excited 兴奋、reveal 揭晓反转、serious 认真、aside 小声嘀咕、question 提问、quote 引用原话
 */
export type Tone = 'plain' | 'excited' | 'reveal' | 'serious' | 'aside' | 'question' | 'quote';
export const TONES: Tone[] = ['plain', 'excited', 'reveal', 'serious', 'aside', 'question', 'quote'];
/** 语速范围：再快再慢就听着不自然了 */
export const MIN_RATE = 0.8;
export const MAX_RATE = 1.25;
/** 重音：第 from 到第 to 个字（不含） */
export interface Accent { from: number; to: number }

export interface Subtitle {
  id: string;
  text: string;
  startedAt: number;
  ms: number;
  /** 合成好的音频地址（/voice/…）；没有就只亮字幕 */
  audio?: string;
  tone?: Tone;
  accents?: Accent[];
  /** 每个字开始念的时刻（毫秒，相对 startedAt，已按语速换算）；没有就按字数平摊 */
  starts?: number[];
  /** 播放语速（1 是原速）：舞台页按这个倍速放，音高不变 */
  rate?: number;
}
/** 黑板：讲课模式下工位上的标题和随讲随出的要点 */
export interface Board { title: string; points: string[]; at: number }
/** 画面素材上屏：讲课时在黑板右边，别的模式盖在片子上。投票的票数在这里数 */
export interface Panel {
  visual: Visual;
  /** 摆在直播间的哪个区域（见 regions.ts） */
  region: StageRegion;
  /** 代码场景的可读地址（/scenes/<文件>） */
  url?: string;
  at: number;
  revealed: boolean;
  votes: number[];
  voters: string[];
  /** 代码场景当前的参数和做过的动作（中途打开的页面照着重放） */
  params?: Record<string, SceneValue>;
  acts?: string[];
  /** 讲解组件：揭到第几步（0 = 只显示没写 step 的元素）、正指着哪个元素 */
  step?: number;
  point?: string;
}
/** 节目单：这场讲什么、讲到第几步（课纲的节、剪辑计划的步骤） */
export interface Rundown { title: string; steps: string[]; at: number; paused: boolean }
/** 一段包装动画：vars 已经换成源组件的变量。runtime 缺省时按 snippet，入口是 /graphics/<source>.html */
export type GraphicRuntime = 'snippet' | 'composition' | 'module';
export interface Graphic {
  id: string;
  name: string;
  source: string;
  vars: Record<string, string | number | boolean>;
  slot: GraphicSlot;
  startedAt: number;
  until: number;
  runtime?: GraphicRuntime;
  /** 相对 /graphics/ 的文件，目录里的条目才有 */
  entry?: string;
  /** 模块用它把秒换算成帧 */
  playFor?: number;
}
/** 右栏信息流里的一条：弹幕，或者礼物、关注、加粉丝团、分享这类事件（各平台混在一起按时间排） */
export type FeedKind = 'chat' | 'gift' | 'follow' | 'fanclub' | 'share';
export interface Danmaku { id: string; platform: Platform; user: string; text: string; at: number; kind?: FeedKind; /** 礼物档 1–5 */ tier?: number }
/** 刚进直播间的人：右栏顶上一行欢迎条，不进信息流（进场太多，会把弹幕刷没） */
export interface Entering { id: string; platform: Platform; user: string; at: number }
export interface Alert { id: string; kind: AlertKind; platform: Platform; user: string; text: string; value?: string; at: number; ms: number; /** 礼物档（1–5），越高越显眼 */ tier?: number }

export interface ResearchSource { title: string; host: string }
export interface ResearchFeed {
  query?: string;
  sources: ResearchSource[];
  /** 正在读的网站 */
  reading?: string;
  /** 这一轮查资料从什么时候开始（换了搜索词就重新算） */
  at: number;
}

export interface StageState {
  rev: number;
  scene: Scene;
  transition: Transition | null;
  /** 上一次切镜头或插 B-roll 的时刻：两者共用画面预算 */
  lastCutAt: number;
  /** 主人锁镜头：只有主人能切 */
  locked: boolean;
  mode: WorkMode;
  /** 状态牌：正在看、细看、切开、验货…… */
  status: string | null;
  /** 正在翻的资料（搜什么、搜到哪些网页、在读哪个）：查资料时主画面上放这个，不冷场 */
  research: ResearchFeed | null;
  /** look：视线朝哪（看镜头、看左边的内容、看右边） */
  avatar: { visible: boolean; mood: Mood; speaking: boolean; look: Look };
  /** 画布：每个元素的位置大小（她可以挪）；layout 是最近一次整套切换的摆法 */
  canvas: Record<ElementId, Element>;
  layout: LayoutName;
  subtitle: Subtitle | null;
  clip: Clip | null;
  /** 时间轴只看这一窗（跳到某一窗） */
  view: Range | null;
  marks: Mark[];
  selection: Range | null;
  splits: number[];
  focus: Focus | null;
  code: CodeExcerpt | null;
  fx: FxBlock[];
  tasks: Task[];
  broll: Broll | null;
  danmaku: Danmaku[];
  entering: Entering[];
  /** 她临时不在（大脑重启）：「直播中」角标换成「马上回来」 */
  away: boolean;
  /** 节目牌：今晚是什么节目（方向的第一句）、正在聊什么；主画面空着时挂出来 */
  program: { title?: string; topic?: string };
  /** 头边冒的表情包（最近几个，到点自己散） */
  emotes: { id: string; emoji: string; anim: string; at: number }[];
  /** 各平台在线人数（平台推来就更新，角标上显示） */
  viewers: Partial<Record<Platform, number>>;
  /** 被点名回应的那条弹幕 */
  picked: string | null;
  alerts: Alert[];
  graphics: Graphic[];
  board: Board | null;
  rundown: Rundown | null;
  /** 画面上的组件，按上屏先后；最多 LIMITS.panels 个，各占一个区域 */
  panels: Panel[];
  /** 画布：她边说边搭的画面（draw/model.ts） */
  draw: DrawState;
  /** 布景（stage/sets.ts）；setFrom 是换之前的（转场用），setAt 是换的时刻 */
  set: string;
  setFrom: string | null;
  setAt: number;
  /** 音响车道：背景音现状和最近独立音效。 */
  sound: SoundState;
  /** 最近演过的布景特效（舞台页按 at 演一次） */
  vfx: { id: string; name: string; at: number }[];
}

/** 车道缺省为主持人，旧调用不受影响。 */
export type Lane = 'host' | 'graphics' | 'lighting' | 'sound';
export const SOUND_FAMILIES = ['pop', 'drip', 'whoosh', 'hit', 'knock', 'mallet', 'riser', 'swell', 'click', 'glitch', 'shutter', 'notify'] as const;
/** 只给站内已知素材，协议不接受任意 URL 或磁盘路径。 */
export const SOUND_TRACKS = Object.values(SETS).flatMap((set) => [
  ...(set.bed ? [`/sets/${set.id}/sfx/bed.mp3`] : []),
  ...Object.values(set.effects).flatMap((fx) => (fx.sound?.files ?? []).map((file) => `/sets/${set.id}/sfx/${file}`)),
  ...Object.values(set.sounds ?? {}).flatMap((files) => files.map((file) => `/sets/${set.id}/sfx/${file}`)),
]);
export type SoundCommand = { type: 'sound'; action: 'bed' | 'volume' | 'stop' | 'effect'; name?: string; volume?: number; fadeMs?: number };
export interface SoundState {
  bed: { name: string; volume: number; fadeMs: number; at: number } | null;
  events: { id: string; name: string; volume: number; at: number }[];
}
export type Command = StageCommand & { lane?: Lane };
type StageCommand =
  | SoundCommand
  | DrawCommand
  /** 换布景（房间、组件、氛围、特效一整套） */
  | { type: 'room'; id: string; by?: Actor }
  /** 演一次当前布景的特效 */
  | { type: 'vfx'; name: string }
  | { type: 'scene'; scene: Scene; cut?: Cut; by?: Actor }
  | { type: 'lock'; locked: boolean }
  | { type: 'mode'; mode: WorkMode; status?: string | null }
  | { type: 'status'; label: string | null }
  | { type: 'avatar'; mood?: Mood; visible?: boolean; look?: Look }
  /** 整套换摆法（杂谈、看片、讲课），跟切场景一样走转场和频率上限 */
  | { type: 'layout'; name: LayoutName; cut?: Cut; by?: Actor }
  /** 挪一个画布元素：给框的几项、或一个区域名；也能藏起来、调前后 */
  | { type: 'place'; el: ElementId; box?: Partial<Box>; at?: StageRegion; visible?: boolean; z?: number }
  | { type: 'say'; id: string; text: string; ms: number; audio?: string; tone?: Tone; accents?: Accent[]; starts?: number[]; rate?: number }
  | { type: 'said'; id: string }
  /** soft：念完正在念的这句再停（主人发话、值得回的弹幕），排着的撤掉；不带就是马上闭嘴 */
  | { type: 'interrupt'; soft?: boolean }
  | { type: 'clip'; title: string; durationSec: number; src?: string; id?: string }
  | { type: 'unclip' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'seek'; at: number }
  | { type: 'view'; range: Range | null }
  | { type: 'mark'; at?: number; label: string; id?: string }
  | { type: 'unmark'; id?: string }
  | { type: 'select'; range: Range | null }
  | { type: 'split'; at?: number }
  | { type: 'focus'; focus: Focus | null }
  | { type: 'code'; code: Omit<CodeExcerpt, 'at'> | null }
  | { type: 'fx'; op: 'add'; name: string; from: number; to: number; id?: string }
  | { type: 'fx'; op: 'move'; id: string; from: number; to: number }
  | { type: 'fx'; op: 'status'; id: string; status: FxStatus }
  | { type: 'fx'; op: 'remove'; id: string }
  | { type: 'task'; op: 'start'; kind: TaskKind; title: string; id?: string }
  | { type: 'task'; op: 'progress'; id: string; progress: number }
  | { type: 'task'; op: 'done' | 'fail' | 'remove'; id: string }
  | { type: 'broll'; title: string; caption?: string; src?: string; ms?: number; by?: Actor; id?: string }
  | { type: 'danmaku'; platform: Platform; user: string; text: string; kind?: FeedKind; tier?: number; id?: string }
  /** 整个换掉右栏信息流：换场次时清空，或者恢复某一场存下来的 */
  | { type: 'feed'; danmaku: Danmaku[] }
  | { type: 'enter'; platform: Platform; user: string }
  | { type: 'away'; on: boolean }
  /** 讲解组件往下揭一步（to 给了就跳到那一步）；on 指定哪一块，不给就是最近摆上的那块讲解组件 */
  | { type: 'step'; on?: string; to?: number }
  /** 讲解组件里指着某个元素（高亮它、其余变淡）；target 为 null 收掉 */
  | { type: 'point'; on?: string; target: string | null }
  | { type: 'emote'; name: string }
  | { type: 'program'; title?: string | null; topic?: string | null }
  | { type: 'viewers'; platform: Platform; count: number }
  | { type: 'research'; query?: string; sources?: ResearchSource[]; reading?: string; done?: boolean }
  | { type: 'pick'; id: string | null }
  | { type: 'alert'; kind: AlertKind; platform: Platform; user: string; text: string; value?: string; tier?: number; id?: string }
  | { type: 'graphic'; name: string; fields?: Record<string, string | number>; slot?: GraphicSlot; seconds?: number; id?: string }
  | { type: 'ungraphic'; id?: string }
  | { type: 'board'; title?: string; point?: string; clear?: boolean }
  | { type: 'rundown'; title: string; steps: string[] }
  | { type: 'rundown'; at?: number; paused?: boolean; clear?: boolean }
  | { type: 'show'; id?: string; visual?: Visual; url?: string; at?: StageRegion }
  | { type: 'unshow'; id?: string }
  | { type: 'move'; id: string; at: StageRegion }
  | { type: 'reveal'; id?: string }
  /** 驱动代码场景：改参数、做动作；on 不给就是最近上屏的那个场景 */
  | { type: 'drive'; on?: string; set?: Record<string, SceneValue>; act?: string };

/** 舞台尺寸 */
export const STAGE_W = 1920;
export const STAGE_H = 1080;

export const LIMITS = {
  danmaku: 30,
  alerts: 3,
  marks: 20,
  splits: 20,
  fx: 8,
  tasks: 4,
  codeLines: 12,
  codeLineChars: 80,
  text: 120,
  subtitle: 300,
  graphics: 3,
  boardPoints: 5,
  panels: 3,
  rundownSteps: 12,
} as const;

/** 两次切换（切镜头、插 B-roll）至少隔多久；主人不限 */
export const CUT_GAP_MS: Record<Actor, number> = { owner: 0, agent: 3_000, auto: 8_000 };

/** 各种转场的时长 */
export const TRANSITION_MS: Record<TransitionKind, number> = { cut: 0, fade: 560, slide: 700, wipe: 640 };

export const ALERT_MS: Record<AlertKind, number> = { gift: 4_000, superchat: 9_000, guard: 6_000 };
export const BROLL_MS = 4_000;
/** 做完、失败的任务在角落留多久 */
export const TASK_LINGER_MS = 8_000;

export const SCENE_NAMES: Record<Scene, string> = { chat: '杂谈', watch: '展示' };
export const MODE_NAMES: Record<WorkMode, string> = { watch: '看片', edit: '剪辑', code: '写代码', fx: '写特效', lesson: '讲课' };

export function initialState(): StageState {
  return {
    rev: 0,
    scene: 'chat',
    transition: null,
    lastCutAt: -1e15,
    locked: false,
    mode: 'watch',
    status: null,
    research: null,
    avatar: { visible: true, mood: 'neutral', speaking: false, look: 'camera' },
    canvas: presetCanvas('chat'),
    layout: 'chat',
    subtitle: null,
    clip: null,
    view: null,
    marks: [],
    selection: null,
    splits: [],
    focus: null,
    code: null,
    fx: [],
    tasks: [],
    broll: null,
    danmaku: [],
    entering: [],
    away: false,
    program: {},
    emotes: [],
    viewers: {},
    picked: null,
    alerts: [],
    graphics: [],
    board: null,
    rundown: null,
    panels: [],
    draw: emptyDraw(),
    set: DEFAULT_SET,
    setFrom: null,
    setAt: -1e15,
    vfx: [],
    sound: { bed: null, events: [] },
  };
}

/** 播放头当前位置（秒） */
export function playhead(clip: Clip, now: number): number {
  const at = clip.playing ? clip.pos + (now - clip.since) / 1000 : clip.pos;
  return Math.max(0, Math.min(clip.durationSec, at));
}

/** 软切、硬切 → 具体转场：硬切直接切；进看片滑入，回杂谈淡回 */
export function transitionFor(cut: Cut, to: Scene): TransitionKind {
  if (cut === 'hard') return 'cut';
  return to === 'watch' ? 'slide' : 'fade';
}

/** 1:05 */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}

const URL_RE = /\bhttps?:\/\/\S+/gi;
// 以 / ~/ ./ ../ 或盘符开头的路径，和至少带两个斜杠的相对路径
// （「A/B」「1/2」这种前面紧挨着字的不算）
const PATH_RE = /(?:\b[A-Za-z]:\\[^\s'"`]+|(?<![\w)\]])(?:~|\.{1,2})?\/[\w.\-@]+(?:\/[\w.\-@]*)*|\b[\w.\-@]+(?:\/[\w.\-@]+){2,})/g;
const HASH_RE = /\b[0-9a-f]{12,}\b/gi;

/** 上屏前脱敏：路径、链接、哈希不进直播画面 */
export function redact(text: string): string {
  return text.replace(URL_RE, '[链接]').replace(PATH_RE, '…').replace(HASH_RE, '…');
}

/** 脱敏并截断成一行 */
export function screenText(text: string, max: number = LIMITS.text): string {
  const one = redact(String(text ?? '')).replace(/\s+/g, ' ').trim();
  const chars = [...one];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : one;
}
