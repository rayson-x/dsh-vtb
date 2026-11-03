> 范围：本包是保留的契约/端口夹具，不代表全产品的运行状态。实际SDK生产、直接组件复用与浏览器播放由 `dsh-livestream/src/live/runtime` 和 `scene-host/src/browser` 执行，参见根README与运行记录。下面的静态验收标志只说明本包不执行认证。

# 本包不是 P4 认证

**P4 脚手架已落地，两条制作路径与代表组件认证没有完成。**

这里是组件生产链的可测骨架：catalog 条目、Component Kit 接入面、pick / scaffold 端口、ScenePackage 元数据，以及和 P1 域类型之间的适配。它不是「现成快搭和 SDK 新效果两条路径可用」，也不是代表组件认证。

计划：`docs/plans/co-creative-live-harness.md` §2.3、§5.2、§5.3、§10。跟踪 GitHub #22，父 issue #7。

## 阻塞

- P0：私有 reelmorph-agent SDK 未交付，本仓不 vendor 其源码
- P2：场景宿主运行验收未通过，不能把制作结果接到播放器
- effects pick / scaffold 没有可执行实现，只返回 blocked
- 代表组件（Remotion、HF/GSAP、D3、轻量 Three）没有真实示例，也没有能力认证

没有私有 SDK 时，不能宣称两条路径可用，也不能宣称代表组件已认证。完成条件仍阻塞于 P0 SDK 交付与 P2 运行验收。

## 本包有什么

目录落在 `packages/scene-package`，对应计划 §2.3 的生产登记，不改 `agent.ts`，也不改 P1 公共 schema。和 `packages/scene-host` 之间只有 JSON 描述符，不调用宿主的 load / take，不安装 React、Remotion 或 HyperFrames。

| 模块 | 作用 |
| --- | --- |
| `src/schema.ts` | ScenePackage 文档：不可变 revision、hash 字段位、依赖版本、params schema |
| `src/capabilities.ts` | 实时运行方式、原地输入更新、确定性回放、hold/loop、资源/ready、音频归属、依赖闭包 hash |
| `src/catalog.ts` | catalog 条目模型、内存 fixture、私有 catalog 的 unavailable 接入面 |
| `src/ports.ts` | pick / scaffold / search / get，以及 Component Kit 接入面 |
| `src/registry.ts` | 任务登记、取消、超时、候选挂接 |
| `src/project.ts` | 投影成 P1 AssetVersion / ProductionTask 的形状 |
| `src/host-contract.ts` | 给 scene-host 的 JSON 描述符，`load` 固定为 `not-requested` |

未验证能力默认是 `false` 或 `unverified`。不支持原地 patch 的条目标 `requiresStandbyRebuild`。音频归属未声明时保持 `unverified`，投影到 P1 时直接拒绝，因为域类型没有这一档，不能写成 `none`。

`hash` 和 `dependencyClosureHash` 是字段位。空字符串表示还没计算，本包不编造摘要。fixture catalog 里的 Remotion、HyperFrames、D3、Three 只是占位条目，`origin` 为 `fixture`，不是 `library/catalog` 的私有条目。

候选 ready 不是认证，也不是 take。`liveEligible` 只表示这份任务还没被取消或标成超时，不表示可以送播。

## 单元测试与跳过

下面的 pass 只说明骨架能在 Node 里跑。它们不是 P4 通过。

| 检查 | 结果 |
| --- | --- |
| schema 校验：拒绝函数、React 元素、`verification: passed`、`@reelmorph/*` 依赖 | pass（单元） |
| 能力默认未验证：realtime、原地更新、回放、hold/loop、资源 ready、音频归属 | pass（单元） |
| pick / scaffold / Component Kit 返回 blocked 或 unavailable，且没有候选模块 | pass（单元） |
| 不可变版本：同一 id 不能覆盖，取消后产物仍在但不能上播 | pass（单元） |
| `requiresStandbyRebuild`：不支持 patch 的 fixture 必须标记 | pass（单元） |
| 投影对齐 P1 AssetVersion / ProductionTask，宿主消息可 JSON 序列化 | pass（单元） |
| 现成快搭路径可用 | skip |
| SDK 新效果路径可用 | skip |
| 代表组件认证（Remotion、HF/GSAP、D3、轻量 Three） | skip |
| 把候选接到 scene-host 真实播放 | skip |

```sh
npm --prefix packages/scene-package ci
npm --prefix packages/scene-package test
npm --prefix packages/scene-package run check
```
