# 共创 Harness：真实运行接线与验证记录

2026-11-02。实现分支承接 PR #28–#36 的领域契约与骨架；该历史记录当时默认legacy；最终集成已改为控制台默认v2，见文末。本文记录已经跑过的接线，不代替主计划的完整验收。用户于本轮要求停止直播并采用模拟测试，以下新增验证没有启动真实 DSH 模型、TTS 或平台输入。

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

## 直接复用现成组件

制作席调用 `searchEffects` 取得组件的 `path` 与 `reuse.effectPath` 后，可向 `workspaceBuildPreview` 提交 `effectPath`，替代 `source` 或 `template`。三种制作输入择一；任务版本、方向资格和制作限额仍照常检查。例如：

```json
{
  "directionEpoch": 1,
  "taskId": "opening-title",
  "taskVersion": 1,
  "effectPath": "library/sources/moving-letters/moving-letters-beautiful-questions",
  "props": { "params": { "text": "记忆里留下的光", "hold": 120 } }
}
```

`directionEpoch`、任务ID与版本必须来自当前简报，示例值不直接复用。复用入口从授权固定SDK目录解析真实Scene及其相对依赖；拒绝目录穿越与越界入口/metadata软链接。工作区只写入导入入口，公开仓不复制私有组件实现。候选manifest保留组件路径、ID、版本与来源，产物沿用原有代码hash、publish/prepare/take链；复用不自动授予实时、patch或离线回放认证。

2026-11-04本机验证：上述真实目录标题组件、使用已安装`d3-scale`的SVG示例、轻量Three/WebGL示例，分别完成编译、真实浏览器就绪、送播、帧推进与hold。固定SDK未提供`d3-selection`，不能因“支持D3”而假定所有子包可导入；该失败保留在记录中，示例改用真实可用依赖，未增加新库。以上只证明所选三个条目的有限运行，不代表全部catalog、复杂媒体、30fps预算或确定性导出均通过。

## 模式切回与宿主释放

v2接管时旧`/command`、`/speak`入口被拒，不能在运行中用`harness.mode=legacy`直接交回。应先停止v2运行，再关闭旧舞台宿主，以legacy模式重启舞台；方向、布景配置和已保存场次均保留，观众数据通过操作台选择场次恢复，不自动重播旧音频。

宿主`close()`先发布`interrupt`，让仍连接的浏览器/桥接端收到音频清除状态，再停止控制器队列/定时器，最后移除订阅。回归检查真实RemoteStage SSE上的停止状态、队列完成为interrupted，以及同端口重启后的方向/布景配置与观众场次恢复；音频URL在此测试中是控制面fixture，不声称解码真实音频。RemoteStage同时归一化根地址末尾的斜杠，避免复制舞台URL后请求到双斜杠路径。

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

## 初次集成的验收缺口（历史记录，最新状态见最终验证与issue）

2026-11-03 舞台合成修复：节目 iframe 已移入现有 1920×1080 舞台的展示区，共用等比缩放、图层与换场机制；不再按浏览器窗口百分比覆盖人物/侧栏。节目画面保持 16:9，布局切换只移动同一个播放器，旧工位在 v2 节目存在时不重复绘制。Ego 实测两布景 × 两布局 × 三种窗口（1920×1080、1280×800、800×1000），12 组均未与人物/侧栏/字幕/角标的框相交，播放器没有重挂或 reload。这是默认布局的合成修复，不代表任意自定义位置、长消息与所有转场均已验收；P8 仍开放。

后续侧栏修复：展示布局只显示当前节目点，聊天布局显示当前附近三点，保留原索引、总数及完整状态数据；长用户名与正文在画面中限行，不截断送给 Agent 的原文。ResizeObserver 按剩余空间显示完整弹幕卡，旧卡在空间恢复时直接显现，不卸载重播进场；弹幕进场使用原位淡入，避免滑入时被列表边缘裁切。真实浏览器以长名称、长正文、研究卡、欢迎条和完整12项节目单验证 watch/chat/watch；完整可见卡数为1/3/1，只有布局变化时也保持卡片和播放器身份。连续20次场景参数更新已完成，节目帧正常前进。快速增删、礼物及更多组合仍继续由P8跟踪。

播出文案只服务当前话题与实际互动；制作席/导播不自动添加“共创舞台”、SDK、参数更新说明或模拟状态等技术页眉页脚。这些状态留在操作台和验证记录。当前本地演示已撤下相关标签；此文仍明确记录它是脚本模拟，不代表真实模型/TTS试播。

- 最终版本下完整共创试播、30 条优先互动的 P50/P95/最大值、主线内版本再迭代和冷切体验；开发期间的多次启动不能拼成一段无中断试播。
- 30 分钟完整资源趋势、实际帧呈现和漂移容限冻结；30 次模拟渲染切场不能替代长期运行和真实模型统计。
- D3、Three 等代表条目的独立能力认证，以及有外部媒体/复杂资源的就绪验证。
- 全舞台/完整音频的 Film 导出、任意有状态组件和 HF 的离线捕帧认证；本轮场景轨样例不能代表所有组件。
- 私有 SDK 在远端/CI 的交付方式、许可条件与可复现构建仍按 P0 跟踪。

这些项目没有验证前，不能将 P2/P4/P9 全部勾选，也不能把本实现标记为完整生产验收通过。

## 最终集成的运行变化

控制台默认使用v2，legacy仅显式回退。控制台提供四岗位状态、暂停/恢复；SDK源码路径可以通过`npm run harness:sdk -- /path`保存到忽略配置，正常启动无需反复手工导出环境变量。纯领域/宿主CI与需要授权的私有SDK集成工作流分开，原始私有实现诊断不进入公开CI日志。

新增全舞台模式：`programme:record`用Ego获取实际呈现帧，并同时录取舞台音效/BGM/旧语音总线和受信场景客户端语音总线；按真实时间对齐为48kHz stereo WAV与有声MP4。`programme:export`校验全部媒体hash，使用原生Film的VisualTrack+AudioTrack生成回放工程和网页预览。画面为实际播出合成录制，CFR输出是对实际呈现帧重采样，不冒充每个源场景始终原生30fps；该路径解决Live2D等有状态呈现的完整记录，不把旧事件补造成过去的画面。已完成10秒真实语音窗口，两个实际音频tap，非静音混音与原生Film页面帧入口均验证。

长期运行发现并修复了v2上下文无限增长：各岗位pre-step用正式Session surface replacement按工具配对边界裁剪，旧历史不删除；普通主人指令单独持久化并有独立便签通道。角色读模型只含局部活跃状态/修订，写工具不重复携带整份工程；SDK文档与细节可以分页读取。模型输出预留按岗限额，turn失败进入可观察退避而不持续灌入同一份超限历史。插件使用宿主DSH SDK peer，避免混装两套SDK导致会话类型/服务实例分裂。

下一段已排语音可在当前播放时并行合成，但只能由前一段真实结束回执触发播放；撤回/换方向释放未来槽和合成任务，不撤销模型cancel以外的已排演出。相关回归在修复前确实失败，修复后通过。最终性能与持续运行结论须使用该修复合并后的验证记录；前一轮发生context overflow的后半段不能计为成功验收。
