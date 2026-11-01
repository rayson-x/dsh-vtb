/**
 * 布景在舞台页上的三样东西：
 *   Ambience  一直在动的环境（雨、灰尘、气泡、光柱、灯光微闪），一块 canvas + 两层 CSS
 *   SetFx     她点的布景特效：按 stage/sets.ts 里的步骤，把基础效果叠在画面上演一次
 *   切换转场  换布景时整块画面渐黑/闪白/擦过/雪花，过半时换皮
 *
 * 基础效果都是 CSS 动画（时长和延迟按步骤给），演完自己消失；只有「震」要作用在整个舞台上，由 Stage 读 shakeOf()。
 */

import { useEffect, useRef, type CSSProperties } from 'react';
import { SETS, effectMs, effectOf, type AmbientKind, type Prim } from '../stage/sets';
import type { StageState } from '../stage/protocol';

const TRANSITION_MS = 1600;

/** 正在切换：返回该用哪套皮（过半前旧的、过半后新的）和转场遮罩的进度 */
export function setPhase(state: StageState, now: number): { set: string; t: number | null } {
  const t = (now - state.setAt) / TRANSITION_MS;
  if (!state.setFrom || t >= 1 || t < 0) return { set: state.set, t: null };
  return { set: t < 0.5 ? state.setFrom : state.set, t };
}

/** 现在要不要震、震多狠（0 不震） */
export function shakeOf(state: StageState, now: number): number {
  let strength = 0;
  for (const v of state.vfx) {
    const fx = effectOf(state.set, v.name);
    for (const s of fx?.steps ?? []) {
      if (s.prim !== 'shake') continue;
      const start = v.at + (s.at ?? 0);
      if (Math.max(now, v.at) >= start && now < start + (s.ms ?? 300)) strength = Math.max(strength, s.strength ?? 0.5);
    }
  }
  return strength;
}

/** 切换遮罩：渐黑 / 闪白 / 擦过 / 雪花，三角形进度（中间最满） */
export function SetTransition({ state, now }: { state: StageState; now: number }) {
  const { t } = setPhase(state, now);
  if (t === null) return null;
  const kind = SETS[state.set]?.transition ?? 'fade-black';
  const peak = 1 - Math.abs(t - 0.5) * 2;
  if (kind === 'wipe') return <div className="set-wipe" style={{ transform: `translateX(${(t * 2 - 1) * 100}%)` }} />;
  return <div className={`set-cover ${kind}`} style={{ opacity: Math.min(1, peak * 1.4) }} />;
}

let staticNoise: string | undefined;

