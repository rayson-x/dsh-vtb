# P9 证据骨架报告

这是 scaffold 报告，不是试播报告。没有真实 Agent 试播，也没有把未跑的测量写成 pass。

- Issue #26，父 issue #7
- 计划：`docs/plans/co-creative-live-harness.md` §9、§12、P9
- 基线：`cursor/p8-thin-adapter-skeleton-2dd4`
- 依赖：P0 SDK + P2 运行验收
- 完成条件：证据可审查（未勾）；代码、文档与已知限制一致（未勾）

- 这是 scaffold 报告，不是试播报告。
- 未记录试播时长、P50、P95、最大值或 1080p/30fps 帧分布。
- 旧全量测试绿不等于新架构验收。单元测试名只是夹具证据指针，不能把 §9.3 行为行写成 pass。
- 真实试播、连续 100 次 live patch、30 次切场和 30 分钟资源趋势均为 blocked。依赖 P0 SDK + P2 运行验收。
- Issue #26 的完成条件未勾。

status=`pass` 只出现在负控行，表示注入的故障被 harness 抓住，并且干净样本没有被误报。§9.3 行为行、§9.4 运行行和 §12 交付行都不是 pass。

## 矩阵

| id | 章节 | 场景 | status | 阻塞 | 缺口 |
| --- | --- | --- | --- | --- | --- |
| editorial-gap | 9.3 | 编导无内容/暂停，制作慢 | skip | — | 夹具覆盖了无编导时不垫话、制作慢不换方向。真实试播未跑，本行保持 skip。 |
| urgent-preempt | 9.3 | 重要输入遇到旧模型生成 | blocked | REAL_DSH | 内存端口能先取消再改向，且不撤已排音频。没有真实 DSH 急件通路，不能标 pass。 |
| direction-continuity | 9.3 | 方向持续 | skip | — | 域序列和编导夹具覆盖了不擅自换向、无请求可放候选。候选不是真实供给，本行保持 skip。 |
| direction-switch | 9.3 | 方向切换 | skip | — | 夹具覆盖软切、强切、群体复核和迟到回执。真实 master 冷切与群体试播未跑，本行保持 skip。 |
| handoff | 9.3 | 当前/下一/过场内容 | skip | — | 三种衔接在域夹具里走得通。没有真实过场画面，本行保持 skip。 |
| cocreation | 9.3 | 真实共创 | blocked | P2_RUNTIME、REAL_TRIAL | 夹具能区分入队、制作完成和兑现。没有真实上场回执，也没有观众看见后再改下一版。 |
| live-patch | 9.3 | Live patch | blocked | P0_SDK、P2_RUNTIME、REAL_TRIAL | scene-host 的 100 次是协议记录，paintReceipt 为空，不是连续 100 次真实输入更新。依赖 P0 SDK + P2 运行验收。 |
| program-preview | 9.3 | Program/Preview | blocked | P2_RUNTIME | 内存 surface 能拒绝预览发声，也记录 dispose。这不是真实 B 槽，也不是 GPU、监听和音频释放证明。 |
| cue-speech | 9.3 | Cue/语音 | blocked | P2_RUNTIME | 夹具拒绝未念锚点、拒绝把 estimated 升成 real、拒绝把 starting 写成 playing。没有真实逐字时标和媒体回执。 |
| concurrency | 9.3 | 并发冲突 | skip | — | 域夹具覆盖过期拒绝和不重放。没有真实断线重连，本行保持 skip，不把夹具绿写成 pass。 |
| sdk-scenes | 9.3 | SDK代表场景 | blocked | P0_SDK、P2_RUNTIME | 两条制作路径和代表场景都还是 blocked，没有真实示例。禁止用空实现冒充 SDK。 |
| resident-ui | 9.3 | 常驻UI | skip | — | 契约测试这一行是 skip。旧布局套件不是新架构常驻 UI 验收，不能升成 pass。 |
| lifecycle | 9.3 | 生命周期与历史 | blocked | P0_SDK、P2_RUNTIME、REAL_TRIAL | 夹具只证明活动集、不重放和 dispose 不声称已测。没有连续 30 次真实切场，也没有 30 分钟资源趋势。依赖 P0 SDK + P2 运行验收。 |
| replay-export | 9.3 | 回放/导出 | blocked | P0_SDK、P2_RUNTIME、REAL_TRIAL | 回放导出测试是 skip。没有从实际播出事件投射的 Film，也没有一段真实回放。 |
| candidate-not-on-air | 9.3 | 候选不等于上播 | skip | — | P6、P7 和内核夹具都拒绝把候选或 take 受理写成上播。这不是观众端未见的试播记录。 |
| legacy-v2-single-path | 11 | legacy/v2 单路径 | skip | — | P8 夹具证明互斥和切回。真实控制台未接线，全量切流未做，默认仍是 legacy。 |
| trial-15min | 9.4 | 真实 Agent 试播 | blocked | P0_SDK、P2_RUNTIME、REAL_TRIAL | 未跑。不记录试播时长。依赖 P0 SDK + P2 运行验收。 |
| interaction-latency | 9.4 | 优先互动样本 | blocked | P0_SDK、P2_RUNTIME、REAL_TRIAL | 未采样。不写中位数、P95 或最大值。依赖 P0 SDK + P2 运行验收。 |
| switches-30 | 9.4 | 连续切换 | blocked | P0_SDK、P2_RUNTIME、REAL_TRIAL | 未跑连续切换。单次软切夹具不是这 30 次。依赖 P0 SDK + P2 运行验收。 |
| input-updates-100 | 9.4 | 输入更新一百次 | blocked | P0_SDK、P2_RUNTIME、REAL_TRIAL | 未跑真实 100 次更新。scene-host 的 100 次协议记录明确不是 live patch。依赖 P0 SDK + P2 运行验收。 |
| resource-trend-30min | 9.4 | 三十分钟资源趋势 | blocked | P0_SDK、P2_RUNTIME、REAL_TRIAL | 未测。不写资源曲线。依赖 P0 SDK + P2 运行验收。 |
| frame-distribution | 9.4 | 1080p/30fps 帧分布 | blocked | P0_SDK、P2_RUNTIME、REAL_TRIAL | 未记录帧分布。计划里的 1080p、30fps 只是基准口径，不是测量结果。 |
| delivery-architecture | 12 | 架构、契约与任务 DAG | skip | — | 执行计划在仓库里。还没有可当最终交付的架构说明，本项不勾。 |
| delivery-sdk-source | 12 | 可复现 SDK 来源 | blocked | P0_SDK | P0 未完成。没有可复现的真实 SDK 来源，也不把空实现写进目录。 |
| delivery-two-paths | 12 | 两条制作路径与回放示例 | blocked | P0_SDK、P2_RUNTIME | pick 与 scaffold 仍是 blocked。没有预览、直播或导出示例。 |
| delivery-live-demo | 12 | 主播与导播真实演示 | blocked | P0_SDK、P2_RUNTIME、REAL_TRIAL | 决策夹具不是真实演示。试播未跑。 |
| delivery-samples | 12 | 延迟样本、截图、时间线与资源趋势 | blocked | REAL_TRIAL、P2_RUNTIME | 有单元夹具。没有延迟样本、动态截图和资源趋势。旧全量测试绿不算本项。 |
| delivery-ops | 12 | 运维说明 | skip | — | 运维说明还没写。P8 夹具里的切回策略不是操作手册。 |
| delivery-honest-pr | 12 | 提交说明不夸大 | skip | — | 本骨架遵守这条。最终交付仍未完成，所以不把 §12 勾上。 |
| neg-ghost-cue | 9.3-negative | 幽灵 cue 负控 | pass | — | 注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。 |
| neg-missing-audio | 9.3-negative | 缺真实 audio 却标 playing | pass | — | 注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。 |
| neg-missing-real-starts | 9.3-negative | 缺真实 starts 却标 real | pass | — | 注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。 |
| neg-failed-exit | 9.3-negative | 失败 exit 记成成功 | pass | — | 注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。 |
| neg-silent-cross-segment | 9.3-negative | 无声跨段 | pass | — | 注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。 |
| neg-input-remount | 9.3-negative | 输入触发重挂 | pass | — | 注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。 |
| neg-empty-legal-remainder | 9.3-negative | 空剩余合法归档 | pass | — | 注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。 |
| neg-downsampled-false-gap | 9.3-negative | 压缩采样假断档 | pass | — | 注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。 |
| neg-swallowed-poll | 9.3-negative | 真实 poll 错误被吞 | pass | — | 注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。 |
| neg-painted-without-receipt | 9.3-negative | 无 paintReceipt 却标 painted | pass | — | 注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。 |

