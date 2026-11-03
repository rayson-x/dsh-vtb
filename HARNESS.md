> 历史说明：本文描述旧版编排。新版多 Agent Harness 以 [运行说明](docs/harness-runtime.md) 和 [设计方案](docs/plans/co-creative-live-harness.md) 为准。

# 主播编排

舞台进程只画画面、排队说话、收弹幕。她下一句说什么、要不要切场景，是另一个进程里的 DSH 会话决定的。这次只读了这条控制流，没有改编排代码。

## 两个进程

| 进程 | 怎么起来 | 干什么 |
|---|---|---|
| 舞台 | `npm run console` 里的 `lib/console.js`，或单独 `npm run stage` / `stage:demo` | 听 `127.0.0.1:3900`。画面、说话队列、语音、`/input` 快报、`/command` 都在这里。`stage:demo` 不接大脑，自己播假情报。 |
| 大脑 | 控制台点「开播」，或 `npm run live` | `scripts/dsh.mjs --profile live --no-open`。插件连上舞台的 `/bridge`，自己在 `:3920` 开控制口。 |

控制台把「开播 / 告诉她」从舞台转到 `:3920`（`src/dsh/index.ts` 的 `controlRoute`，`src/dsh/live.ts` 执行）。关控制台不会关掉大脑；要停她得点「下播」。

