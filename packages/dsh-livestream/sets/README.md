# 布景与基础特效

每个 `sets/<id>/` 放本布景的 `room.webp`（背景）、`kit/`（组件皮肤）、`sfx/`（音效与可选的 `bed.mp3`）、`set.css`。目录名与 `src/stage/sets.ts` 的布景 id 一致。

`set.css` 用 `.stage[data-set="<id>"]` 限定作用域，覆盖房间 `--set-room`、组件 `--kit-*` 与切片 `--kit-*-slice`、文字 `--ink-*`、强调色 `--whale/--coral/--gold/--mark`、纸面 `--paper/--chip/--note-paper/--note-back/--clue-paper`、淡色 `--tint-a/--tint-b`、暗角 `--room-vignette`、粒子混合模式 `--fx-particle-blend`（浅底 multiply，深底 screen）。可补少量本布景的组件规则；海底书房直接使用舞台默认变量。

新增布景：按上述目录放素材，写限定作用域的皮肤，在 `SETS` 增加 id、中文说明、环境、转场和招牌特效；招牌特效用 `steps` 组合已有基础效果，颜色、次数、强度与时间写在步骤数据里。

新增基础效果：在 `sets.ts` 的 `Prim` 联合类型和 `PRIMS` 中各加一项，在 `SetFx.tsx` 的 `Step` 增加绘制分支，在 `stage.css` 的布景特效段增加形状和关键帧。步骤参数由组件转成样式变量，CSS 定义形状与轨迹，混合模式由布景变量决定。粒子按步骤的 `particle` 选配色、按 `count` 定数量；骤暗的亮洞跟随 `state.canvas.avatar`，保持时间读 `hold`。调用方式为 `[[fx prim:名字]]`。

验收（低内存机器串行执行）：

1. `node build.mjs`，启动 `node lib/dev.js --port 3906`，等 3 秒。
2. `OUT=qa-shots/fx node scripts/fx-qa/capture-playwright.mjs`；脚本结束会关闭 Chromium，再执行 `pkill -f "lib/dev.js --port 3906"` 关闭舞台。
3. `.venv/bin/python scripts/fx-qa/measure.py qa-shots/fx`，最后必须是 `ALL PASS`；逐张查看两个布景的 18 张 `*-peak.png` 和 12 张 `sig-*.png`，检查效果形态、文字可读与结束后无残留。
4. 截图期间也不要打开图片查看工具；确认舞台、浏览器都关闭，再看图或运行 `npx tsc --noEmit -p .` 和 `npx vitest run`；只允许任务基线中的 DSH 包缺失错误及 `test/stage.test.ts` 加载失败，其余 118 个测试应通过。不要在截图时跑测试，不要改验收脚本或截图时间。
