/**
 * 舞台状态机：纯函数，(状态, 指令, 现在) → 新状态或拒绝的理由。
 *
 * 导播规则也在这里：切镜头和插 B-roll 共用画面预算（频率上限）、转场中不再切、锁镜头只有主人能切。
 * 拒绝的理由直接回给 Agent，写成她能照着改的话。
 */

import { TIER_ALERT_MS, type GiftTier } from './gifts';
import { EMOTE_MENU, emoteOf } from './emotes';
import { EXPLAIN_KINDS, pointable, stepCount, type Explain, type ExplainKind } from './explain';
/** 表情包在头边待多久（毫秒） */
export const EMOTE_MS = 2_400;
import { MAX_RATE, MIN_RATE, SOUND_FAMILIES, SOUND_TRACKS } from './protocol';
import {
  ALERT_MS, BROLL_MS, CUT_GAP_MS, LIMITS, TASK_LINGER_MS, TRANSITION_MS,
  playhead, screenText, transitionFor,
  type Actor, type Clip, type Command, type Graphic, type Panel, type Range, type StageState,
} from './protocol';
import { AVATAR_BASE, ELEMENT_IDS, LAYOUT_NAMES, PRESETS, placeBox, presetCanvas, type Box, type LayoutName } from './canvas';
import { DEFAULT_REGION, REGIONS, STAGE_REGIONS, regionsOverlap } from './regions';
import { hearDraw, reduceDraw, type DrawCommand } from './draw/reduce';
import { visualToDraw } from './draw/fromVisual';
import { FX_GAP_MS, SETS, SET_GAP_MS, SET_IDS, effectOf } from './sets';
import { graphicToDraw } from './draw/cue';
import { applyEffectFields, effectSlot, resolveEffect } from './effects';
import { GRAPHICS, GRAPHIC_HOLD_MS, GRAPHIC_OUT_MS, GRAPHIC_SLOTS, graphicMenu } from './graphics';

export interface Outcome {
  state: StageState;
  error?: string;
}

const ok = (state: StageState): Outcome => ({ state });
const no = (state: StageState, error: string): Outcome => ({ state, error });

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 能不能再切一次画面：转场中、锁镜头、频率上限 */
function cutBlocked(s: StageState, by: Actor, now: number): string | undefined {
  if (s.transition) return '正在转场，等这次切完再切';
  if (s.locked && by !== 'owner') return '主人锁了镜头，现在不能切';
  const wait = s.lastCutAt + CUT_GAP_MS[by] - now;
  if (wait > 0) return `刚切过画面，${Math.ceil(wait / 1000)} 秒后才能再切`;
  return undefined;
}

/** 把时间夹在片长里；没片子时拒绝 */
function inClip(s: StageState, at: number | undefined, now: number): number | string {
  if (!s.clip) return '主画面还没有片子，先上一段片子';
  if (at === undefined) return playhead(s.clip, now);
  if (!finite(at)) return '时间要是秒数';
  return clamp(at, 0, s.clip.durationSec);
}

function inRange(s: StageState, range: Range): Range | string {
  if (!s.clip) return '主画面还没有片子，先上一段片子';
  if (!finite(range.from) || !finite(range.to)) return '起止时间要是秒数';
  const from = clamp(Math.min(range.from, range.to), 0, s.clip.durationSec);
  const to = clamp(Math.max(range.from, range.to), 0, s.clip.durationSec);
  if (to - from < 0.5) return '这一段太短了（至少半秒）';
  return { from, to, ...(range.label ? { label: screenText(range.label, 24) } : {}) };
}

/** 播放头停在 at：保留播放与否 */
function seekClip(clip: Clip, at: number, now: number): Clip {
  return { ...clip, pos: at, since: now };
}

export function reduce(prev: StageState, cmd: Command, now: number): Outcome {
  const s = prev;
  const lane = cmd.lane ?? 'host';
  const graphics = ['draw', 'link', 'touch', 'shift', 'erase', 'page', 'group'];
  if (lane !== 'host' && !(lane === 'graphics' && graphics.includes(cmd.type)) && !(lane === 'lighting' && cmd.type === 'vfx') && !(lane === 'sound' && cmd.type === 'sound')) return no(s, `车道 ${lane} 不能发 ${cmd.type}`);
  if (lane === 'graphics' && cmd.type === 'draw' && INTERACTIVE.has(cmd.kind)) return no(s, '互动道具只有 host 能画');
  if (lane === 'graphics' && 'id' in cmd && s.draw.items.some((x) => x.id === cmd.id && INTERACTIVE.has(x.kind))) return no(s, 'graphics 不能修改、擦掉或挤掉主持人的互动道具');
  const id = ('id' in cmd && typeof cmd.id === 'string' && cmd.id) || `${cmd.type}${s.rev + 1}`;
  const out = apply(s, cmd, now, id);
  if (out.error || out.state === s) return out;
  // 只允许翻页更改互动的排版信息；投票、内容、揭晓状态等必须逐字保持。
  if (lane === 'graphics' && s.draw.items.some((item) => {
    if (!INTERACTIVE.has(item.kind)) return false;
    const after = out.state.draw.items.find((x) => x.id === item.id);
    const comparable = after && cmd.type === 'page' ? { ...after, cell: item.cell, docked: item.docked } : after;
    return JSON.stringify(comparable) !== JSON.stringify(item);
  })) return no(s, 'graphics 不能修改、擦掉或挤掉主持人的互动道具');
  return { state: { ...out.state, rev: s.rev + 1 } };
}

