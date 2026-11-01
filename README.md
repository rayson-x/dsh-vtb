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

```sh
npm run console        # 打开 http://127.0.0.1:3800/ ：直播控制台
```

控制台常开，大脑（DSH）由它管：点「开播」启动 DSH（`live` 配置，读根目录 `.env`），点「下播」关掉；关控制台进程也会把大脑一起关掉，不会在后台偷偷花钱。开播后在控制台选课件开讲、跟她说话（告诉她 / 打断她），下面「她的输入输出」一条条显示她收到什么、怎么想、调了哪个工具、工具回了什么、每一步用了多少 token。OBS 浏览器源仍然开舞台页 `http://127.0.0.1:3900/`。不用 DSH 自己的客户端。

## 运行

```sh
npm ci
npm --prefix packages/dsh-livestream install
node packages/dsh-livestream/scripts/fetch-font.mjs   # 展示字体，可选
npm run stage          # 单独起舞台：http://127.0.0.1:3900/ ，调试台 /control
npm run stage:demo     # 起来就循环跑一轮假情报演示
npm run stage:voice    # 单独起舞台，并读取根目录 .env（ElevenLabs）
npm run plugin:test
npm run plugin:check
```

在 DSH 里用：

```sh
npm run plugin:build
npm run dsh -- web --no-open --host 127.0.0.1 --port 3080
```

DSH 起来后舞台在 `http://127.0.0.1:3900/`。新建会话时选「直播舞台」模式，她就能用这些工具：`speak`、`stage_scene`、`stage_work`、`stage_avatar`、`clip_control`、`timeline`、`look_closer`、`code_strip`、`fx_block`、`task_corner`、`broll`、`graphic`、`graphic_clear`、`stage_brief`。

平台弹幕、礼物和主人插话，暂时通过 `POST /command` 下 `danmaku` / `alert` / `interrupt` 指令（见 `src/stage/protocol.ts`）。

## 包装

`graphic` 按名字上一段动画（标题、通知、划重点、进度、留言），`graphic_clear` 撤下。字段是短中文，带 * 的必填；同一位置新的会顶掉旧的，同时最多三段。调试台「包装」一排按钮用示例上屏。舞台按自己的时钟逐帧 seek，中途打开也落在同一帧，到点淡出。

素材不进仓库。从隔壁效果库导入（HyperFrames，Apache-2.0）：

```sh
npm run stage:graphics
```

默认读 `../reelmorph-agent/acceptance/effects`，也可以把目录当参数传给 `node packages/dsh-livestream/scripts/import-graphics.mjs`。许可在导入后的 `packages/dsh-livestream/assets/graphics/LICENSE`。

## 讲课

`lessons/<名字>.md` 是课件：`#` 标题，`>` 一句简介，每个 `##` 是一节（要点、事实和出处、画面建议），「可能被问到的问题」这类节是附录，不进节目单。开播前写好、审过；直播时她只讲课件里的事实。

在「直播舞台」模式里跟她说「打开课件 cat-righting 开始上课」。她用 `lesson_open` 开课（右栏出节目单，工位变黑板），一节节讲，`lesson_next` 翻节，有人提问先 `lesson_lookup` 查课件再答。

- `speak` 一次交一段，排进说话队列就返回（队里剩不到 9 秒才回来），所以她总比嘴快一段，不冷场。
- 舞台动作写在台词里：`[[board 标题]]`、`[[point 要点]]`、`[[graphic 名字 字段=值]]`、`[[scene watch]]`、`[[mood happy]]` 等，念到那个字时按 ElevenLabs 的逐字时间下指令（见 `src/stage/cues.ts`）。
- 她闲着时（嘴停了、几秒没调工具），插件推一条【直播间】消息给她：有新弹幕就带上，课没讲完就让她接着讲。
- `GET /state` 里的 `speech.gaps` 是每两段之间空了多久（毫秒）。

## 出声

`speak` 先用 ElevenLabs 合成（`ELEVENLABS_API_KEY`、`ELEVENLABS_VOICE_ID`，可选 `ELEVENLABS_MODEL_ID`）。mp3 缓存在 `packages/dsh-livestream/.cache/voice/`，舞台页按真实时长出声，并用音量驱动嘴型。没配密钥或合成失败就按字数估时长，只亮字幕。调试台不出声；OBS 从舞台页 `/` 的浏览器源采音。

## 还没接

抖音和 B 站输入、Show 注意力、记忆、Studio、云上 Bridge。
