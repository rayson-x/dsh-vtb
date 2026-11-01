/**
 * 画布音效：每个动效自动带一声，她不用管。参考 reelmorph-agent 的动效—音效家族搭配。
 *
 *   出场  pop 啵 · slide 呼 · type 打字咔哒 · slam 撞击（落定那一下）· draw 轻咔
 *   强调  圈/划重点/下划线/划掉 落笔咔哒 · 放大 啵 · 抖 敲 · 等回答 上扬 · 箭头 嗖 · 聚光 倒吸
 *   变化  换字/翻面 槌音叮 · 数字滚 滚完叮 · 打勾 敲 · 打叉 撞击
 *   整页  翻页、全擦 呼 · 推镜头 倒吸 · 连线 嗖
 *   直播间  弹幕 水滴（很轻）· 礼物 叮咚
 *
 * 规则：同一时刻只响一声（120ms 内的后来者丢掉）；她说话时整体压低；同家族几条轮换；
 * 音效的起音对齐动效的落点（slam 落在 250ms、盖章 200ms）。网址带 sfx=0 就不出声。
 */

import { useEffect, useRef } from 'react';
import type { Fx, Item } from '../stage/draw/model';
import type { StageState } from '../stage/protocol';
import { audioContext, playable } from './voice';
import { SETS } from '../stage/sets';

type Family = 'pop' | 'drip' | 'whoosh' | 'hit' | 'knock' | 'mallet' | 'riser' | 'swell' | 'click' | 'glitch' | 'shutter' | 'notify';

/** 各家族的音量（相对），提示音单独一档 */
const LEVEL: Record<Family, number> = {
  pop: 0.55, drip: 0.35, whoosh: 0.45, hit: 0.7, knock: 0.55, mallet: 0.5, riser: 0.45, swell: 0.5, click: 0.4, glitch: 0.45, shutter: 0.5, notify: 0.5,
};
const MASTER = 0.5;
/** 她说话时压低到这么多 */
const DUCK = 0.55;
const GAP_MS = 120;

const ENTER_SOUND: Record<Item['enter'], [Family, number] | null> = {
  pop: ['pop', 60], slide: ['whoosh', 0], type: ['click', 0], slam: ['hit', 250], draw: ['click', 80], fade: null, decode: ['glitch', 0], words: ['whoosh', 0],
};
const FX_SOUND: Partial<Record<Fx, [Family, number]>> = {
  circle: ['click', 60], highlight: ['click', 40], underline: ['click', 40], strike: ['click', 40],
  grow: ['pop', 0], shake: ['knock', 0], pulse: ['riser', 0], arrow: ['whoosh', 0], spotlight: ['swell', 0],
  swap: ['mallet', 200], count: ['mallet', 1050], flip: ['mallet', 500], check: ['knock', 200], cross: ['hit', 200], stamp: ['hit', 200],
};

let buffers: Partial<Record<Family, AudioBuffer[]>> | undefined;
let loading: Promise<void> | undefined;
const turn: Partial<Record<Family, number>> = {};
let lastAt = 0;

function load(): Promise<void> {
  loading ??= (async () => {
    const index = (await (await fetch(playable('/sfx/index.json'))).json()) as Record<Family, string[]>;
    const ctx = audioContext();
    const out: Partial<Record<Family, AudioBuffer[]>> = {};
    await Promise.all(Object.entries(index).map(async ([fam, files]) => {
      out[fam as Family] = (await Promise.all(files.map(async (f) => {
        try {
          return await ctx.decodeAudioData(await (await fetch(playable(`/sfx/${f}`))).arrayBuffer());
        } catch {
          return undefined;
        }
      }))).filter((b): b is AudioBuffer => !!b);
    }));
    buffers = out;
  })().catch(() => { loading = undefined; });
  return loading;
}

/** 布景的声音：sets/<id>/sfx/<文件>，用到才加载，加载过就留着 */
const setBuffers = new Map<string, Promise<AudioBuffer | undefined>>();
function setSound(set: string, file: string): Promise<AudioBuffer | undefined> {
  const key = `${set}/${file}`;
  if (!setBuffers.has(key)) {
    setBuffers.set(key, fetch(playable(`/sets/${set}/sfx/${file}`)).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject())).then((b) => audioContext().decodeAudioData(b)).catch(() => undefined));
  }
  return setBuffers.get(key)!;
}