const INTERACTIVE = new Set(['poll', 'tier', 'score', 'guess', 'soup', 'timer', 'wall']);

function apply(s: StageState, cmd: Command, now: number, id: string): Outcome {
  switch (cmd.type) {
    case 'sound': {
      if (!['bed', 'volume', 'stop', 'effect'].includes(cmd.action)) return no(s, '没有这个音响动作');
      if (cmd.volume !== undefined && (!finite(cmd.volume) || cmd.volume < 0 || cmd.volume > 1)) return no(s, '音量要在 0 到 1 之间');
      if (cmd.fadeMs !== undefined && (!finite(cmd.fadeMs) || cmd.fadeMs < 0 || cmd.fadeMs > 10_000)) return no(s, '淡入淡出要在 0 到 10000 毫秒之间');
      const sound = s.sound ?? { bed: null, events: [] };
      if (cmd.action === 'effect') {
        if (!SOUND_FAMILIES.includes(cmd.name as typeof SOUND_FAMILIES[number]) && !SOUND_TRACKS.includes(cmd.name ?? '')) return no(s, '独立音效不在素材菜单里');
        return ok({ ...s, sound: { ...sound, events: [...sound.events.filter((x) => now - x.at < 10_000), { id, name: cmd.name!, volume: cmd.volume ?? 0.5, at: now }].slice(-8) } });
      }
      if (cmd.action === 'bed' && !SOUND_TRACKS.includes(cmd.name ?? '')) return no(s, '背景音不在素材菜单里');
      if (cmd.action === 'volume' && (!sound.bed || cmd.volume === undefined)) return no(s, '先放背景音，再给音量');
      const old = sound.bed;
      const bed = cmd.action === 'stop' ? (old ? { ...old, volume: 0, fadeMs: cmd.fadeMs ?? 800, at: now } : null)
        : { name: cmd.action === 'bed' ? cmd.name! : old!.name, volume: cmd.volume ?? 0.12, fadeMs: cmd.fadeMs ?? 800, at: now };
      return ok({ ...s, sound: { ...sound, bed } });
    }
    case 'draw': case 'link': case 'touch': case 'shift': case 'erase': case 'page': case 'zoom': case 'judge': case 'rank': case 'result': case 'group': case 'ans':
      return drawOn(s, cmd, now);
    case 'scene': {
      if (cmd.scene === s.scene && !s.transition) return ok(s);
      const by = cmd.by ?? 'agent';
      const blocked = cutBlocked(s, by, now);
      if (blocked) return no(s, blocked);
      const kind = transitionFor(cmd.cut ?? 'soft', cmd.scene);
      const transition = kind === 'cut' ? null : { kind, from: s.scene, to: cmd.scene, startedAt: now, ms: TRANSITION_MS[kind] };
      // 回杂谈时收起工位上的临时东西；换场景就是换成这个场景的整套摆法
      const back = cmd.scene === 'chat' ? { focus: null, broll: null } : {};
      const name: LayoutName = cmd.scene === 'watch' && s.mode === 'lesson' ? 'lesson' : cmd.scene;
      return ok({ ...s, ...back, ...arrange(s, name), scene: cmd.scene, transition, lastCutAt: now });
    }
    case 'layout': {
      if (!LAYOUT_NAMES.includes(cmd.name)) return no(s, `没有这套摆法：${cmd.name}（能用：${LAYOUT_NAMES.join(' ')}）`);
      const to = PRESETS[cmd.name].scene;
      if (to === s.scene && !s.transition) return ok({ ...s, ...arrange(s, cmd.name) });
      const by = cmd.by ?? 'agent';
      const blocked = cutBlocked(s, by, now);
      if (blocked) return no(s, blocked);
      const kind = transitionFor(cmd.cut ?? 'soft', to);
      const transition = kind === 'cut' ? null : { kind, from: s.scene, to, startedAt: now, ms: TRANSITION_MS[kind] };
      return ok({ ...s, ...arrange(s, cmd.name), scene: to, transition, lastCutAt: now });
    }
    case 'place': {
      if (!ELEMENT_IDS.includes(cmd.el)) return no(s, `画布上没有这个元素：${cmd.el}（有：${ELEMENT_IDS.join(' ')}）`);
      const prev = s.canvas[cmd.el];
      let patch: Partial<Box> = { ...cmd.box };
      if (cmd.at) {
        if (!STAGE_REGIONS.includes(cmd.at)) return no(s, `没有这个区域：${cmd.at}`);
        const r = REGIONS[s.scene][cmd.at];
        // 人物锁宽高比：在区域里放得下的最大尺寸，底边对齐、水平居中
        if (cmd.el === 'avatar') {
          const w = Math.min(r.w, (r.h * AVATAR_BASE.w) / AVATAR_BASE.h);
          const h = (w * AVATAR_BASE.h) / AVATAR_BASE.w;
          patch = { x: r.x + (r.w - w) / 2, y: r.y + r.h - h, w };
        } else patch = { ...r };
      }
      const next = { ...placeBox(cmd.el, prev, patch), ...(cmd.visible !== undefined ? { visible: cmd.visible } : {}), ...(cmd.z !== undefined && finite(cmd.z) ? { z: clamp(Math.round(cmd.z), 0, 20) } : {}) };
      return ok({
        ...s,
        canvas: { ...s.canvas, [cmd.el]: next },
        ...(cmd.el === 'avatar' && cmd.visible !== undefined ? { avatar: { ...s.avatar, visible: cmd.visible } } : {}),
      });
    }
    case 'lock':
      return s.locked === cmd.locked ? ok(s) : ok({ ...s, locked: cmd.locked });
    case 'mode':
      return ok({ ...s, mode: cmd.mode, ...(cmd.status !== undefined ? { status: cmd.status ? screenText(cmd.status, 12) : null } : {}) });
    case 'research': {
      if (cmd.done) return ok({ ...s, research: null });
      const prev = s.research;
      // 换了搜索词：新一轮，搜到的网页清掉
      const fresh = !prev || (cmd.query !== undefined && cmd.query !== prev.query);
      const sources = [...(fresh ? [] : prev.sources), ...(cmd.sources ?? [])]
        .map((x) => ({ title: screenText(x.title, 40), host: screenText(x.host, 30) }))
        .filter((x, i, a) => x.title && a.findIndex((y) => y.title === x.title) === i)
        .slice(-6);
      return ok({
        ...s,
        research: {
          ...(cmd.query !== undefined ? { query: screenText(cmd.query, 40) } : prev?.query ? { query: prev.query } : {}),
          sources,
          ...(cmd.reading !== undefined ? { reading: screenText(cmd.reading, 30) } : !fresh && prev?.reading ? { reading: prev.reading } : {}),
          at: fresh ? now : prev!.at,
        },
      });
    }
    case 'status':
      return ok({ ...s, status: cmd.label ? screenText(cmd.label, 12) : null });
    case 'avatar':
      return ok({
        ...s,
        avatar: { ...s.avatar, ...(cmd.mood ? { mood: cmd.mood } : {}), ...(cmd.visible !== undefined ? { visible: cmd.visible } : {}), ...(cmd.look ? { look: cmd.look } : {}) },
        ...(cmd.visible !== undefined ? { canvas: { ...s.canvas, avatar: { ...s.canvas.avatar, visible: cmd.visible } } } : {}),
      });
    case 'say': {
      const text = screenText(cmd.text, LIMITS.subtitle);
      if (!text) return no(s, '没有要说的话');
      // 脱敏改了字的话，重音和逐字时刻对不上了，就不要了
      const same = text === cmd.text;
      const length = [...text].length;
      const accents = same ? (cmd.accents ?? []).filter((a) => a.from >= 0 && a.to <= length && a.to > a.from).slice(0, 8) : [];
      const subtitle = {
        id, text, startedAt: now, ms: Math.max(0, cmd.ms),
        ...(cmd.audio ? { audio: cmd.audio } : {}),
        ...(cmd.tone && cmd.tone !== 'plain' ? { tone: cmd.tone } : {}),
        ...(accents.length ? { accents } : {}),
        ...(same && cmd.starts?.length === length ? { starts: cmd.starts } : {}),
        ...(cmd.rate && cmd.rate !== 1 ? { rate: clamp(cmd.rate, MIN_RATE, MAX_RATE) } : {}),
      };
      return ok({ ...s, subtitle, avatar: { ...s.avatar, speaking: true } });
    }
    case 'said':
      if (s.subtitle?.id !== cmd.id) return ok(s);
      return ok({ ...s, subtitle: null, picked: null, avatar: { ...s.avatar, speaking: false } });
    case 'interrupt':
      // 停声、停字幕、闭嘴。软打断要等这句念完，到时宿主再发一次硬的
      if (cmd.soft || (!s.subtitle && !s.avatar.speaking)) return ok(s);
      return ok({ ...s, subtitle: null, picked: null, avatar: { ...s.avatar, speaking: false } });

    case 'clip': {
      if (!finite(cmd.durationSec) || cmd.durationSec <= 0) return no(s, '片长要是正的秒数');
      const clip: Clip = { id, title: screenText(cmd.title, 40), durationSec: cmd.durationSec, playing: false, pos: 0, since: now, ...(cmd.src ? { src: cmd.src } : {}) };
      // 换片：旧片子上的旗、选区、切点、特效块都不再适用
      return ok({ ...s, clip, view: null, marks: [], selection: null, splits: [], fx: [], focus: null });
    }
    case 'unclip':
      return ok({ ...s, clip: null, view: null, marks: [], selection: null, splits: [], fx: [], focus: null });
    case 'play':
      if (!s.clip) return no(s, '主画面还没有片子');
      if (s.clip.playing) return ok(s);
      // 放到头了就从头放
      return ok({ ...s, clip: { ...s.clip, playing: true, pos: s.clip.pos >= s.clip.durationSec ? 0 : s.clip.pos, since: now } });
    case 'pause':
      if (!s.clip) return no(s, '主画面还没有片子');
      if (!s.clip.playing) return ok(s);
      return ok({ ...s, clip: { ...s.clip, playing: false, pos: playhead(s.clip, now), since: now } });
    case 'seek': {
      const at = inClip(s, cmd.at, now);
      if (typeof at === 'string') return no(s, at);
      return ok({ ...s, clip: seekClip(s.clip!, at, now) });
    }
    case 'view': {
      if (!cmd.range) return ok({ ...s, view: null });
      const range = inRange(s, cmd.range);
      if (typeof range === 'string') return no(s, range);
      // 跳到这一窗：播放头不在窗里就挪到窗头
      const head = playhead(s.clip!, now);
      const clip = head < range.from || head > range.to ? seekClip(s.clip!, range.from, now) : s.clip;
      return ok({ ...s, view: range, clip });
    }
    case 'mark': {
      const at = inClip(s, cmd.at, now);
      if (typeof at === 'string') return no(s, at);
      const mark = { id, at, label: screenText(cmd.label, 16) || '旗' };
      const marks = [...s.marks, mark].sort((a, b) => a.at - b.at).slice(-LIMITS.marks);
      return ok({ ...s, marks });
    }
    case 'unmark':
      if (!cmd.id) return ok({ ...s, marks: [] });
      if (!s.marks.some((m) => m.id === cmd.id)) return no(s, `没有这面旗：${cmd.id}`);
      return ok({ ...s, marks: s.marks.filter((m) => m.id !== cmd.id) });
    case 'select': {
      if (!cmd.range) return ok({ ...s, selection: null });
      const range = inRange(s, cmd.range);
      if (typeof range === 'string') return no(s, range);
      return ok({ ...s, selection: range });
    }
    case 'split': {
      const at = inClip(s, cmd.at, now);
      if (typeof at === 'string') return no(s, at);
      if (at <= 0 || at >= s.clip!.durationSec) return no(s, '片头片尾不用切');
      if (s.splits.some((x) => Math.abs(x - at) < 0.25)) return ok(s);
      return ok({ ...s, splits: [...s.splits, at].sort((a, b) => a - b).slice(-LIMITS.splits) });
    }
    case 'focus':
      if (cmd.focus && !s.clip) return no(s, '主画面还没有片子');
      return ok({ ...s, focus: cmd.focus ? { region: cmd.focus.region, ...(cmd.focus.label ? { label: screenText(cmd.focus.label, 16) } : {}) } : null });
    case 'code': {
      if (!cmd.code) return ok({ ...s, code: null });
      // 代码只上摘录：限行数、限行宽、脱敏
      const lines = cmd.code.lines.slice(0, LIMITS.codeLines).map((line) => {
        const clean = screenTextKeepIndent(line);
        return clean.length > LIMITS.codeLineChars ? `${clean.slice(0, LIMITS.codeLineChars - 1)}…` : clean;
      });
      if (!lines.some((l) => l.trim())) return no(s, '代码摘录是空的');
      const highlight = cmd.code.highlight !== undefined && cmd.code.highlight >= 1 && cmd.code.highlight <= lines.length ? cmd.code.highlight : undefined;
      return ok({ ...s, code: { title: screenText(cmd.code.title, 24), lang: screenText(cmd.code.lang, 12), lines, ...(highlight ? { highlight } : {}), at: now } });
    }
    case 'fx':
      return fx(s, cmd, now, id);
    case 'task':
      return task(s, cmd, now, id);
    case 'broll': {
      const blocked = cutBlocked(s, cmd.by ?? 'agent', now);
      if (blocked) return no(s, blocked);
      if (s.scene !== 'watch') return no(s, 'B-roll 只在看片场景插（先切到看片）');
      const broll = { id, title: screenText(cmd.title, 24), ...(cmd.caption ? { caption: screenText(cmd.caption, 40) } : {}), ...(cmd.src ? { src: cmd.src } : {}), startedAt: now, ms: clamp(cmd.ms ?? BROLL_MS, 1_500, 10_000) };
      return ok({ ...s, broll, lastCutAt: now });
    }
    case 'feed':
      return ok({ ...s, danmaku: cmd.danmaku.slice(-LIMITS.danmaku), picked: null });
    case 'danmaku': {
      const text = screenText(cmd.text, 60);
      if (!text) return ok(s);
      const kind = cmd.kind && cmd.kind !== 'chat' ? cmd.kind : undefined;
      const line = { id, platform: cmd.platform, user: screenText(cmd.user, 16) || '观众', text, at: now, ...(kind ? { kind } : {}), ...(kind === 'gift' && cmd.tier ? { tier: clamp(Math.round(cmd.tier), 1, 5) } : {}) };
      // 投票只认弹幕，礼物、关注这些不算
      const panels = kind ? s.panels : s.panels.map((x) => vote(x, `${cmd.platform}:${line.user}`, text));
      const draw = kind ? s.draw : hearDraw(s.draw, `${cmd.platform}:${line.user}`, cmd.text);
      return ok({ ...s, danmaku: [...s.danmaku, line].slice(-LIMITS.danmaku), panels, draw });
    }
    case 'away':
      return ok({ ...s, away: cmd.on });
    case 'program': {
      const program = { ...s.program };
      if (cmd.title !== undefined) { if (cmd.title) program.title = screenText(cmd.title, 16); else delete program.title; }
      if (cmd.topic !== undefined) { if (cmd.topic) program.topic = screenText(cmd.topic, 24); else delete program.topic; }
      return ok({ ...s, program });
    }
    case 'room': {
      if (!SETS[cmd.id]) return no(s, `没有这个布景：${cmd.id}（有：${SET_IDS.join(' ')}）`);
      if (cmd.id === s.set) return ok(s);
      const by = cmd.by ?? 'agent';
      const wait = s.setAt + SET_GAP_MS - now;
      if (by === 'agent' && wait > 0) return no(s, `刚换过布景，${Math.ceil(wait / 60_000)} 分钟后才能再换`);
      // 换布景就是翻一页：画布上的东西跟着旧布景走
      const draw = s.draw.items.length ? { ...s.draw, items: [], page: s.draw.page + 1, pageAt: now, zoom: null } : s.draw;
      return ok({ ...s, set: cmd.id, setFrom: s.set, setAt: now, draw, vfx: [] });
    }
    case 'vfx': {
      const fx = effectOf(s.set, cmd.name);
      if (!fx) return no(s, `「${SETS[s.set]?.name}」没有这个特效：${cmd.name}（有：${Object.keys(SETS[s.set]?.effects ?? {}).join(' ')}）`);
      const last = s.vfx.find((x) => x.name === cmd.name);
      if (last && now - last.at < FX_GAP_MS) return no(s, `${fx.zh}刚演过，隔几秒再用`);
      return ok({ ...s, vfx: [...s.vfx.filter((x) => now - x.at < 10_000), { id, name: cmd.name, at: now }].slice(-4) });
    }
    case 'emote': {
      const e = emoteOf(cmd.name);
      if (!e) return no(s, `没有这个表情：${cmd.name}。能用：${EMOTE_MENU}，或者直接写一个 emoji`);
      return ok({ ...s, emotes: [...s.emotes.filter((x) => now - x.at < EMOTE_MS), { id, ...e, at: now }].slice(-3) });
    }
    case 'enter': {
      const user = screenText(cmd.user, 16);
      if (!user) return ok(s);
      const entering = [...s.entering.filter((x) => !(x.platform === cmd.platform && x.user === user)), { id, platform: cmd.platform, user, at: now }].slice(-6);
      return ok({ ...s, entering });
    }
    case 'viewers':
      if (!Number.isFinite(cmd.count) || cmd.count < 0) return no(s, '人数不对');
      return ok({ ...s, viewers: { ...s.viewers, [cmd.platform]: Math.round(cmd.count) } });
    case 'pick':
      if (cmd.id && !s.danmaku.some((d) => d.id === cmd.id)) return no(s, '这条弹幕已经不在屏上了');
      return ok({ ...s, picked: cmd.id });
    case 'alert': {
      const tier = cmd.tier && cmd.tier >= 1 && cmd.tier <= 5 ? (Math.round(cmd.tier) as GiftTier) : undefined;
      const alert = {
        id, kind: cmd.kind, platform: cmd.platform, user: screenText(cmd.user, 16) || '观众', text: screenText(cmd.text, 40),
        ...(cmd.value ? { value: screenText(cmd.value, 12) } : {}), at: now, ms: tier ? TIER_ALERT_MS[tier] : ALERT_MS[cmd.kind],
        ...(tier ? { tier } : {}),
      };
      // 同时最多几条：挤掉最早的
      return ok({ ...s, alerts: [...s.alerts, alert].slice(-LIMITS.alerts) });
    }
    case 'graphic': {
      // 包装停用：不再渲染旧包装，常用的几种画到画布上，别的拒绝
      const drawn = graphicToDraw(cmd.name, cmd.fields ?? {});
      return typeof drawn === 'string' ? no(s, drawn) : drawOn(s, drawn, now);
    }
    case 'board': {
      if (cmd.clear) return ok({ ...s, board: null });
      if (cmd.title !== undefined) {
        // 换标题就是换一块黑板：要点清空
        const title = screenText(cmd.title, 20);
        if (!title) return no(s, '黑板标题是空的');
        // 换黑板就是换一节：上一节的素材也收掉
        return ok({ ...s, panels: [], board: { title, points: cmd.point ? [screenText(cmd.point, 30)] : [], at: now } });
      }
      if (cmd.point !== undefined) {
        if (!s.board) return no(s, '黑板上还没有标题，先写标题');
        const point = screenText(cmd.point, 30);
        if (!point) return no(s, '要点是空的');
        if (s.board.points.length >= LIMITS.boardPoints) return no(s, `一块黑板最多 ${LIMITS.boardPoints} 条要点，换个标题再写`);
        return ok({ ...s, board: { ...s.board, points: [...s.board.points, point], at: now } });
      }
      return ok(s);
    }
    case 'show': {
      if (!cmd.visual) return no(s, cmd.id ? `没有这块素材：${cmd.id}` : '没给素材');
      // 素材都画到画布上（只有一套样子）；位置交给画布排版
      const drawn = visualToDraw(cmd.visual, cmd.at ? REGION_ANCHOR[cmd.at] : undefined, cmd.url);
      return typeof drawn === 'string' ? no(s, drawn) : drawOn(s, drawn, now);
    }
    case 'move': {
      if (s.draw.items.some((x) => x.id === cmd.id)) return drawOn(s, { type: 'shift', id: cmd.id, at: REGION_ANCHOR[cmd.at] ?? 'center' }, now);
      const target = s.panels.find((x) => x.visual.id === cmd.id);
      if (!target) return no(s, `画面上没有 ${cmd.id}`);
      if (!STAGE_REGIONS.includes(cmd.at)) return no(s, `没有这个区域：${cmd.at}`);
      const kept = s.panels.filter((x) => x === target || !regionsOverlap(x.region, cmd.at));
      return ok({ ...s, panels: kept.map((x) => (x === target ? { ...x, region: cmd.at } : x)) });
    }
    case 'unshow':
      // 素材都在画布上：撤一块 = 擦掉它，不写编号 = 全擦
      if (!cmd.id || s.draw.items.some((x) => x.id === cmd.id)) return drawOn(s, cmd.id ? { type: 'erase', id: cmd.id } : { type: 'erase' }, now);
      if (!cmd.id) return s.panels.length ? ok({ ...s, panels: [] }) : ok(s);
      if (!s.panels.some((x) => x.visual.id === cmd.id)) return no(s, `画面上没有 ${cmd.id}`);
      return ok({ ...s, panels: s.panels.filter((x) => x.visual.id !== cmd.id) });
    case 'reveal': {
      // 揭晓画布上的投票、打分、猜数字（问答也画成了投票）
      const open = [...s.draw.items].reverse().find((x) => (cmd.id ? x.id === cmd.id : true) && ['poll', 'score', 'guess'].includes(x.kind));
      if (open) return drawOn(s, { type: 'result', id: open.id }, now);
      const target = pick(s, cmd.id, (k) => k === 'quiz' || k === 'poll');
      if (!target) return no(s, '画面上没有问答或投票');
      return ok({ ...s, panels: s.panels.map((x) => (x === target ? { ...x, revealed: true } : x)) });
    }
    case 'step': {
      const target = pick(s, cmd.on, (k) => EXPLAIN_KINDS.includes(k as ExplainKind));
      if (!target) return no(s, cmd.on ? `画面上没有讲解组件 ${cmd.on}` : '画面上没有讲解组件（图解、标注图、数据图），先 [[show 编号]]');
      const max = stepCount(target.visual as Explain);
      if (!max) return no(s, '这块讲解组件没有分步（元素都没写 step）');
      const next = cmd.to !== undefined ? clamp(Math.round(cmd.to), 0, max) : Math.min(max, (target.step ?? 0) + 1);
      return ok({ ...s, panels: s.panels.map((x) => (x === target ? { ...x, step: next } : x)) });
    }
    case 'point': {
      const target = pick(s, cmd.on, (k) => EXPLAIN_KINDS.includes(k as ExplainKind));
      if (!target) return no(s, '画面上没有讲解组件，没东西可指');
      if (cmd.target === null) {
        const { point: _gone, ...rest } = target;
        return ok({ ...s, panels: s.panels.map((x) => (x === target ? rest : x)) });
      }
      const ids = pointable(target.visual as Explain);
      if (!ids.includes(cmd.target)) return no(s, `没有这个元素：${cmd.target}（能指：${ids.slice(0, 12).join('、')}）`);
      return ok({ ...s, panels: s.panels.map((x) => (x === target ? { ...x, point: cmd.target! } : x)) });
    }
    case 'drive': {
      const target = pick(s, cmd.on, (k) => k === 'scene');
      if (!target) return no(s, cmd.on ? `画面上没有代码场景 ${cmd.on}` : '画面上没有代码场景，先 [[show 编号]]');
      const act = cmd.act ? screenText(cmd.act, 30) : undefined;
      // 动作留最近 50 个，够中途打开的页面重放
      const next = { ...target, params: { ...target.params, ...cmd.set }, acts: act ? [...(target.acts ?? []), act].slice(-50) : target.acts ?? [] };
      return ok({ ...s, panels: s.panels.map((x) => (x === target ? next : x)) });
    }
    case 'rundown': {
      if ('steps' in cmd) {
        const steps = cmd.steps.map((x) => screenText(x, 16)).filter(Boolean).slice(0, LIMITS.rundownSteps);
        if (!steps.length) return no(s, '节目单是空的');
        return ok({ ...s, rundown: { title: screenText(cmd.title, 24), steps, at: -1, paused: false } });
      }
      if (cmd.clear) return ok({ ...s, rundown: null });
      if (!s.rundown) return no(s, '还没有节目单');
      // at 可以等于步数：表示全部讲完
      const at = cmd.at !== undefined && finite(cmd.at) ? clamp(Math.round(cmd.at), -1, s.rundown.steps.length) : s.rundown.at;
      return ok({ ...s, rundown: { ...s.rundown, at, ...(cmd.paused !== undefined ? { paused: cmd.paused } : {}) } });
    }
    case 'ungraphic': {
      // 不删，只把退场时间提到现在：留出淡出
      const hit = s.graphics.filter((g) => (!cmd.id || g.id === cmd.id) && g.until > now);
      if (cmd.id && !hit.length) return no(s, `屏上没有这段包装：${cmd.id}`);
      if (!hit.length) return ok(s);
      return ok({ ...s, graphics: s.graphics.map((g) => (hit.includes(g) ? { ...g, until: now } : g)) });
    }
  }
}

