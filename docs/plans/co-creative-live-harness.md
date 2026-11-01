# 观众共创直播 Harness 与场景生产体系：执行计划 v1

状态：供 Grok bot 组织、拆解和实施的计划。日期：2026-11-01。

执行入口：GitHub Issue #7。应用已发布代码基线：`8335e37505c4b3591fee1b4c3a048f388773c0b5`。

本计划整合并替代 Issue 中此前累积的起始角色草案。先落实职责和产物契约，不把某一种工具能力固定成一个常驻 Agent。本次交付计划文档，不启动实施；用户将让 Grok bot 组织后续工作。

## 0. 开工前必须知道

### 0.1 产品目标

建立一个能与观众共同创作、持续演出的直播间。舞台是正在制作和播放的视听工程；多个 Agent 并行工作，观众参与改变未来内容。

目标是**可控、可响应、有观看价值的节奏**，不是零制作时间、持续发声、持续切画面或不断制造新信息。

### 0.2 不可反转的用户约束

1. 一个大方向维持一段时间，小方向、段落、表达方式和作品版本可以变化。
2. 只有 master 明确切换，或达到已定义的群体反对规则，才更换大方向。普通沉默、观点争论、单人刷屏、下一场做完，均不构成自动切换授权。
3. 编导研究观众想看什么；没人提要求时主动准备后续内容。它提供内容、备选和衔接建议，不审批全部现场行为。
4. 主播掌握当下表达、接话、即兴和停顿；现场导播掌握连续播出、内容切入退出、画面驻留、声画配合和转场。二者共同控制临场节奏。
5. 编导无新内容、制作慢或后台任务失败时，主播和导播仍能正常工作。节目单不是发言许可证，主播不是只能照稿发声的 TTS 执行器。
6. 允许展示、观察、思考、等待和留白。不能默认“嘴空就垫话”“画面若干秒没变就加效果”或“静音超过六秒就失败”。
7. 调研、写代码、制作或旧模型生成不得同步卡住现场决策。重要输入是否需要立即口头回应，由现场判断，不强迫每条弹幕打断节目。
8. 画面能带动主播，主播也能带动画面；说话过程中仍可编辑未执行的画面/效果，不在 speak 入队时一次编好。
9. 下一方向可以提前准备，但准备和送播分离。不同方向的事实、故事、状态、素材和专属代码不能默认复用。
10. 基础 SDK、成熟组件库、Scene/Component Kit/语义 Cue/Film 是制作与渲染基础；优先复用真实能力，不另造一套功能贫乏的画布指令 DSL。

### 0.3 源库与公开边界

- 目标仓库：`rayson-x/dsh-vtb`，公开仓库。
- 可复用系统来源：`rayson-x/reelmorph-agent`，私有仓库。
- 本次研究固定来源提交：`c73ac74f9a5479586f0ea5d39f5c40d2dc39a98b`。相关 SDK 文件在该提交中存在且本地未修改；SSH 可读取，当前 GitHub CLI 身份访问该源仓返回 404。
- **Grok 在 P0 验证源库或私有 SDK 包读取权限。** 默认通过有授权的只读源快照/私有包使用；公开仓库提交集成代码与版本/provenance 信息，不擅自公开私有 SDK 实现或复制整个源项目。
- 若需要公开抽取某些 SDK 源码，先列出最小文件/依赖闭包与许可，再取得明确授权；这是实际的跨私有/公开边界，不是每次修改都要求审批。
- 若 bot 无法获取源实现，必须报告依赖阻塞。不能伪造 `@reelmorph/scene`、替换成空 shim，或自行重写一个同名接口后宣称复用了现有 SDK。
- `acceptance/effects` 是构建产物，不应假设远程 Git 克隆自带。来源脚本有 `effects:build`、`effects:sync`、`library:load`；P0 核实固定版本的重建路径与所需来源。

### 0.4 工作树保护

基线之外已有暂停中的草稿：DSH urgent-preempt 后端改动，以及独立侧栏原型。它们不是本方案已完成的证明。开工先盘点、保存补丁、评估复用，不 `reset --hard`、不清理未知文件、不把所有本地脏改动一起提交。其他工作者的改动不得回滚。

## 1. 现有资产与已核实缺口

### 1.1 固定 SDK 版本

以下来自源项目 manifest 与本地实际安装元数据，不以官网较新功能替代：

| 能力 | 固定基础 |
| --- | --- |
| React/React DOM | `19.3.0`，供场景制作与新场景宿主使用 |
| Remotion 与配套包 | `4.0.535`；Player、Bundler、Transitions、Three、Layout Utils、Shapes、Paths、Motion Blur、Light Leaks、Lottie、GIF、Media Utils 等同版本 |
| GSAP | `3.15.0`，含实际可用插件；按使用需要注册/加载 |
| Three.js | `0.186.1` |
| React Three Fiber / Drei | `9.8.1` / `10.7.9`；该系列要求 React 19 |
| 后处理 | `postprocessing 6.39.5`、`@react-three/postprocessing 3.2.2` |
| 数据与图形 | 已锁定的 D3 系列；OpenType、KaTeX、Rough.js、文字分词工具 |
| 动画素材与细节 | Lottie、GIF、Simplex Noise、Culori 等 manifest 中实际版本 |
| HyperFrames | 本地 `@hyperframes/core/engine/producer 0.8.212`；当前未安装 Player，不假装已经接入 |

当前直播插件仍使用 React/DOM `18.3.1`。**首版保留控制台/旧外壳版本，使用独立 React 19 场景宿主边界；不能把 R3F 9/React 19 场景直接塞入 React 18 的同一个组件树。** 每个场景 bundle 只解析一套 React/Remotion 实例。

不在此任务顺手升级所有依赖。新增正式包须锁版本、更新锁文件、核实随包许可和来源；旧导入脚本跳过 Remotion/Shotcraft 的历史决定不等于技术上不可使用。

