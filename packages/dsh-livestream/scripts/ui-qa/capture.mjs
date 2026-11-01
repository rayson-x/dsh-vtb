// 画布 UI 截图（本机）：node lib/dev.js --port 3906 起舞台，然后 ego-browser nodejs < scripts/ui-qa/capture.mjs
// 输出 <布景>-<场景>.png 和同名 .json（元素框）。只拍部分场景：配置里给 only: ["charts", "tier"]
// 在别的副本、别的端口跑（ego-browser 不传环境变量，配置拼在脚本前面）：
//   (echo 'globalThis.QA = { root: "<副本>/packages/dsh-livestream", out: "<截图目录>", base: "http://127.0.0.1:<端口>", space: "<任务名>" };'; cat scripts/ui-qa/capture.mjs) | ego-browser nodejs
const QA = globalThis.QA ?? {};
const ROOT = QA.root ?? "/Users/Ruihan/orca/projects/aivtb/packages/dsh-livestream";
const OUT = QA.out ?? "/Users/Ruihan/orca/projects/aivtb/.deps/tasks/shots/ui";
const BASE = QA.base ?? "http://127.0.0.1:3906";
const { shoot } = await import(`${ROOT}/scripts/ui-qa/shoot.mjs`);
const task = await taskSpace(QA.space ?? "aivtb 画布UI截图");
const p = task.page("p1");
await p.cdp("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await p.goto(`${BASE}/?sfx=0`);
await p.waitForTimeout(3000);
await p.cdp("Page.bringToFront", {}); // 不在前台浏览器会暂停动画
await shoot({ base: BASE, out: OUT, only: QA.only, page: {
  wait: (ms) => p.waitForTimeout(ms),
  screenshot: (path) => p.screenshot({ path }),
  evaluate: (js) => p.evaluate(js),
} });
await task.finish({ keep: [] });
console.log("done", OUT);
