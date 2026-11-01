/**
 * 画布上每种元素长什么样：小书房的配色（奶油底、深海军蓝描边、DeepSeek 蓝和珊瑚粉点缀）。
 * 出场动效在 CSS（enter-*），这里只管打字、数字滚动这种要按时间算的。
 */

import type { Box } from './Canvas';
import { TIERS, type Item } from '../../stage/draw/model';

const TYPE_MS = 55;
const COUNT_MS = 1100;

const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/** 「73%」「1,951」「3.5 亿」→ 能滚的数字和前后缀 */
function numeric(s: string): { pre: string; n: number; post: string; digits: number } | undefined {
  const m = /^(.*?)(-?\d[\d,]*(?:\.\d+)?)(.*)$/.exec(s);
  if (!m) return undefined;
  const raw = m[2]!.replace(/,/g, '');
  return { pre: m[1]!, n: Number(raw), post: m[3]!, digits: raw.includes('.') ? raw.split('.')[1]!.length : 0 };
}

/** 数字从 prev 滚到 text（刚出场时从 0 滚） */
function Rolling({ item, now }: { item: Item; now: number }) {
  const to = numeric(item.text);
  if (!to) return <>{item.text}</>;
  const from = item.fx?.kind === 'count' && item.prev ? numeric(item.prev)?.n ?? 0 : 0;
  const start = item.fx?.kind === 'count' ? item.fx.at : item.born;
  const t = ease((now - start) / COUNT_MS);
  const v = from + (to.n - from) * t;
  const shown = v.toLocaleString('zh-CN', { minimumFractionDigits: to.digits, maximumFractionDigits: to.digits });
  return <>{to.pre}{shown}{to.post}</>;
}

/** 打字出场：一个字一个字出来，带光标 */
function Typed({ text, born, now }: { text: string; born: number; now: number }) {
  const chars = [...text];
  const n = Math.min(chars.length, Math.floor((now - born) / TYPE_MS));
  return (
    <>
      {chars.slice(0, n).join('')}
      {n < chars.length && <i className="draw-caret" />}
    </>
  );
}

/** 换字：旧的往上滑走，新的从下面上来 */
function Swapped({ item, children }: { item: Item; children: React.ReactNode }) {
  if (item.fx?.kind !== 'swap' || !item.prev) return <>{children}</>;
  return (
    <span className="draw-swap" key={item.fx.at}>
      <span className="draw-swap-old">{item.prev}</span>
      <span className="draw-swap-new">{children}</span>
    </span>
  );
}

/** 乱码解码：先滚乱码，从左到右一个个锁定成真字 */
const GLYPHS = '鲸海蓝光#%&@$?01量子回声';
function Decoded({ text, born, now }: { text: string; born: number; now: number }) {
  const chars = [...text];
  const t = now - born;
  const locked = Math.floor((t - 200) / 70);
  return (
    <>
      {chars.map((c, i) => (i < locked ? c : <span key={i} className="draw-glyph">{GLYPHS[(i * 7 + Math.floor(t / 60)) % GLYPHS.length]}</span>))}
    </>
  );
}

/** 逐词浮上来：按标点和空格切成小段，一段段从下面浮起 */
function Words({ text }: { text: string }) {
  const parts = text.split(/(?<=[，。、！？；,.!?\s])/).filter(Boolean);
  return <>{parts.map((w, i) => <span key={i} className="draw-word" style={{ animationDelay: `${i * 160}ms` }}>{w}</span>)}</>;
}

function Text({ item, now }: { item: Item; now: number }) {
  const body = item.enter === 'type' ? <Typed text={item.text} born={item.born} now={now} />
    : item.enter === 'decode' ? <Decoded text={item.text} born={item.born} now={now} />
    : item.enter === 'words' ? <Words text={item.text} />
    : item.text;
  return (
    <div className={`draw-text size-${item.size ?? 'm'}`}>
      <span className="draw-ink"><Swapped item={item}>{body}</Swapped></span>
      {item.note && <small>{item.note}</small>}
    </div>
  );
}