## 负控

注入判定的 fail 表示抓住了故障。干净样本的 pass 表示这份声明和证据一致，负控不报警。两者都不是试播通过。

| id | code | 注入判定 | 干净样本 | 负控有效 | 说明 |
| --- | --- | --- | --- | --- | --- |
| ghost-cue | GHOST_CUE | fail | pass | 是 | ghost-1 未绑定却标成 executed |
| missing-audio | MISSING_AUDIO | fail | pass | 是 | line-ghost-audio 标成 playing，但没有 audioRef 或媒体观察 |
| missing-real-starts | MISSING_REAL_STARTS | fail | pass | 是 | line-fake-real 标成 real，但没有逐字 starts |
| failed-exit | FAILED_EXIT_AS_SUCCESS | fail | pass | 是 | scene-a 退出失败却记成成功 |
| silent-cross-segment | SILENT_CROSS_SEGMENT | fail | pass | 是 | seg-a 到 seg-b 声称有声衔接，边界没有媒体观察 |
| input-remount | INPUT_REMOUNT | fail | pass | 是 | scene-a 输入更新换了实例或重载，却标成原地 patch |
| empty-legal-remainder | EMPTY_LEGAL_REMAINDER | fail | pass | 是 | 应留下 pinned-speech，归档后剩余为空却标成功 |
| downsampled-false-gap | DOWNSAMPLED_FALSE_GAP | fail | pass | 是 | 原始样本连续且都正常，压缩后的断档是假的 |
| swallowed-poll | SWALLOWED_POLL_ERROR | fail | pass | 是 | poll 失败被写成健康：platform-down |
| painted-without-receipt | PAINTED_WITHOUT_RECEIPT | fail | pass | 是 | scene-a 标成 painted，但没有 paintReceipt |