### 1.2 优先复用的真实系统

以下路径相对源仓库固定提交：

| 系统 | 真实接口/位置 | 复用内容 |
| --- | --- | --- |
| Scene | `packages/svml/html-program/src/scene.ts` | `setup(root, props)` → `render(localFrame)` / 可选 `patch(props)` / `dispose()`；`defineScene`、`defineRemotionScene`、`defineHyperframesScene` |
| Component Kit | `library/components/_shared/` | props、cues、media、design、文字/媒体、根动效等共享实现 |
| 组件 catalog | `library/catalog/catalog.ts`、`install.ts` | 元数据、参数契约、来源与版本、复制可编辑源码、运行类型适配 |
| Scene 绑定 | `sandbox/program/scene-package.ts` | Scene 的 Param/Cue/Media 与 timeline/window → VisualTrack |
| 语义 Cue | `sandbox/program/cue-binding.mjs`、`packages/svml/semantic/` | 时间投射与词/段锚点表达；目前主要是编译阶段绑定 |
| Film | `packages/svml/film/src/{surface,program}.ts` | 将 VisualTrack/AudioTrack 汇成统一 Composition |
| 构建与预览 | `sandbox/program/{scene-bundle,remotion,preview}.mjs` | SDK alias、真实模块解析、打包、官方 Remotion 页面、modules/pages/media/metadata 预览包 |
| SDK 给 Agent | `sandbox/sdk/INDEX.md`、`src/tools/effects.ts`、`effects-scaffold.ts` | SDK info/read/search/list；effects search/get/pick/scaffold；可编辑模板与用法 |

### 1.3 必须补齐，不能靠“依赖已安装”冒充完成

1. 当前 Remotion adapter 没有原地 props patch；props 变化会 dispose/setup iframe。实时票数/文本不能每次重载。
2. 当前 HF patch 只接受部分有效输入不变的更新；params/media/design 变化仍重建。本地桥没有完整 runtimeData 路由。
3. 现有 `render(frame)`/ready 链以制作、精确 seek 和导出为主，没有证明所有 Three/shader 场景可直播 30fps。
4. `clock:'virtual'` 的服务器回放截图路径、离线 engine 捕帧不能直接搬到直播主链。
5. Film/语义 Cue 的编译表达不等于已有无限直播、观众事件总线和未来增量改轨。
6. HyperFrames 的公开 Player 有正常播放与 runtimeData 接口，但改 src 会导航；其预览 swap/hold 不能当成无条件直播热更。`renderSeek` 会影响音频/暂停，不可每帧调用并假设仍正常播放。
7. 当前 aivtb 的 `Graphics.tsx` 主要是导入 HTML 效果与自制兼容变量，不是完整上述 Scene SDK 宿主。

## 2. 目标结构与职责

### 2.1 四类职责、独立工作循环

首版：编导、现场导播、主播各一个常驻实例；制作池默认一个实例，最多两个并行，按任务拆调研/代码等能力。此数量是可运行起点，不要求一种能力一个永久 Agent。

| 角色 | 自己决定 | 能写的产物 | 不应承担 |
| --- | --- | --- | --- |
| 编导 | 观众可能想看什么、无人请求时后续内容、当前方向内的发展与备选 | EditorialProposal、内容池、制作任务、下一方向预备包、交接建议 | 审批全部发言、独占现场节奏、越权切大方向 |
| 现场导播 | 连续演出节奏、何时驻留/切入/退出、声画配合、转场、选哪个就绪版本 | ProgrammeTimeline 的演出安排、Scene/Cue/输入与备场命令 | 长研究、编译制作、替主播写每句话 |
| 主播 | 当前表达、接谁、即兴、追问、语气、停顿；提出临时互动/制作请求 | SpeechOffer、口播意图与反馈 | 被节目单当许可证、承担长编程/调研、独自改大方向 |
| 制作池 | 在任务目标与 SDK 中选择实现和迭代办法 | 资料、Component/ScenePackage 不可变版本、预览与验证结果 | 直接替换在播版本、改播放器核心、抢现场控制 |

主播与导播双向带动。导播给“收束/继续/停留/准备切入”等短 cue，主播在自然话尾协调；不要求每句话先过导播模型批准，更不等编导审批。

### 2.2 多 Agent 的运行要求

- 使用现有 DSH AgentRegistry 创建独立 session/context/inbox/工具白名单，不能用同一个 LLM 对话串行切提示词假扮多个岗位。
- 允许同一个进程和异步调度器承载多个 Agent；“JavaScript 事件循环”与“模型工作循环”不是同一概念。
- 每个 Agent 都有独立的 observe → decide → tools → feedback → revise/yield 循环；不是给主持人每段台词跑一次装饰调用。
- 不把生产结果或普通补料通知做成当前语音工具链必须等待的子调用。
- 为主播/导播保留请求并发与 TTS 优先通道；制作池不能占满共享模型/任务队列导致现场排队。
- Agent 之间主要交换结构化产物与事件，不递归转发完整对话，也不为每条弹幕全部唤醒。

### 2.3 最小技术分层

保留现有控制台与输入源入口。建议按边界拆模块，目录可小调，职责不可合并回单一大 loop：

```text
现有 packages/dsh-livestream
  live/domain       工程、方向、提议、任务、权限、版本与事件契约
  live/events       平台输入归一、聚合、优先级与角色收件箱
  live/agents       editorial / director / performer / production
  live/production   任务与产物登记、截止/取消、候选就绪
  live/timeline     实际演出安排、语义锚点、未来编辑与回执
  live/playback     场景宿主协议、ProgrammeClock、AudioBus桥

独立 scene-host 子项目/包（React 19，单独构建）
  已授权的 Scene/Component Kit/Film 基础依赖
  Remotion/HF/DOM/Three 等真实运行 adapter
  Program / Preview / Persistent surfaces
  ScenePackage loader、输入更新、生命周期和事件回执
```

