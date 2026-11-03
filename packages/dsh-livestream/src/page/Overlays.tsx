/**
 * 叠层上的挂件：口播字幕、弹幕框、礼物（含醒目留言、上船）、任务角、开播角标。
 */

import { useLayoutEffect, useRef } from 'react';
import { playedMs } from './mouth';
import type { Alert, Platform, StageState, TaskKind } from '../stage/protocol';

const PLATFORM: Record<Platform, string> = { douyin: '抖', bilibili: 'B', tiktok: 'T', owner: '主', sim: '测' };
const TASK: Record<TaskKind, string> = { generate: '生成', export: '导出', render: '渲染', sandbox: '工位' };

/** 字幕：整句都在，念到哪亮到哪 */
/** 语音还在加载时字幕先等着；等这么久还没出声（被浏览器拦了之类）就按服务端时间走 */
const AUDIO_WAIT_MS = 1_500;
/** 揭晓、兴奋的短句跳到画面中间砸出来；长句还在底下，只是带点劲 */
const PUNCH_MAX = 24;
/** 字幕一页最多几个字：长段落按句翻页，只挂正在念的那句（最多两行） */
const PAGE_SOFT = 22;
const PAGE_HARD = 34;

/** 把一段话切成字幕页：句号问号处必切；够长了在逗号处切；再长就硬切。返回每页的 [起, 止) */
export function pages(chars: string[]): [number, number][] {
  const out: [number, number][] = [];
  let from = 0;
  for (let i = 0; i < chars.length; i++) {
    const len = i + 1 - from;
    const c = chars[i]!;
    const end = /[。！？!?；;…]/.test(c) && !/[。！？!?…」”）)]/.test(chars[i + 1] ?? '');
    const soft = len >= PAGE_SOFT && /[，,、：:]/.test(c);
    if (end || soft || len >= PAGE_HARD) {
      out.push([from, i + 1]);
      from = i + 1;
    }
  }
  if (from < chars.length) out.push([from, chars.length]);
  // 太短的尾巴并回上一页（别单挂一两个字）
  if (out.length > 1 && out[out.length - 1]![1] - out[out.length - 1]![0] <= 3) {
    const tail = out.pop()!;
    out[out.length - 1]![1] = tail[1];
  }
  return out;
}
/** 重音里的数字从 0 滚到它，滚多久（毫秒） */
const COUNT_MS = 700;

/** 重音里的第一个数字滚到 p（0–1）时显示成什么：小数位、千分位照原样 */
function rolling(text: string, p: number): string {
  return text.replace(/\d[\d,]*(\.\d+)?/, (m) => {
    const decimals = m.split('.')[1]?.length ?? 0;
    const value = Number(m.replace(/,/g, '')) * p;
    const fixed = value.toFixed(decimals);
    return m.includes(',') ? Number(fixed).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : fixed;
  });
}

/**
 * 口播字幕：同一时刻只有这一条。她只标语气（tone）和重音（*词*），怎么演由这里定：
 * 逐字跟着发音点亮；念到重音那个词时它放大变色、划一道（里面有数字就滚上去）；
 * 揭晓、兴奋的短句跳到画面中间一个字一个字砸出来；小声嘀咕变小变暗；提问的问号跳一下；引用加引号。
 */
export function Subtitle({ state, now }: { state: StageState; now: number }) {
  const sub = state.subtitle;
  if (!sub) return null;
  const chars = [...sub.text];
  // 声音在放就跟着声音走；还在加载、没接语音时按服务端时间
  const t = playedMs(sub.id) ?? (sub.audio && now - sub.startedAt < AUDIO_WAIT_MS ? 0 : now - sub.startedAt);
  const at = (i: number) => sub.starts?.[i] ?? (i / Math.max(1, chars.length)) * sub.ms;
  let lit = 0;
  while (lit < chars.length && at(lit) <= t) lit++;
  const tone = sub.tone ?? 'plain';
  const punch = (tone === 'reveal' || tone === 'excited') && chars.length <= PUNCH_MAX;
  // 只挂正在念的那一页；揭晓的短句整句砸，不翻页
  const all = punch ? [[0, chars.length] as [number, number]] : pages(chars);
  const page = all.find(([, to]) => Math.max(0, lit - 1) < to) ?? all[all.length - 1]!;
  const [first, last] = page;
  const accents = (sub.accents ?? []).filter((a) => a.to > first && a.from < last).map((a) => ({ from: Math.max(first, a.from), to: Math.min(last, a.to) }));
  const pieces: JSX.Element[] = [];
  for (let i = first; i < last;) {
    const accent = accents.find((a) => a.from === i);
    if (accent) {
      const on = lit > accent.from;
      const word = chars.slice(accent.from, accent.to).join('');
      const shown = on && /\d/.test(word) ? rolling(word, Math.min(1, (t - at(accent.from)) / COUNT_MS)) : word;
      pieces.push(<em key={i} className={`accent ${on ? 'on' : ''} ${punch && !on ? 'ghost' : ''}`}>{shown}</em>);
      i = accent.to;
      continue;
    }
    const next = accents.find((a) => a.from > i)?.from ?? last;
    if (punch) {
      // 一个字一个字砸：点亮的字各自带一次落下的动画，没念到的先占着位置不显示
      for (let j = i; j < next; j++) pieces.push(<span key={j} className={j < lit ? 'lit slam' : 'ghost'}>{chars[j]}</span>);
    } else {
      const end = Math.max(i, Math.min(next, lit));
      if (end > i) pieces.push(<span key={`${i}l`} className="lit">{chars.slice(i, end).join('')}</span>);
      const rest = chars.slice(end, next);
      // 提问：最后那个问号念到了就跳一下
      if (end < next) pieces.push(<span key={`${i}r`}>{rest.join('')}</span>);
    }
    i = next;
  }
  const asked = tone === 'question' && lit >= chars.length && /[?？]$/.test(sub.text);
  return (
    <div className={`subtitle tone-${tone} ${punch ? 'punch' : ''} ${asked ? 'asked' : ''}`} key={`${sub.id}-${first}`}>
      {pieces}
    </div>
  );
}

