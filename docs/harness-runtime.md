# 共创 Harness：真实运行接线与验证记录

2026-11-02。实现分支承接 PR #28–#36 的领域契约与骨架；默认仍为 legacy，使用 `AIVTB_HARNESS=v2` 显式启用。本文记录已经跑过的接线，不代替主计划的完整验收。用户于本轮要求停止直播并采用模拟测试，以下新增验证没有启动真实 DSH 模型、TTS 或平台输入。

## 运行结构

- `live/runtime/root-plugin.ts` 是真实生产装配入口，不调用 MemoryAgentHarness/LiveFloor 的模型夹具。
- 主播、导播、编导、制作各有真实 DSH AgentRegistry session、角色预设和工具实例；服务端按绑定的 session 识别岗位，不信模型传入 actorId。
- 普通口播直接进入独立调度器；编导、源码构建不在发声的同步依赖链。制作编译在独立 Node 子进程中运行，默认一件。岗位按初始化完成顺序各自开始工作；初始化中的岗位不会被 poll/invoke 提前驱动。私有 SDK 在制作席首次使用时加载，SDK 缺失不阻塞主播。
- 工程事实写入本地 fsync WAL。恢复折叠事实、恢复幂等与节目时间，不自动重放已提交音频或 take。浏览器重新连接时对账场景与音频。
- 浏览器网关只允许一个播放窗口；另一窗口不能重复发声。备场与输入更新采用异步命令/回执。
- React 19 场景宿主使用官方 Remotion Player 4.0.535 和 HyperFrames Player 0.8.212。生成的源码在禁止同源权限的隔离 iframe 里执行，不能共享控制器的 JS 全局对象。首次握手校验来源窗口、实际 origin 与实例 nonce；在加载生成代码之前建立私有 MessageChannel，后续操作与回执不经过生成代码可监听的 Window 消息。
- Scene 原生 frame adapter 使用最新帧背压；Remotion/HF 正常播放，不逐帧 seek。源码修改产生不可变候选，输入 patch 保持场景实例。每个 patch 原子预留 operationId 与输入版本，确认回执只能兑现绑定到该操作的提议；cue 与导播更新共享这个入口。
- 人声使用现有 ElevenLabs 合成器；真实媒体 playing/timeupdate/ended 驱动工程状态，逐字时标不使用字数均摊冒充。强切先撤销旧方向未来动作，直到浏览器停止回执才记音频 aborted。
- 旧舞台保留人物、布景、礼物/弹幕和字幕。新音频向常驻人物与字幕投送受来源校验的播放信息；旧导演、旧语音入口及自动垫话在 v2 接管时停止。

## 私有 SDK 来源

制作或导出时设置 `AIVTB_SDK_REPO` 指向有读取授权的 `reelmorph-agent` Git 检出。启动器从 Git 对象导出固定提交 `c73ac74f9a5479586f0ea5d39f5c40d2dc39a98b` 到被忽略的 `.deps/sdk/<commit>`，不会读取当前 HEAD 代替固定版本。Node 依赖复用该已授权机器的安装；因此需先安装该源项目的固定依赖。

公开仓只保存集成桥；快照、生成源码、bundle、语音和运行日志均在忽略目录。CI/其他机器仍须建立私有源访问，不能据本机成功宣称远端交付完成。

实际复用 Scene、Component Kit、SDK 模板和原生构建配置。制作席可检索本地组件源元数据、读取 SDK 文档，使用原生 GSAP/Remotion 模板或提交新源码编译。HyperFrames 的旧 capture Scene 需要额外提供 `liveHtml`；需要更新时，HTML 必须通过原生 `window.__hyperframes.registerRuntimeDataHandler` 注册消费方。没有消费方的条目不能宣称支持原地 patch。

## 仅模拟，不启动直播

```sh
export AIVTB_SDK_REPO=/absolute/path/to/reelmorph-agent
npm run harness:build
npm run harness:sim
# 在 Ego 浏览器打开输出的 scene URL；另一个终端运行：
npm run harness:sim:check -- <operator URL>
```

模拟器只装配生产 Runtime 与 SDK 渲染器，由脚本扮演岗位/观众，不创建 DSH 会话、不连接平台、不读取 TTS 密钥。报告写入 `.deps/harness-simulation-report.json`。

## 启动真实团队（本轮未启动）

需要 Node >=24、仓库各包的依赖和已授权 SDK 源项目的依赖。

```sh
export AIVTB_SDK_REPO=/absolute/path/to/reelmorph-agent
npm run harness:sdk
npm run harness:build
npm run harness:console -- --port 3850 --stage 3954 --brain 3952
```

场景端口默认 3930，可用 `AIVTB_SCENE_PORT` 改；控制台仍负责开关大脑。私有凭据沿用本地 `.env`/DSH credentials，不能放进场景包。

只启用 v2 环境时才创建真实团队，legacy 的 agent 工具/轮询不会同时启动。退出 v2 后启动 legacy 是独立模式重启，不让两个路径共同送播。

主人的明确切换可通过 `/live/start` 的 direction，或现有“告诉她”输入 `切换方向：…`；`立即切换方向：…` 执行强切。普通文本不会直接获得切换授权。群体反对由记录的去重输入与确定性政策复核。

