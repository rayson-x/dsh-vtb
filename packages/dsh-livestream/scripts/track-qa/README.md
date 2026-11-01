# 画面轨历史诊断与验收交接

**收尾安排已变更：未独立完成连续三轮，最终由协调者统一同版本验收接管。最终集成验收为同一产品版本连续三轮，每轮团队开6分钟、关1分钟，同时覆盖plan和track；本副本不再启动长测或大脑。**

本目录旧 `sim.mjs/run.mjs/analyze.mjs/strict.mjs` 保留原阶段的5分钟开+1分钟关诊断逻辑，不是最终集成验收脚本，不可拿这些旧数据替代集成验收。`report.mjs` 现在只生成带当前源码指纹的历史证据清单，不生成“最终全过”报告。

以下仅为历史诊断复现说明，当前不执行启动步骤。所有命令在 `packages/dsh-livestream` 执行。只使用控制台3823、舞台3923、大脑3943；不访问其他验证端口。

1. `npx vitest run`、`npx tsc --noEmit -p .`、`node build.mjs`。
2. 环境已有HTTP代理时，只给本任务进程设置 `NODE_USE_ENV_PROXY=1 NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost`；不要打印代理值或改变系统配置。根目录启动 `node packages/dsh-livestream/lib/console.js --port 3823 --stage 3923 --brain 3943`；POST `http://127.0.0.1:3823/brain/start`。
3. 用 ego-browser 建立本任务唯一 TaskSpace `aivtb-track 直播`，p1打开 `http://127.0.0.1:3923/`。运行 `node scripts/track-qa/run.mjs 编号1 编号2 编号3`。每轮先安装观察器并以真实鼠标动作开启音频，再开播；实际开口后5分钟开团队、1分钟关闭。任一轮失败立即停止后续轮。
4. `node scripts/track-qa/contact.mjs 编号...`、`node scripts/track-qa/timeline.mjs 编号...`，逐张查看联系表；`node scripts/track-qa/strict.mjs 编号1 编号2 编号3` 汇总。不能把中断、缺证据或多数轮通过算作完成。
5. POST `/brain/stop`，关闭本任务控制台，`finish({keep:[]})`；删原始JPEG，只保留联系表、时间轴PNG和JSON证据。

`sim.mjs` 只发送礼物附言、主人要求和低人气提问，以及真实队列的改写/撤回。绝不注入主持人回答、模型输出或合成音频。每200ms记录说话轨和画面轨，SSE记录字幕真实起落、执行回执和灯光；每5秒截图并测量DOM相交/溢出。

`observe.mjs` 不改画面、播放参数或舞台状态。它保留原生play方法的调用与返回值，监听媒体playing事件、媒体时间与倍速；逐帧读取元素几何和样式，记录组件首次至少有2%内容可见的时刻。测的是进场开始，不是整段进场动画结束。字的实际念出时刻由对应音频playing、当时媒体进度、倍速和真实starts计算。不能用服务器计划时刻替代浏览器记录；缺任何一项即计该进场未通过。

改轨次数只算成功且实际改变未来计划的edit；重复提交相同锚点不算。跨段片段按实际在场区间与至少两个不同原段的有声区间相交判断，音频拆截不冒充多段。进场成功必须有实际退场回执，外部互动揭晓已收掉的组件单列external；未执行的失效计划不算出现。关闭期最简主题不参与“至少两个说明”的稀疏检查。接话、冷场、致谢、DOM和灯光沿用crew-live-qa严格口径。

探索证据编号不进入最终三轮。原始截图路径虽在shots.jsonl保留，收尾后对应JPEG会删除；联系表frames.json提供逐张编号与时刻。

当前代码检查：相关回归23项、全量31文件220项、tsc/build/diff-check通过。日志在final-*.log，留磁盘未提交。第13轮稀疏原因证据见sparse-13-analysis.json；最新directorEdits修复尚未长测，需统一验收确认。