不要为了整洁重写 DSH、FFmpeg、字幕、Live2D、平台连接器和已有 SDK。私有 SDK 的包/镜像交付方式由 P0 明确；公开目标仓不擅自 vendor 私有实现。

## 3. 状态、产物与控制权契约

本节是**本项目要实现的域契约**，不是声称 SDK 已有同名 API。最终 TypeScript/schema 由契约负责人统一维护。

### 3.1 核心实体

| 实体 | 至少保存 |
| --- | --- |
| ShowProject | 节目方向、当前 DirectionSession、revision、频道稳定状态、观众贡献、播放记录 |
| DirectionSession | id/epoch、持续承诺/核心问题、边界、共创结果、已知资料、未解问题、内容池、状态 |
| AudienceProposal | source/eventIds、去重观众、意图、与当前方向关系、状态、关联任务/片段、兑现证据 |
| EditorialProposal | 当前方向内的段落意图、观看价值、参与入口、承接/收束点、最低物料、备选方案 |
| ProductionTask | id/version、目标、directionEpoch、优先级、输入/依赖、截止、取消标记、产物引用 |
| AssetVersion/ScenePackage | 不可变代码/资源版本、hash、依赖版本、schema、能力、预览/验证与来源 |
| ProgrammeTimeline | 轨道、片段实例、cue绑定、实际播放状态、可编辑边界、revision |
| SpeechPart | 唯一partId、文本、音频引用、真实逐字时标、实际播放区间、未念/取消范围 |
| PlaybackEvent | 实际应用/绘制/发声/结束/失败回执；与 event/task/scene/part/cue 关联 |

提议的 received/accepted/creating/ready/presented/deferred/cancelled 分别记录。制作完成或语音入队不能直接变成“观众已看到/已兑现”；兑现声明须能关联实际播出记录，且语义质量仍可审阅。

### 3.2 单一所有权与并发

- 编导写编辑建议，不直接覆盖实际演出轨。
- 导播写视觉/镜头/片段安排；主播提交口播，语音调度器独立接纳合法现场发言，不串行等待导播一次模型审批。
- 制作池只发布产物与候选版本；Runtime 写真实执行状态。
- 所有写入带 idempotencyKey、expectedRevision、directionEpoch，异步工作再带 taskVersion/sceneInstanceId。
- 冲突返回明确类型与最新快照，例如 STALE_DIRECTION、REVISION_CONFLICT、SCENE_NOT_READY、UNSUPPORTED_LIVE_PATCH、CUE_ALREADY_EXECUTED；不能静默覆盖或无限重试。
- 过时任务可保留有用产物入库，但不能凭迟到的 ready 事件上播。旧场景的迟到 ack/painted 不能污染新实例。

### 3.3 消息结构

事件至少有 eventId、type、sequence、source、receivedAt、相关 showTime、directionEpoch、correlation/causation、payload。

区分：外部观众输入、内容提案、制作结果、演出命令、实际执行回执。Renderer 不订阅原始弹幕后自行生成节目；Agent 也不把内部任务日志直接当成观众内容。

### 3.4 各角色读模型

- 主播：当前方向卡、当前可见画面简报、最近必要对话/互动、导播短 cue、自己的发声状态。
- 导播：当前 Programme、近期可编辑窗口、场景能力/cues、就绪候选、观众简报、主播实际意图/发声。
- 编导：观众兴趣证据/假设、当前方向进展、共创后果、待兑现事项、内容池与制作就绪情况。
- 制作池：当前任务、相关资料与素材、固定 SDK 文档/组件契约、目标 Scene 和验证反馈。

完整记录留在工程事件库，不塞给每个低延迟角色。不能将“重做一次全场上下文压缩”作为现场节奏前置条件。

### 3.5 工具权限与一次并行协作

以下是待实现的工具端口名称示意，不是现有 DSH/SDK 的原生 API：

| 角色 | 允许的工具族 | 权限边界 |
| --- | --- | --- |
| 编导 | readShow、readAudienceSummary、publishEditorialProposal、requestProduction、prepareDirection | prepare 只能建候选；无 take、切换授权签发、播放中止权限 |
| 导播 | readProgramme、inspectCandidate、prepareScene、editFutureTimeline、updateInputs、take、sendPerformerCue | 所有现场写入经过 Runtime 校验；只能消费有效的方向切换授权 |
| 主播 | readLiveBrief、offerSpeech、yieldSpeech、requestInteraction、requestProduction | 不直接加载代码或覆写视觉轨；普通口播无需导演模型批准 |
| 制作池 | readTask、sdk/effects检索、工作区源码/构建/预览、publishCandidate、reportProgress | 无在播控制权限；无生产凭据；产物登记不等于送播 |

群体反对由输入聚合器保存去重证据，编导/现场可提议分类；确定性方向控制器复核配置、证据与当前 epoch 后签发一次性授权。master 命令经现有可信身份入口签发；观众文本声称“我是master”不能获得控制权。模型的普通叙述不能绕过授权检查。

典型流程：观众提出变体 → 路由器同时给主播/导播必要简报并更新编导兴趣证据 → 主播自行决定回应、追问或继续展示 → 编导登记提议并发制作任务 → 制作池生成 v2、验证并发布候选 → 导播在合适节点预备/take → Runtime 确认实际显示 → 提议才进入 presented，下一轮反馈可产生 v3。任何一步的后台耗时都不让主播等待该调用返回。

首版命令信封最小形态为 `{commandId, idempotencyKey, actorId, directionEpoch, expectedRevision, target, payload}`；Runtime 从已认证角色映射核对 actor，不能相信调用方自报。读模型返回各实体 revision，写入仅比较目标聚合的 revision，避免全局一个计数导致独立口播/画面互相冲突；跨方向切换事务由方向控制器协调。

