/**
 * 画布的样子：展示板里她搭的画面。每个元素按格子摆，出场、强调、变化都是 CSS/SVG 动效，
 * 同一个动作再做一次（fx.at 变了）就重播。元素长什么样在 Items.tsx，这里管摆放、连线、镜头和翻页。
 */

import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { AREA, COLS, ROWS, type DrawState, type Item } from '../../stage/draw/model';
import { ItemBody } from './Items';
import { Docked } from './Docked';
import { FxLayer } from './Fx';

const CW = AREA.w / COLS;
const CH = AREA.h / ROWS;
/** 元素之间留的缝 */
const GAP = 10;
/** 这几种按内容大小贴着画强调（字、数字、贴纸），别的贴着整格 */
const HUG = new Set(['text', 'number', 'sticker']);

export interface Box { x: number; y: number; w: number; h: number }

export const boxOf = (item: Item): Box => ({
  x: item.cell.col * CW + GAP / 2, y: item.cell.row * CH + GAP / 2,
  w: item.cell.w * CW - GAP, h: item.cell.h * CH - GAP,
});

/** 两个框之间的箭头：从一个框的边出发，到另一个框的边，略弯 */
function linkPath(a: Box, b: Box): { d: string; mid: { x: number; y: number } } {
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const edge = (c: { x: number; y: number }, box: Box, toward: { x: number; y: number }) => {
    const dx = toward.x - c.x;
    const dy = toward.y - c.y;
    const sx = dx ? (box.w / 2 + 8) / Math.abs(dx) : Infinity;
    const sy = dy ? (box.h / 2 + 8) / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy, 1);
    return { x: c.x + dx * s, y: c.y + dy * s };
  };
  const p = edge(ca, a, cb);
  const q = edge(cb, b, ca);
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2;
  // 往一侧弯一点，像手画的
  const nx = -(q.y - p.y) * 0.12;
  const ny = (q.x - p.x) * 0.12;
  return { d: `M ${p.x} ${p.y} Q ${mx + nx} ${my + ny} ${q.x} ${q.y}`, mid: { x: mx + nx / 2, y: my + ny / 2 } };
}

function Links({ items }: { items: Item[] }) {
  const byId = new Map(items.map((x) => [x.id, x]));
  const links = items.filter((x) => x.kind === 'link');
  if (!links.length) return null;
  return (
    <svg className="draw-links" width={AREA.w} height={AREA.h}>
      <defs>
        <marker id="draw-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ink-navy)" />
        </marker>
      </defs>
      {links.map((l) => {
        const a = byId.get(l.from!);
        const b = byId.get(l.to!);
        if (!a || !b) return null;
        const { d, mid } = linkPath(boxOf(a), boxOf(b));
        // 两头都是线索：红线（不带箭头），像侦探板
        const string = a.kind === 'clue' && b.kind === 'clue';
        return (
          <g key={`${l.id}-${l.born}`} className={`draw-link ${string ? 'string' : ''}`}>
            <path d={d} pathLength={1} markerEnd={string ? undefined : 'url(#draw-arrow)'} />
            {/* 流光：一个小光点沿线来回走，表示「传过去」 */}
            {!string && <circle className="link-spark" r={7}><animateMotion dur="2.4s" repeatCount="indefinite" path={d} /></circle>}
            {l.text && <foreignObject x={mid.x - 90} y={mid.y - 24} width={180} height={48}><div className="draw-link-label">{l.text}</div></foreignObject>}
          </g>
        );
      })}
    </svg>
  );
}

/**
 * 自动取景：这一页上的东西不多时，镜头推近一点、放到正中，别挤在左上角留一大片空；
 * 往上加东西时镜头慢慢拉远（transform 有过渡，像摄影师在跟）。最多放大 1.45 倍。
 */
function frame(d: DrawState): CSSProperties {
  const shown = d.items.filter((x) => x.kind !== 'link' && x.kind !== 'group' && !x.dim);
  if (d.items.some((x) => x.docked)) return { transform: 'none' };
  if (!shown.length) return { transform: 'none' };
  const boxes = shown.map(boxOf);
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  const scale = Math.max(1, Math.min(1.45, (AREA.w * 0.94) / (x1 - x0), (AREA.h * 0.92) / (y1 - y0)));
  const tx = AREA.w / 2 - ((x0 + x1) / 2) * scale;
  const ty = AREA.h / 2 - ((y0 + y1) / 2) * scale;
  return { transform: `translate(${tx}px, ${ty}px) scale(${scale})` };
}

