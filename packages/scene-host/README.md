# 本包不是 P2 验收

**P2 运行验收没有通过。**

这里是独立 `scene-host` 的脚手架和端口接线，不是直播可行性证明。完整 live patch 连续 100 次保实例、真实绘制、音频唯一、就绪超时和漂移容限，仍然阻塞于私有 SDK 与 Chromium。

## 阻塞

- 无私有 reelmorph-agent SDK 包，本仓不 vendor 其源码
- 未安装 @remotion/player 4.0.535，Remotion live patch 未接通
- 未安装 HyperFrames Player（计划锁定的 core/engine/producer 0.8.212 不等于 Player 已接入）
- 没有 Chromium 里的 iframe、首帧绘制或音频唯一证明
- 连续 100 次输入更新保实例仍未做
- 就绪超时与漂移容限仍是待 P2 冻结，本包不填写这些数字

计划：`docs/plans/co-creative-live-harness.md` §2.3、§6、§7.1。跟踪 GitHub #20，父 issue #7。

## 本包有什么

控制台留在 `packages/dsh-livestream`，React 18.3.1。本包是将来单独构建的场景宿主边界，目标 React 19.3.0，**当前不安装 React，也不渲染组件**。跨边界只有 JSON 消息：校验 origin、宿主实例握手和字段，不传 React 元素、函数或 hooks。

| 模块 | 作用 |
| --- | --- |
| `src/messages.ts` | 与控制台隔离的消息 schema |
| `src/lifecycle.ts` | `load/prepare/ready/take/updateInputs/cue/hold/resume/retire/dispose` 的内存录制 |
| `src/surfaces.ts` | A/B Program、Preview、常驻层的状态转移 |
| `src/measure.ts` | 四门闩和漂移只记样本 |
| `src/wiring.ts` | 把节目钟、录制宿主、槽位和测量接在一起 |
| `src/adapters/` | Remotion 与 HyperFrames 的阻塞说明，没有播放器工厂 |

内存录制里的 `applied` 只表示协议受理，`paintReceipt` 恒为 `null`。`memoryGeneration` 不变不是 iframe 保实例。备场不会调用节目钟的 `pause`。常驻层（字幕、人物、基础频道）没有被候选加载换掉的路径。

测量 harness 不写超时毫秒，不写漂移容限。资源超时要由调用方记成 `timedOut`，不会被收成成功。`await` 一个 Promise 只记下 `promiseResolved`，不写成首帧可见。SDK 的 `ready` / `applied` / `assetsready` / `painted` 另册记录，不能冒充四门闩。

## 单元测试与跳过

下面的 pass 只说明协议状态机能在 Node 里跑。它们不是 P2 通过。

| 检查 | 结果 |
| --- | --- |
| 消息 schema：拒绝函数、React 元素、错误 origin、未握手、超时/容限字段 | pass（单元） |
| 生命周期录制、非法转移、输入历史 | pass（单元） |
| A/B/常驻状态转移，失败和超时不换掉在播 | pass（单元） |
| 四门闩与漂移只记样本，不生成阈值 | pass（单元） |
| `@remotion/player@4.0.535` 连续 100 次 inputProps 更新保实例 | skip |
| HyperFrames / HTML 真实播放与 runtimeData，连续 100 次不重载 | skip |
| Chromium 首帧、离屏节流、漂移容限冻结 | skip |

```sh
npm --prefix packages/scene-host ci
npm --prefix packages/scene-host test
npm --prefix packages/scene-host run check
```