口播采用单一 SpeechScheduler 排队，首版同一时刻一个主播人声；导演短 cue 是内部控制消息，不发声。切场与 offerSpeech 同时发生时，调度器在入队及开播前复核 epoch/收束 lease；若已获强切授权则中止不再合法的正在播出部分并记录边界。普通停止模型生成不具有这个音频中止权限。

SpeechPart 状态为 offered → accepted → queued → starting → playing → ended，另有 rejected/cancelled/aborted/failed。单一 Runtime 协调器按事件序列裁决方向提交、口播撤回/开播、cue dispatch 和 take，模型只发命令，不互持模型锁。starting/dispatch/take 执行前完成最终合法性检查并记录序号；此后编辑返回 TOO_LATE，须走显式停止/收束，不能假装尚未执行。实际媒体 playing/painted 是后续事实回执，不能以命令受理序号冒充真实发声/绘制。设备已启动而回执未到时也按已提交执行处理，失败另记。

## 4. 方向持续、场次交接与节奏

### 4.1 内容层级

大方向/节目承诺 → 可变化的段落 → 镜头与多轨执行。编导维护弹性运行单，导演维护真实演出 Timeline；运行单不是整场逐字稿，播放器时间线也不等于大方向策略。

编导持续供给：观众兴趣判断、当前方向内容池、弹性运行单、下一方向预备包、场次交接建议。没人请求也能提出下一段；不因没有消息而停工，也不因想证明活跃而逼现场输出。

### 4.2 可执行的首版默认政策

以下是产品配置的起点，不是行业标准；不得硬写进模型提示词。配置变更有记录：

- 当前方向没有固定自动寿命。目标自然完成时，可展示、复盘、接受反馈或在当前方向继续；不自行新增“时间到/做完就换方向”权限。
- master 普通切换：在当前自然话尾/约定收束点实施，不等待全套新素材。明确“立即停止/马上切”可强切。
- 群体否决默认可自动触发切换，不再逐次等 master；语义必须是拒绝继续当前方向，不能把观点争论直接当否决。
- 建议初始观测：120秒活跃去重观众集合、30秒反对窗口、至少5名不同观众、明确反对比例至少60%、持续两次评估且跨度至少10秒。所有值可配；小房间不足绝对人数时不凭一两个人的高比例自动换主线，可调整小段或询问意见。试播须校准，不声称这些数字有行业证明。
- master 未指定下一方向时，编导提供有理由的候选，导播结合真实偏好和就绪程度选择；不要求每次投票。
- 编导离线时，导播可在有效切换授权范围内选择已有候选；没有合适候选则先撤下被否决内容，进入中性过渡，由主播询问观众下一方向。此时不虚构新方向，临场交流仍可继续；下一方向明确后再提交，不能因缺编导而继续播放已被否决的内容。
- 当前制作优先；空闲时预备一个较成熟的下一方向启动包与少量低成本想法，不默认提前精作许多整场。
- 普通临场意见分歧：导播发收束/延长 cue，主播自然配合；不直接替主播写话或硬静音。切换已授权后，拒绝新提交的过时方向口播，但可让已在发声的合法收束结束。master 强制命令优先。

### 4.3 切换事务

切换记录原因、授权来源、from/to epoch、软/强策略、保留/撤回事项、过场与候选引用。

唯一提交者是 Runtime 方向控制器：接收带 expectedEpoch 的 switch 命令，在同一持久状态事务中消费一次性授权、递增 epoch、失效旧 future 动作并签发有限收束 lease，再发事件通知各角色。即使下一方向尚待明确，也建立新的过渡 epoch；有候选后提交该 epoch 的方向内容，不恢复旧方向。执行端在 speech start、cue dispatch、take 前复核最新 epoch/lease；断线重连按持久序列恢复，不重放已提交执行动作。

1. 确认授权，逻辑上建立新方向与过渡计划。
2. 撤销旧方向未执行的排播、cue与过时任务；不能回写已播历史。允许的旧场收束只对已在执行部分发短期 lease，不允许继续追加旧题。
3. 把未兑现承诺明确延期/撤销并归档，保存观众贡献与作品版本，不假记完成。
4. 导播选择过场/新场开口，主播无需等编导批准才能回应。
5. 新专属画面未就绪时，中性频道呈现与主播仍可工作；不让旧方向因为技术未完成而继续占场。
6. 候选画面达到实际就绪条件后，导播决定 take；新画面确认可见，再释放旧实例和资源。

### 4.4 三种衔接

| 情况 | 内容处理 | 制作处理 |
| --- | --- | --- |
| 获授权且已预备 | 收束旧结果/贡献 → 新场观看与共创承诺 → 首个可播片段 | Preview 检查后送播，不因 ready 自动切 |
| master 冷切未备方向 | 迅速确认新方向，按切换策略结束旧场，进入新方向的轻量开场 | 专属物料并行制作；可用通用舞台/字幕/组件呈现新的内容 |
| 制作超时 | 留在新方向，导播与主播选择停留、局部成果、同方向低依赖内容或解释安排 | 编导更新备选；缩小交付，不假倒计时，不擅自跳第三方向 |

过场本身要有观看价值，但可以安静：观察作品、让观众思考、等待决定、讨论草图或比较已完成版本。不能靠反复“正在做”或强制观众不停答题消耗时间。是否把创作过程上屏，由编辑价值与现场节奏决定，不默认显示终端和编译日志。

### 4.5 节奏与空白

现场可处于说话、展示、互动、观察、停留或转场；这些是描述现场意图，不是规定固定节目循环，也不是让每次呼吸都申请许可。

长停留需有可理解的继续/退出条件；短自然停顿无需门禁。技术 watchdog 检测失联、不可恢复时钟/资源故障，不以静音时间或画面不变时长触发自动垫话/加效果。

## 5. SDK、成熟组件与场景绑定