function Step({ p, delay, elapsed, ms, hole }: { p: Prim; delay: number; elapsed: number; ms: number; hole: { x: number; y: number; rx: number; ry: number } }) {
  const base: CSSProperties = { animationDelay: `${delay}ms`, animationDuration: `${ms}ms` };
  switch (p.prim) {
    case 'flash':
      return <i className="vfx vfx-flash" style={{ ...base, animationDuration: `${ms / (p.times ?? 1)}ms`, animationIterationCount: p.times ?? 1, background: p.color ?? '#fff' }} />;
    case 'dark':
      return <i className="vfx vfx-dark" style={{ ...base, ['--level' as string]: p.level ?? 0.8, ['--hx' as string]: `${hole.x}px`, ['--hy' as string]: `${hole.y}px`, ['--hrx' as string]: `${hole.rx}px`, ['--hry' as string]: `${hole.ry}px`, animationTimingFunction: `linear(0, 0 ${Math.max(0, Math.min(85, (p.hold ?? ms * 0.55) / ms * 100))}%, 1)` }} />;
    case 'pulse':
      return <i className="vfx vfx-pulse" style={{ ...base, animationDuration: `${ms / (p.times ?? 3)}ms`, animationIterationCount: p.times ?? 3, ['--pc' as string]: p.color ?? 'rgba(0,0,0,0.6)' }} />;
    case 'static': {
      // 小块黑白位图只生成一次，避免 SVG 噪声滤镜反复栅格化占用内存。
      if (!staticNoise) {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 96;
        const g = canvas.getContext('2d')!;
        const pixels = g.createImageData(96, 96);
        let seed = 17;
        for (let i = 0; i < pixels.data.length; i += 4) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = seed >>> 31 ? 255 : 0;
          pixels.data[i + 3] = 255;
        }
        g.putImageData(pixels, 0, 0);
        staticNoise = canvas.toDataURL();
      }
      return <i className="vfx vfx-static" data-active={elapsed >= 0 && elapsed < ms ? true : undefined} style={{ ...base, animationPlayState: 'paused', animationDelay: `${-elapsed}ms`, ['--noise' as string]: `url("${staticNoise}")`, ['--scan' as string]: 'rgba(0,0,0,0.32)' }} />;
    }
    case 'fog':
      return <i className="vfx vfx-fog" style={{ ...base, ['--fc' as string]: p.color ?? 'rgba(220,230,240,0.6)' }} />;
    case 'tint':
      return <i className="vfx vfx-tint" style={{ ...base, background: p.color }} />;
    case 'sweep':
      return <i className="vfx vfx-sweep" style={{ ...base, ['--sc' as string]: p.color ?? 'rgba(255,255,255,0.5)' }} />;
    case 'burst': {
      const n = Math.max(0, Math.min(60, p.count ?? 24));
      const colors = { bubble: ['#8bd9ff', '#24568a'], spark: ['#ffd36a', '#87501b'], ember: ['#ffb347', '#963b1a'], petal: ['#ffb7c9', '#943956'] };
      const [color, edge] = colors[p.particle];
      return (
        <div className="vfx-burst">
          {Array.from({ length: n }, (_, i) => {
            // 固定的伪随机；暂停 CSS 时钟，用舞台时间定位，低帧率时也不从底部重演
            const r = (k: number) => ((Math.sin((i + 1) * 12.9898 * k) * 43758.5453) % 1 + 1) % 1;
            return (
              <i key={i} className="vfx-bit" style={{ left: `${r(1) * 100}%`, animationPlayState: 'paused', animationDelay: `${-elapsed + r(2) * ms * 0.06}ms`, animationDuration: `${ms * (1 - r(2) * 0.06)}ms`, ['--drift' as string]: `${(r(4) - 0.5) * 240}px`, ['--lift' as string]: `${450 + r(3) * 500}px`, ['--rise' as string]: `${1400 + r(3) * 500}px`, ['--size' as string]: `${64 + r(5) * 100}px`, ['--bc' as string]: color, ['--be' as string]: edge }}><b className={`bit-shape bit-${p.particle}`}>{p.particle === 'spark' && <svg viewBox="0 0 100 100"><path d="M50 4 65 35 96 50 65 65 50 96 35 65 4 50 35 35Z" /><path className="bit-glint" d="M50 4 65 35 96 50 65 65 50 96 35 65 4 50 35 35Z" /></svg>}</b></i>
            );
          })}
        </div>
      );
    }
    default:
      return null;
  }
}

/** 她点的布景特效：最近 10 秒内的，按步骤叠上去 */
export function SetFx({ state, now }: { state: StageState; now: number }) {
  // 每个特效第一次挂上时记下「已经过去多久」（中途打开页面时不从头演）；之后不再改，
  // 否则每帧改 animation-delay 会让进度重复累加、一下子演完
  const started = useRef(new Map<string, number>());
  const a = state.canvas.avatar;
  const hole = { x: a.x + a.w * 0.5, y: a.y + a.h * 0.65, rx: a.w * 0.85, ry: a.h * 0.8 };
  const live = state.vfx.filter((v) => {
    const fx = effectOf(state.set, v.name);
    return fx && now - v.at < effectMs(fx) + 200;
  });
  if (!live.length) return null;
  return (
    <div className="layer vfx-layer">
      {live.map((v) => {
        const fx = effectOf(state.set, v.name)!;
        if (!started.current.has(v.id)) started.current.set(v.id, Math.max(0, now - v.at));
        const past = started.current.get(v.id)!;
        return (
          <div key={v.id} className="vfx-group">
            {fx.steps.map((s, i) => <Step key={i} p={s} delay={(s.at ?? 0) - past} elapsed={Math.max(now, v.at) - v.at - (s.at ?? 0)} ms={s.ms ?? 800} hole={hole} />)}
          </div>
        );
      })}
    </div>
  );
}