/** 礼物、关注这些事件前面的小图标 */
const FEED_ICON = { gift: '🎁', follow: '＋', fanclub: '♥', share: '↗' } as const;
/** 欢迎条只挂最近 20 秒进来的人 */
const WELCOME_MS = 20_000;

/**
 * 右栏信息流：各平台的弹幕、礼物、关注、加粉丝团、分享混在一起按时间往上滚；
 * 进场单独一行欢迎条（进场太多，放进信息流会把弹幕刷没）。
 */
export function Danmaku({ state, now }: { state: StageState; now: number }) {
  const lines = state.danmaku.slice(-9);
  const list = useRef<HTMLDivElement>(null);
  const lineIds = lines.map((line) => line.id).join(':');
  useLayoutEffect(() => {
    const root = list.current;
    if (!root) return;
    // Keep whole cards at the bottom. Hidden older cards still participate in
    // layout, so resizing can reveal them again without re-entering animations.
    const cards = Array.from(root.querySelectorAll<HTMLElement>('.dm-line'));
    const fit = () => {
      const padding = getComputedStyle(root);
      const top = parseFloat(padding.paddingTop) || 0;
      const bottom = root.clientHeight - (parseFloat(padding.paddingBottom) || 0);
      for (const card of cards) {
        card.style.visibility = card.offsetTop >= top - 1 && card.offsetTop + card.offsetHeight <= bottom + 1 ? 'visible' : 'hidden';
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(root);
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [lineIds]);
  const fresh = (state.entering ?? []).filter((x) => now - x.at < WELCOME_MS).slice(-3);
  return (
    <div className="danmaku">
      {fresh.length > 0 && (
        <div className="dm-welcome" key={fresh[fresh.length - 1]!.id}>
          <span>欢迎</span>
          {fresh.map((x) => <b key={x.id} className={x.platform}>{x.user}</b>)}
          <span>进入直播间</span>
        </div>
      )}
      <div className="dm-list" ref={list}>
        {lines.map((d) => (
          <div key={d.id} className={`dm-line ${d.platform} ${d.kind ? `ev ev-${d.kind}` : ''} ${d.tier ? `tier-${d.tier}` : ''} ${state.picked === d.id ? 'picked' : ''}`}>
            <b className="dm-pf">{PLATFORM[d.platform]}</b>
            <span className="dm-user">{d.user}</span>
            <span className="dm-text">{d.kind && d.kind !== 'chat' && <i className="dm-icon">{FEED_ICON[d.kind]}</i>}{d.text}</span>
          </div>
        ))}
        {!lines.length && (
          <div className="dm-empty">
            <b>还没有弹幕</b>
            <span>发一条，她会看到</span>
          </div>
        )}
      </div>
    </div>
  );
}

function AlertCard({ alert, now }: { alert: Alert; now: number }) {
  const leaving = alert.at + alert.ms - now < 400;
  if (alert.kind === 'superchat') {
    return (
      <div className={`alert sc ${leaving ? 'leaving' : ''}`}>
        <div className="sc-head">
          <b>{alert.user}</b>
          {alert.value && <span>{alert.value}</span>}
        </div>
        <div className="sc-text">{alert.text}</div>
      </div>
    );
  }
  return (
    <div className={`alert ${alert.kind} ${alert.tier ? `tier-${alert.tier}` : ''} ${leaving ? 'leaving' : ''}`}>
      <i className="alert-icon">{alert.kind === 'guard' ? '⚓' : '✦'}</i>
      <b>{alert.user}</b>
      <span>{alert.text}</span>
      {alert.value && <em>{alert.value}</em>}
    </div>
  );
}

/** 千元大礼：全屏庆祝一下（名字、礼物大字，光圈散开），前几秒最显眼 */
export function Celebration({ state, now }: { state: StageState; now: number }) {
  const big = [...state.alerts].reverse().find((a) => a.tier === 5 && now - a.at < 6_000);
  if (!big) return null;
  return (
    <div className="celebration" key={big.id}>
      <div className="celebration-ring" />
      <div className="celebration-card">
        <b>{big.user}</b>
        <span>{big.text}{big.value ? ` ${big.value}` : ''}</span>
      </div>
    </div>
  );
}

/** 表情包在头边待多久（跟 reducer 一致） */
const EMOTE_SHOW_MS = 2_400;

/**
 * 表情包：冒在她头的右上方，按动效演一下就散。几种动效会多撒几个小的（笑出来的、飘起来的爱心、往下滴的泪）
 */
export function Emotes({ state, now }: { state: StageState; now: number }) {
  const avatar = state.canvas.avatar;
  const live = (state.emotes ?? []).filter((e) => now - e.at < EMOTE_SHOW_MS);
  if (!avatar.visible || !live.length) return null;
  const e = live[live.length - 1]!;
  const size = Math.max(90, Math.min(200, avatar.w * 0.3));
  const scatter = e.anim === 'burst' || e.anim === 'float' || e.anim === 'drip' || e.anim === 'sparkle';
  return (
    // 冒在头的右上方：模型的头顶在人物框往下约 29% 处（杂谈、展示两种摆法实测一致）；不出画面
    <div className="emote-host" style={{ left: Math.min(1920 - size - 20, avatar.x + avatar.w * 0.66), top: Math.max(20, avatar.y + avatar.h * 0.29 - size * 0.7), fontSize: size }} key={e.id}>
      <span className={`emote emote-${e.anim}`}>{e.emoji}</span>
      {scatter && [0, 1, 2, 3, 4].map((i) => (
        <span key={i} className={`emote-bit emote-bit-${e.anim}`} style={{ ['--i' as string]: i }}>{e.emoji}</span>
      ))}
    </div>
  );
}

export function Alerts({ state, now }: { state: StageState; now: number }) {
  return (
    <div className="alerts">
      {state.alerts.map((a) => <AlertCard key={a.id} alert={a} now={now} />)}
    </div>
  );
}

export function Tasks({ state }: { state: StageState }) {
  if (!state.tasks.length) return null;
  return (
    <div className="tasks">
      {state.tasks.map((t) => (
        <div key={t.id} className={`task ${t.status}`}>
          <span className="task-kind">{TASK[t.kind]}</span>
          <span className="task-title">{t.title}</span>
          <span className="task-state">{t.status === 'running' ? `${Math.round(t.progress * 100)}%` : t.status === 'done' ? '完成' : '失败'}</span>
          <div className="task-bar"><i style={{ width: `${Math.round(t.progress * 100)}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

/** 节目单：讲到哪一步。讲过的打勾，当前这步鲸蓝底 */
/** 她在查资料：右上角一个小气泡（查什么、在读哪个网站），不打断她正在讲的 */
export function Searching({ state }: { state: StageState }) {
  const r = state.research;
  if (!r) return null;
  return (
    <div className="searching">
      <i className="searching-lens" />
      <span>正在查：{r.query ?? '资料'}</span>
      {r.reading && <small>在读 {r.reading}</small>}
    </div>
  );
}

export function Rundown({ state }: { state: StageState }) {
  const r = state.rundown;
  if (!r) return null;
  const count = state.scene === 'watch' ? 1 : 3;
  const start = Math.max(0, Math.min(r.at - (count === 1 ? 0 : 1), r.steps.length - count));
  return (
    <div className="rundown">
      <div className="rd-title"><span className="rd-label">{r.title}</span>{r.steps.length > count && <small>{Math.min(r.at + 1, r.steps.length)}/{r.steps.length}</small>}{r.paused && <em>暂停</em>}</div>
      <ol>
        {r.steps.slice(start, start + count).map((step, offset) => {
          const i = start + offset;
          return (
          <li key={i} className={i < r.at ? 'done' : i === r.at ? 'now' : ''}>
            <i>{i < r.at ? '✓' : i + 1}</i>
            <span>{step}</span>
          </li>
          );
        })}
      </ol>
    </div>
  );
}

const VIEWER_NAMES: Record<string, string> = { douyin: '抖音', bilibili: 'B站', tiktok: 'TikTok' };

export function OnAir({ now, viewers, away }: { now: number; viewers?: Partial<Record<string, number>>; away?: boolean }) {
  const d = new Date(now);
  const counts = Object.entries(viewers ?? {}).filter(([, n]) => typeof n === 'number');
  return (
    <div className="onair">
      {away ? <b className="away"><i />大肥鱼马上回来</b> : <b><i />直播中</b>}
      {counts.map(([p, n]) => <span key={p}>{counts.length > 1 ? `${VIEWER_NAMES[p] ?? p} ` : ''}{n} 人在看</span>)}
      <span>{String(d.getHours()).padStart(2, '0')}:{String(d.getMinutes()).padStart(2, '0')}</span>
    </div>
  );
}
