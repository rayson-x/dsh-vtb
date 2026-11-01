// 纯 DOM 测量：不修改样式、节点、动画或舞台状态。可直接传给 page.evaluate。
export function measureOverlap() {
  const rect = (r) => ({ x: r.x, y: r.y, w: r.width, h: r.height });
  const items = [...document.querySelectorAll('.draw-item')].map((el, index) => ({ el, id: el.dataset.itemId ?? String(index), box: el.getBoundingClientRect() }));
  const pairs = [], overflow = [];
  for (let i = 0; i < items.length; i++) {
    const { el, id, box } = items[i];
    for (const b of items.slice(i + 1)) {
      const w = Math.min(box.right, b.box.right) - Math.max(box.left, b.box.left);
      const h = Math.min(box.bottom, b.box.bottom) - Math.max(box.top, b.box.top);
      if (w > 0 && h > 0) pairs.push({ a: id, b: b.id, w, h });
    }
    const outside = [];
    const check = (r, node) => {
      if (r.width <= 0 || r.height <= 0) return;
      if (r.left < box.left - 4 || r.top < box.top - 4 || r.right > box.right + 4 || r.bottom > box.bottom + 4) outside.push({ node, box: rect(r) });
    };
    for (const child of el.querySelectorAll('*')) {
      const style = getComputedStyle(child);
      // 不可见的翻面、退场字不属于当前可见内容；仍测量其余所有子元素及逐行文字。
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      check(child.getBoundingClientRect(), child.tagName + '.' + child.getAttribute('class'));
      for (const text of child.childNodes) if (text.nodeType === Node.TEXT_NODE && text.textContent?.trim()) {
        const range = document.createRange(); range.selectNodeContents(text);
        for (const r of range.getClientRects()) check(r, '#text:' + text.textContent.slice(0, 24));
      }
    }
    if (outside.length) overflow.push({ id, box: rect(box), children: outside });
  }
  return { pairs, overflow, count: items.length };
}