## 未测量

§9.4 各行 status=blocked。本报告不含试播时长、P50、P95、最大值或帧分布。

## 逐行证据

### editorial-gap

编导无内容/暂停，制作慢。status=`skip`。

主播与导播仍能交流、即兴、展示或安静停留，不强迫垫话。

缺口：夹具覆盖了无编导时不垫话、制作慢不换方向。真实试播未跑，本行保持 skip。

证据：

- `unit-fixture` packages/dsh-livestream/test/live-domain.sequence.test.ts :: 主播和导播照常口播、留白，不生成垫话。域序列：无内容时不造垫话
- `unit-fixture` packages/dsh-livestream/test/live-p7.decision.test.ts :: 编导暂停且收件箱为空时，主播可开口、可提问，导播可留白。决策夹具，不是真实无编导演出
- `unit-fixture` packages/dsh-livestream/test/live-p7.decision.test.ts :: 静音和画面停留都不生成口播、效果或失败。不强迫垫话
- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: 制作超时不新开方向；登记候选也不是送播。制作慢不换方向，也不上播

### urgent-preempt

重要输入遇到旧模型生成。status=`blocked`。

真正 abort 旧生成并处理新消息；会话、inbox、worker 和已排音频保留。

缺口：内存端口能先取消再改向，且不撤已排音频。没有真实 DSH 急件通路，不能标 pass。

证据：

- `unit-fixture` packages/dsh-livestream/test/live-domain.sequence.test.ts :: 取消未提交生成不会撤回已提交口播。只覆盖未提交生成，不是真实模型 abort
- `unit-fixture` packages/dsh-livestream/test/live-agents.harness.test.ts :: 急件先 cancel 再 steer，在播的 audioRef 和总线占用还在。内存端口，不是已安装的 DSH 急件通路
- `unit-fixture` packages/dsh-livestream/test/live-agents.harness.test.ts :: 工具还在跑时只 steer，不取消这次工具，也不停已排口播。工具执行中的取消边界
- `unit-fixture` packages/dsh-livestream/test/live-agents.harness.test.ts :: 取消过时制作任务不改已排口播。制作取消不撤已排音频
- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: 导播短 cue 不发声；取消未提交生成也不撤掉正在播的人声。短 cue 与取消都不改已播口播

### direction-continuity

方向持续。status=`skip`。

普通提议改变局部；沉默和观点争论不擅自换方向；无请求仍有后续供给。

缺口：域序列和编导夹具覆盖了不擅自换向、无请求可放候选。候选不是真实供给，本行保持 skip。

证据：

- `unit-fixture` packages/dsh-livestream/test/live-domain.sequence.test.ts :: 沉默、争论和主线内提议都不换大方向；没人请求也能供给下一段。方向持续的域序列
- `unit-fixture` packages/dsh-livestream/test/live-p6.editorial.test.ts :: 沉默、争论、自称 master 只改摘要，不切大方向。兴趣判断不切主线
- `unit-fixture` packages/dsh-livestream/test/live-p6.editorial.test.ts :: 当前、下一、过场都有候选，而且没有上播。无请求供给停在候选
- `unit-fixture` packages/dsh-livestream/test/live-agents.harness.test.ts :: 重复争论只留一条编导摘要，不唤醒主播和导播。争论不升级成现场切换
- `unit-fixture` packages/dsh-livestream/test/live-agents.harness.test.ts :: 观众自称 master 只进编导证据，不签发授权。观众文本不能签发切换

### direction-switch

方向切换。status=`skip`。

master 软切、强切和群体规则；旧的未来动作失效，迟到旧任务不抢播。

缺口：夹具覆盖软切、强切、群体复核和迟到回执。真实 master 冷切与群体试播未跑，本行保持 skip。

证据：