/** 镜头推近：把那个元素放大到画布中间 */
function camera(d: DrawState): CSSProperties {
  if (d.zoom === 'all') {
    // 揭晓的格子可能是奇数宽，格子取整会偏半格；镜头按实际元素中心校正。
    const result = d.items.find((x) => x.result);
    const b = result ? boxOf(result) : undefined;
    const cx = b ? b.x + b.w / 2 : AREA.w / 2;
    const cy = b ? b.y + b.h / 2 : AREA.h / 2;
    return { transform: `translate(${AREA.w / 2 - cx * 0.88}px, ${AREA.h / 2 - cy * 0.88}px) scale(0.88)` };
  }
  const target = d.zoom ? d.items.find((x) => x.id === d.zoom) : undefined;
  if (!target) return frame(d);
  const b = boxOf(target);
  const scale = Math.min(2.2, Math.min(AREA.w / (b.w + 80), AREA.h / (b.h + 80)));
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  return { transform: `translate(${AREA.w / 2 - cx * scale}px, ${AREA.h / 2 - cy * scale}px) scale(${scale})` };
}

/** 内容按实际字形和子元素的范围等比缩进格子，测量在绘制前完成。 */
function Fitted({ box, children, item, now }: { box: Box; children: ReactNode; item: Item; now: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.transform = 'none';
    const r = el.getBoundingClientRect(), unit = r.width / box.w;
    if (!unit) return;
    let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
    const include = (b: DOMRect) => {
      if (!b.width || !b.height) return;
      left = Math.min(left, b.left); top = Math.min(top, b.top);
      right = Math.max(right, b.right); bottom = Math.max(bottom, b.bottom);
    };
    for (const node of el.querySelectorAll('*')) {
      include(node.getBoundingClientRect());
      for (const text of node.childNodes) if (text.nodeType === Node.TEXT_NODE && text.textContent?.trim()) {
        const range = document.createRange(); range.selectNodeContents(text);
        for (const rect of range.getClientRects()) include(rect);
      }
    }
    const width = (right - left) / unit, height = (bottom - top) / unit;
    const scale = Math.min(1, (box.w - 8) / width, (box.h - 8) / height);
    const x = (box.w - width * scale) / 2 - (left - r.left) / unit * scale;
    const y = (box.h - height * scale) / 2 - (top - r.top) / unit * scale;
    el.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }, [item, box.w, box.h, now]);
  return <div className="draw-fit" ref={ref}>{children}</div>;
}

export function Canvas({ draw, now }: { draw: DrawState; now: number }) {
  if (!draw.items.length) return null;
  const spot = draw.items.some((x) => x.fx?.kind === 'spotlight' && !x.dim);
  return (
    <div className="draw" style={{ left: AREA.x, top: AREA.y, width: AREA.w, height: AREA.h }}>
      {/* 翻页：换了页码整块重新挂上，从右边滑进来 */}
      <div className={`draw-page ${spot ? 'spot' : ''} ${draw.pageKind === 'wipe' ? 'wiped' : ''} ${draw.zoom === 'all' ? 'overview' : ''}`} key={draw.page} style={camera(draw)}>
        <div className="draw-drift">
        <Links items={draw.items} />
        <Groups items={draw.items} />
        {draw.items.filter((x) => x.kind !== 'link' && x.kind !== 'group').map((item) => {
          const b = boxOf(item);
          return (
            <div
              key={`${item.id}-${item.born}`}
              data-item-id={item.id}
              className={`draw-item ${item.docked ? 'docked' : ''} kind-${item.kind} enter-${item.enter} ${item.dim ? 'dim' : ''} ${item.big ? 'big' : ''} ${item.struck ? 'struck' : ''} ${item.fx?.kind === 'spotlight' && !item.dim ? 'lit' : ''}`}
              style={{ left: b.x, top: b.y, width: b.w, height: b.h }}
            >
              {item.docked ? <Docked item={item} now={now} /> : <Fitted box={b} item={item} now={now}>
              <div className={`draw-shake ${item.fx?.kind === 'shake' ? 'go' : ''}`} key={item.fx?.kind === 'shake' ? item.fx.at : 'still'}>
                {/* 强调画在内容上：字就贴着字（.hug），图表、卡片贴着整块 */}
                <div className={`draw-hug ${HUG.has(item.kind) ? 'hug' : ''}`}>
                  <ItemBody item={item} box={b} now={now} />
                  <FxLayer item={item} hug={HUG.has(item.kind)} />
                </div>
              </div>
              </Fitted>}
            </div>
          );
        })}
        </div>
      </div>
    </div>
  );
}

/** 归组框：把成员的框连起来外扩一圈，虚线圆角框，左上角挂名字 */
function Groups({ items }: { items: Item[] }) {
  const byId = new Map(items.map((x) => [x.id, x]));
  return (
    <>
      {items.filter((x) => x.kind === 'group').map((g) => {
        const boxes = (g.members ?? []).map((m) => byId.get(m)).filter((x): x is Item => !!x).map(boxOf);
        if (boxes.length < 2) return null;
        const x0 = Math.min(...boxes.map((b) => b.x)) - 16;
        const y0 = Math.min(...boxes.map((b) => b.y)) - 16;
        const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + 16;
        const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + 16;
        return (
          <div key={`${g.id}-${g.born}`} className="draw-group" style={{ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }}>
            {g.text && <b>{g.text}</b>}
          </div>
        );
      })}
    </>
  );
}