/** 换成一套摆法：画布元素回到预设位置（藏起来的人物保持藏着），视线跟着摆法走 */
/**
 * 画布：画上第一样东西时整套换到展示摆法（展示板铺开、她缩到右下），全擦干净回到杂谈。
 * 翻页不算擦干净：她在接着讲下一个点。
 */
/** 旧的区域名 → 画布位置 */
const REGION_ANCHOR: Record<string, string> = {
  main: 'center', center: 'center', left: 'left', right: 'right', top: 'top', bottom: 'bottom', banner: 'top', lower: 'bottom',
};

function drawOn(s: StageState, cmd: DrawCommand, now: number): Outcome {
  // 弹幕上墙：按名字找这个人最近一条弹幕（不写名字就最新一条），把原话和名字放上去
  if (cmd.type === 'draw' && cmd.kind === 'wall') {
    const name = cmd.text.trim();
    const said = [...s.danmaku].reverse().find((d) => !d.kind && (!name || d.user === name || d.user.includes(name)));
    if (!said) return no(s, name ? `弹幕里没找到 ${name} 说的话` : '还没有弹幕可以上墙');
    cmd = { ...cmd, text: said.text, note: `${said.user}`, rows: [{ label: said.platform }] };
  }
  const draw = reduceDraw(s.draw, cmd, now, 'lane' in cmd && cmd.lane === 'graphics');
  if (typeof draw === 'string') return no(s, draw);
  if (draw === s.draw) return ok(s);
  const opening = !s.draw.items.length && draw.items.length && s.scene === 'chat';
  const closing = cmd.type === 'erase' && !cmd.id && s.scene === 'watch' && !s.panels.length;
  if (opening) return ok({ ...s, draw, ...arrange(s, 'watch'), scene: 'watch', transition: { kind: 'slide', from: 'chat', to: 'watch', startedAt: now, ms: TRANSITION_MS.slide } });
  // 她跟着画面：画新东西时看向画布；揭晓、打叉、盖章时头边冒个表情
  const react = cmd.type === 'result' || (cmd.type === 'touch' && cmd.fx === 'flip') ? '✨'
    : cmd.type === 'touch' && (cmd.fx === 'cross' || cmd.fx === 'stamp') ? '😱'
    : cmd.type === 'touch' && cmd.fx === 'check' ? '👌' : undefined;
  const look = cmd.type === 'draw' && s.scene === 'watch' ? { avatar: { ...s.avatar, look: 'left' as const } } : {};
  if (react) {
    const e = emoteOf(react);
    if (e) return ok({ ...s, draw, ...look, emotes: [...s.emotes.filter((x) => now - x.at < EMOTE_MS), { id: `react${s.rev + 1}`, ...e, at: now }].slice(-3) });
  }
  if (Object.keys(look).length) return ok({ ...s, draw, ...look });
  if (closing) return ok({ ...s, draw, ...arrange(s, 'chat'), scene: 'chat', transition: { kind: 'slide', from: 'watch', to: 'chat', startedAt: now, ms: TRANSITION_MS.slide } });
  return ok({ ...s, draw });
}