- `unit-fixture` packages/dsh-livestream/test/live-domain.sequence.test.ts :: 软切使未来动作失效，已在说的口播可收束，迟到旧任务不能上播。软切域序列
- `unit-fixture` packages/dsh-livestream/test/live-domain.sequence.test.ts :: 强切中止正在播出的旧口播并记下边界。强切域序列
- `unit-fixture` packages/dsh-livestream/test/live-domain.sequence.test.ts :: 群体反对要达到配置；观众自称 master 不能签发。群体规则是配置复核，不是试播校准
- `unit-fixture` packages/dsh-livestream/test/live-domain.contract.test.ts :: 小房间高比例不能通过群体反对复核。绝对人数不足时不自动换主线
- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: 软切作废未来片段和 cue，已派发的历史不改，持久层还在。未来失效，已播不改
- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: 强切中止正在播出的口播并记下边界，不改已经说出的词。强切边界
- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: 迟到的绘制回执标成孤儿，不把已撤下的场景写回在播。旧场景迟到 painted 不抢播
- `unit-fixture` packages/dsh-livestream/test/live-p7.decision.test.ts :: 没有一次性授权时，主播、编导和导播都不能切。越权切方向被拒
- `unit-fixture` packages/dsh-livestream/test/live-p7.decision.test.ts :: 只有可信入口签发的一次性授权能切；沉默、争论和自称 master 都不切。冷切只认一次性授权

### handoff

当前/下一/过场内容。status=`skip`。

预备就绪不自动切；冷切有新方向的可用开口；超时不自动跳第三题。

缺口：三种衔接在域夹具里走得通。没有真实过场画面，本行保持 skip。

证据：

- `unit-fixture` packages/dsh-livestream/test/live-domain.sequence.test.ts :: 预备就绪不自动切；冷切有开口；超时不跳第三题。三种衔接的域序列
- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: 制作超时不新开方向；登记候选也不是送播。超时不跳题
- `unit-fixture` packages/dsh-livestream/test/live-p6.editorial.test.ts :: 当前、下一、过场都有候选，而且没有上播。预备包不是送播
- `unit-fixture` packages/dsh-livestream/test/live-p7.decision.test.ts :: 门闩齐了也不切；显式 take 只是受理，没有 painted。就绪不自动 take

### cocreation

真实共创。status=`blocked`。

提议影响一个可辨识版本；版本上场后反馈能继续改变下一版，并保留贡献与兑现证据。

缺口：夹具能区分入队、制作完成和兑现。没有真实上场回执，也没有观众看见后再改下一版。

证据：

- `unit-fixture` packages/dsh-livestream/test/live-domain.sequence.test.ts :: 入队和制作完成都不是兑现；上场后的反馈才进入下一版。兑现必须能关联播出记录；夹具里没有真实上场
- `unit-fixture` packages/dsh-livestream/test/live-p6.editorial.test.ts :: 不 pump 就没有产物；ready 不 take，主播口播不靠这张回报。ready 不是送播
- `unit-fixture` packages/dsh-livestream/test/live-p6.editorial.test.ts :: 过期 epoch 的产物能入库，但不能 take，也不会进新方向的池。迟到产物留下，不上播

### live-patch

Live patch。status=`blocked`。

至少 React/Remotion 与 HTML/GSAP 各一个组件，连续 100 次输入更新不重载、不归零、不重播入场。

缺口：scene-host 的 100 次是协议记录，paintReceipt 为空，不是连续 100 次真实输入更新。依赖 P0 SDK + P2 运行验收。

证据：

- `unit-fixture` packages/dsh-livestream/test/live-domain.sequence.test.ts :: 未验证能力不能原地更新；已验证更新不换实例、不换代码版本。域规则，不是真实组件的 100 次更新
- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: 输入更新不会被记成已应用，Promise 和 SDK 信号也不能打开就绪门闩。无播放器时拒绝冒充已应用
- `unit-fixture` packages/scene-host/test/lifecycle.test.ts :: 100 次协议记录不是 live patch：applied 不带绘制回执，代数不变。反证：这 100 次不是 §9.3 的真实输入更新
- `unit-fixture` packages/scene-host/test/adapters.test.ts :: Remotion 与 HyperFrames 只有阻塞说明，没有工厂。两类 adapter 仍阻塞
- `unit-fixture` packages/scene-package/test/catalog.test.ts :: 不支持 patch 的 fixture 全部标注重建，而且没有认证。不能把重建伪装成原地更新

### program-preview

Program/Preview。status=`blocked`。

B 加载、失败、超时都不阻塞 A 与主播；preview 无声；take 后旧资源可释放。

缺口：内存 surface 能拒绝预览发声，也记录 dispose。这不是真实 B 槽，也不是 GPU、监听和音频释放证明。

