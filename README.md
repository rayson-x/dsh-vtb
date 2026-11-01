# aivtb

AI 虚拟主播「大肥鱼」的本地直播舞台。DSH 负责主持和后台编导，`packages/dsh-livestream` 提供控制台、语音队列、共享黑板、独立画面导演和 OBS 浏览器源。

## 本仓库的 scene-host 不是 P2 验收

`packages/scene-host` 只是脚手架和端口接线。**P2 运行验收没有通过。** 连续 100 次 live patch 保实例、真实 Remotion / HyperFrames 播放器和 Chromium 绘制仍然阻塞。详见 `packages/scene-host/README.md`。

## 开播

项目使用本机 DSH 的 `live` 配置，并需将本插件加入该配置。`.dsh/` 是本机状态，不随仓库提交。

使用 Node.js 24 或更新版本：

```sh
npm ci
npm --prefix packages/dsh-livestream ci
npm run console
```

打开控制台 `http://127.0.0.1:3800/`，设置本场方向后点「开播」。控制台管理大脑进程；「下播」停止大脑，关闭控制台也会清理它启动的子进程。舞台页为 `http://127.0.0.1:3900/`，可作为 OBS 的浏览器源；大脑内部控制口为 3920。

根目录 `.env` 存放本机凭据，不提交到仓库。画面导演使用 `DEEPSEEK_API_KEY`；语音使用 `ELEVENLABS_API_KEY`、`ELEVENLABS_VOICE_ID`，可选 `ELEVENLABS_MODEL_ID`。DSH 的凭据也可由其凭据服务提供。没有语音凭据或合成失败时会退回估时字幕，这不等同于真实语音播放。

如果本机通过环境变量配置 HTTP 代理，可对控制台进程启用 Node 的环境代理支持，并让本机端口直连：

```sh
NODE_USE_ENV_PROXY=1 NO_PROXY=localhost,127.0.0.1,::1 npm run console
```

这里使用已有代理配置，不设置系统代理。

## 舞台团队

- **主持人**负责说话、表情和互动内容。普通讲述按节目单最上面的点展开；重要新消息先短回应，再接回原来的话。主持人不能用台词直接控制说明画面、灯光和布景。
- **编导与黑板**维护当前话题、节目单、素材架、观众要求和历史归档。点题与礼物附言进入点单，由编导决定插入位置与理由；实际念完并点名后才关单。换题保留旧题未讲的安排，删点需说明理由。
- **说话轨**保存排队、正在念、挂起、已念和撤回的段落，以及真实 TTS 逐字时标。软打断、插队、改稿和接回会同步更新锚点。
- **画面导演**独立读取说话轨、黑板和画布，持续编辑组件的进场、效果与退场。组件可以跨多段话保留；未执行的计划可改，已执行回执保留。锚点所依赖的话被撤回或改掉时，相关未执行计划作废。

画面不是入队时给每段台词配好的一组装饰。导演由队列变化、话题和素材变化、画布变化及巡场唤醒；事件本身不会直接变成预设画面。运行时校验车道权限、互动保护、排版预算和灯光频率。

控制台的「舞台团队」关闭后停止画面计划，只保留当前主题；再次开启交回画面导演。当前阶段互动道具仍由主持人发起。画面通告回传、完整互动请求交接，以及布景、灯光和音响各自的独立岗位循环仍是后续工作。

## 画面与声音

舞台为 1920×1080，支持海底书房与午夜怪谈布景、说明组件、互动挂件、基础灯光效果和 Live2D 人物。角色与大型素材不进仓库；没有角色资源时使用 SVG 占位。

可选展示字体：

```sh
node packages/dsh-livestream/scripts/fetch-font.mjs
```

语音缓存在插件的 `.cache/voice/`。声音从舞台页播放，控制台不代替舞台采音；浏览器首次打开时需允许声音。

## 开发与验证

```sh
npm run plugin:check
npm run plugin:test
npm run plugin:build
npm run stage          # 独立开发舞台，默认 3900
npm run stage:demo     # 本地演示
npm run stage:voice    # 读取根目录 .env 的独立语音舞台
```

程序入口在 `src/host/stagehost.ts`，说话与画面轨在 `src/host/{timeline,track}.ts`，导演在 `src/host/crew/director.ts`，共享黑板在 `src/host/blackboard.ts`。控制台的 `/tracks` 可读取双轨快照。

`scripts/merged-qa/README.md` 说明统一真实语音验收：同一产品版本连续三轮，每轮六分钟团队开启、一分钟关闭，同时检查点单、换题、真实逐字进场、跨段退场、改轨、打断与最简退路。截图使用 ego-browser；原始取证数据、联系表和时间轴由脚本生成，不作为测试答案提交。

基础特效和画布的截图检查分别在 `scripts/fx-qa/` 与 `scripts/ui-qa/`。测试端口与日常控制台分开，避免把测试节目送进正在使用的舞台。