/** 当前布景：通用动作的声音可以被布景换掉 */
let currentSet = '';

const muted = () => new URLSearchParams(location.search).get('sfx') === '0';

function start(buffer: AudioBuffer, delayMs: number, volume: number): void {
  const ctx = audioContext();
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  src.connect(gain).connect(ctx.destination);
  src.start(ctx.currentTime + Math.max(0, delayMs) / 1000);
}

/** 布景特效的声音：不受「同一时刻只响一声」限制（特效就是主角） */
function playEffect(set: string, files: string[], delayMs: number, volume: number, speaking: boolean): void {
  if (muted() || !files.length) return;
  const file = files[Math.floor(Math.random() * files.length)]!;
  void setSound(set, file).then((b) => b && start(b, delayMs, MASTER * volume * (speaking ? 0.8 : 1)));
}

/** 环境底噪：循环放，换布景时交叉淡入淡出 */
let bed: { set: string; gain: GainNode; src: AudioBufferSourceNode } | null = null;
function switchBed(set: string): void {
  const def = SETS[set];
  if (bed?.set === set) return;
  const ctx = audioContext();
  if (bed) {
    const old = bed;
    old.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.6);
    setTimeout(() => old.src.stop(), 3_000);
    bed = null;
  }
  if (!def?.bed || muted()) return;
  void setSound(set, 'bed.mp3').then((b) => {
    if (!b || currentSet !== set) return;
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(ctx.destination);
    src.start();
    gain.gain.setTargetAtTime(MASTER * def.bed!.volume, ctx.currentTime, 0.8);
    bed = { set, gain, src };
  });
}

/** 音响车道的背景音覆盖布景底噪；异步解码期间换曲也只启动最后一首。 */
let crewBed: { name: string; gain: GainNode; src: AudioBufferSourceNode } | null = null;
let bedGeneration = 0;
const trackBuffers = new Map<string, Promise<AudioBuffer | undefined>>();
function track(name: string): Promise<AudioBuffer | undefined> {
  if (!trackBuffers.has(name)) trackBuffers.set(name, fetch(playable(name)).then((r) => r.ok ? r.arrayBuffer() : Promise.reject()).then((b) => audioContext().decodeAudioData(b)).catch(() => undefined));
  return trackBuffers.get(name)!;
}
function crewBackground(next: NonNullable<StageState['sound']['bed']>): void {
  const generation = ++bedGeneration;
  const ctx = audioContext();
  const fade = (gain: GainNode, volume: number) => {
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(volume * MASTER, ctx.currentTime + next.fadeMs / 1000);
  };
  if (bed) {
    const old = bed; bed = null;
    fade(old.gain, 0);
    setTimeout(() => { try { old.src.stop(); } catch {} }, next.fadeMs + 50);
  }
  if (crewBed?.name === next.name && next.volume > 0) { fade(crewBed.gain, next.volume); return; }
  if (crewBed) {
    const old = crewBed; crewBed = null;
    fade(old.gain, 0);
    setTimeout(() => { try { old.src.stop(); } catch {} }, next.fadeMs + 50);
  }
  if (!next.volume || muted()) return;
  void track(next.name).then((buffer) => {
    if (!buffer || generation !== bedGeneration) return;
    const src = ctx.createBufferSource(); src.buffer = buffer; src.loop = true;
    const gain = ctx.createGain(); gain.gain.value = 0;
    src.connect(gain).connect(ctx.destination); src.start();
    fade(gain, next.volume); crewBed = { name: next.name, gain, src };
  });
}

