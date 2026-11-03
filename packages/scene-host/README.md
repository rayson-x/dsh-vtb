# Scene Host

React 19 独立浏览器宿主与原有协议夹具。真实运行入口位于 `src/browser`，使用 Remotion Player 4.0.535、HyperFrames Player 0.8.212，以及固定 Scene SDK 的 frame 场景。

`src/wiring.ts` / `RecordingSceneHost` 仍是内存协议夹具，不把它们当成生产播放器。浏览器宿主通过 runtime 网关接入真实 DSH 团队；生成的场景运行在没有同源权限的 iframe 中。

- `npm run build`：生成独立宿主、隔离场景页面和共享 React/Remotion 模块。
- `npm test`：协议与生命周期的 owner-boundary 测试，不能代替浏览器验收。
- `npm run check`：类型检查。

运行方式、私有来源、浏览器实测和未完成项目见 [运行接线记录](../../docs/harness-runtime.md)。整体 P2/P9 尚未全部验收；不因播放器依赖可用而宣称所有条目具备实时能力。
