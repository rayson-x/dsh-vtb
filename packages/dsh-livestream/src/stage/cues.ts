/**
 * 台词标记：她把舞台动作写在台词里，念到那个字的时候发生。
 *
 *   剪辑里最重要的是[[graphic highlight text=好剪辑的关键是节奏 word=节奏]]节奏。
 *
 * 标记从念的字里拿掉；at 是它前面有几个字（按念的文本数），宿主按语音的逐字时间对上。
 * 写错的标记在排队时就报错，不等到上屏。
 */

import { KIND_HELP } from './draw/model';
import { resolveEffect } from './effects';
import { GRAPHICS, GRAPHIC_SLOTS, type GraphicSlot } from './graphics';
import { ELEMENT_IDS, LAYOUT_NAMES, type Box, type ElementId, type LayoutName } from './canvas';
import type { Command, Look, Mood, Region, WorkMode } from './protocol';
import { STAGE_REGIONS, type StageRegion } from './regions';
import { EMOTE_MENU } from './emotes';
import { sceneParams } from './visual';
import { drawCue, graphicToDraw } from './draw/cue';

export interface Cue {
  /** 在念的文本里的位置（第几个字之前） */
  at: number;
  /** 原样的标记，报错时给她看 */
  raw: string;
  cmd: Command;
}

export interface Parsed {
  /** 拿掉标记后要念的话 */
  text: string;
  cues: Cue[];
  errors: string[];
  /** *重音* 落在哪几个字上 */
  marks: Mark[];
}

