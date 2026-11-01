// 在独立测试页上反证检查器：既能抓到框相交，也能抓到被 overflow:hidden 裁掉的长字。
const { measureOverlap } = await import('/Users/Ruihan/orca/projects/aivtb-crew2/packages/dsh-livestream/scripts/crew-qa/overlap.mjs');
const task = await taskSpace('aivtb-crew2 回放');
const page = await task.newPage();
try {
  await page.goto('data:text/html,' + encodeURIComponent('<div class="draw-item" data-item-id="a" style="position:absolute;left:0;top:0;width:80px;height:40px;overflow:hidden"><span style="white-space:nowrap">abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz</span></div><div class="draw-item" data-item-id="b" style="position:absolute;left:60px;top:20px;width:80px;height:40px"></div>'));
  const bad = await page.evaluate(measureOverlap.toString() + ';measureOverlap()');
  if (bad.pairs.length !== 1 || bad.overflow.length !== 1) throw new Error('检查器未识别已知反例');
  const { writeFile } = await import('node:fs/promises');
  await writeFile('/Users/Ruihan/orca/projects/aivtb-crew2/packages/dsh-livestream/scripts/crew-qa/out-2a/checker-proof.json', JSON.stringify(bad, null, 2));
  console.log({ pairs: bad.pairs.length, overflow: bad.overflow.length });
} finally { await page.close(); }