### 5.1 三层基座

1. **基础能力**：Remotion、GSAP、Three/R3F/Drei、后处理、D3、文字/绘制/噪声/颜色等固定依赖。
2. **成熟组件与效果**：HyperFrames、Shotcraft、MagicUI、Paper Shaders、Remotion 效果，以及自有组件。
3. **系统集成**：Scene、Component Kit、语义 Cue、Film、统一预览和导出。

来源品牌与运行类型分开。现有 MagicUI/PaperShaders 条目已有按帧适配；不能假定原网站任意组件或某个来源所有条目天然可直播。

### 5.2 两条制作路径

**快速复用：** SDK/组件检索 → effects get/pick → 复制可编辑实现 → Scene 绑定 params/cues/media/design → 预览与能力验证 → 发布候选版本。

**临时创作：** 场景目标与现有积木 → effects scaffold 或 Scene 模板 → 原生 SDK 编码/组合 → compile/preview/验证 → 新版本候选。DOM/GSAP 用真实 Scene 接口，React 视频用真实 Remotion；Three/D3 等按需组合。

不把 native SDK 缩成只有 text/list/bars 的封闭 JSON API。Agent 可以编写真实源码，但在隔离任务工作区内，只交付 ScenePackage，不直接改正在播出的播放器。

临时场景局部效果不必都注册成全局组件；经验证、确有复用价值再沉淀 ComponentEntry。

### 5.3 组件契约

复用现有 ComponentEntry 的 params JSON Schema、cues、media roles、design、duration/aspect/cost、source/license/version、entry/dependencies。

补充可验证能力：实时运行方式、是否支持原地输入更新、确定性回放、hold/loop能力、资源/ready要求、音频归属、依赖闭包hash。未经验证的能力默认不成立。

一份 SceneDefinition 绑定布局/安全区域与组件版本、实例、数据来源、语义 cue；运行时 SceneInstance 单独有 instanceId、directionEpoch、inputsRevision、时钟映射。

必须分清：代码版本、场景实例、输入数据版本、节目安排版本、方向 epoch。票数变化不是代码换版，不能更换 React key 重播入场动画。

### 5.4 布局与动效

- 布局先按稳定几何计算，再应用动画；不能用入场中已偏移的 BCR 计算永久 fit，导致动画结束后越界。
- SDK 各管所长：Remotion 帧表达/Sequence；GSAP DOM/SVG编舞和 Flip；D3算图；Three渲三维。一个属性只有一个动画所有者。
- 当前节目中的常驻栏、字幕、人物等不因场景 params/cue 更新整体重挂。
- 侧栏按完整卡片容量处理，旧文本流顶部遮罩不能裁半张气泡；布局变化和进退协调，快速更新可减弱位置动效。
- 优先使用 SDK 已有动画与文字测量能力，不另造一个通用动画框架。必要的卡片容量/业务布局算法与 tween 引擎分开。
- 适配目标 viewport、长文本、两个现有布景和 reduced-motion；保持现有设计语言，不顺手重做整套 UI。

## 6. 实时场景宿主与播放

### 6.1 隔离边界

独立 React 19 场景宿主使用已锁 SDK；旧控制台和暂存外壳仍可 React 18。跨边界使用有 schema 的消息，不传 React实例、函数或依赖两个 React runtime 共享 hooks。

制作代码在独立任务工作区构建；生成场景运行在与控制台权限分离的宿主 origin/受限 iframe，不能读取模型密钥、文件系统服务或控制台会话。跨窗口协议校验来源窗口、origin/实例握手及消息 schema，资源经明确的 asset 引用加载；首版限制依赖闭包、资源预算和外部访问。iframe 不能隔离全部 GPU/CPU 故障，须配合验证、超时与退回常驻层；不宣称仅加 sandbox 就可安全执行任意代码。

同一包表达可用于制作预览、直播和离线导出，但**执行路径不必相同**。保留确定性制作/导出 adapter，新增经验证的直播 adapter；不要把服务器逐帧截图路径当实时播放器。

### 6.2 两类首版实时 adapter

- Remotion：用官方 `@remotion/player 4.0.535` 的真实 Component、稳定身份和 inputProps 更新做首版直播适配；旧 rendering-page bridge保留给精确制作/导出，不让每次投票重建iframe。
- HTML/HF：核实固定版本 Player/runtime 发布产物，再用其真实播放与 runtimeData 接口，或经验证的正式 runtime 集成。现有静态变量注入与 seek shim 不算 live patch 实现。
- 普通 DOM/GSAP/Canvas/Three frame 场景可用最新帧驱动的 adapter，但 render 背压只保留最新请求，不能积累过时帧。重场景可标预渲染或需降复杂度，不虚报实时能力。

所有路径对外遵守统一生命周期：load/prepare、ready、take、updateInputs/cue、hold/resume、retire/dispose。此为项目端口，由真实 SDK 方法适配，不是假称 SDK 已有同名全栈接口。

### 6.3 输入更新与源码换版分离

- live patch 包含 instanceId、codeVersion、inputsRevision、appliedAtShowTime，返回 applied/error，并记录实际绘制回执。
- 已认证实时组件在票数/文本等更新时保留 iframe、React/DOM 实例、播放位置和入场状态。
- 未支持 patch 的条目明确标记 requiresStandbyRebuild，在候选槽重建；不能把重载伪装成连续原地更新。
- 源码修改始终产生新不可变版本：旧版继续播，新版在 Preview 准备，导播选择替换点。
- Live patch 和 cue 是时间相关输入；事件按时间保存，不能只保留“最新票数”后声称可以回放过去。

### 6.4 Program / Preview / Persistent

首版两套可控场景 surface 加稳定常驻层：A在播，B备场；字幕/人物/基础频道呈现与音频总线不被候选加载重置。

