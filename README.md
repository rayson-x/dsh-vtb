# 大肥鱼直播舞台

本地运行的 AI 主播与舞台。主播、现场导播、编导和制作席使用独立 DSH 会话，共享工程事实；制作不会阻塞现场。观众建议可以改变场景版本或在播参数，只有实际播出回执才记为兑现。

## 启动

需要 Node.js 24。角色、布景大型资源和凭据保存在本机，不提交到公开仓。

```sh
npm ci
npm --prefix packages/dsh-livestream ci
npm --prefix packages/scene-host ci
npm --prefix packages/scene-package ci
npm run plugin:install
npm run harness:sdk -- /authorized/path/to/reelmorph-agent
npm run console
```

控制台 `http://127.0.0.1:3800/`；舞台/OBS 浏览器源 `http://127.0.0.1:3900/`。设置方向后开播；控制台可分别暂停/恢复四个岗位。开播使用本机 `.env` / DSH 凭据服务，语音沿用 ElevenLabs 配置，字段见 `.env.example`。SDK 路径只写入忽略的 `.deps/sdk-source.json`；也可用 `AIVTB_SDK_REPO` 环境变量覆盖。

控制台默认使用 v2 Harness；需回退时先停止团队、关闭控制台，再以 `AIVTB_HARNESS=legacy npm run console` 重启。同一舞台不热交接给两套控制路径。未播放的历史音频不因恢复自动重放。平台输入需在控制台另行配置；本地开播不等于向外部直播平台推流。

## 制作与播出

- **编导**研究观众兴趣，维持当前方向，准备当前/下一/过场内容；不审批每句话。
- **制作席**复用真实组件或编写原生 SDK Scene，编译为不可变候选；不能直接上播。
- **导播**管理未来时间轴、备场、实际 take、驻留和参数更新。
- **主播**负责当下表达、即兴和留白；编导离线时也可继续工作。

采用真实 Remotion、HyperFrames/GSAP、Scene/Component Kit。D3、Three 等依赖用于原生源码创作。四类可复用示例在 `examples/scenes/`，制作席也可通过 `searchSdk` 的 `aivtb/*` 条目读取。目录中未经验证的能力仍标未认证，不因所属 SDK 或品牌自动宣称实时、patch、确定性回放全部可用。

模型上下文按岗位控制大小，完整历史仍保留；写工具只返回薄回执，详细工程按需读取。普通主人指令单独持久化，恢复与裁剪不会把它们混入普通观察点。模型输出预留按岗位限制；失败有独立健康状态和退避，不能把 ready 当作请求成功。

## 录制与导出

```sh
npm run programme:record -- <Ego-space> <page> 10
npm run programme:export -- <输出的录制目录>
```

记录实际合成画面及舞台/受信场景客户端的节目混音，生成有声 MP4、规范 WAV、媒体 hash 清单和真正的原生 Film。全舞台回放是**实际播出录制**，包含当时人物、字幕、侧栏、场景与节目音频；不宣称能从旧的、不完整事件重建所有 Live2D 动作。网页预览和 Film 使用同一份媒体。

另有 `harness:film:export` / `harness:film:capture` 对经认证的 Scene 轨做事件级、可逐帧复现的离线回放。两种方式的范围不同，详见[运行说明](docs/harness-runtime.md)。录制不访问麦克风、不连接外部推流平台；未接入节目混音总线的外部工作区视频会明确拒绝录音，避免静默丢失声音。

## 验证

```sh
npm run plugin:check
npm run plugin:test
npm run scene-host:check && npm run scene-host:test
npm run scene-package:check && npm run scene-package:test
npm run sdk:doctor
npm run harness:sim
# 在 Ego 中打开输出的场景地址后：
npm run harness:sim:check -- <operator-url>
```

持续验证使用 `harness:acceptance`，实际调用本地四个模型岗位，观众输入由脚本提供；不注入模型回答或虚构统计。报告明确区分真人观众、脚本观众、实际播放及未匹配回应。

固定私有 SDK 来源、依赖核验、CI 和许可清单见[SDK 重建说明](docs/sdk-reproducibility.md)。公开 CI 不需要私有源码；私有集成需要单独的只读授权，不把未配置/未执行的 job 写成成功。运行数据、生成源码与录制素材保留在 `.deps/`，不自动发布。

历史设计见 [总计划](docs/plans/co-creative-live-harness.md)，当前实现与验收记录以[运行说明](docs/harness-runtime.md)和 GitHub issue 为准。`HARNESS.md` 描述旧版单主持人路径。
