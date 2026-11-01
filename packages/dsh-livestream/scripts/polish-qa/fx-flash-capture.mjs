// 基础特效截图：在 dev 舞台（默认 3922）上，两个布景 × 九种基础效果，每种拍 前 / 高峰 / 结束后 三张。
// 用法：node lib/dev.js --port 3922 起舞台，然后 ego-browser nodejs < scripts/fx-qa/capture.mjs
// 截图写到 OUT（下面这行），文件名 <布景>-<效果>-<before|peak|after>.jpg
const OUT = "/Users/Ruihan/orca/projects/aivtb-polish/.deps/tasks/shots/fx-polish";
const BASE = "http://127.0.0.1:3922";
const SETS = ["ocean-study", "midnight-tales"];
// 高峰拍在第几毫秒（相对触发）；after 在效果总时长 + 400ms
const PRIMS = { flash: [120, 900], dark: [500, 2600], pulse: [300, 2400], shake: [180, 500], static: [250, 900], fog: [900, 3000], burst: [900, 2400], sweep: [500, 1400], tint: [600, 2400] };

const fs = await import("node:fs");
fs.mkdirSync(OUT, { recursive: true });
const rawCommand = (c) => fetch(`${BASE}/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) }).then((r) => r.json());
// 实际控制器会限制灯光，拒绝时记录并等待额度恢复；高峰计时仍从成功触发开始。
const cmd = async c => {
  for (let retry = 0; retry < 4; retry++) {
    const result = await rawCommand(c);
    const limited = result.results?.some(r => !r.ok && /lighting:/.test(r.error ?? ''));
    if (!limited) return result;
    console.log('QA等待灯光限频', c.name, JSON.stringify(result.results));
    await new Promise(r => setTimeout(r, 31000));
  }
  throw new Error('灯光额度未恢复');
};
const task = await taskSpace("aivtb-polish 验收");
const page = task.page("p1");
const jpeg = async path => { const shot=await page.cdp('Page.captureScreenshot',{format:'jpeg',quality:92}); fs.writeFileSync(path,Buffer.from(shot.data,'base64')); };
await page.cdp("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await page.goto(`${BASE}/?sfx=0`);
await page.waitForTimeout(3000);
// 舞台页必须在前台，否则浏览器会暂停动画
await page.cdp("Page.bringToFront", {});
for (const set of SETS) {
  await cmd({ type: "room", id: set, by: "owner" });
  await page.waitForTimeout(2200);
  // 固定的画面：画布上一个大字 + 一个列表，字幕一句，用来看特效压在内容上的样子
  await cmd({ type: "draw", id: "qa-a", kind: "text", text: "测试主题", size: "xl", at: "top" });
  await cmd({ type: "draw", id: "qa-b", kind: "list", text: "", rows: [{ label: "第一条" }, { label: "第二条" }], at: "bottom" });
  await page.waitForTimeout(2500);
  for (const [prim, [peak, total]] of Object.entries(PRIMS).filter(([name]) => name === 'flash')) {
    await jpeg(`${OUT}/${set}-${prim}-before.jpg`);
    const r = await cmd({ type: "vfx", name: `prim:${prim}` });
    if (r.results?.some((x) => !x.ok)) console.log("ERR", set, prim, JSON.stringify(r));
    await page.waitForTimeout(peak);
    await jpeg(`${OUT}/${set}-${prim}-peak.jpg`);
    await page.waitForTimeout(total - peak + 400);
    await jpeg(`${OUT}/${set}-${prim}-after.jpg`);
    await page.waitForTimeout(4200); // 同一个效果隔几秒才能再放；也让画面完全回去
  }
}