function arrange(s: StageState, name: LayoutName): Pick<StageState, 'canvas' | 'layout' | 'avatar'> {
  const canvas = presetCanvas(name);
  canvas.avatar.visible = s.avatar.visible;
  return { canvas, layout: name, avatar: { ...s.avatar, look: PRESETS[name].scene === 'watch' ? 'left' : 'camera' } };
}

/** 按编号找画面上的组件；不给编号就找最近上屏的那类 */
function pick(s: StageState, id: string | undefined, kind: (k: Panel['visual']['kind']) => boolean): Panel | undefined {
  if (id) return s.panels.find((x) => x.visual.id === id && kind(x.visual.kind));
  return [...s.panels].reverse().find((x) => kind(x.visual.kind));
}

/** 投票进行中时，弹幕发「1」「2」或「A」「B」算一票，一人一票 */
function vote(panel: Panel, who: string, text: string): Panel {
  if (panel.visual.kind !== 'poll' || panel.revealed) return panel;
  const m = /^\s*([1-4]|[A-Da-d])\s*$/.exec(text);
  if (!m) return panel;
  const idx = /\d/.test(m[1]!) ? Number(m[1]) - 1 : m[1]!.toUpperCase().charCodeAt(0) - 65;
  if (idx >= panel.votes.length || panel.voters.includes(who)) return panel;
  return { ...panel, votes: panel.votes.map((v, i) => (i === idx ? v + 1 : v)), voters: [...panel.voters, who].slice(-2_000) };
}