function Bars({ item, box }: { item: Item; box: Box }) {
  const rows = item.rows ?? [];
  const max = Math.max(...rows.map((r) => r.value ?? 0), 1);
  const plotH = box.h - 96;
  const slot = (box.w - 40) / rows.length;
  return (
    <div className="draw-chart">
      <div className="draw-bars" style={{ height: plotH }}>
        {rows.map((r, i) => (
          <div key={r.label} className="draw-bar" style={{ width: Math.min(110, slot * 0.62), ['--h' as string]: `${((r.value ?? 0) / max) * 82}%`, animationDelay: `${i * 160}ms` }}>
            <b>{r.value}{item.text}</b>
          </div>
        ))}
      </div>
      <div className="draw-bar-labels">{rows.map((r) => <span key={r.label} style={{ width: slot }}>{r.label}</span>)}</div>
      {item.note && <cite>{item.note}</cite>}
    </div>
  );
}

function Line({ item, box }: { item: Item; box: Box }) {
  const rows = item.rows ?? [];
  const vals = rows.map((r) => r.value ?? 0);
  const lo = Math.min(...vals, 0);
  const hi = Math.max(...vals, 1);
  const w = box.w - 60;
  const h = box.h - 110;
  // 顶上留 44px 给数值标签，别被裁掉
  const pts = vals.map((v, i) => ({ x: 30 + (rows.length > 1 ? (i / (rows.length - 1)) * w : w / 2), y: 44 + (h - 24) - ((v - lo) / (hi - lo || 1)) * (h - 24) }));
  return (
    <div className="draw-chart">
      <svg width={box.w} height={h + 40} className="draw-line">
        <path d={pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ')} pathLength={1} />
        {pts.map((p, i) => (
          <g key={i} style={{ animationDelay: `${300 + i * 180}ms` }} className="draw-dot">
            <circle cx={p.x} cy={p.y} r={9} />
            <text x={p.x} y={p.y - 18} textAnchor="middle">{vals[i]}{item.text}</text>
          </g>
        ))}
      </svg>
      <div className="draw-bar-labels">{rows.map((r) => <span key={r.label} style={{ width: (box.w - 20) / rows.length }}>{r.label}</span>)}</div>
      {item.note && <cite>{item.note}</cite>}
    </div>
  );
}

function Ratio({ item, box }: { item: Item; box: Box }) {
  const [lit, total] = item.text.split('/').map(Number) as [number, number];
  const n = Math.min(total, 100);
  const cols = n <= 10 ? n : Math.ceil(Math.sqrt(n * 2));
  const size = Math.min(56, (box.w - 20) / cols - 6);
  return (
    <div className="draw-ratio">
      <div className="draw-people" style={{ gridTemplateColumns: `repeat(${cols}, ${size}px)` }}>
        {Array.from({ length: n }, (_, i) => (
          <svg key={i} viewBox="0 0 20 24" width={size} height={size * 1.2} className={i < lit ? 'on' : ''} style={{ animationDelay: `${i * Math.max(12, 600 / n)}ms` }}>
            <circle cx="10" cy="6" r="5" />
            <path d="M2 23 C2 14 18 14 18 23 Z" />
          </svg>
        ))}
      </div>
      <p><b>{lit}</b> / {total}{item.note ? `　${item.note}` : ''}</p>
    </div>
  );
}

/** 环里的字最大多大才不压到环：内径按字数分（布景换了宽字体也不出圈），CSS 取它和原字号里小的 */
const fitRing = (inner: number, text: string) => ({ ['--fit' as string]: `${Math.floor((inner * 2 * 0.86) / Math.max(1.6, [...text].length * 0.62))}px` });

function Ring({ item, box }: { item: Item; box: Box }) {
  const pct = Math.max(0, Math.min(100, Number(item.text)));
  const r = Math.min(box.w, box.h - 40) / 2 - 16;
  return (
    <div className="draw-ring">
      <svg width={r * 2 + 24} height={r * 2 + 24}>
        <circle className="track" cx={r + 12} cy={r + 12} r={r} />
        <circle className="fill" cx={r + 12} cy={r + 12} r={r} pathLength={100} style={{ ['--pct' as string]: pct }} />
        <text x={r + 12} y={r + 22} textAnchor="middle" style={fitRing(r - 11, `${pct}%`)}>{pct}%</text>
      </svg>
      {item.note && <p>{item.note}</p>}
    </div>
  );
}

/** 投票：横条按票数长，揭晓后最高票戴上皇冠 */
function Poll({ item }: { item: Item }) {
  const rows = item.rows ?? [];
  const votes = rows.map((r) => item.votes?.[r.label] ?? 0);
  const total = votes.reduce((a, b) => a + b, 0);
  const top = Math.max(...votes);
  return (
    <div className="draw-poll">
      <h3>{item.text}</h3>
      {rows.map((r, i) => {
        const pct = total ? Math.round((votes[i]! / total) * 100) : 0;
        return (
          <div key={r.label} className={`poll-row ${item.result && (item.answer !== undefined ? item.answer === i + 1 : votes[i] === top && top > 0) ? 'win' : ''}`}>
            <b>{i + 1}</b>
            <div className="poll-bar"><i style={{ width: `${pct}%` }} /><span>{r.label}</span></div>
            <em>{votes[i]} 票{total ? ` · ${pct}%` : ''}</em>
          </div>
        );
      })}
      <p className="draw-hint">{item.open ? `发 ${rows.map((_, i) => i + 1).join(' / ')} 投票` : `共 ${total} 票`}</p>
    </div>
  );
}

/** 夯到拉：五档横条，放好的东西是贴纸；正在评的那样东西挂在顶上，每档旁边是观众的票 */
function Tier({ item }: { item: Item }) {
  const total = Object.values(item.votes ?? {}).reduce((a, b) => a + b, 0);
  return (
    <div className="draw-tier">
      <h3>{item.text}{item.judging && <span className="tier-judging">正在评：<b key={item.judging}>{item.judging}</b>{item.open && <small>　发「夯」「顶级」「人上人」「NPC」「拉完了」</small>}</span>}</h3>
      {TIERS.map((t) => {
        const n = item.votes?.[t] ?? 0;
        return (
          <div key={t} className="tier-row">
            <b>{t}</b>
            <div className="tier-items">
              {(item.placed ?? []).filter((p) => p.tier === t).map((p) => <span key={p.label} className="tier-chip">{p.label}</span>)}
            </div>
            {item.judging && <em className="tier-votes" style={{ ['--w' as string]: total ? `${(n / total) * 100}%` : '0%' }}><i /><span>{n} 票</span></em>}
          </div>
        );
      })}
    </div>
  );
}

/** 打分：大大的平均分，下面 1–10 分的分布 */
function Score({ item }: { item: Item }) {
  const vs = (item.values ?? []).map((x) => x.v);
  const avg = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : 0;
  const bins = Array.from({ length: 10 }, (_, i) => vs.filter((v) => v === i + 1).length);
  const max = Math.max(...bins, 1);
  return (
    <div className="draw-score">
      <h3>{item.text}</h3>
      <b className={item.result ? 'final' : ''}>{vs.length ? avg.toFixed(1) : '–'}<small> 分</small></b>
      <div className="score-bins">{bins.map((n, i) => <i key={i} style={{ height: `${(n / max) * 100}%` }} title={`${i + 1}`} />)}</div>
      <div className="score-axis">{bins.map((_, i) => <span key={i}>{i + 1}</span>)}</div>
      <p className="draw-hint">{item.open ? `发 1–10 打分 · 已有 ${vs.length} 人` : `${vs.length} 人打分`}</p>
    </div>
  );
}

/** 猜数字：全场猜的数落成一排排点，揭晓时一根线落在真答案上，报猜得最近的人 */
function Guess({ item, box }: { item: Item; box: Box }) {
  const vs = item.values ?? [];
  const nums = vs.map((x) => x.v);
  const shown = item.result && item.answer !== undefined ? [...nums, item.answer] : nums;
  const lo = shown.length ? Math.min(...shown) : 0;
  const hi = shown.length ? Math.max(...shown) : 1;
  const span = hi - lo || 1;
  const bins = 24;
  const counts = Array.from({ length: bins }, () => 0);
  for (const v of nums) counts[Math.min(bins - 1, Math.floor(((v - lo) / span) * bins))]!++;
  const max = Math.max(...counts, 1);
  const sorted = [...nums].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : undefined;
  const closest = item.result && item.answer !== undefined ? [...vs].sort((a, b) => Math.abs(a.v - item.answer!) - Math.abs(b.v - item.answer!)).slice(0, 3) : [];
  const x = (v: number) => `${((v - lo) / span) * 100}%`;
  return (
    <div className="draw-guess">
      <h3>{item.text}</h3>
      <div className="guess-plot" style={{ height: Math.max(80, box.h - 190) }}>
        {counts.map((n, i) => <i key={i} style={{ left: `${(i / bins) * 100}%`, width: `${100 / bins}%`, height: `${(n / max) * 100}%` }} />)}
        {median !== undefined && <span className="guess-median" style={{ left: x(median) }}>大家猜 {median}</span>}
        {item.result && item.answer !== undefined && <span className="guess-answer" style={{ left: x(item.answer) }}>答案 {item.answer}</span>}
      </div>
      <p className="draw-hint">
        {item.result ? (closest.length ? `最接近：${closest.map((c) => `${c.who.split(':').slice(1).join(':')}（${c.v}）`).join('、')}` : '没人猜') : `直接发一个数 · 已有 ${vs.length} 人猜`}
      </p>
    </div>
  );
}

/** 线索：钉在板上的便签，红图钉；翻过来是真相 */
function Clue({ item }: { item: Item }) {
  return (
    <div className={`draw-clue ${item.flipped ? 'flipped' : ''}`}>
      <i className="clue-pin" />
      <div className="face front"><b>{item.text}</b></div>
      <div className="face back"><small>真相</small>{item.note ?? ''}</div>
    </div>
  );
}

/** 倒计时：环从满倒数到空，最后三秒变红、抖 */
function Timer({ item, box, now }: { item: Item; box: Box; now: number }) {
  const total = Number(item.text) * 1000;
  const left = Math.max(0, total - (now - item.born));
  const sec = Math.ceil(left / 1000);
  const r = Math.min(box.w, box.h - (item.note ? 34 : 0)) / 2 - 14;
  const pct = left / total;
  return (
    <div className={`draw-timer ${sec <= 3 ? 'hurry' : ''} ${left === 0 ? 'done' : ''}`}>
      <svg width={r * 2 + 20} height={r * 2 + 20}>
        <circle className="track" cx={r + 10} cy={r + 10} r={r} />
        <circle className="left" cx={r + 10} cy={r + 10} r={r} pathLength={100} style={{ strokeDashoffset: 100 - pct * 100 }} />
        <text x={r + 10} y={r + 22} textAnchor="middle" style={fitRing(r - 8, left === 0 ? '到!' : String(sec))}>{left === 0 ? '到!' : sec}</text>
      </svg>
      {item.note && <p>{item.note}</p>}
    </div>
  );
}

/** 弹幕上墙：一个大对话气泡，原话放大，下面是谁说的 */
function Wall({ item }: { item: Item }) {
  const pf = item.rows?.[0]?.label;
  return (
    <div className="draw-wall">
      <q>{item.text}</q>
      <cite><b className={`wall-pf ${pf ?? ''}`}>{pf === 'douyin' ? '抖' : pf === 'bilibili' ? 'B' : pf === 'tiktok' ? 'T' : '弹'}</b>{item.note}</cite>
    </div>
  );
}

/** 横向时间线：一条轴，节点依次点亮，时间在上、事件在下 */
function Timeline({ item }: { item: Item }) {
  const rows = item.rows ?? [];
  return (
    <div className="draw-timeline">
      <i className="tl-axis" />
      {rows.map((r, i) => (
        <div key={i} className="tl-node" style={{ animationDelay: `${300 + i * 380}ms` }}>
          <b>{r.label}</b>
          <i className="tl-dot" />
          <span>{r.note}</span>
        </div>
      ))}
    </div>
  );
}

/** 流程链：方块加箭头，从左到右依次出来 */
function Flow({ item }: { item: Item }) {
  const rows = item.rows ?? [];
  return (
    <div className="draw-flow">
      {rows.map((r, i) => (
        <div key={i} className="flow-step" style={{ animationDelay: `${i * 300}ms` }}>
          {i > 0 && <i className="flow-arrow" />}
          <b>{r.label}</b>
        </div>
      ))}
    </div>
  );
}

/** 排名条：按数值从大到小排，数值变了条子滑到新名次 */
function Race({ item }: { item: Item }) {
  const rows = item.rows ?? [];
  const max = Math.max(...rows.map((r) => r.value ?? 0), 1);
  const order = [...rows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).map((r) => r.label);
  const H = 100 / Math.max(rows.length, 1);
  return (
    <div className="draw-race">
      {rows.map((r) => {
        const rank = order.indexOf(r.label);
        return (
          <div key={r.label} className={`race-row ${rank === 0 ? 'top' : ''}`} style={{ top: `${rank * H}%`, height: `${H}%` }}>
            <span>{r.label}</span>
            <div><i style={{ width: `${((r.value ?? 0) / max) * 100}%` }} /><b>{r.value}{item.text}</b></div>
          </div>
        );
      })}
    </div>
  );
}

/** 海龟汤：汤面在上；问题按回答分三栏，没答的在最下面排队；翻过来是汤底 */
function Soup({ item }: { item: Item }) {
  const asks = item.asks ?? [];
  const col = (a: string) => asks.filter((x) => x.a === a).slice(-6);
  const waiting = asks.filter((x) => !x.a).slice(0, 3);
  return (
    <div className={`draw-soup ${item.flipped ? 'flipped' : ''}`}>
      <div className="soup-face">
        <h3><small>汤面</small>{item.text}</h3>
        <div className="soup-cols">
          {(['是', '不是', '不重要'] as const).map((a) => (
            <div key={a} className={`soup-col a-${a}`}>
              <b>{a}</b>
              {col(a).map((x, i) => <span key={i}>{x.q}</span>)}
            </div>
          ))}
        </div>
        <p className="draw-hint">{waiting.length ? `等她回答：${waiting.map((x) => `「${x.q}」`).join(' ')}` : '发「是不是……」提问，她只答 是 / 不是 / 不重要'}</p>
      </div>
      <div className="soup-back"><small>汤底</small>{item.note ?? '（没写汤底）'}</div>
    </div>
  );
}

export function ItemBody({ item, box, now }: { item: Item; box: Box; now: number }) {
  switch (item.kind) {
    case 'text':
      return <Text item={item} now={now} />;
    case 'number':
      return (
        <div className="draw-number">
          <b><Swapped item={item}><Rolling item={item} now={now} /></Swapped></b>
          {item.note && <span>{item.note}</span>}
        </div>
      );
    case 'image':
      return (
        <figure className="draw-image">
          <img src={item.text} alt={item.note ?? ''} draggable={false} />
          {item.note && <figcaption>{item.note}</figcaption>}
        </figure>
      );
    case 'sticker':
      return <div className="draw-sticker" style={{ fontSize: Math.min(box.w, box.h) * 0.78 }}>{item.text}</div>;
    case 'card':
      return (
        <div className={`draw-card ${item.flipped ? 'flipped' : ''}`}>
          <div className="face front"><b><Swapped item={item}>{item.text}</Swapped></b>{item.note && <span>{item.note}</span>}</div>
          <div className="face back">{item.note ?? ''}</div>
        </div>
      );
    case 'list': {
      // 密集清单截短内容，不把八行说明一起缩成小字；全文留在每行title里。
      const limit = item.text || item.rows?.some(r => r.note) ? 3 : 4;
      const dense = (item.rows?.length ?? 0) > limit;
      const short = (s: string, n: number) => [...s].length > n ? [...s].slice(0, n - 1).join('') + '…' : s;
      const rows = (item.rows ?? []).slice(0, limit);
      return (
        <div className="draw-listbox">
          {item.text && <h3>{item.text}</h3>}
          <ul className="draw-list">
            {rows.map((r, i) => <li key={r.label + i} title={`${r.label}${r.note ? '：' + r.note : ''}${dense && i === rows.length - 1 ? `（另有${item.rows!.length - limit}项）` : ''}`} style={{ animationDelay: `${i * 220}ms` }}><b>{dense ? short(r.label, 8) + (i === rows.length - 1 ? '…' : '') : r.label}</b>{r.note && <span>{dense ? short(r.note, 8) : r.note}</span>}</li>)}
          </ul>
        </div>
      );
    }
    case 'versus': {
      const [a, b] = item.rows ?? [];
      return (
        <div className="draw-versusbox">
        {item.text && <h3>{item.text}</h3>}
        <div className="draw-versus">
          <div className="vs-side left"><b>{a?.label}</b>{a?.note && <span>{a.note}</span>}</div>
          <i>VS</i>
          <div className="vs-side right"><b>{b?.label}</b>{b?.note && <span>{b.note}</span>}</div>
        </div>
        </div>
      );
    }
    case 'bars':
      return <Bars item={item} box={box} />;
    case 'line':
      return <Line item={item} box={box} />;
    case 'ratio':
      return <Ratio item={item} box={box} />;
    case 'ring':
      return <Ring item={item} box={box} />;
    case 'poll':
      return <Poll item={item} />;
    case 'tier':
      return <Tier item={item} />;
    case 'score':
      return <Score item={item} />;
    case 'guess':
      return <Guess item={item} box={box} />;
    case 'clue':
      return <Clue item={item} />;
    case 'timer':
      return <Timer item={item} box={box} now={now} />;
    case 'wall':
      return <Wall item={item} />;
    case 'timeline':
      return <Timeline item={item} />;
    case 'flow':
      return <Flow item={item} />;
    case 'race':
      return <Race item={item} />;
    case 'soup':
      return <Soup item={item} />;
    default:
      return null;
  }
}