const MOODS: Mood[] = ['neutral', 'happy', 'surprised', 'thinking', 'sad'];
const MODES: WorkMode[] = ['watch', 'edit', 'code', 'fx', 'lesson'];
const REGIONS: Region[] = ['center', 'left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];

/** 能写的标记，给 Agent 看的一行一个 */
export const CUE_HELP = [
  '节目单：每段讲最上面的点，讲完在整段末尾写 [[beat done b编号]]。对应观众点单时正文必须点名；实际念到末尾才结点并关单。编号以节目单为准，写错报错。',
  '点单兑现：在兑现那句点名点单人，兑现整段的最后写 [[done o1]]；婉拒说明理由后，在整段最后写 [[decline o1]]。关闭标记后不能再跟正文（句末标点除外），写早了会报错且不关闭。编号必须来自未兑现点单簿，写错会报错。',
  '你只管说话，画面导演独立管理画布、灯光与布景。不要写画面、灯光、布景或意图标记；团队关闭时程序显示当前主题。',
  ...(['poll', 'tier', 'score', 'guess', 'soup', 'timer', 'wall'] as const).map((kind) => KIND_HELP[kind]),
  '互动结果用 [[result 编号]]，答案 [[ans 编号 是]]（是/不是/不重要），评档 [[judge 编号 东西]]，排序 [[rank 编号 选项 档位]]。',
  '[[mood happy]]（neutral happy surprised thinking sad）  [[emote laugh]] 头边冒个表情包（' + EMOTE_MENU + '；也可以直接写一个 emoji，比如 [[emote 🥹]]），点到为止，一段最多一个',
].join('\n');

/** 「at=right」→ 区域；没写 at 返回 undefined，写错返回理由 */
function region(rest: string): string | undefined {
  const at = /\bat=(\S+)/.exec(rest)?.[1];
  if (!at) return undefined;
  return STAGE_REGIONS.includes(at as StageRegion) ? at : `没有这个区域：${at}（能用：${STAGE_REGIONS.join(' ')}）`;
}

/** 「1:20」「80」→ 秒 */
function sec(value: string): number | undefined {
  const parts = value.trim().split(':');
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return undefined;
  return parts.reduce((sum, n) => sum * 60 + Number(n), 0);
}

/** 「text=好剪辑 的关键 word=节奏」→ { text: '好剪辑 的关键', word: '节奏' }：值一直到下一个「名字=」 */
function fields(rest: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(?:^|\s)([A-Za-z_][\w-]*)=/g;
  const marks: { key: string; start: number; end: number }[] = [];
  for (let m = re.exec(rest); m; m = re.exec(rest)) marks.push({ key: m[1]!, start: m.index, end: m.index + m[0].length });
  marks.forEach((mark, i) => {
    out[mark.key] = rest.slice(mark.end, marks[i + 1]?.start ?? rest.length).trim();
  });
  return out;
}

/** 一个标记 → 指令；认不出返回理由 */
/** 本身就是标记的词（不当包装名改写） */
const KNOWN_VERBS = new Set(['emote', 'step', 'board', 'clear', 'do', 'focus', 'graphic', 'layout', 'look', 'mark', 'mode', 'mood', 'move', 'pause', 'place', 'play', 'point', 'reveal', 'scene', 'seek', 'set', 'show', 'status', 'unfocus', 'unshow']);

/** 把语气名写进 mood 是常见笔误（实测 [[mood excited]]）：换成对应的表情 */
const TONE_AS_MOOD: Record<string, Mood> = { excited: 'happy', reveal: 'surprised', serious: 'neutral', aside: 'thinking', question: 'thinking', quote: 'neutral', plain: 'neutral' };

export function cueCommand(body: string): Command | string {
  // 主持人偶尔混用旧素材类型：table/quote 兼容为已有列表/卡片，不引入新元素。
  const trimmed = body.trim().replace(/^(draw\s+\S+\s+)(table|quote)(?=\s)/, (_, prefix: string, kind: string) => prefix + (kind === 'table' ? 'list' : 'card'));
  // 画布的标记先认（highlight、count 这些名字跟旧包装重名，画布优先）
  {
    const sp = trimmed.search(/\s/);
    const drawn = drawCue((sp < 0 ? trimmed : trimmed.slice(0, sp)).toLowerCase(), sp < 0 ? '' : trimmed.slice(sp + 1).trim());
    if (drawn !== undefined) return drawn;
  }
  // 包装短名字直接当标记写（实测 [[highlight text=… word=…]]）：当成 [[graphic highlight …]]
  const head = trimmed.split(/\s/)[0]!.toLowerCase();
  if (GRAPHICS[head] && !KNOWN_VERBS.has(head)) return cueCommand(`graphic ${trimmed}`);
  const space = trimmed.search(/\s/);
  const verb = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const rest = space < 0 ? '' : trimmed.slice(space + 1).trim();
  const word = rest.split(/\s+/)[0] ?? '';
  switch (verb) {
    case 'sound': {
      const [action] = rest.split(/\s+/);
      if (!['bed', 'volume', 'stop', 'effect'].includes(action ?? '')) return 'sound 要写 bed / volume / stop / effect';
      const f = fields(rest);
      return { type: 'sound', action: action as 'bed' | 'volume' | 'stop' | 'effect', ...(f.name ? { name: f.name } : {}), ...(f.volume !== undefined ? { volume: Number(f.volume) } : {}), ...(f.fadeMs !== undefined ? { fadeMs: Number(f.fadeMs) } : {}) };
    }
    case 'room':
      if (!word) return 'room 后面写布景 id';
      return { type: 'room', id: word, by: 'agent' };
    case 'fx':
      if (!word) return 'fx 后面写特效名';
      return { type: 'vfx', name: word };
    case 'scene':
      if (word !== 'chat' && word !== 'watch') return 'scene 后面写 chat 或 watch';
      return { type: 'scene', scene: word, cut: /\bhard\b/.test(rest) ? 'hard' : 'soft', by: 'agent' };
    case 'emote':
      if (!rest) return 'emote 后面写表情名或一个 emoji';
      return { type: 'emote', name: rest };
    case 'mood': {
      const mood = MOODS.includes(word as Mood) ? (word as Mood) : TONE_AS_MOOD[word];
      if (!mood) return `mood 只能是 ${MOODS.join(' ')}`;
      return { type: 'avatar', mood };
    }
    case 'mode':
      if (!MODES.includes(word as WorkMode)) return `mode 只能是 ${MODES.join(' ')}`;
      return { type: 'mode', mode: word as WorkMode };
    case 'status':
      return { type: 'status', label: rest || null };
    case 'board':
      return '黑板撤了：要画面就 [[draw …]] 画到画布上';
    case 'set':
    case 'do':
      return '代码场景停用了：画面都上画布，用 [[draw …]]';
    case 'step':
      return 'step 停用了：要一步步揭开，就一样样 [[draw]] 上去，或者用 [[flip]] 翻卡片';
    case 'point':
      // 「指着某个元素」= 画布上画个箭头
      if (!word || word === 'clear') return 'point 后面写画布上的编号（会画个箭头指着它）';
      return { type: 'touch', id: word, fx: 'arrow', ...(rest.slice(word.length).trim() ? { arg: rest.slice(word.length).trim() } : {}) };
    case 'graphic': {
      const name = word;
      // 旧包装停用：画面都上画布。常用的几种直接换成画布元素，别的退回让她改写
      return graphicToDraw(name, fields(rest.slice(name.length)));
    }
    case 'clear':
      return { type: 'ungraphic', ...(word ? { id: word } : {}) };
    case 'play':
      return { type: 'play' };
    case 'pause':
      return { type: 'pause' };
    case 'seek': {
      const at = sec(word);
      return at === undefined ? 'seek 后面写时间，比如 1:20' : { type: 'seek', at };
    }
    case 'beat':
      if (!/^done b[1-9]\d*$/.test(rest)) return '节目单标记写 [[beat done b编号]]';
      return { type: 'mark', label: `beat:done:${rest.slice(5)}` };
    case 'done':
    case 'decline':
      if (!/^o[1-9]\d*$/.test(rest)) return `${verb} 后面写点单编号，比如 o1`;
      return { type: 'mark', label: `order:${verb}:${rest}` };
    case 'mark':
      return { type: 'mark', label: rest || '旗' };
    case 'focus': {
      if (!REGIONS.includes(word as Region)) return `focus 的位置只能是 ${REGIONS.join(' ')}`;
      const label = rest.slice(word.length).trim();
      return { type: 'focus', focus: { region: word as Region, ...(label ? { label } : {}) } };
    }
    case 'unfocus':
      return { type: 'focus', focus: null };
    case 'show': {
      // 编号由宿主对着课件查成素材
      if (!word) return 'show 后面写素材编号';
      const at = region(rest);
      if (typeof at === 'string' && at.startsWith('没有')) return at;
      return { type: 'show', id: word, ...(at ? { at: at as StageRegion } : {}) };
    }
    case 'move': {
      const at = region(rest);
      if (!word || !at) return 'move 后面写编号和 at=区域';
      if (at.startsWith('没有')) return at;
      return { type: 'move', id: word, at: at as StageRegion };
    }
    case 'layout':
      if (!LAYOUT_NAMES.includes(word as LayoutName)) return `layout 只能是 ${LAYOUT_NAMES.join(' ')}`;
      return { type: 'layout', name: word as LayoutName, cut: /\bhard\b/.test(rest) ? 'hard' : 'soft', by: 'agent' };
    case 'place': {
      if (!ELEMENT_IDS.includes(word as ElementId)) return `画布上没有这个元素：${word}（有：${ELEMENT_IDS.join(' ')}）`;
      const args = rest.slice(word.length);
      const at = region(args);
      if (at && at.startsWith('没有')) return at;
      const box: Partial<Box> = {};
      for (const k of ['x', 'y', 'w', 'h'] as const) {
        const m = new RegExp(`\\b${k}=(-?\\d+)`).exec(args);
        if (m) box[k] = Number(m[1]);
      }
      const z = /\bz=(\d+)/.exec(args)?.[1];
      const visible = /\bhide\b/.test(args) ? false : /\bshow\b/.test(args) ? true : undefined;
      if (!at && !Object.keys(box).length && visible === undefined && !z) return 'place 后面写 at=区域、x= y= w= h=、hide 或 show';
      return { type: 'place', el: word as ElementId, ...(at ? { at: at as StageRegion } : {}), ...(Object.keys(box).length ? { box } : {}), ...(visible !== undefined ? { visible } : {}), ...(z ? { z: Number(z) } : {}) };
    }
    case 'look':
      if (!['camera', 'left', 'right'].includes(word)) return 'look 只能是 camera left right';
      return { type: 'avatar', look: word as Look };
    case 'unshow':
      return { type: 'unshow', ...(word ? { id: word } : {}) };
    case 'reveal':
      return { type: 'reveal', ...(word ? { id: word } : {}) };
    default:
      return `认不出标记「${verb}」`;
  }
}

export function parseCues(input: string): Parsed {
  const cues: Cue[] = [];
  const errors: string[] = [];
  let text = '';
  // 有时会把标记包进尖括号或反引号里：<[[...]]>，括号不念
  // 模型偶尔混进网页标签（实测 <br>）：换行标签当停顿，其余标签去掉，不念也不上字幕
  let rest = input.replace(/[<`]\s*(\[\[[\s\S]*?\]\])\s*[>`]/g, '$1').replace(/<br\s*\/?>/gi, ' ').replace(/<\/?[a-z][a-z0-9]*(\s[^<>]*)?\/?>/gi, '')
    // 点单标记少写一层括号（实测 [done o3]）：会被念出来、点单也关不掉，按双层认
    .replace(/(?<!\[)\[(done|decline)\s+([A-Za-z0-9_-]+)\](?!\])/g, '[[$1 $2]]');
  for (;;) {
    const open = rest.indexOf('[[');
    if (open < 0) break;
    const close = rest.indexOf(']]', open + 2);
    if (close < 0) {
      errors.push(`标记没闭合：${rest.slice(open, open + 20)}`);
      rest = rest.slice(0, open) + rest.slice(open + 2);
      continue;
    }
    text += rest.slice(0, open);
    const raw = rest.slice(open, close + 2);
    const body = rest.slice(open + 2, close);
    if (/^意图\s/.test(body.trim())) { rest = rest.slice(close + 2); continue; }
    const cmd = cueCommand(body);
    if (typeof cmd === 'string') errors.push(`${raw}：${cmd}`);
    else cues.push({ at: [...text].length, raw, cmd });
    rest = rest.slice(close + 2);
  }
  text += rest;
  // 去掉开头的空白，位置跟着往前挪
  const lead = [...text].length - [...text.trimStart()].length;
  const trimmed = text.trim();
  const length = [...trimmed].length;
  const placed = cues.map((c) => ({ ...c, at: Math.min(length, Math.max(0, c.at - lead)) }));
  // *重音*：星号不念，记下重音落在哪几个字上，标记的位置跟着挪
  const { text: spoken, map, marks } = emphasis(trimmed);
  const timed = placed.map((c) => ({ ...c, at: map[c.at]! }));
  const valid = timed.filter((c) => {
    if (c.cmd.type !== 'mark' || !/^(?:order:(done|decline):|beat:done:)/.test(c.cmd.label)) return true;
    if (![...spoken].slice(c.at).join('').replace(/[。！？!?，,；;」』）)"”'…\s]/g, '')) return true;
    errors.push(`${c.raw}：点单标记必须放在兑现整段的最后，后面还有没念的内容`);
    return false;
  });
  return { text: spoken, cues: valid, errors, marks };
}

/** 一段重音：念到第 from 个字到第 to 个字（不含）时字幕上强调 */
export interface Mark { from: number; to: number }

/**
 * 去掉 *重音* 的星号（** 也算一个）：返回念的字、旧位置 → 新位置、重音段。
 * 星号没配对的那个直接去掉，不算重音；空的重音不要。
 */
export function emphasis(text: string): { text: string; map: number[]; marks: Mark[] } {
  const chars = [...text];
  const out: string[] = [];
  const map: number[] = [];
  const marks: Mark[] = [];
  let open: number | undefined;
  for (let i = 0; i < chars.length; i++) {
    map.push(out.length);
    const c = chars[i]!;
    if (c !== '*' && c !== '＊') {
      out.push(c);
      continue;
    }
    // 连着的星号算一个
    while (chars[i + 1] === '*' || chars[i + 1] === '＊') map.push(out.length), i++;
    if (open === undefined) open = out.length;
    else {
      if (out.length > open) marks.push({ from: open, to: out.length });
      open = undefined;
    }
  }
  map.push(out.length);
  return { text: out.join(''), map, marks };
}