/** 字段 → 源组件变量：查名字、查必填、脱敏、限长、数字解析。短名字走手工模板，其余走特效目录。 */

function graphicTemplate(t: (typeof GRAPHICS)[string], cmd: Extract<Command, { type: 'graphic' }>): { error: string } | { name: string; source: string; vars: Graphic['vars']; slot: Graphic['slot']; seconds: number } {
  const fields = cmd.fields ?? {};
  const unknown = Object.keys(fields).filter((k) => !t.fields.some((f) => f.key === k));
  if (unknown.length) return { error: `${cmd.name} 没有这些字段：${unknown.join('、')}。能填：${t.fields.map((f) => f.key).join('、')}` };
  const vars: Graphic['vars'] = { ...t.fixed };
  for (const f of t.fields) {
    const raw = fields[f.key];
    const given = raw !== undefined && raw !== null && String(raw).trim() !== '';
    if (!given) {
      if (f.required) return { error: `${cmd.name} 要填 ${f.key}（${f.label}）` };
      // 可选文字字段不填就留空，不让源组件的英文默认值上屏
      if (f.kind !== 'number') vars[f.to] = '';
      continue;
    }
    if (f.kind === 'number') {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,，%\s]/g, ''));
      if (!finite(n)) return { error: `${f.key} 要是数字` };
      vars[f.to] = n;
    } else {
      // 列表字段允许中文逗号
      const value = f.kind === 'list' ? String(raw).replace(/，/g, ',') : String(raw);
      vars[f.to] = screenText(value, f.max ?? LIMITS.text);
    }
  }
  return { name: cmd.name, source: t.source, vars, slot: cmd.slot ?? t.slot, seconds: t.seconds };
}