证据：

- `unit-fixture` packages/dsh-livestream/test/live-domain.sequence.test.ts :: 备场不暂停节目时钟，预览不能发声，take 失败保持 A。域规则里的 A/B
- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: 预览不能发声，人声速率不被漂移补偿改掉，同一声道不能两处一起响。预览无声
- `unit-fixture` packages/scene-host/test/surfaces.test.ts :: B 的失败和未就绪 take 都不换掉 A，常驻层不动。内存 surface，不是真实 B 槽
- `unit-fixture` packages/scene-host/test/wiring.test.ts :: 装 B、B 超时都不暂停 A，门闩未齐不能 take。超时不阻塞 A 的夹具
- `unit-fixture` packages/scene-host/test/wiring.test.ts :: 四门闩齐了才换到 B，旧实例要另 dispose，预览不能发声。dispose 记录不是 GPU 释放证明
- `unit-fixture` packages/scene-host/test/lifecycle.test.ts :: cue 只记录派发，hold 不暂停节目钟，dispose 不声称资源已测。hold 与 dispose 都不冒充已测资源

### cue-speech

Cue/语音。status=`blocked`。

有真实逐字时标与实际媒体证据；未念语句不得触发未来画面，已播历史不改。

缺口：夹具拒绝未念锚点、拒绝把 estimated 升成 real、拒绝把 starting 写成 playing。没有真实逐字时标和媒体回执。

证据：

- `unit-fixture` packages/dsh-livestream/test/live-domain.sequence.test.ts :: 未念到的锚点不能出画面；已派发的历史不能改；estimated 不是 real。域序列拒绝假锚和假 real
- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: 未念到的字不能出画面；撤回未念部分只失效未来锚，已派发的不改。未念不触发，已派发不改
- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: 替换未提交口播后，原来的字位锚失效。换词后旧锚失效
- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: 相同文本不会落到另一段口播的首次匹配。锚点认 partId，不认首次相同文本
- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: 没有逐字时标不能标成 real，estimated 也不会被升成真实字位。estimated 不能冒充 real
- `unit-fixture` packages/dsh-livestream/test/live-p7.decision.test.ts :: 开播提交之后不能改词，也不能把 starting 写成 playing。受理不是 playing
- `unit-fixture` packages/dsh-livestream/test/live-p7.decision.test.ts :: 已派发的画面 cue 可以带出下一句；未念到的语义锚不能派发。双向带动停在决策夹具

### concurrency

并发冲突。status=`skip`。

过时 revision、task、scene 结果被拒；断线重连不重复执行旧 cue。

缺口：域夹具覆盖过期拒绝和不重放。没有真实断线重连，本行保持 skip，不把夹具绿写成 pass。

证据：

- `unit-fixture` packages/dsh-livestream/test/live-domain.sequence.test.ts :: 过期 revision 被拒；断线重连不重放已提交 cue；starting 之后 TOO_LATE。并发冲突的域序列
- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: 旧 revision 不覆盖；过期任务和场景不能上播；产物还在库里。过期写入被拒
- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: 恢复只折叠事实，再次派发被拒绝，提交钩子不再响。重连不重放已提交 cue
- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: starting 之后不能改词，take 之后不能改已提交片段；受理本身不是 playing 或 painted。已提交之后 TOO_LATE
- `unit-fixture` packages/dsh-livestream/test/live-p7.decision.test.ts :: revision、epoch 和未接线的 live patch 都按内核拒绝，并且不记成已绘制。导播命令不绕过内核

### sdk-scenes

SDK代表场景。status=`blocked`。

原生 Remotion、HF/GSAP、D3 与轻量 Three 分别有真实示例及能力认证；重场不虚报实时。

缺口：两条制作路径和代表场景都还是 blocked，没有真实示例。禁止用空实现冒充 SDK。

证据：

- `unit-fixture` packages/scene-host/test/adapters.test.ts :: Remotion 与 HyperFrames 只有阻塞说明，没有工厂。没有真实 adapter 工厂
- `unit-fixture` packages/scene-host/test/honesty.test.ts :: 验收标记保持失败，README 写明阻塞。scene-host 不把脚手架说成通过
- `unit-fixture` packages/scene-package/test/ports.test.ts :: 两条路径都是 blocked，sdk 为 unavailable，没有候选模块。pick / scaffold 仍阻塞
- `unit-fixture` packages/scene-package/test/honesty.test.ts :: 验收标记保持失败，两条路径和代表认证都不勾。scene-package 不把脚手架说成通过
- `unit-fixture` packages/scene-package/test/capabilities.test.ts :: 缺省能力全部不成立。未验证能力默认不成立
- `gap` TODO(P2/P4) SDK 代表场景。live-domain.sequence.test.ts 里这一行是 skip，没有 Remotion、HF/GSAP、D3、轻量 Three 的真实示例

