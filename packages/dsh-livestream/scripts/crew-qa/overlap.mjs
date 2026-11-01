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
  // 附加只读文字测量；原有几何判断不变。
  const normalize = text => text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
  const visible = el => {
    for (let x = el; x; x = x.parentElement) {
      const s = getComputedStyle(x);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    }
    return true;
  };
  const content = items.map(({ el, id }) => ({ id, text: normalize(el.querySelector('.draw-ink, .draw-number > b')?.textContent ?? el.textContent ?? '') }));
  const duplicates = [];
  for (let i = 0; i < content.length; i++) for (const b of content.slice(i + 1)) {
    const a = content[i];
    if (a.text && b.text && (a.text === b.text || Math.min(a.text.length, b.text.length) >= 3 && Math.abs(a.text.length - b.text.length) <= 2 && (a.text.includes(b.text) || b.text.includes(a.text)))) duplicates.push({ a: a.id, b: b.id, text: a.text });
  }
  const smallText = [];
  for (const { el, id } of items) for (const node of el.querySelectorAll('*')) {
    if (!visible(node) || ![...node.childNodes].some(t => t.nodeType === Node.TEXT_NODE && t.textContent?.trim())) continue;
    let scale = 1;
    for (let ancestor = node; ancestor && !ancestor.classList.contains('stage-frame'); ancestor = ancestor.parentElement) {
      const matrix = new DOMMatrix(getComputedStyle(ancestor).transform);
      scale *= Math.hypot(matrix.a, matrix.b);
    }
    const fontSize = Math.min(parseFloat(getComputedStyle(node).fontSize), parseFloat(getComputedStyle(node).fontSize) * scale);
    if (fontSize < 18) smallText.push({ id, text: node.textContent, fontSize });
  }
  const titles = items.filter(({ el }) => el.querySelector('.size-xl')).map(({ el, id }) => ({ id, text: el.textContent }));
  return { pairs, overflow, count: items.length, duplicates, smallText, titles };
}
