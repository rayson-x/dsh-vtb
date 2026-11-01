/**
 * 场景页共用的画布底子：自适应、字号、补间、随机数。
 * 每个场景自己画，自己挂 window.scene = { set, do }。
 */
(function () {
  const colors = {
    bg: '#071226',
    panel: '#0e1d40',
    text: '#eef3ff',
    mute: '#8d9cc6',
    whale: '#4d6bfe',
    foam: '#8fe3d8',
    coral: '#ff6f8e',
    gold: '#f4c86a',
    line: 'rgba(150, 180, 255, 0.2)',
  };
  const SANS = "'PingFang SC','Noto Sans SC','Microsoft YaHei',sans-serif";
  const DISPLAY = "'Smiley Sans','PingFang SC','Noto Sans SC',sans-serif";

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

  function num(v, fallback, min, max) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (!Number.isFinite(n)) return fallback;
    return clamp(n, min, max);
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function rand() {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 主画面（1400×900）正文 ≥28、标注 ≥22；更小的容器按短边托住，避免缩成蚂蚁。 */
  function fonts(w, h) {
    const s = Math.min(w / 1400, h / 900);
    const m = Math.min(w, h);
    const body = Math.round(clamp(Math.max(28 * s, m * 0.055), 16, 46));
    const label = Math.round(clamp(Math.max(22 * s, m * 0.042), 14, 32));
    const title = Math.round(clamp(Math.max(body * 1.18, 34 * s), 20, 54));
    const pad = Math.round(clamp(m * 0.04, 12, 36));
    return { title, body, label, pad };
  }

  function font(size, weight, display) {
    return `${weight || 600} ${size}px ${display ? DISPLAY : SANS}`;
  }

  function wrap(ctx, text, maxW, size) {
    ctx.font = font(size, 500, false);
    const lines = [];
    let line = '';
    for (const ch of String(text || '')) {
      const next = line + ch;
      if (line && ctx.measureText(next).width > maxW) {
        lines.push(line);
        line = ch;
        if (lines.length === 2) break;
      } else line = next;
    }
    if (line && lines.length < 2) lines.push(line);
    return lines.length ? lines : [''];
  }

  function ellipsis(ctx, text, maxW, size, weight) {
    ctx.font = font(size, weight || 600, false);
    const s = String(text || '');
    if (ctx.measureText(s).width <= maxW) return s;
    let out = s;
    while (out.length > 1 && ctx.measureText(`${out}…`).width > maxW) out = out.slice(0, -1);
    return `${out}…`;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  /**
   * 铺底、标题、副题、底部状态。返回中间可画的区域。
   * 状态同时写进 #status，方便试玩页和验收读取。
   */
  function chrome(ctx, w, h, title, sub, status) {
    const f = fonts(w, h);
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const titleText = ellipsis(ctx, title, w - f.pad * 2, f.title, 400);
    ctx.fillStyle = colors.foam;
    ctx.font = font(f.title, 400, true);
    ctx.fillText(titleText, f.pad, f.pad);
    const lines = wrap(ctx, sub, w - f.pad * 2, f.label);
    ctx.fillStyle = colors.mute;
    ctx.font = font(f.label, 500, false);
    lines.forEach((line, i) => {
      ctx.fillText(line, f.pad, f.pad + f.title + 8 + i * (f.label + 4));
    });
    const top = f.pad + f.title + 8 + lines.length * (f.label + 4) + 10;
    const foot = f.body + 8;
    ctx.fillStyle = colors.text;
    ctx.font = font(f.body, 600, false);
    ctx.fillText(ellipsis(ctx, status, w - f.pad * 2, f.body, 600), f.pad, h - f.pad - f.body);
    const el = document.getElementById('status');
    if (el && el.textContent !== status) el.textContent = status;
    ctx.restore();
    return {
      f,
      chart: {
        x: f.pad,
        y: top,
        w: Math.max(40, w - f.pad * 2),
        h: Math.max(48, h - top - foot - f.pad),
      },
    };
  }

  function mount(canvas, frame) {
    const ctx = canvas.getContext('2d', { alpha: true });
    let w = 1;
    let h = 1;
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(1, window.innerWidth);
      h = Math.max(1, window.innerHeight);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);
    let alive = true;
    const loop = (now) => {
      if (!alive) return;
      frame(ctx, w, h, now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return { stop() { alive = false; } };
  }

  function panel(ctx, chart, radius) {
    ctx.fillStyle = colors.panel;
    roundRect(ctx, chart.x, chart.y, chart.w, chart.h, radius ?? 18);
    ctx.fill();
  }

  window.SceneKit = {
    colors, SANS, DISPLAY, clamp, lerp, ease, num, mulberry32, fonts, font, wrap, ellipsis, roundRect, chrome, mount, panel,
  };
})();