### resident-ui

常驻UI。status=`skip`。

长消息、欢迎和礼物、研究出现与消失、节目历史增长、快速增删、两套布景和布局；无半卡、遮挡或无意义重入。

缺口：契约测试这一行是 skip。旧布局套件不是新架构常驻 UI 验收，不能升成 pass。

证据：

- `gap` packages/dsh-livestream/test/live-domain.sequence.test.ts :: TODO(P8) 常驻 UI：长消息、礼物、两套布景和无半卡。该测试是 skip，不是覆盖
- `gap` packages/dsh-livestream/test/regions.test.ts。旧布局套件文件，不是新架构常驻 UI 验收
- `gap` packages/dsh-livestream/test/sets.test.ts。旧布景套件，不能升成 pass
- `gap` packages/dsh-livestream/test/crew-layout.test.ts。旧画布套件，不能升成 pass

### lifecycle

生命周期与历史。status=`blocked`。

连续切场和重连之后，长时间运行没有持续的资源增长、积累音频或失效订阅。

缺口：夹具只证明活动集、不重放和 dispose 不声称已测。没有连续 30 次真实切场，也没有 30 分钟资源趋势。依赖 P0 SDK + P2 运行验收。

证据：

- `unit-fixture` packages/dsh-livestream/test/live-domain.sequence.test.ts :: 重连不重放，dispose 清掉该实例的域级订阅，迟到回执不写进新实例。域级订阅，不是资源曲线
- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: tick 只看活动 cue，历史页要另外翻；未执行锚点还引用的口播不能删。活动集与依法留下的口播
- `unit-fixture` packages/scene-host/test/lifecycle.test.ts :: cue 只记录派发，hold 不暂停节目钟，dispose 不声称资源已测。dispose 不声称资源已测
- `unit-fixture` packages/scene-host/test/measure.test.ts :: 缺测保持 pending，超时不会被收成成功。测量缺测不能收成成功

### replay-export

回放/导出。status=`blocked`。

实际输入、语音、hold 与场景版本可复原选定播出区间，不只输出一段预编假演示。

缺口：回放导出测试是 skip。没有从实际播出事件投射的 Film，也没有一段真实回放。

证据：

- `gap` packages/dsh-livestream/test/live-domain.sequence.test.ts :: TODO(P3/P9) 回放导出：用实际输入、语音、hold 和场景版本重建播出区间。该测试是 skip。没有 Film 导出，也没有一段真实回放

### candidate-not-on-air

候选不等于上播。status=`skip`。

候选就绪、制作完成或 ready 回报不等于上播；显式 take 的受理也不是 painted。

缺口：P6、P7 和内核夹具都拒绝把候选或 take 受理写成上播。这不是观众端未见的试播记录。

证据：

- `unit-fixture` packages/dsh-livestream/test/live-p6.editorial.test.ts :: 不 pump 就没有产物；ready 不 take，主播口播不靠这张回报。ready 不是 take
- `unit-fixture` packages/dsh-livestream/test/live-p6.editorial.test.ts :: 过期 epoch 的产物能入库，但不能 take，也不会进新方向的池。入库不是上播
- `unit-fixture` packages/dsh-livestream/test/live-p6.editorial.test.ts :: 当前、下一、过场都有候选，而且没有上播。内容池里的候选不上播
- `unit-fixture` packages/dsh-livestream/test/live-p7.decision.test.ts :: 门闩齐了也不切；显式 take 只是受理，没有 painted。take 受理不是 painted
- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: 制作超时不新开方向；登记候选也不是送播。登记候选不是送播
- `unit-fixture` packages/dsh-livestream/test/live-agents.harness.test.ts :: progress / waiting / ready / blocked / failed 都留下，ready 不是送播。回报信封不送播
- `unit-fixture` packages/scene-package/test/immutable.test.ts :: 取消和超时之后产物可以留下，但不能标成可上播。留下的版本不可上播

### legacy-v2-single-path

legacy/v2 单路径。status=`skip`。

同一舞台只有一条控制路径；切到 v2 停掉旧 loop 和订阅；可以切回；双路径同时 active 被拒。

缺口：P8 夹具证明互斥和切回。真实控制台未接线，全量切流未做，默认仍是 legacy。

证据：