interface Mote { x: number; y: number; vx: number; vy: number; r: number; a: number }

/** 一直在动的环境：雨丝、浮尘、气泡画在 canvas 上；光柱、灯光微闪是 CSS 层 */
export function Ambience({ set }: { set: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const kinds = SETS[set]?.ambient ?? [];
  const sig = kinds.map((k) => `${k.kind}:${k.amount ?? ''}`).join(',');
  useEffect(() => {
    const canvas = ref.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const W = 1920;
    const H = 1080;
    const rnd = Math.random;
    const make = (kind: AmbientKind, n: number): Mote[] => Array.from({ length: n }, () => {
      if (kind === 'rain') return { x: rnd() * W, y: rnd() * H, vx: -1.2, vy: 14 + rnd() * 8, r: 14 + rnd() * 18, a: 0.08 + rnd() * 0.12 };
      if (kind === 'bubbles') return { x: rnd() * W, y: H + rnd() * H, vx: 0, vy: -(0.5 + rnd() * 1.1), r: 4 + rnd() * 10, a: 0.4 + rnd() * 0.4 };
      return { x: rnd() * W, y: rnd() * H, vx: (rnd() - 0.5) * 0.25, vy: (rnd() - 0.5) * 0.2, r: 1 + rnd() * 2.2, a: 0.15 + rnd() * 0.35 };
    });
    const layers = kinds.filter((k) => k.kind === 'rain' || k.kind === 'dust' || k.kind === 'bubbles').map((k) => ({ kind: k.kind, motes: make(k.kind, k.amount ?? 30) }));
    let raf = 0;
    let last = 0;
    let t = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden || now - last < 1000 / 30) return;
      last = now;
      t += 1;
      g.clearRect(0, 0, W, H);
      for (const L of layers) {
        for (const m of L.motes) {
          if (!reduce) { m.x += m.vx; m.y += m.vy; }
          if (L.kind === 'rain') {
            if (m.y > H) { m.y = -m.r; m.x = rnd() * W; }
            g.strokeStyle = `rgba(190, 210, 235, ${m.a})`;
            g.lineWidth = 1.2;
            g.beginPath();
            g.moveTo(m.x, m.y);
            g.lineTo(m.x + m.vx * 2, m.y - m.r);
            g.stroke();
          } else if (L.kind === 'bubbles') {
            if (m.y < -20) { m.y = H + 20; m.x = rnd() * W; }
            const x = m.x + Math.sin((t + m.r * 10) / 40) * 6;
            g.strokeStyle = `rgba(220, 245, 255, ${m.a})`;
            g.lineWidth = 1.5;
            g.beginPath();
            g.arc(x, m.y, m.r, 0, Math.PI * 2);
            g.stroke();
          } else {
            if (m.x < 0) m.x = W; if (m.x > W) m.x = 0; if (m.y < 0) m.y = H; if (m.y > H) m.y = 0;
            g.fillStyle = `rgba(255, 220, 160, ${m.a * (0.6 + 0.4 * Math.sin((t + m.x) / 30))})`;
            g.beginPath();
            g.arc(m.x, m.y, m.r, 0, Math.PI * 2);
            g.fill();
          }
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [sig]);
  return (
    <div className="layer ambience">
      {kinds.some((k) => k.kind === 'rays') && <div className="amb-rays" />}
      <canvas ref={ref} width={1920} height={1080} />
      {kinds.some((k) => k.kind === 'flicker') && <div className="amb-flicker" />}
    </div>
  );
}