候选就绪至少区分：模块装载、schema/资源状态、首帧绘制、业务版本匹配。SDK 的 ready、applied、assetsready、painted 不互相冒充；资源超时不能记为成功。

备场不能发声，也不能为加载 B 暂停 A 的节目时钟。take 期间明确可见层与音频归属，失败保持可演出的 A 或频道基础呈现；释放旧实例时清理监听、动画、视频、WebGL资源和待确认请求。

隐藏/离屏备场可能受节流；P1定义测量协议，P2实测并冻结就绪契约。不要只因 await 一个 Promise 返回就认定首帧可见。

## 7. 时间、语义 Cue、语音与 Film

### 7.1 唯一节目时间与局部时间

浏览器 ProgrammeClock 是实际演出的时间基准；后端同步其映射与状态。各 Scene 有局部 frame/time/hold/rate 映射，不能让独立墙钟偷偷成为第二个权威。

原生 Player 可正常播放并报告时刻；adapter跟随节目开始、暂停、恢复与有限漂移校正。**禁止默认每帧对正在播放的 Player 强行 seek。** HF seek会暂停、renderSeek涉及音频/捕帧；Remotion也不能把play与频繁seek混用当无代价同步。

P1定义测量与暂定端口，P2实测并确定 adapter 的漂移容限与校准策略，P3的实际播放接线和P7以此冻结结果为前提。视觉-only 的帧驱动与原生媒体播放分开；不得通过加速真实人声来补图形漂移。首版节目画面以1080p/30fps为基准，不承诺所有重shader/运动模糊都实时60fps。

### 7.2 语音独立与 AudioBus

- 主播可提交计划口播或临场 SpeechOffer；plannedBeatRef 可选。缺节目单不得阻止普通合法临场发言。
- AudioBus统一管理人声、音乐、声效；Scene预览不自发播放音频，同一音轨不能在parent与iframe重复发声。
- 预备台词与已提交播放队列分开；实际队列保持短且可在自然边界接入，不把未来一分钟全锁住。
- 记录实际 playing/timeupdate/pause/ended/aborted 与媒体引用、速率；字幕不是声音已播放的证明。
- TTS逐字时标与实际发声时钟形成锚点；缺alignment时明确 estimated 模式，不用均匀估时冒充真实逐字。
- 正在执行的音频受主播/现场协调和master控制，不因取消旧模型请求或制作worker而被自动撤回。

### 7.3 语义 Cue 的实时投射

复用现有 semantic Instant/Projection → Scene局部cue 的表达；新增运行时 resolver处理未知真实时长、即兴、软打断和撤回。

锚点引用独立 SpeechPartId 和 Unicode 字位置，或节目时间/明确节目事件。不要仅靠重复文本首次匹配定位。

已执行 cue 不改写或重放；未执行的 cue 随未来编辑更新。依赖的未念话被撤回或替换时，相关未来动作失效并通知导播；不得执行假锚点。已在场内容如何收束由其生命周期与导播安排处理，不回写已播历史，也不因此把整台变黑。

### 7.4 Film 与记录导出

复用 Scene → VisualTrack、独立 AudioTrack → Film Composition 的组合语义。

直播采用可编辑 ProgrammeTimeline 与已挂载 scene，不每来一条互动就重新编译/重载一部越来越长的完整 Film。回放/导出时，从实际播出事件、语音、输入版本和hold区间投射成有限 Film，再走统一离线制作链。

至少交付一段方向单元/选区的真实回放与导出。相同场景代码、资源版本、seed与输入历史应可重建内容；跨机器像素完全一致不作为未经证明的承诺，误差标准与参考环境要记录。

## 8. 低延迟、取消与故障隔离

### 8.1 快链并行

```text
观众输入 → 归一/聚合/路由 ┬→ 主播：现场判断、回应或停留
                       ├→ 导播：画面与近期演出判断
                       └→ 编导：兴趣判断、后续供给 → 制作池
制作池 → 就绪候选 → 导播选择 → 实际播出回执 → 所有角色相关读模型
```

收到事件不等于必须说话，快速处理也不等于强制打断。编导不在主播响应的同步依赖链上。

### 8.2 正式 DSH 急件抢占

安装版 DSH 0.2.1-rc.2 有正式 `cancel(cause,{keepInbox:true})` 后同步 `steer(message)` 的通路。用 assistant-stream start/end 按实际 Agent instance与attemptId追踪生成状态。

- 只有真实急件且主持人正在生成旧回复时取消该旧生成，再steer；不能先steer后cancel，不等whenIdle。
- 正在执行工具或普通闲时补料时不取消工具，只按正常steer/通知处理。
- 保留inbox和会话；核对本项目worker没有被父exec.signal间接连带取消。
- 舞台enqueue不绑定主持人模型turn abort信号；取消未提交生成不能硬停正在播的声音。
- 该机制解决旧生成阻塞，不自动保证任何云端模型在任意条件下都小于某个秒数。真实链路必须测量。

### 8.3 限额与历史

快角色保留请求资源；背景生产按task优先级/版本/截止调度，过时工作可取消。重复提议合并，不一条消息开一组Agent。

活动 timeline/scene/cue 集合与历史归档分离。tick只扫活动内容，历史分页/落盘；仍被未执行锚点引用的语音数据不可盲删。避免现有全场history每20ms全扫再全量snapshot的增长模式。

编导/制作池停止时现场继续；单场景失败不能拖垮整个舞台。角色恢复从结构化工程状态重建，不用让主播停下来等全局重启。错误反馈给相关角色/操作台，不默认把后台报错或假进度变成节目。

## 9. 默认验收预算与口径

### 9.1 不再继承的旧目标

删除或重写与本设计冲突的旧断言：全局静音六秒失败、空闲必须补话、画面不变就失败、每轮至少改轨若干次、每段必须有多个说明组件、所有发言必须结节目点。保留其真正保护的行为，不能为了全绿直接删掉真实回归。