- `unit-fixture` packages/dsh-livestream/test/live-p8.migration.test.ts :: 打开舞台时只有 legacy 是 active，再次打开不会再起一个控制器。默认 legacy，单路径夹具
- `unit-fixture` packages/dsh-livestream/test/live-p8.migration.test.ts :: 停 loop 和订阅，而不是只丢弃输出继续烧模型调用。切到 v2 会停旧订阅
- `unit-fixture` packages/dsh-livestream/test/live-p8.migration.test.ts :: 先停 v2 订阅，再恢复旧 loop。可以切回 legacy
- `unit-fixture` packages/dsh-livestream/test/live-p8.migration.test.ts :: activate 不会在另一条还活着时把第二条点亮。双路径同时 active 被拒
- `unit-fixture` packages/dsh-livestream/test/live-p8.migration.test.ts :: say、enqueue、danmaku 映射成 CommandEnvelope，不写成播放回执。旧命令映射不冒充播放
- `unit-fixture` packages/dsh-livestream/test/live-p8.migration.test.ts :: 旧画面上限、打断、填词和未提交草稿都不静默丢掉。不能映射的返回 unsupported
- `unit-fixture` packages/dsh-livestream/test/live-p8.migration.test.ts :: 切到 v2 再切回都不删除角色资源和素材引用。夹具清单还在，不是用户数据已迁移
- `unit-fixture` packages/dsh-livestream/test/live-p8.migration.test.ts :: 归一入口可挂在任一模式，同一批弹幕不能被两条路径一起消费。输入只进当前路径
- `unit-fixture` packages/dsh-livestream/test/live-p8.migration.test.ts :: 三条完成条件保持未勾，表格里的真实链路是 skip。P8 自己也不把夹具绿写成完成

### trial-15min

真实 Agent 试播。status=`blocked`。

不少于 15 分钟，包含无人要求、主线内共创、已备切换、master 冷切、主动留白、慢制作。不注入模型答案、画面计划或假音频。

缺口：未跑。不记录试播时长。依赖 P0 SDK + P2 运行验收。

证据：

- `gap` not-run。没有可引用的夹具，也没有试播记录

### interaction-latency

优先互动样本。status=`blocked`。

至少 30 条优先互动样本，报告中位数、P95 和最大值及条件。样本不足就标明，不声称统计保证。

缺口：未采样。不写中位数、P95 或最大值。依赖 P0 SDK + P2 运行验收。

证据：

- `gap` not-run。没有可引用的夹具，也没有试播记录

### switches-30

连续切换。status=`blocked`。

连续切换至少 30 次，检查切场后的订阅、音频和资源是否残留。

缺口：未跑连续切换。单次软切夹具不是这 30 次。依赖 P0 SDK + P2 运行验收。

证据：

- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: 软切作废未来片段和 cue，已派发的历史不改，持久层还在。单次软切夹具，不是连续 30 次运行

### input-updates-100

输入更新一百次。status=`blocked`。

输入更新至少 100 次，且不重载、不归零、不重播入场。

缺口：未跑真实 100 次更新。scene-host 的 100 次协议记录明确不是 live patch。依赖 P0 SDK + P2 运行验收。

证据：

- `unit-fixture` packages/scene-host/test/lifecycle.test.ts :: 100 次协议记录不是 live patch：applied 不带绘制回执，代数不变。反证：协议计数不是连续 100 次真实更新

### resource-trend-30min

三十分钟资源趋势。status=`blocked`。

单独做至少 30 分钟的活动集合与资源趋势检查。静态停留不要求无意义的每帧重绘。

缺口：未测。不写资源曲线。依赖 P0 SDK + P2 运行验收。

证据：

- `unit-fixture` packages/dsh-livestream/test/live-kernel.fixture.test.ts :: tick 只看活动 cue，历史页要另外翻；未执行锚点还引用的口播不能删。活动集夹具，没有 30 分钟趋势
- `unit-fixture` packages/scene-host/test/measure.test.ts :: 缺测保持 pending，超时不会被收成成功。缺测不能被收成资源曲线

### frame-distribution

1080p/30fps 帧分布。status=`blocked`。

动画示例按 1080p、30fps 的基准记录实际呈现分布和重资产降级。同帧、反向 seek 与回放状态要核对。

缺口：未记录帧分布。计划里的 1080p、30fps 只是基准口径，不是测量结果。

证据：

- `gap` not-run。没有可引用的夹具，也没有试播记录

### delivery-architecture

架构、契约与任务 DAG。status=`skip`。

说明每个 Agent 的决定权、工具、输入、输出和取消边界。

缺口：执行计划在仓库里。还没有可当最终交付的架构说明，本项不勾。

证据：

- `gap` not-run。没有可引用的夹具，也没有试播记录

### delivery-sdk-source

可复现 SDK 来源。status=`blocked`。

依赖锁、真实组件 catalog 及能力认证记录。不公开私有实现。

缺口：P0 未完成。没有可复现的真实 SDK 来源，也不把空实现写进目录。

证据：

- `gap` not-run。没有可引用的夹具，也没有试播记录

### delivery-two-paths

两条制作路径与回放示例。status=`blocked`。

