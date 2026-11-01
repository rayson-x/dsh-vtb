# aivtb

自用 AI 直播项目。DSH 是唯一的大脑；`packages/dsh-livestream` 是 DSH 插件，提供直播舞台（OBS 浏览器源）和 Agent 控制舞台的工具。

旧实现（平台输入、TTS、Live2D、记忆、Studio）已清掉，打包在 `../aivtb-legacy-2026-10-30.tgz`。

## 舞台

1920×1080，同一套叠层在两个场景间切换，不另做界面：

- **杂谈**：人物坐在左边的大舷窗前，工位缩成桌上的一台显示器，弹幕在右栏，口播字幕在人下面
- **看片**：工位铺满主画面，人物缩到右下，弹幕留在原地

视觉是「水下的小船舱」：她是鲸鱼女仆，所以房间在海里。舷窗是全场唯一抢眼的东西（窗外有光斑，隔很久游过一头鲸），其余都安静。配色从角色身上取：深海蓝做底、鲸蓝（`--whale`）做强调、海沫绿表示完成和进度、草莓粉只给开播和礼物。展示字用得意黑（Smiley Sans，OFL；`node packages/dsh-livestream/scripts/fetch-font.mjs` 下载到 `assets/fonts/`，构建时拷进 `lib/`，没有就退回系统黑体），正文用系统黑体，时间码等宽。字幕不加底框，白字描深蓝边。

图层从下到上：背景、工位、装饰、人物、弹幕框、礼物。工位里有片子（没有地址时画一段假片子）、播放进度条（播放头、旗、选区、切点、特效块、放大一窗）、细看、B-roll、代码条、状态牌和四种工位模式（看片、剪辑、写代码、写特效）。右栏有任务角和弹幕。

人物层默认是 Live2D（`packages/dsh-livestream/assets/characters/deepseek-live2d/`，vendor 脚本从 `/characters/` 按需加载，不打进舞台包）。装不上，或地址带 `?avatar=svg`，就退回 SVG 占位。嘴型每帧读 `mouth()`；表情按 `avatar.mood` 映射到模型（开心兴奋、感叹号、呆呆眼、悲伤）。

转场：Agent 只说软切或硬切，导播选 cut、slide、fade、wipe。工位和人物换场景时不卸载，只做 transform，所以不闪白。切镜头和 B-roll 共用频率上限，主人可以锁镜头。

路径、链接、哈希上屏前一律脱敏；给 Agent 的只是一份薄情报（`src/stage/brief.ts`）。

## 开播（日常用这个）

需要 Node.js >= 24（根目录 `package.json` 的 `engines`）。舞台和演示不需要密钥；要让她真的说话才需要本机的 DSH profile 和 `.env`。

```sh
npm ci
npm --prefix packages/dsh-livestream ci
npm run stage:demo     # 不需要密钥：http://127.0.0.1:3900/ 循环跑一轮假情报，调试台 /control
```

控制台（舞台常驻在 `:3900`，控制页在 `:3800`）：

```sh
npm run console        # 打开 http://127.0.0.1:3800/
```

控制台常开，大脑（DSH）由它管：点「开播」启动 DSH（`live` 配置，有根目录 `.env` 就读），点「下播」关掉。关掉控制台进程不会把大脑一起带走，要停她得点「下播」。没装 live profile 时，开播失败写在控制台的启动日志里，舞台还在。没配 `DEEPSEEK_API_KEY` 时大脑进程能起来，但模型请求会失败。OBS 浏览器源开舞台页 `http://127.0.0.1:3900/`。不用 DSH 自己的客户端（开播时加了 `--no-open`；DSH 的网页若起来，默认在 `:3080`，可以不打开）。

第一次在这台机器上开播，还要准备 profile（写到 `.dsh/`，不进仓库）和密钥：

```sh
corepack enable && corepack prepare pnpm@10 --activate   # dsh plugin 会转给 pnpm
npm run plugin:install                                   # 建 live profile，装上本插件，补上 web 模板里的 agent 预设
cp .env.example .env                                     # 至少填 DEEPSEEK_API_KEY
npm run console
```

`@deepseek-ai/dsh`（`0.2.1-rc.2`）是公开 npm 包，`npm ci` 会装上。`live` 不是 DSH 自带的 profile 名：`plugin:install` 会在 `.dsh/profiles/live` 建一个，并保证 bundle 里有 `@deepseek-ai/dsh-web-app`（agent 预设服务在这层；只留 base 模板的话，「直播舞台」预设挂不上）。已有的 `cordis.patch.yml` 不会被改掉。主播一轮怎么转，见 [HARNESS.md](HARNESS.md)。

