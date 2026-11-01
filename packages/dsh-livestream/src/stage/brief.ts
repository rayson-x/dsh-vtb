/**
 * 给 Agent 的薄情报：舞台现在大概什么样。
 *
 * 只说她做决定用得上的：场景、能不能切、画面上有什么组件和包装、画布怎么摆。
 * 剪辑那一套（工位模式、片子、旗、选区）先不进直播：只有工位上真有片子时才提。
 * 不给整包状态，不给地址，不给弹幕原文（弹幕由 Show 挑过再推给她）。
 */

import { canvasLine } from './canvas';
import { SETS } from './sets';
import { CUT_GAP_MS, SCENE_NAMES, clock, playhead, type StageState } from './protocol';

const pct = (p: number) => `${Math.round(p * 100)}%`;

export function brief(s: StageState, now: number): string {
  const lines: string[] = [];
  const cutWait = Math.max(0, s.lastCutAt + CUT_GAP_MS.agent - now);
  const cut = s.locked ? '主人锁了镜头' : s.transition ? '正在转场' : cutWait > 0 ? `${Math.ceil(cutWait / 1000)} 秒后能切` : '能切';
  lines.push(`场景：${SCENE_NAMES[s.scene]}（${cut}）${s.status ? `  状态牌：${s.status}` : ''}`);

  if (s.clip) {
    const c = s.clip;
    lines.push(`片子：《${c.title}》 ${clock(playhead(c, now))} / ${clock(c.durationSec)} ${c.playing ? '播放中' : '暂停'}`);
    if (s.view) lines.push(`时间轴窗口：${clock(s.view.from)}–${clock(s.view.to)}`);
    if (s.marks.length) lines.push(`旗：${s.marks.map((m) => `${m.label} ${clock(m.at)}（${m.id}）`).join('、')}`);
    if (s.selection) lines.push(`选区：${clock(s.selection.from)}–${clock(s.selection.to)}${s.selection.label ? ` ${s.selection.label}` : ''}`);
    if (s.splits.length) lines.push(`切点：${s.splits.map(clock).join('、')}`);
    if (s.focus) lines.push(`正在细看：${s.focus.region}${s.focus.label ? ` ${s.focus.label}` : ''}`);
    if (s.fx.length) lines.push(`特效块：${s.fx.map((b) => `${b.name} ${clock(b.from)}–${clock(b.to)} ${b.status}（${b.id}）`).join('、')}`);
  }
  if (s.rundown) {
    const r = s.rundown;
    const where = r.at < 0 ? '还没开始' : r.at >= r.steps.length ? '全部讲完' : `第 ${r.at + 1}/${r.steps.length} 步「${r.steps[r.at]}」`;
    lines.push(`节目单：${r.title} ${where}${r.paused ? '（主人让先停）' : ''}`);
  }
  for (const p of s.panels) {
    const v = p.visual;
    const votes = v.kind === 'poll' ? `；票数 ${v.options.map((o, i) => `${o} ${p.votes[i]}`).join('、')}` : '';
    const scene = v.kind === 'scene' ? `；参数 ${JSON.stringify(p.params ?? {})}${v.controls ? `；可调：${v.controls}` : ''}` : '';
    lines.push(`组件：${v.id}（${v.kind}）在 ${p.region}${p.revealed ? ' 已揭晓' : ''}${votes}${scene}`);
  }
  if (s.code) lines.push(`代码条：${s.code.title}（${s.code.lines.length} 行）`);
  if (s.tasks.length) {
    lines.push(`任务：${s.tasks.map((t) => `${t.title} ${t.status === 'running' ? `进行中 ${pct(t.progress)}` : t.status === 'done' ? '完成' : '失败'}（${t.id}）`).join('、')}`);
  }
  if (s.broll) lines.push(`B-roll：${s.broll.title}`);
  const graphics = s.graphics.filter((g) => g.until > now);
  if (graphics.length) lines.push(`包装：${graphics.map((g) => `${g.name}@${g.slot} 还剩 ${Math.ceil((g.until - now) / 1000)} 秒（${g.id}）`).join('、')}`);
  if (s.draw.items.length) {
    const shown = s.draw.items.filter((x) => x.kind !== 'link').map((x) => `${x.id}(${x.kind}${x.text ? `「${x.text.slice(0, 10)}」` : x.rows ? `「${x.rows.map((r) => r.label).join('/').slice(0, 14)}」` : ''}${x.dim ? '，退后了' : ''})`);
    if (s.draw.evicted?.length) lines.push(`刚才画新东西时挤掉了：${s.draw.evicted.join('、')}（同类只留一个、或者地方不够）`);
    lines.push(`画布第 ${s.draw.page + 1} 页：${shown.join('、')}${s.draw.zoom ? `；镜头推在 ${s.draw.zoom}` : ''}`);
    // 海龟汤：没答的问题给她看，好一个个回
    for (const x of s.draw.items) if (x.kind === 'soup') {
      const waiting = (x.asks ?? []).filter((q) => !q.a).slice(0, 5);
      if (waiting.length) lines.push(`海龟汤 ${x.id} 等你回答（[[ans ${x.id} 是/不是/不重要]] 答最早那个）：${waiting.map((q) => `「${q.q}」`).join(' ')}`);
    }
  }
  {
    const set = SETS[s.set];
    if (set) lines.push(`布景：${set.name}；能用的特效：${Object.entries(set.effects).map(([k, e]) => `${k} ${e.zh}`).join('、')}`);
  }
  lines.push(`版面（摆法 ${s.layout}，你看向 ${s.avatar.look}）：${canvasLine(s.canvas)}`);
  return lines.join('\n');
}
