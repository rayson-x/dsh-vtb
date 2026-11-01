// 两种截图脚本共用的流程：给一个 page 适配器（screenshot / evaluate / wait），拍完全部场景。
import fs from "node:fs";
import { SETS, SCENES, SETTLE_MS } from "./scenes.mjs";

export async function shoot({ base, out, page, only }) {
  fs.mkdirSync(out, { recursive: true });
  const cmd = (c) => fetch(`${base}/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) }).then((r) => r.json());
  for (const set of SETS) {
    await cmd({ type: "room", id: set, by: "owner" });
    await page.wait(2500);
    for (const [name, steps] of Object.entries(SCENES)) {
      if (only && !only.includes(name)) continue;
      await cmd({ type: "erase" });
      await page.wait(900);
      for (const c of steps) {
        const r = await cmd(c);
        if (r.results?.some((x) => !x.ok)) console.log("ERR", set, name, JSON.stringify(c), JSON.stringify(r.results));
        await page.wait(c.type === "danmaku" ? 120 : 250);
      }
      await page.wait(SETTLE_MS);
      await page.screenshot(`${out}/${set}-${name}.png`);
      // 每样东西在屏幕上的框，measure.py 按框量对比度和颜色
      const boxes = await page.evaluate(`[...document.querySelectorAll('.draw-item')].map((e) => {
        const r = e.getBoundingClientRect(); const k = [...e.classList].find((c) => c.startsWith('kind-'));
        return { kind: k ? k.slice(5) : '?', x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      })`);
      fs.writeFileSync(`${out}/${set}-${name}.json`, JSON.stringify(boxes));
    }
  }
  await cmd({ type: "erase" });
}
