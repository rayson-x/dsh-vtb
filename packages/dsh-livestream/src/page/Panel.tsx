/**
 * 直播间的组件：她用 [[show 编号 at=区域]] 摆到某个区域（见 stage/regions.ts），这里按区域定位。
 * 每种素材一个样子；列表类的项依次浮上来。投票的票数实时涨，揭晓后标出答案或最高票。
 */

import { useEffect, useRef, type CSSProperties } from 'react';
import type { Panel as PanelState, Scene, StageState } from '../stage/protocol';
import { SLOT_BOX } from '../stage/graphics';
import { REGIONS } from '../stage/regions';
import type { Explain } from '../stage/explain';
import type { Visual } from '../stage/visual';

const LETTERS = ['A', 'B', 'C', 'D'];
const stagger = (i: number): CSSProperties => ({ animationDelay: `${120 + i * 140}ms` });

interface SceneApi {
  set?: (params: Record<string, unknown>) => void;
  do?: (action: string, options?: { replay?: boolean }) => void;
}

/**
 * 代码场景：同源 iframe，直接调它的 window.scene.set / do。
 * 记着已经做到第几个动作；iframe 重新加载（中途打开页面）时从头重放参数和全部动作。
 */
function Scene({ panel }: { panel: PanelState }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const done = useRef(0);
  const api = () => (frame.current?.contentWindow as (Window & { scene?: SceneApi }) | null)?.scene;
  const sync = (replay = false) => {
    const scene = api();
    if (!scene) return;
    scene.set?.(panel.params ?? {});
    const acts = panel.acts ?? [];
    for (const a of acts.slice(done.current)) scene.do?.(a, { replay });
    done.current = acts.length;
  };
  useEffect(() => sync(), [panel.params, panel.acts]);
  return (
    <iframe
      ref={frame}
      className="pv-scene"
      title={panel.visual.id}
      src={`${panel.url ?? ''}${location.search}`}
      onLoad={() => { done.current = 0; sync(true); }}
    />
  );
}