/** 同一个位置只放一段；超过三段挤掉最早的 */
function placeGraphic(
  s: StageState,
  cmd: Extract<Command, { type: 'graphic' }>,
  now: number,
  id: string,
  built: { error: string } | { name: string; source: string; vars: Graphic['vars']; slot: Graphic['slot']; seconds: number; runtime?: Graphic['runtime']; entry?: string; playFor?: number },
): Outcome {
  if ('error' in built) return no(s, built.error);
  const slot = built.slot;
  if (!GRAPHIC_SLOTS.includes(slot)) return no(s, `位置只能是：${GRAPHIC_SLOTS.join('、')}`);
  const hold = cmd.seconds !== undefined && finite(cmd.seconds) ? clamp(cmd.seconds * 1000, 1_500, 30_000) : built.seconds * 1000 + GRAPHIC_HOLD_MS;
  const graphics = s.graphics.map((g) => (g.slot === slot && g.until > now ? { ...g, until: now } : g));
  const live = graphics.filter((g) => g.until > now);
  const evict = live.length >= LIMITS.graphics ? live[0]!.id : null;
  const next: Graphic = {
    id, name: built.name, source: built.source, vars: built.vars, slot, startedAt: now, until: now + hold,
    ...(built.runtime ? { runtime: built.runtime, entry: built.entry, playFor: built.playFor } : {}),
  };
  return ok({ ...s, graphics: [...graphics.map((g) => (g.id === evict ? { ...g, until: now } : g)), next] });
}