`live` 不是 DSH 自带的 profile。`npm run plugin:install` 在 `.dsh/profiles/live` 建它，并放上 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dsh-livestream`。agent 预设服务在 web 模板那一层。只有 base 时，日志里会是 `preset-dsh-livestream … waiting for service: agentPresets`，人设和工具挂不上。

## 一轮怎么转

1. 开播时 `createLive` 建一个会话，预设写死为 `dsh-livestream`（显示名「直播舞台」），推理等级写死 `low`。然后再 `agentPresets.select` 一次。
2. 往这个会话 `followup` 一条【主人】开播消息：先打招呼，并 `research kind=topic`。方向来自控制台；没存过就用 `shows/vibe-classroom.md`。
3. 模型在这一轮里调工具。普通回复正文不会被念出来，观众听到的只有 `speak` 写进队列的字。
4. `speak` 把字交给舞台排队后就尽量返回。嘴自己念。同一轮里还可以再 `speak`、`research`、`stage_scene`。
5. 她闲下来（嘴里剩下的话短于水位、没有工具在跑、几秒没再调工具）时，插件每秒看一次，往同一会话 `steer`（没有就 `followup`）一条【直播间】。有弹幕就带上；正在聊话题就让她接着讲或换题。直播间安静时把间隔放长，并允许她停一下。
6. 后台是另一个会话，预设 `dsh-livestream-worker`。`research` 派出去就返回。后台只 `deliver` 到桌子上，不碰舞台。她下一次工具回执或闲置推进时拿走【你查的资料】。

上下文不另调模型做摘要。每一步之前，早于窗口的一整块换成一条便签（默认最近 10 分钟留原文，多出来攒满 5 分钟才换一次）。根插件 config 可以改 `windowMinutes` / `chunkMinutes`，`cordis.patch.yml` 里没写，所以用默认。

## 行为写在哪

| 内容 | 位置 | 改了要不要重启大脑 |
|---|---|---|
| 性格 | `soul/whale-maid.md`，预设 config `soul: whale-maid` | 不用。每次组装提示词读文件 |
| 直播规矩（必须 `speak`、先说再查、画面用 `[[draw]]`、事实只用查到的） | `cordis.patch.yml` 里预设 `preset-dsh-livestream` 的 persona 前缀 | 要。这是 profile 补丁 |
| 后台规矩、`web_search` / `web_fetch` | 同一文件里的 `preset-dsh-livestream-worker` | 要 |
| 开场白、打断、清空记忆后怎么接 | `src/dsh/live.ts` | 要重新构建并重启大脑 |
| 闲置推进、马上回、工具名单、说话水位 | `src/dsh/agent.ts` | 同上 |
| 弹幕打分和合并 | `src/host/gate.ts`，由 `src/host/input.ts` 调用 | 舞台进程重启后生效 |
| 台词标记 | `src/stage/cues.ts`，排队时在 `src/host/controller.ts` 拆开 | 舞台进程 |
| 嘴空了垫一句 | `src/host/filler.ts`，舞台进程在桥断开或她想下一句时调用 | 舞台进程。没 `DEEPSEEK_API_KEY` 就只垫写死的五句短话 |

## 她手里的工具

台上这个预设实际注册的是：

`speak`、`speech_queue`、`stage_scene`、`stage_avatar`、`stage_place`、`stage_brief`、`research`、`research_cancel`、`audience`。

`stage_scene` 只收 `chat` / `watch`，`soft` 或 `hard`。这是她自己切场景的入口。台词里的 `[[scene chat]]` / `[[scene watch]]` 会在念到那个字时做同一件事。

这些函数还在文件里，但 `EDIT_TOOLS` 把它们挡在注册之外，主播调不到：`stage_work`、`clip_control`、`timeline`、`look_closer`、`code_strip`、`fx_block`、`task_corner`、`broll`、`graphic`、`graphic_clear`。剪辑和包装不走这一轮。

`lesson_open`、`lesson_next`、`lesson_lookup` 不在代码里。放行器仍有 `mode: 'lesson'` 的名额（一拍 2 条），但主播取快报时写死 `mode: 'chat'`（一拍 4 条）。

后台预设另有 `deliver`、`graphic_search`、`graphic_pick`，加上 DSH 的网页搜索。它的提示词写明代码场景和包装特效停用，画面交给 `visual` 块，由她 `[[show 编号]]` 上屏。

## 说话队列和标记

水位在 `agent.ts` 里写死，没有环境变量：

- 嘴里多于约 10 秒，`speak` 才等到念掉一些再返回（`full`）。
- 低于约 5–8 秒算快空了，闲置推进可以推她（`lead`，还会加上最近合成花的时间，上限 8 秒）。
- 有新弹幕时，嘴里不超过约 15 秒就可以提前返回，最多 6 秒看一次。
- `next=true` 插到正在念的下一段，用来先回弹幕。
- 主人「打断她」走 `agent.steer`，并 `interrupt` 舞台。不硬切时先 `speech.break`：念完当前句，后面挂起，回执里带 `HELD_NOTE`。
- 观众礼物、醒目留言、上船，以及人少时的提问，隔 20 秒才能再软打断一次。主人弹幕隔 3 秒。

`[[标记]]` 不念。`at` 是它前面有几个字。有 ElevenLabs 时按逐字时间对上；没有密钥就按字数估时长，标记仍会按这个估时触发。写错的标记在排队时就回到 `speak` 回执里。

## 弹幕怎么进她的下一轮

两条路，都要大脑开着才会变成她的下一句：

- 平台事件走 `POST /input`（控制台「模拟观众」，或 `input:douyin` / `input:bilibili` / `input:tiktok`）。先进 `LiveInput`，按 `gate.ts` 打分，人少（能说话的事件不超过 12 条）就原话全给。她在工具回执、闲置推进或「马上回」里看到快报。
- `POST /command` 的 `{type:'danmaku', platform:'owner'|'sim'}` 直接上舞台。只有这两种进 `inbox()`，会插队软打断。调试台「主人」按钮走这条。

调试台大部分按钮是直接改舞台，不经过她。

## 可配和写死

可配：性格文件、开播方向（控制台写入 `packages/dsh-livestream/.cache/show.json`）、`cordis.patch.yml` 里的人设和后台提示、根插件的 `windowMinutes` / `chunkMinutes` / `brainPort`、`.env` 里的 `DEEPSEEK_API_KEY` 和 ElevenLabs、控制台里的房间号。

写死：预设 id、推理等级、说话水位、闲置和打断间隔、放行名额和分数、取快报时用的称呼（大肥鱼、肥鱼、主播、DeepSeek、ds娘）、默认方向文件、嘴替用的 `deepseek-flash`、剪辑工具名单。

## 基本循环还卡在哪

「自己讲、接弹幕、切场景」不依赖剪辑工具，也不依赖课件工具。卡点是：

1. **没有 `DEEPSEEK_API_KEY` 时，第一轮会直接结束。** 云端这次把 live profile 补上 web 模板后开播：舞台和控制台都在，会话建出来了，轨迹是「第 1 轮开始」然后「第 1 轮结束（error）」，`speech.lines` 仍是 0。她不会自己往下讲。密钥配上之后，同一条开场消息才会进入 `speak` / `research`。
2. **知识向的默认方向要求先查再讲。** `shows/vibe-classroom.md` 加上人设里的规矩：年份、数字只用【你查的资料】。查资料要后台预设、DSH 的 `web_search`，以及同一把密钥。只打招呼、接弹幕、`stage_scene` 切 `chat`/`watch`，不依赖后台。
3. **真实抖音 / B 站弹幕不会自己出现。** 控制台「模拟观众」可以走完放行和「马上回」。房间号要另外接 `input:*` 脚本，那些接入还没接到日常开播的必需路径上。
4. **课件那一套不能用。** 跟她说「打开课件」没有对应工具。现在的推进看的是桌上的话题（`research kind=topic`），不是课章节。

嘴可以没有 ElevenLabs：按字数估时，字幕照亮，场景标记照走。OBS 仍看 `http://127.0.0.1:3900/`。