### 9.2 分开测量

1. 系统收到输入 → 路由/现场决策开始。
2. 需要即时处理的输入 → 实际有效回应或节目变化。
3. 制作任务 → 首个可讨论/可播版本。
4. candidate ready → take → 实际可见/可闻。
5. 本地节目输出 → 目标直播平台观众端。

首次有效回应不限定音频，但纯内部ACK、排队成功或UI“收到”不能自动冒充实质回应。按节目意图分类样本，不能把不需打断的留言当超时。

首版建议目标：本地可控急件取消/新请求调度分别在200/500ms内完成；需要即时现场处理的真实样本先以P95≤5秒为优化目标。记录参考设备、模型/TTS/网络、样本及全部失败；不把三次幸运成功当统计保证，不删掉慢样本。若外部接口本身超预算，单列原因与替代方案，不谎报达标。

### 9.3 必须完成的行为矩阵

| 场景 | 必须证明 |
| --- | --- |
| 编导无内容/暂停，制作慢 | 主播与导播仍能交流、即兴、展示或安静停留，不强迫垫话 |
| 重要输入遇到旧模型生成 | 真正abort旧生成并处理新消息；会话/inbox、worker和已排音频保留 |
| 方向持续 | 普通提议改变局部；沉默/观点争论不擅自换方向；无请求仍有后续供给 |
| 方向切换 | master软/强切与群体规则；旧future动作失效，迟到旧任务不抢播 |
| 当前/下一/过场内容 | 预备就绪不自动切；冷切有新方向的可用开口；超时不自动跳第三题 |
| 真实共创 | 提议影响一个可辨识版本，版本上场后反馈能继续改变下一版，保留贡献与兑现证据 |
| Live patch | 至少React/Remotion与HTML/GSAP各一个组件，连续100次输入更新不重载iframe、不归零、不重播入场 |
| Program/Preview | B加载、失败、超时都不阻塞A与主播；preview无声；take后旧资源可释放 |
| Cue/语音 | 有真实逐字时标与实际媒体证据；未念语句不得触发未来画面，played历史不改 |
| 并发冲突 | 过时revision/task/scene结果被拒；断线重连不重复执行旧cue |
| SDK代表场景 | 原生Remotion、HF/GSAP、D3与轻量Three分别有真实示例及能力认证；重场不虚报实时 |
| 常驻UI | 长消息、欢迎/礼物、研究出现消失、节目历史增长、快速增删、两布景/两布局；无半卡、遮挡或无意义重入 |
| 生命周期与历史 | 连续切场/重连、长时间运行后无持续资源增长、积累音频或失效订阅 |
| 回放/导出 | 实际输入、语音、hold与场景版本可复原选定播出区间，不只输出一段预编假演示 |

自动化负控先证明能抓到：幽灵cue、缺真实audio/starts、失败exit、无声跨段、输入触发重挂、空剩余合法归档、压缩采样区间假断档、真实poll错误。

真实观感不能只看DOM零报错。保留联系表、关键动态帧和时间线；人工检查段落是否有观看价值、留白是否自然、主播与画面是否互相理解、切场有没有内容接法。制作流程公开不等于所有工具细节都适合观众。

### 9.4 参考运行

- 可控边界测试：使用真实接口/运行时与阻塞fixture验证隔离、取消、版本和媒体状态；不写CSS字符串/配置表抄写断言或测试专用生产接口。
- 真实Agent试播：不少于15分钟，包含无人要求、主线内共创、已备切换、master冷切、主动留白、慢制作；不注入模型答案、画面计划或假音频。
- 优先互动样本至少30条，完整报告P50/P95/最大值和条件；真人/平台数据不足就明确标注，不声称统计留存保证。
- 生命周期压力：连续切换至少30次，输入更新至少100次；单独做至少30分钟的活动集合/资源趋势检查。静态hold不要求无意义每帧重绘。
- 动画示例1080p/30fps，记录实际frame呈现分布与重资产降级方案；同帧/反向seek与回放状态核对。

## 10. Grok bot 任务组织与依赖顺序

不要让多个工作者同时大改同一个 `agent.ts` 或公共schema。契约负责人先拆接缝，集成者最后接薄入口；工作者明确目录所有权，发现他人变更要适配，不能回滚。

| 任务 | 依赖 | 负责人范围/产物 | 完成条件 |
| --- | --- | --- | --- |
| P0 基线与来源 | 无 | repo/dirty-work审计；SDK source权限、固定快照、许可与重建路径、执行环境 | 有可读取的真实SDK/库来源与版本；未公开私有实现；无假shim |
| P1 契约与模块边界 | P0的来源结论 | domain/schema、角色读模型、权限、revision/epoch、Clock/SceneHost端口 | 能用事件序列解释上述矩阵；公共契约有单一负责人 |
| P2 SDK/实时可行性 | P0，遵守P1 | 独立React19宿主、两类live adapter、真实组件与SDK导入 | patch保实例、正常播放/hold、A/B备场、音频唯一、readiness可证；不能仅有静态截图 |
| P3 工程与播放内核 | P1；领域部分与P2并行，真实播放接线依赖P2冻结契约 | 事件库、ProgrammeTimeline、语义实时投射、AudioBus/回执/版本 | 无Agent时可用fixture验证执行、失效、历史与恢复；无伪造真实播放 |
| P4 组件生产链 | P1+P2端口 | catalog/ComponentKit、pick/scaffold、ScenePackage、能力与来源metadata | 现成快搭和SDK新效果两条路径可用；至少代表组件认证 |
| P5 Agent运行与路由 | P1+P3 | 独立DSH sessions/inboxes/tools、优先级和取消/限额、读模型 | 长生产不阻塞现场；无共享对话扮多岗；无强制持续输出 |
| P6 编导与制作 | P4+P5 | 当前/下一/过场内容池、兴趣判断、运行单、生产任务 | 无请求主动供给，遵守主线授权，后台提交的只是候选 |
| P7 主播与导播 | P2+P3+P5 | 自主演出、实际Timeline控制、cue反馈与冷切 | 无编导可工作；双向带动；不逐句等编导/导演模型审批 |
| P8 迁移与控制台 | P6+P7 | 旧入口薄适配、状态/操作台、feature flag、输入源保持 | 同一舞台只能一个控制路径；用户数据/素材不丢；有切回策略 |
| P9 完整验证与交付 | P8 | 行为矩阵、真实试播、回放导出、资源趋势、文档 | 证据可审查，关键缺口不隐藏；代码/文档/已知限制一致 |

