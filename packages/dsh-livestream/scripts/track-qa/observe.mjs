// 仅取证：保留原 play 调用与返回值，记录真实媒体 playing 和首帧可见时刻。
await page.evaluate(() => {
  if (window.__trackQA) return;
  const qa = window.__trackQA = { events: [], seen: new Set(), installedAt: Date.now() };
  const listening = new WeakSet();
  const original = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    if (!listening.has(this)) {
      listening.add(this);
      this.addEventListener('playing', () => qa.events.push({ type: 'audio', at: Date.now(), src: this.currentSrc || this.src, currentTime: this.currentTime, rate: this.playbackRate }));
    }
    return original.apply(this, args);
  };
  const frame = () => {
    for (const el of document.querySelectorAll('.draw-item')) {
      const id = el.dataset.itemId;
      if (!id || qa.seen.has(id)) continue;
      const style = getComputedStyle(el), box = el.getBoundingClientRect();
      if (style.visibility === 'hidden' || Number(style.opacity) < .05 || box.width < 1 || box.height < 1 || box.right <= 0 || box.bottom <= 0 || box.left >= innerWidth || box.top >= innerHeight) continue;
      const clip = /inset\([^ ]+ ([\d.]+)%/.exec(style.clipPath);
      if (clip && Number(clip[1]) > 98) continue;
      qa.seen.add(id); qa.events.push({ type: 'enter', id, at: Date.now() });
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
});
