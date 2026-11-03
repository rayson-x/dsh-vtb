# 验收证据骨架

这里是 P9 的 scaffold 报告，不是试播报告。

- 计划依据：`docs/plans/co-creative-live-harness.md` §9、§12 与 P9 条目。
- Issue #26，父 issue #7。
- 生成代码：`packages/dsh-livestream/src/live/acceptance`。
- `scaffold-report.md` 与 `scaffold-report.json` 由该模块收集。测试会核对文件和收集器一致。

status=`pass` 只表示负控注入被抓住。§9.3 的行为行没有 pass。真实试播、100 次 live patch 和 30 分钟资源趋势是 blocked，依赖 P0 SDK 与 P2 运行验收。

旧全量测试绿不等于新架构验收。报告里的测试名只是夹具证据指针。

Issue #26 的完成条件未勾。