同一场景包的预览、直播、回放和导出示例。

缺口：pick 与 scaffold 仍是 blocked。没有预览、直播或导出示例。

证据：

- `gap` not-run。没有可引用的夹具，也没有试播记录

### delivery-live-demo

主播与导播真实演示。status=`blocked`。

独立运行、方向持续、冷切衔接与观众共创版本迭代的真实演示。

缺口：决策夹具不是真实演示。试播未跑。

证据：

- `gap` not-run。没有可引用的夹具，也没有试播记录

### delivery-samples

延迟样本、截图、时间线与资源趋势。status=`blocked`。

自动测试之外，还要有实际延迟样本、关键动态截图、时间线、资源趋势和全部已知限制。

缺口：有单元夹具。没有延迟样本、动态截图和资源趋势。旧全量测试绿不算本项。

证据：

- `gap` not-run。没有可引用的夹具，也没有试播记录

### delivery-ops

运维说明。status=`skip`。

启动、模式切换、备场和回退、角色恢复、配置项、日志位置；控制台运行与大脑开关清楚。

缺口：运维说明还没写。P8 夹具里的切回策略不是操作手册。

证据：

- `gap` not-run。没有可引用的夹具，也没有试播记录

### delivery-honest-pr

提交说明不夸大。status=`skip`。

提交和 PR 围绕已有行为与证据，不写未经证明的实时、零等待或留存保证。

缺口：本骨架遵守这条。最终交付仍未完成，所以不把 §12 勾上。

证据：

- `gap` not-run。没有可引用的夹具，也没有试播记录

### neg-ghost-cue

幽灵 cue 负控。status=`pass`。

未绑定，或锚在未念字上，却标成 dispatched / executed 时，harness 必须 fail。

缺口：注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。

证据：

- `negative-control` GHOST_CUE。注入被判 fail：ghost-1 未绑定却标成 executed

### neg-missing-audio

缺真实 audio 却标 playing。status=`pass`。

没有 audioRef 或媒体观察，却把口播标成 playing 时，harness 必须 fail。

缺口：注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。

证据：

- `negative-control` MISSING_AUDIO。注入被判 fail：line-ghost-audio 标成 playing，但没有 audioRef 或媒体观察

### neg-missing-real-starts

缺真实 starts 却标 real。status=`pass`。

alignment 标成 real，但没有逐字 starts 时，harness 必须 fail。

缺口：注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。

证据：

- `negative-control` MISSING_REAL_STARTS。注入被判 fail：line-fake-real 标成 real，但没有逐字 starts

### neg-failed-exit

失败 exit 记成成功。status=`pass`。

退出失败却记成 success 时，harness 必须 fail。

缺口：注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。

证据：

- `negative-control` FAILED_EXIT_AS_SUCCESS。注入被判 fail：scene-a 退出失败却记成成功

### neg-silent-cross-segment

无声跨段。status=`pass`。

声称有声衔接，但段边界没有媒体观察时，harness 必须 fail。

缺口：注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。

证据：

- `negative-control` SILENT_CROSS_SEGMENT。注入被判 fail：seg-a 到 seg-b 声称有声衔接，边界没有媒体观察

### neg-input-remount

输入触发重挂。status=`pass`。

输入更新换了实例代数或重载，却标成原地 patch 时，harness 必须 fail。

缺口：注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。

证据：

- `negative-control` INPUT_REMOUNT。注入被判 fail：scene-a 输入更新换了实例或重载，却标成原地 patch

### neg-empty-legal-remainder

空剩余合法归档。status=`pass`。

未执行锚点仍引用的口播被归档空，却标成归档成功时，harness 必须 fail。

缺口：注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。

证据：

- `negative-control` EMPTY_LEGAL_REMAINDER。注入被判 fail：应留下 pinned-speech，归档后剩余为空却标成功

### neg-downsampled-false-gap

压缩采样假断档。status=`pass`。

原始样本连续且正常，压缩报告却声称断档时，harness 必须 fail。

缺口：注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。

证据：

- `negative-control` DOWNSAMPLED_FALSE_GAP。注入被判 fail：原始样本连续且都正常，压缩后的断档是假的

### neg-swallowed-poll

真实 poll 错误被吞。status=`pass`。

poll 失败却把健康标记写成真时，harness 必须 fail。

缺口：注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。

证据：

- `negative-control` SWALLOWED_POLL_ERROR。注入被判 fail：poll 失败被写成健康：platform-down

### neg-painted-without-receipt

无 paintReceipt 却标 painted。status=`pass`。

没有 paintReceipt，却把场景标成 painted 时，harness 必须 fail。

缺口：注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。

证据：

- `negative-control` PAINTED_WITHOUT_RECEIPT。注入被判 fail：scene-a 标成 painted，但没有 paintReceipt
