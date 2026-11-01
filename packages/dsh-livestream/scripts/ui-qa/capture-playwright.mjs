// 画布 UI 截图（服务器，Playwright）：场景、等待、文件名和 capture.mjs 完全一样。
// 用法：node lib/dev.js --port 3906 起舞台，然后 OUT=qa-shots/ui node scripts/ui-qa/capture-playwright.mjs
import { chromium } from "playwright";
import { shoot } from "./shoot.mjs";
const OUT = process.env.OUT ?? "qa-shots/ui";
const BASE = process.env.BASE ?? "http://127.0.0.1:3906";
const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await p.goto(`${BASE}/?sfx=0`);
await p.waitForTimeout(3000);
await shoot({ base: BASE, out: OUT, only: process.env.ONLY?.split(","), page: {
  wait: (ms) => p.waitForTimeout(ms),
  screenshot: (path) => p.screenshot({ path }),
  evaluate: (js) => p.evaluate(js),
} });
await browser.close();
console.log("done", OUT);