/** 代码摘录保留缩进，只脱敏 */
function screenTextKeepIndent(line: string): string {
  const indent = /^\s*/.exec(line)?.[0].replace(/\t/g, '  ') ?? '';
  return indent + screenText(line.trimStart(), LIMITS.codeLineChars);
}

function fx(s: StageState, cmd: Extract<Command, { type: 'fx' }>, now: number, id: string): Outcome {
  if (cmd.op === 'add') {
    const range = inRange(s, { from: cmd.from, to: cmd.to });
    if (typeof range === 'string') return no(s, range);
    if (s.fx.length >= LIMITS.fx) return no(s, `特效块最多 ${LIMITS.fx} 个，先删掉一个`);
    return ok({ ...s, fx: [...s.fx, { id, name: screenText(cmd.name, 12) || '特效', from: range.from, to: range.to, status: 'draft', at: now }] });
  }
  const block = s.fx.find((b) => b.id === cmd.id);
  if (!block) return no(s, `没有这个特效块：${cmd.id}`);
  if (cmd.op === 'remove') return ok({ ...s, fx: s.fx.filter((b) => b.id !== cmd.id) });
  if (cmd.op === 'move') {
    const range = inRange(s, { from: cmd.from, to: cmd.to });
    if (typeof range === 'string') return no(s, range);
    return ok({ ...s, fx: s.fx.map((b) => (b.id === cmd.id ? { ...b, from: range.from, to: range.to, at: now } : b)) });
  }
  return ok({ ...s, fx: s.fx.map((b) => (b.id === cmd.id ? { ...b, status: cmd.status, at: now } : b)) });
}