function play(family: Family, delayMs: number, speaking: boolean): void {
  if (muted()) return;
  // 布景换掉了这一类的声音就用布景的
  const own = SETS[currentSet]?.sounds?.[family];
  if (own?.length) {
    const at = performance.now() + delayMs;
    if (at - lastAt < GAP_MS) return;
    lastAt = at;
    playEffect(currentSet, own, delayMs, LEVEL[family], speaking);
    return;
  }
  const list = buffers?.[family];
  if (!list?.length) return;
  const at = performance.now() + delayMs;
  if (at - lastAt < GAP_MS) return;
  lastAt = at;
  const ctx = audioContext();
  const i = (turn[family] = ((turn[family] ?? -1) + 1) % list.length);
  const src = ctx.createBufferSource();
  src.buffer = list[i]!;
  const gain = ctx.createGain();
  gain.gain.value = MASTER * LEVEL[family] * (speaking ? DUCK : 1);
  src.connect(gain).connect(ctx.destination);
  src.start(ctx.currentTime + delayMs / 1000);
}

/** 盯着画布和直播间：新元素、新动作、翻页、推镜头、新弹幕、礼物，各响一声 */
export function useSfx(state: StageState | null): void {
  const soundSeen = useRef<{ bedKey?: string; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (!state?.sound) return;
    const prev = soundSeen.current;
    const next = state.sound;
    const bedKey = JSON.stringify(next.bed);
    soundSeen.current = { bedKey, ids: new Set(next.events.map((x) => x.id)) };
    if (next.bed && bedKey !== prev?.bedKey) crewBackground(next.bed);
    if (!prev || muted()) return;
    for (const event of next.events) {
      if (prev.ids.has(event.id) || Date.now() - event.at > 1500) continue;
      if (event.name.startsWith('/')) void track(event.name).then((b) => b && start(b, 0, MASTER * event.volume * (state.avatar.speaking ? DUCK : 1)));
      else {
        // 独立音效也复用现有家族文件；尊重车道给出的音量。
        const list = buffers?.[event.name as Family];
        if (list?.length) start(list[0]!, 0, MASTER * event.volume * (state.avatar.speaking ? DUCK : 1));
      }
    }
  }, [state?.rev]);
  const seen = useRef<{ born: Map<string, number>; fx: Map<string, number>; page: number; zoom: string | null; danmaku: string | undefined; alert: string | undefined; count: number; vfx: string | undefined } | null>(null);
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!state) return;
    const d = state.draw;
    const speaking = state.avatar.speaking;
    const last = state.danmaku.at(-1)?.id;
    const alert = state.alerts.at(-1)?.id;
    const prev = seen.current;
    const vfx = state.vfx.at(-1);
    seen.current = {
      born: new Map(d.items.map((x) => [x.id, x.born])), fx: new Map(d.items.map((x) => [x.id, x.fx?.at ?? 0])),
      page: d.page, zoom: d.zoom, danmaku: last, alert, count: d.items.length, vfx: vfx?.id,
    };
    if (currentSet !== state.set) {
      currentSet = state.set;
      if (!state.sound?.bed) switchBed(state.set);
    }
    // 第一次挂上（刷新页面）不补放之前的声音
    if (!prev) return;
    if (d.page !== prev.page || (prev.count && !d.items.length)) play(d.pageKind === 'wipe' ? 'swell' : 'whoosh', 0, speaking);
    if (d.zoom !== prev.zoom) play('swell', 0, speaking);
    for (const x of d.items) {
      if (prev.born.get(x.id) !== x.born) {
        const s = x.kind === 'link' ? (['whoosh', 0] as [Family, number]) : ENTER_SOUND[x.enter];
        if (s) play(s[0], s[1], speaking);
      } else if (x.fx && prev.fx.get(x.id) !== x.fx.at) {
        const s = FX_SOUND[x.fx.kind];
        if (s) play(s[0], s[1], speaking);
      }
    }
    if (last && last !== prev.danmaku) play('drip', 0, speaking);
    if (alert && alert !== prev.alert) play('notify', 0, speaking);
    // 布景特效：配套的声音，落点对齐画面
    if (vfx && vfx.id !== prev.vfx) {
      const fx = SETS[state.set]?.effects[vfx.name];  // 基础效果（prim:）没有配声音
      if (fx?.sound) playEffect(state.set, fx.sound.files, fx.sound.at ?? 0, fx.sound.volume ?? 0.7, speaking);
    }
  }, [state?.rev]);
}