function Body({ v, panel }: { v: Visual; panel: PanelState }) {
  switch (v.kind) {
    case 'scene':
      return <Scene panel={panel} />;
    case 'image':
      return (
        <figure className="pv-image">
          <img src={`${panel.url ?? ''}${location.search}`} alt={v.caption ?? ''} />
          {(v.caption || v.credit) && (
            <figcaption>
              {v.caption && <span>{v.caption}</span>}
              {v.credit && <small>{v.credit}</small>}
            </figcaption>
          )}
        </figure>
      );
    case 'compare':
      return (
        <div className="pv-compare">
          {[v.left, v.right].map(([head, text], i) => (
            <div key={i} className={`pv-side ${i ? 'right' : 'left'}`} style={stagger(i)}>
              <h4>{head}</h4>
              <p>{text}</p>
            </div>
          ))}
          <b className="pv-vs">VS</b>
        </div>
      );
    case 'table':
      return (
        <table className="pv-table">
          <thead><tr>{v.rows[0]!.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
          <tbody>
            {v.rows.slice(1).map((r, i) => (
              <tr key={i} style={stagger(i)}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
            ))}
          </tbody>
        </table>
      );
    case 'timeline':
      return (
        <ol className="pv-timeline">
          {v.items.map(([when, what], i) => (
            <li key={i} style={stagger(i)}><time>{when}</time><span>{what}</span></li>
          ))}
        </ol>
      );
    case 'flow':
      return (
        <ol className="pv-flow">
          {v.steps.map((s, i) => (
            <li key={i} style={stagger(i)}><i>{i + 1}</i><span>{s}</span></li>
          ))}
        </ol>
      );
    case 'list':
      return (
        <ul className="pv-list">
          {v.items.map((s, i) => <li key={i} style={stagger(i)}>{s}</li>)}
        </ul>
      );
    case 'formula':
      return (
        <div className="pv-formula">
          <div className="pv-formula-text">{v.text}</div>
          {v.note && <p>{v.note}</p>}
        </div>
      );
    case 'quiz':
      return (
        <div className="pv-choice">
          <h4>{v.question}</h4>
          <ol>
            {v.options.map((o, i) => (
              <li key={i} style={stagger(i)} className={panel.revealed ? (i + 1 === v.answer ? 'right' : 'wrong') : ''}>
                <i>{LETTERS[i]}</i><span>{o}</span>{panel.revealed && i + 1 === v.answer && <em>答案</em>}
              </li>
            ))}
          </ol>
        </div>
      );
    case 'poll': {
      const total = panel.votes.reduce((a, b) => a + b, 0);
      const top = Math.max(...panel.votes);
      return (
        <div className="pv-choice poll">
          <h4>{v.question}</h4>
          <ol>
            {v.options.map((o, i) => {
              const n = panel.votes[i] ?? 0;
              const pct = total ? Math.round((n / total) * 100) : 0;
              return (
                <li key={i} style={stagger(i)} className={panel.revealed && n === top && total ? 'right' : ''}>
                  <b className="pv-bar" style={{ width: `${pct}%` }} />
                  <i>{i + 1}</i><span>{o}</span><em>{n} 票{total ? ` · ${pct}%` : ''}</em>
                </li>
              );
            })}
          </ol>
          <p className="pv-hint">{panel.revealed ? `共 ${total} 票` : '发弹幕 1、2、3 投票'}</p>
        </div>
      );
    }
    case 'quote':
      return (
        <blockquote className="pv-quote">
          <p>{v.text}</p>
          {v.source && <cite>{v.source}</cite>}
        </blockquote>
      );
    case 'diagram':
    case 'figure':
    case 'chart':
    case 'number':
      return <ExplainFallback v={v} panel={panel} />;
  }
}

/**
 * 讲解组件的简易版（正式渲染还在做）：按步数只显示揭开了的元素，被指着的加亮。
 * 图解列节点、标注图列标记、数据图出表格、数字时刻写大字；出处写在底下
 */
function ExplainFallback({ v, panel }: { v: Explain; panel: PanelState }) {
  const step = panel.step ?? 0;
  const shown = (s?: number) => (s ?? 0) <= step;
  const lit = (id: string) => (panel.point === id ? 'pv-lit' : panel.point ? 'pv-dim' : '');
  const source = 'source' in v && v.source ? <cite className="pv-source">出处：{v.source}</cite> : null;
  switch (v.kind) {
    case 'diagram':
      return (
        <div className="pv-explain">
          <ol className="pv-list">{v.nodes.filter((n) => shown(n.step)).map((n) => <li key={n.id} className={lit(n.id)}>{n.label}{n.note ? `：${n.note}` : ''}</li>)}</ol>
          {source}
        </div>
      );
    case 'figure':
      return (
        <div className="pv-explain">
          <ul className="pv-list">{v.marks.filter((m) => shown(m.step) && m.label).map((m) => <li key={m.id} className={lit(m.id)}>{m.label}</li>)}</ul>
          {v.caption && <p>{v.caption}</p>}
          {source}
        </div>
      );
    case 'chart': {
      const cols = v.reveal === 'points' ? v.x.slice(0, Math.max(1, step)) : v.x;
      const rows = v.reveal === 'series' ? v.series.slice(0, Math.max(1, step)) : v.series;
      return (
        <div className="pv-explain">
          <table className="pv-table">
            <thead><tr><th />{cols.map((x) => <th key={x} className={lit(x)}>{x}</th>)}</tr></thead>
            <tbody>{rows.map((r) => <tr key={r.name}><td>{r.name}</td>{cols.map((_, i) => <td key={i}>{r.values[i]}{v.unit ?? ''}</td>)}</tr>)}</tbody>
          </table>
          {source}
        </div>
      );
    }
    case 'number':
      return (
        <div className="pv-explain pv-number">
          {v.mode === 'count' || v.mode === 'ratio'
            ? <p className="pv-big">{v.value}{v.mode === 'ratio' ? ` / ${v.of}` : v.unit ?? ''}</p>
            : <p className="pv-big">{(v.items ?? []).map((it) => `${it.label} ${it.value}${v.unit ?? ''}`).join('  vs  ')}</p>}
          {v.label && <p>{v.label}</p>}
          {source}
        </div>
      );
  }
}

function Panel({ panel, scene, yieldTo }: { panel: PanelState; scene: Scene; yieldTo: boolean }) {
  const v = panel.visual;
  const title = 'title' in v ? v.title : undefined;
  const box = REGIONS[scene][panel.region];
  // 区域小（杂谈时的空地）就整体缩小，排版不变；横幅和底条本来就矮，只按宽度缩
  const strip = panel.region === 'banner' || panel.region === 'lower';
  const scale = Math.min(1, box.w / 700, strip ? 1 : box.h / 420);
  return (
    <div
      className={`panel region-${panel.region} pv-${v.kind}-wrap ${yieldTo ? 'yield' : ''}`}
      style={{ left: box.x, top: box.y, width: box.w / scale, height: box.h / scale, transform: `scale(${scale})` }}
    >
      {title && <h3 className="pv-title">{title}</h3>}
      <Body v={v} panel={panel} />
    </div>
  );
}

type Rect = { x: number; y: number; w: number; h: number };
/** 两个框重叠的面积占 a 的几成 */
function covered(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / (a.w * a.h) : 0;
}

/**
 * 组件层：画面上的组件按区域摆，换场景或挪位置时滑过去。
 * 主画面一次只放一样东西：有包装（graphic）压上来时，被压住一成半以上的组件先让开（淡出），包装播完再回来
 */
export function Panels({ state, scene, now }: { state: StageState; scene: Scene; now: number }) {
  if (!state.panels.length) return null;
  const live = state.graphics.filter((g) => g.until > now).map((g) => SLOT_BOX[g.slot]);
  return (
    <div className="layer panels">
      {state.panels.map((p) => {
        const box = REGIONS[scene][p.region];
        return <Panel key={`${p.visual.id}-${p.at}`} panel={p} scene={scene} yieldTo={live.some((g) => covered(box, g) > 0.15)} />;
      })}
    </div>
  );
}