建议并行组：SDK与Renderer、领域/播放内核、生产/组件库、Agents与内容、验证集成。依赖契约可以并行讨论，但P2不通过前不要把整套Agent接到假实时播放器上。

每张子issue写清：问题、输入、输出、所有权、依赖、完成条件、验证、遗留。常规实现按本文默认自行推进，不逐步找master确认；真实源库权限、需公开私有代码或超出既定产品权限的选择必须明确报告。

## 11. 迁移规则

- 使用显式legacy/v2模式，默认不让两个导演/计时器同时发同一舞台指令。停掉旧loop/订阅，不只丢弃其输出继续烧模型调用。
- 先复用输入源、控制台、角色资源、基础舞台与已有可用测试；不要从头搬整个其他项目。
- 旧draw/graphic写法可有局部兼容适配，但不能继续成为新创作能力的上限。旧的每段装饰、主持人覆盖所有车道、空闲强填词不能重新引回。
- SDK制作包、播放器和任务工作区分开；源代码热改发布新候选，不改在播模块。
- 旧未提交草稿逐项评估，不自动发布。新组件体系下重新审视侧栏和Fitted测量，不能堆叠多个动效系统。
- 保留原始失败证据。旧全量测试绿不等于新实时架构验收通过；不改score阈值掩盖假接入。

## 12. 最终交付清单

- 架构/契约文档和任务DAG，说明每个Agent的决定权、工具、输入、输出和取消边界。
- 可复现SDK来源、依赖锁、真实组件catalog及能力认证记录。
- 两条制作路径与同一场景包的预览、直播、回放/导出示例。
- 主播/导播独立运行、方向持续、冷切衔接与观众共创版本迭代的真实演示。
- 自动测试、实际延迟样本、关键动态截图/联系表、时间线、资源趋势和全部已知限制。
- 运维说明：启动、模式切换、备场/回退、角色恢复、配置项、日志位置；控制台运行与大脑开关清楚。
- 提交/PR描述围绕最终行为与证据，不写“所有SDK都能实时/零等待/已保证留存”等未经证明的结论。

## 13. 参考依据与阅读优先级

### 项目一手来源

- 目标代码基线：`rayson-x/dsh-vtb@8335e37`；现有 blackboard/timeline/track/director 与控制台入口。
- 私有SDK来源：`rayson-x/reelmorph-agent@c73ac74f9a5479586f0ea5d39f5c40d2dc39a98b`，按1.2表阅读；获取权限见0.3。
- 必读制作契约：源 `sandbox/sdk/INDEX.md`、`scene.ts`、`component-library.ts`、`scene-package.ts`、`scene-runtime.mjs`、Film的surface/program、remotion/hyperframes adapter。

### 官方能力与方法

- [Remotion Player](https://www.remotion.dev/docs/player)、[Player最佳实践](https://www.remotion.dev/docs/player/best-practices)、[缓冲状态](https://www.remotion.dev/docs/player/buffer-state)：真实组件、动态props与播放器边界；文档新版功能需对固定4.0.535核验。
- [HyperFrames开发者分层](https://hyperframes.heygen.com/developers/overview)、[Player](https://hyperframes.heygen.com/packages/player)、[Frame adapters](https://hyperframes.heygen.com/concepts/frame-adapters)。只以HeyGen官方站/源库为依据。
- [HF 0.8.212 Player源码](https://github.com/heygen-com/hyperframes/blob/eba596d026347d2e25a95692d77bd0ca2b830fe3/packages/player/src/hyperframes-player.ts)：接口存在不等于本地已安装、接通或全部实时行为已经验证。
- [FRI producer职责](https://training.farmradio.fm/how-to-be-an-effective-producer-of-a-farmer-radio-program/)、[运行单](https://training.farmradio.fm/developing-a-run-sheet/)：受众研究、主动策划与弹性内容供给。
- [ScreenSkills producer](https://www.screenskills.com/job-profiles/browse/unscripted-tv/editorial/producer-unscripted-tv/)、[多机位导演](https://www.screenskills.com/job-profiles/browse/unscripted-tv/editorial/multi-camera-director/)：编辑规划与现场节奏的不同职责，不是固定Agent人数依据。
- [Blackmagic Preview/Program](https://www.blackmagicdesign.com/products/atemmini/software)：准备、预览、选择送播分离。
- [Twitch创作直播](https://www.twitch.tv/creatorcamp/en/level1/content-categories-on-twitch/creative-coding-co-working/)：让观众参与作品形成，同时判断哪些过程值得看。
- [Adobe Animatics](https://www.adobe.com/uk/creativecloud/animation/discover/animatics.html)、[J/L cuts](https://helpx.adobe.com/premiere/desktop/edit-projects/trim-clips/perform-j-cuts-and-l-cuts.html)：低成本预演与声画衔接方法，不是任意主题零制作时间保证。
- [YouTube直播延迟](https://support.google.com/youtube/answer/7444635?hl=en)：本地快速不等于观众端快速，目标平台须单独测量。

本计划的主线授权、角色自主权、节奏原则来自用户；具体域模型、默认参数、模块与阶段是工程方案。专业资料提供方法依据，不为这些产品默认值背书。
