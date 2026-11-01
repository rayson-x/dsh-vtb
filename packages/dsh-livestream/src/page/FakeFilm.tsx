/**
 * 假片子：没有可播地址时画一段。画面只由时间决定，所以跳转、暂停都对得上。
 * seed 不同画出来的「镜头」不同（B-roll 用另一个 seed）。
 */

import { useEffect, useRef } from 'react';

const W = 1280;
const H = 720;

function hash(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

function draw(ctx: CanvasRenderingContext2D, t: number, seed: number): void {
  // 每 8 秒一个「镜头」，镜头之间换色调和构图
  const shot = Math.floor(t / 8);
  const local = t - shot * 8;
  const hue = (seed * 67 + shot * 41) % 360;
  const sky = ctx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, `hsl(${hue}, 45%, ${22 + 6 * Math.sin(t / 5)}%)`);
  sky.addColorStop(0.65, `hsl(${(hue + 30) % 360}, 55%, 46%)`);
  sky.addColorStop(1, `hsl(${(hue + 50) % 360}, 40%, 18%)`);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // 远处的光斑
  for (let i = 0; i < 14; i++) {
    const x = ((hash(seed + i) * W + t * (8 + i)) % (W + 200)) - 100;
    const y = hash(seed + i + 50) * H * 0.5;
    const r = 18 + hash(i + seed * 3) * 40;
    ctx.fillStyle = `hsla(${(hue + 40) % 360}, 80%, 75%, ${0.08 + 0.08 * hash(i)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 台阶
  const steps = 5;
  const pan = Math.sin(t / 7 + seed) * 40;
  ctx.fillStyle = `hsl(${(hue + 200) % 360}, 18%, 12%)`;
  for (let i = 0; i < steps; i++) {
    const sx = 160 + i * 190 + pan;
    const sy = H - 120 - i * 70;
    ctx.fillRect(sx, sy, W, H - sy);
  }

  // 主角：一团沿台阶往上跳的影子
  const hop = (local / 8) * steps;
  const step = Math.min(steps - 1, Math.floor(hop));
  const frac = hop - step;
  const cx = 240 + step * 190 + frac * 190 + pan;
  const base = H - 120 - step * 70 - frac * 70;
  const cy = base - 46 - Math.abs(Math.sin(frac * Math.PI)) * 90;
  ctx.fillStyle = `hsl(${(hue + 180) % 360}, 25%, 88%)`;
  ctx.beginPath();
  ctx.ellipse(cx, cy, 52, 40, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx + 22, cy - 34);
  ctx.lineTo(cx + 34, cy - 66);
  ctx.lineTo(cx + 44, cy - 28);
  ctx.moveTo(cx - 10, cy - 38);
  ctx.lineTo(cx + 2, cy - 68);
  ctx.lineTo(cx + 14, cy - 36);
  ctx.fill();

  // 胶片颗粒和暗角
  for (let i = 0; i < 40; i++) {
    const v = hash(Math.floor(t * 24) + i * 13.7);
    ctx.fillStyle = `rgba(255,255,255,${0.03 * v})`;
    ctx.fillRect(hash(i + v) * W, hash(i * 2 + v) * H, 2, 2);
  }
  const vignette = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.85);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);
}

export function FakeFilm({ time, seed = 1 }: { time: number; seed?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (ctx) draw(ctx, time, seed);
  }, [time, seed]);
  return <canvas ref={ref} width={W} height={H} className="film" />;
}