## 运行

```sh
npm ci
npm --prefix packages/dsh-livestream ci          # 或 npm install；锁文件在 packages/dsh-livestream/package-lock.json
node packages/dsh-livestream/scripts/fetch-font.mjs   # 展示字体，可选；没有就退回系统黑体，页面会 404 这个字体文件
npm run stage          # 单独起舞台：http://127.0.0.1:3900/ ，调试台 /control
npm run stage:demo     # 起来就循环跑一轮假情报演示（不读 .env）
npm run stage:voice    # 单独起舞台；根目录有 .env 就读（ElevenLabs），没有也能起
npm run plugin:test
npm run plugin:check
```

不经过控制台、自己起大脑（舞台要另外开着，默认连 `http://127.0.0.1:3900`）：

```sh
npm run plugin:install
npm run live           # 有 .env 就读；没有文件不会因为 --env-file 直接退出
```

密钥见 `.env.example`：

| 变量 | 谁用 | 没有会怎样 |
|---|---|---|
| `DEEPSEEK_API_KEY` | DSH 模型；舞台上导播/嘴替的短调用 | 舞台和演示照常。开播后模型请求失败 |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | `speak` 出声 | 按字数估时长，只亮字幕。可选 `ELEVENLABS_MODEL_ID` |
| `TYPESAFE_API_KEY` | `graphic_pick` 打分 | 打分拿不到。剪辑类工具目前没挂给她 |

抖音 / B 站 / TikTok 输入还没接到日常开播上（`npm run input:*` 是单独脚本）。礼物到剪辑、时间轴这些工具留在舞台里，没有挂进主播预设。

平台弹幕、礼物和主人插话，暂时通过 `POST /command` 下 `danmaku` / `alert` / `interrupt` 指令（见 `src/stage/protocol.ts`）。

## 包装

`graphic` 按名字上一段动画（标题、通知、划重点、进度、留言），`graphic_clear` 撤下。字段是短中文，带 * 的必填；同一位置新的会顶掉旧的，同时最多三段。调试台「包装」一排按钮用示例上屏。舞台按自己的时钟逐帧 seek，中途打开也落在同一帧，到点淡出。

素材不进仓库。从隔壁效果库导入（HyperFrames，Apache-2.0）：

```sh
npm run stage:graphics
```

默认读 `../reelmorph-agent/acceptance/effects`，也可以把目录当参数传给 `node packages/dsh-livestream/scripts/import-graphics.mjs`。许可在导入后的 `packages/dsh-livestream/assets/graphics/LICENSE`。

## 讲课

主播预设里没有 `lesson_open` / `lesson_next` / `lesson_lookup`。现在一场的推进是：开播方向（默认 `shows/vibe-classroom.md`）加上 `speak`、`research` 和闲置时推来的【直播间】。细节在 [HARNESS.md](HARNESS.md)。

- `speak` 把一段话写进说话队列。嘴里大约超过 10 秒才等；快空（大约 5–8 秒）或有新弹幕会提前回来。
- 舞台动作写在台词里：`[[scene watch]]`、`[[mood happy]]`、`[[draw …]]` 等，念到那个字时下指令（见 `src/stage/cues.ts`）。
- 她闲着时（嘴快空了、几秒没调工具），插件推一条【直播间】：有新弹幕就带上，话题还在就让她接着讲或换题。
- `GET /state` 里的 `speech.gaps` 是每两段之间空了多久（毫秒）。

## 出声

`speak` 先用 ElevenLabs 合成（`ELEVENLABS_API_KEY`、`ELEVENLABS_VOICE_ID`，可选 `ELEVENLABS_MODEL_ID`）。mp3 缓存在 `packages/dsh-livestream/.cache/voice/`，舞台页按真实时长出声，并用音量驱动嘴型。没配密钥或合成失败就按字数估时长，只亮字幕。调试台不出声；OBS 从舞台页 `/` 的浏览器源采音。

## 还没接

抖音和 B 站输入、Show 注意力、记忆、Studio、云上 Bridge。剪辑 / MV（时间轴、工位、B-roll、包装库）的舞台实现还在，但没有接到主播预设上，这次引导也不依赖它们。