内部控制口支持 `/live/status`、`/live/harness`、`/live/roles`（POST `{role,online}`）；仅本机 JSON 请求，拒绝带浏览器 Origin 的跨站控制。它们用于操作与诊断，不是观众流程。

## 已取得的证据

- 独立 Codex review 审查原始 PR 栈，报出 7 个 P1：跨方向/急件合并、提交失败后输入丢失、兑现证据关联、恢复时钟、候选错误上播声明、信任自报 origin、输入 revision 倒退。已按对应生产边界修复。
- 新增的 5 条内核/输入回归在原 PR 栈上全部失败，在修复分支上通过；另有 WAL 尾部写损恢复测试。保留原有测试中的真实不变量。
- 删除了“依赖必须不存在”和“源码不得导入 Player”的脚手架测试：这些断言在真实接入后已反向约束需求。真实浏览器运行承担相应证明，未删除真实播放回归来掩盖失败。
- Ego TaskSpace 125 的真实浏览器：固定 SDK 声明经真实构建进入官方 Remotion Player，隔离宿主连续 100 次 inputProps 更新，位置从 frame 1304 推进至 2844，未归零；该次约 54.3 秒。原生 HyperFrames runtimeData 连续 100 次更新，位置从 frame 28 推进至 2215，约 73.0 秒。数值包含前后台标签节流，不能称为通用性能保证。
- A 在播期间 B 备场，take 前 A 仍为 program；take 后旧 iframe 释放。浏览器实际检查过可见几何，曾发现并修复宿主高度为零的空白问题。
- 真实四会话试播产生编导任务、模型编写的 Canvas 场景、编译候选、备场、take/painted，以及真实 TTS playing、逐字进度和 ended 回执；没有注入模型回答或假音频。此段是开发试播，尚未覆盖主计划全部场景。

新增模拟验证：

- 模拟预制 B 方向：授权前 take 被拒；授权后同一 code hash 上播。未发布候选的资格从 WAL 中的任务/方向授权投射，重启不依赖逐个重写 manifest。
- 模拟观众直接修改在播参数：无需制作任务，只有对应 operationId 的实际 patch 绘制确认后才 presented。并发同输入版本、cue 与导播竞争均有回归。
- 编导初始化慢/失败、旧 Agent 实例回执、SDK 缺失、WS 断线后再发声、journal 换代和重放去重都有生产边界测试。刷新舞台后累计节目时间继续推进，未从零冻结。
- Ego 模拟 30 次 prepare/take，始终只有一个在播 iframe；本次本机 P50≈2068ms、P95≈2101ms，属于脚本+渲染器数据，不含云端模型/TTS/平台耗时。
- 原生 Film 的 183 帧、1080p/30fps 场景轨 MP4 已生成。源是带实际 take/patch/hold/resume 回执的模拟记录；hold 区间像素一致，正向/反向/重复 seek 校验通过。片段明确无声，没有伪造口播音轨。

## 原生 Film 回放/导出

```sh
npm run harness:film:export -- <run directory> <from ms> <until ms> <seek certificate JSON>
# 在已有 Ego TaskSpace 打开输出 URL，然后：
npm run harness:film:capture -- <space ID> <page label> <export log file>
```

导出桥真实调用固定 SDK 的 Film / VisualTrack / AudioTrack / HTML-document API。所有私有包解析到固定快照，拒绝掉回当前 HEAD 的 workspace 链接。原生 `__compositionFrameProgram.applyFrame` 使用 `waitUntil` 等待同一个隔离 Scene 宿主完成离线 `renderAt`；直播路径仍正常播放，不逐帧 seek。

当前导出范围是**场景画面轨**，不包含旧舞台的角色、侧栏等常驻 UI。选区最多60秒；只接受经认证的确定性组件，拒绝无实际可见起点的记录。输入变化和反向 seek 会重建离线实例，避免状态串入。当前 CLI 明确省略未要求/未具备证明的音频；原生 WAV AudioTrack 绑定与 MP3 拒绝已有结构契约测试，未冒充媒体解码/完整音频导出验证。

本机证据在 `.deps/*-100-result.json`、`.deps/*tests*.log`、`.deps/live-v2/events.jsonl` 和截图。包含私有生成内容的完整运行目录不自动上传公开仓。

## 尚需完成的完整验收

- 最终版本下完整共创试播、30 条优先互动的 P50/P95/最大值、主线内版本再迭代和冷切体验；开发期间的多次启动不能拼成一段无中断试播。
- 30 分钟完整资源趋势、实际帧呈现和漂移容限冻结；30 次模拟渲染切场不能替代长期运行和真实模型统计。
- D3、Three 等代表条目的独立能力认证，以及有外部媒体/复杂资源的就绪验证。
- 全舞台/完整音频的 Film 导出、任意有状态组件和 HF 的离线捕帧认证；本轮场景轨样例不能代表所有组件。
- 私有 SDK 在远端/CI 的交付方式、许可条件与可复现构建仍按 P0 跟踪。

这些项目没有验证前，不能将 P2/P4/P9 全部勾选，也不能把本实现标记为完整生产验收通过。