function task(s: StageState, cmd: Extract<Command, { type: 'task' }>, now: number, id: string): Outcome {
  if (cmd.op === 'start') {
    const running = s.tasks.filter((t) => t.status === 'running');
    if (running.length >= LIMITS.tasks) return no(s, `同时最多 ${LIMITS.tasks} 个任务在跑`);
    // 角落位置有限：挤掉已经结束的
    const kept = [...s.tasks.filter((t) => t.status !== 'running'), ...running].slice(-(LIMITS.tasks - 1));
    return ok({ ...s, tasks: [...kept, { id, kind: cmd.kind, title: screenText(cmd.title, 20) || '任务', progress: 0, status: 'running', startedAt: now }] });
  }
  const t = s.tasks.find((x) => x.id === cmd.id);
  if (!t) return no(s, `没有这个任务：${cmd.id}`);
  if (cmd.op === 'remove') return ok({ ...s, tasks: s.tasks.filter((x) => x.id !== cmd.id) });
  if (t.status !== 'running') return no(s, '这个任务已经结束了');
  const next = cmd.op === 'progress'
    ? { ...t, progress: clamp(finite(cmd.progress) ? cmd.progress : t.progress, 0, 0.99) }
    : { ...t, status: cmd.op === 'done' ? 'done' as const : 'failed' as const, progress: cmd.op === 'done' ? 1 : t.progress, endedAt: now };
  return ok({ ...s, tasks: s.tasks.map((x) => (x.id === cmd.id ? next : x)) });
}

/** 时间推进：转场播完落地、礼物、B-roll 和包装到点退场、结束的任务过一会儿离开角落 */
export function tick(s: StageState, now: number): StageState {
  const transition = s.transition && now >= s.transition.startedAt + s.transition.ms ? null : s.transition;
  const alerts = s.alerts.filter((a) => now < a.at + a.ms);
  const broll = s.broll && now >= s.broll.startedAt + s.broll.ms ? null : s.broll;
  const tasks = s.tasks.filter((t) => t.status === 'running' || now < (t.endedAt ?? now) + TASK_LINGER_MS);
  // 放到头自动停下
  const clip = s.clip?.playing && playhead(s.clip, now) >= s.clip.durationSec ? { ...s.clip, playing: false, pos: s.clip.durationSec, since: now } : s.clip;
  const graphics = s.graphics.filter((g) => now < g.until + GRAPHIC_OUT_MS);
  if (transition === s.transition && alerts.length === s.alerts.length && broll === s.broll && tasks.length === s.tasks.length && clip === s.clip && graphics.length === s.graphics.length) return s;
  return { ...s, transition, alerts, broll, tasks, clip, graphics, rev: s.rev + 1 };
}
