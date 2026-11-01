# 开播后跟随话题升级舞台：行为设计

状态：P0 已按本文落地（人设、StageAim、桥、素材上屏）。P1/P2 未做。基线 `8335e375`。读者按本文改 `agent.ts`、`cordis.patch.yml`、`blackboard.ts`、`stagehost.ts`、`director.ts` 时，不得另起节目单、画面总线或第二套导演。

抓眼是一条因果：台上出现一个能被看见的感觉，舞台才改一处。感觉来自查到的事实、观众点单、或话题边界。陪聊、致谢和固定栏目都不构成升级。

## 0. 必须沿用的接缝

| 接缝 | 现网符号 | 本文怎么用 |
| --- | --- | --- |
| 话题边界 | `Blackboard.topic(id, card)` 换 id 时归档 `beats` 并清空当前节目单 | 换题只走这条。旧 `StageAim` 随 id 失效 |
| 口播顺序 | `beats`；`OrderBook.add` → 编导 `plan_update` / `deliver` 的 plan | 不新增节目单。点单仍先成为 beat，再谈画面 |
| 画面执行 | `pictureDirector` + `VisualTrack` | 导演仍是唯一说明画面执行者。进场提前量、作废、灯光额度全部保留 |
| 素材上屏 | `visual.put` / `blackboard.material` → `visualToDraw` → `graphicsMenu` 允许的种类 | 接通这条，不恢复主持人 `[[show]]` |
| 互动 | 主持人 `speak` 里的 `poll/tier/score/guess/soup/timer/wall` 与 `result/ans/judge/rank` | 在请求交接落地前，导演不代发 |
| 主持人边界 | `enqueue(..., { host: true })` 过滤 | 布景、灯光、说明画布继续不从台词进入 |

现网布景只有 `ocean-study` 与 `midnight-tales`（`src/stage/sets.ts` 的 `SETS`）。镜头只有 `chat` / `watch`。

## 1. 角色在四个时刻做什么

四个时刻：换题、展开、收束、急件。职责按「谁感知、谁下目标、谁执行、谁开口」划分。

### 主持人（`dsh-livestream` / `speak`）

做：

- 换题：一句 `next=true`、45 字以内，点名并说出编导回执里的相对位置（眼前这点之后 / 先收尾）。然后 `research kind=topic` 仅当 `Desk.requestTopic` 没有已经开题。用 `speech_queue` 撤回旧话题还挂着的台词。
- 展开：按 `blackboard.line()` 最上面未排播的点讲，段末 `[[beat done b编号]]`。兑现点单时点名，句末 `[[done o编号]]` 或 `[[decline o编号]]`。
- 收束：把这个点的最后一句说完再打完成标记。换题前用一段把当前点收住，不另起无节目点的过场。
- 急件：只接 `speech.break` 带给她的那一条。45 字以内短句。点单已进节目单时，复述 `notices` 里的真实位置。
- 互动：仅当这一拍的感觉是「要观众现在选、猜、等、把原话挂上墙」，才写一个互动标记。

不做：

- 不写说明类 `[[draw]]`、`[[show]]`、`[[fx]]`、`[[room]]`、`[[page]]`、`[[erase]]`、布局标记。
- 不调用 `stage_scene` / `stage_place` 来「升级舞台」。这两个工具 P0 仍留在代码里，提示词里退出升级路径；P2 再考虑从预设摘掉。
- 不把「我记下了」说成已经排到第几。没收到 `plan_update` 回执，就说已交编导。
- 不替导演描述画布上还不存在的组件编号。

### 编导（`dsh-livestream-worker` / `deliver` + `plan_update`）

做：

- 换题：`Blackboard.topic` 用新任务 id。起步卡仍是 3–5 个 beat，但同时写一条舞台感觉（第 2 节），`device` 只有一个，`materialIds` 指向这一拍真要上屏的素材。
- 展开：新事实、新对比、新序列才追加 beat，并给这条 beat 一个 `device`。素材用 ` ```visual ``` ` 入库，种类必须能被 `visualToDraw` 收成说明组件。
- 收束：不再往当前话题尾部堆「总结点」。当前点讲完由主持人的完成标记关闭。要换题时先给一个收尾 beat（`position: 'now'` 或 `'after-current'`），再交给主持人开新话题。
- 急件：点单进单后立刻 `plan_update`，插到当前点之后；观众原文含「稍后 / 晚点 / 不急」才允许 `later`。换题正则仍走 `Desk.requestTopic`，不在旧话题里把新题讲完。

不做：

- 不 `speak`，不 `apply` 画面，不写进场锚点。
- 不把 poll / quiz / 海龟汤交给 `visual` 块。那些仍等主持人标记。
- 不因一条普通弹幕改节目单。进 `OrderBook` 的要求，或主持人明确的 `research`，才算感觉。
- 不维护第二份「画面节目单」。感觉挂在即将插入或正在服务的那个 beat 上。

### 画面导演（`pictureDirector`）

做：

- 换题：丢掉 `topicId` 已经对不上的未执行片段（`delete` pending）；在场片段把退场收到 `now` 附近或新话题第一句的合法锚点（`edit` exit / `leave`）。新话题开场只使用新 id 的 prepared 素材；没有素材时，沿用现有空画布规则，用话题标题加一句钩子补两块短说明。
- 展开：黑板阶段为 `develop` 且 `available` 里出现本 beat 的关键词时，用 prepared cue `add` 一次。已有相同内容则 `edit` 退场，不第二份。
- 收束：阶段为 `close` 时只改未来退场和 `leave` / `delete`。不 `add`。
- 高潮 / 对撞：阶段为 `clash` 时，这一拍只上 prepared 的对比、数字、时间线或流程，并最多一个 `[[fx]]`，仍过 `lightingLimit`。
- 急件：不把接话短句、`acknowledgement` 段、`held` 段当作退场锚点。不因为软打断改 `StageAim`。

不做：

- 不改互动道具的内容、票数、揭晓状态。互动展开挡住说明时，才允许现有的 `{op:"page"}`。
- 不换布景、不切 `scene`、不放音床（P2 才单独立项）。
- 不把 `archives` 里的旧题画回来。
- 不在每次黑板唤醒时都出新图。阶段没变、素材没变、画布仍覆盖当前 hook，就只巡检退场。

## 2. 共享对象 `StageAim`

不新建存储。挂在 `BoardSnapshot` 上，跟现有 `blackboard` SSE 和 `RemoteStage.blackboard` 走。`pictureDirector` 已经把黑板放进用户 JSON，不必再开一条唤醒总线。

### 字段

```ts
type GrabDevice =
  | 'text' | 'number' | 'versus' | 'bars' | 'line' | 'timeline' | 'flow' | 'list' | 'card' | 'image'
  | 'hold';

interface StageAim {
  topicId: string;           // 必须等于当前 Blackboard.topic.id，否则整条作废
  beatId?: string;           // 服务哪一个 pending beat；开场还没有点时可空
  phase: 'open' | 'develop' | 'clash' | 'close'; // 只由 Blackboard 推算，模型不直接写
  hook: string;              // 一句人话，这一拍眼睛要落下的感觉。最多 40 字
  device: GrabDevice;        // 唯一手法。hold = 这一拍不新上说明
  materialIds: string[];     // 素材架 id，0–2 个。空则导演只用正在说的原话补短说明
  setHint?: 'ocean-study' | 'midnight-tales'; // P2 前只记录，不执行
  sceneHint?: 'chat' | 'watch';               // P2 前只记录，不执行
  note?: string;             // 导演回写：已排 / 拒绝原因。给主持人看
  at: number;
}
```

`hold`、空 `materialIds`、以及 `phase: 'close'` 都是合法目标。没有目标时导演保持今天的巡场，不发明高潮。

### 谁写谁读

| 字段 | 谁写 | 谁读 |
| --- | --- | --- |
| `hook` `device` `materialIds` `beatId` `setHint` `sceneHint` | 编导，经 `deliver` 的 plan 项或 `plan_update` 的 add 项 | 导演、`blackboard.line()` |
| `phase` | `Blackboard` 在 `topic` / `edit` / `reserve` / `done` 时推算 | 导演执行，编导只读回执 |
| `note` | `pictureDirector` 在本轮编辑结束后回写 | 下一次 `blackboard.line()`，主持人只复述，不改 |
| `VisualTrack` | 只有导演 | `GET /tracks`。不复制进 `StageAim` |

编导提交的是感觉，不是阶段名。阶段机在第 3 节。模型若在 JSON 里自带 `phase`，黑板丢掉该字段。

### 最小协议

P0 只加两处，都落在现有桥上：

1. `BoardSnapshot` 增加可选 `stage?: StageAim`。`GET /bridge/events` 的 `blackboard` 消息本来就推整份快照，大脑侧 `RemoteStage.blackboard` 自动可见。不新增 SSE 类型。
2. `POST /bridge/call` 增加 `blackboard.aim`，参数 `{ key, topicId, beatId?, hook, device, materialIds, setHint?, sceneHint? }`。走现有 `Blackboard.update(key)` 去重。舞台侧校验：话题 id 一致、素材在架上、`device` 在枚举内、`materialIds` 最多 2 个。成功后由黑板推算 `phase` 并 `changed()`。

导演回写用同一个方法的内部路径，不给主持人工具：`pictureDirector` 调用 `blackboard.aimNote(note)`，只改 `note`。失败句子进入现有 `feedback`，同时写入 `note`，这样「画面通告」先从黑板回执回来，不必先做独立通道。

`blackboard.line()` 在节目单正文后加一行，有 `stage` 才出现：

`【这一拍】{hook}。画面用 {device}，素材 {ids 或「无，导演只用你正在说的话」}。{note 或「导演还没排」}。你只管讲，不要写画面标记。`

`GET /tracks` 保持现状，供验收看片段，不供主持人阅读。

P0 不执行 `setHint` / `sceneHint`。字段先占位，避免 P2 再改快照形状。

## 3. 话题阶段状态机

状态存在当前话题的 `StageAim.phase`。换 `topic.id` 时旧目标作废，不带去新题。

```
换题 / 新 topic id
    → open
第一笔 pending beat 被 reserve，或开场补画已执行
    → develop
编导把 device 写成 number | versus | bars | line | timeline | flow，且 materialIds 非空
    → clash
当前最上面的点 done，且后面还有 pending
    → develop
没有 pending，或 requestTopic / 换题已发生
    → close
close 且新 topic id 已写入
    → open
```

`list` / `text` / `card` / `image` 停在 `develop`，不升到 `clash`。`hold` 不改变阶段。急件不改变阶段。

### 每一阶段谁被触发、限什么频

限频叠在现有导演节奏之上：250ms 合并、调用间隔至少 1800ms、单次 5 秒超时、12 秒无变化才巡场。下表是新增的产品限频，由黑板和导演服务端拒绝，不只写在提示词里。

| 阶段 | 编导 | 导演 | 限频 |
| --- | --- | --- | --- |
| `open` | 新话题第一批 `deliver start` 写一条感觉。不起搜索也可以先交假设，但 `device: 'hold'`，数字类必须等带出处的素材 | 空画布沿用现规则：两块 `now+3500` 短说明，退场约 60 秒。有 prepared 素材则两块里至少一块用它 | 每个 `topicId` 只 `add` 一轮开场。20 秒内重复 aim 被黑板拒绝 |
| `develop` | 每个新 beat 最多一条感觉。素材晚到时允许把该 beat 的 `materialIds` 从空改成有，算一次更新 | 关键字出现在 `available`（未念到且 ≥3500ms）才 `add`。同内容已在 pending/active 则只 `edit` 退场 | 同一 `beatId` 最多上屏 1 个新说明组件。全页仍 ≤5，导演侧未来计划仍 ≤12 |
| `clash` | 只在这一拍真有对比、数字或序列素材时把 `device` 设成对应种类 | 上 prepared 结构，锚到 `available` 里的关键词。`[[fx]]` 最多一个，且过 `lightingLimit`（同种 30 秒，全屏 ≤2/分钟，粒子 ≤3/分钟） | 每个 beat 最多进入一次 `clash`。第二次对比写成下一个 beat，不在本拍叠第二张图 |
| `close` | 不再 `add` 新的讲解点，除非是换题所需的那一个收尾点 | 只 `edit` 未来 exit、`leave`、`delete` pending。不 `page`，除非互动展开挡住说明 | `close` 期间导演 `add` 直接拒绝。新话题的 `open` 不受这条限制 |
| 急件 | 只 `plan_update` 插单，不改 `device`，除非这条点单本身就是换题 | 不改目标，不用接话段做锚点 | 观众软打断仍是 `BREAK_GAP_MS` 20 秒。主人说话不占这 20 秒 |

换题迁移，补上现网缺口：

1. `Blackboard.topic` 发现 id 变化：旧 `stage` 标进 `note`「已换题」，`phase` 先落 `close`，并把 `topicId` 改成旧 id 仅供导演扫一轮。
2. 导演本轮：`materialIds` 不属于新话题、或片段 enter 锚在已 `retracted` 段上的 pending，`delete`；active 且锚点已 `invalid` 的，现有 `VisualTrack.tick` 会作废并退出，导演不必再补一次。
3. 新 id 的第一条 aim 把阶段推回 `open`。开场板只用新话题素材。

服务端拒绝（导演编辑循环里，生成之后、`track.edit` 之前）：

- `close` 出现 `add`
- `develop` / `clash` 的 `add` 与 prepared cue 的种类、正文不一致（有 prepared 时）
- 任何阶段 `add` 互动种类
- 用 `acknowledgement` 段或长度 ≤12 的插话段做 `exit` 锚点

## 4. 接通素材上屏

断点有两处：主持人 `[[show]]` 被 `host: true` 滤掉；导演提示词只让模型自由写 `[[draw text/list]]`，不读 `visualToDraw` 的结果。`visualToDraw`（`src/stage/draw/fromVisual.ts`）已经能把 `compare/list/flow/timeline/table/formula/quote/image/number/chart/diagram` 收成 `versus/list/flow/timeline/text/card/image/number/bars/line`。

接通时不把 `[[show]]` 交回主持人。

### 舞台侧准备，不让模型自造 cue

`visual.put` 与 `blackboard.material` 在 `stagehost.ts` 落架时：

1. 若 `data` 是 `Visual`，调用 `visualToDraw(visual)`。
2. 结果种类属于导演说明菜单（`text` `number` `list` `versus` `bars` `line` `ratio` `ring` `race` `timeline` `flow` `card` `clue` `sticker` `image`）才保留。
3. `poll` / `quiz` 的转换结果是互动 `poll`，记 `withheld: 'host'`，不放进导演输入。编导人设改为不要交这两种 visual。
4. `figure`、`scene` 以及 `default` 分支返回的错误字符串，记 `withheld` 原因，`deliver` 回执要求编导改成 `flow` / `list` / `chart` 再交。
5. 生成短编号 `alias`，规则 `m` + 序号，匹配导演 `^[A-Za-z0-9_一-龥-]{1,16}$`。`visualToDraw` 的 `id` 用 `alias`，不把 `t1-abcd1234-auto1-1` 这种任务 id 送上画布。
6. 素材记录变为 `{ id, description, data, alias, prepared?: Draw, withheld?: string }`。`prepared` 是服务器算的，编导 JSON 里的同名字段忽略。

导演 `work()` 的用户 JSON 增加 `prepared: [{ alias, materialId, device, cue }]`。`cue` 是 `prepared` 已通过 `parseCues` 的那一条 `[[draw alias kind …]]`。

### 导演怎么用

- `StageAim.materialIds` 有 prepared：本拍 `add` 的 cue 正文必须等于该 cue，锚点和退场仍由导演按 `available` 决定。
- 没有 prepared：只允许现有的短 `text` / 两三行 `list`，文字必须能在 `present` 或素材正文里找到，不编数字。`device: 'hold'` 时连这个也禁止。
- 同一 `alias` 已在 `pending` 或 `active`：禁止 `add`，只能 `edit`。
- 内容去重继续走 `reduceDraw` 里的同文判断；导演试算「会并进已有实体」时保持拒绝。

这条通路的单测应落在现有 `test/blackboard.test.ts` 与 `test/track.test.ts` 的风格里：给定一块 `compare` visual，黑板出现 `prepared.kind === 'versus'`，导演输入含该 cue，主持人台词里的 `[[show]]` 与说明 `[[draw]]` 仍被 `enqueue` 拒绝。

## 5. 热点与外网怎样升级画面

外网内容只为当前这一拍的感觉服务。聊天、梗、致谢不升级舞台。

允许触发升级的感觉：

1. 带出处的事实，和黑板上正在讲的点冲突，或把直觉用一个数说反。
2. 一个能被 `visualToDraw` 画出来的对比、序列、流程、大数。
3. 已进 `OrderBook` 的点题，改变「现在该看见什么」。
4. `topic.id` 换了。

路径全部用现网工具：

- 主持人感知到「这得看见」：先短句接住，再 `research kind=topic|more|answer`。`ask` 写观众原话和要看见的那一个矛盾，不写「聊聊天」。
- 编导继续 `web_search` / `web_fetch`。事实行仍要出处。`deliver start|cards` 的 plan 项带上 `hook` 与 `device`；能画的附 ` ```visual ``` `。
- 点单不走主持人转述才进单。`input.take` → `orders.add` → `follow()` 里现有的 `plan_update` steer 保持。编导插 beat 时带 `device`，素材没到就先 `hold`，素材到了再更新 `materialIds`，阶段机决定是否进入 `clash`。
- 补料节奏不变：`REFILL_SPOKEN_MS` 45 秒、起步卡预算约 8 秒、补料约 30 秒。热点不另开轮询。点单和换题是即时的，因为现网已经即时。

导演只在 `stage` 或 prepared 素材变化时升级画面。弹幕文本变化不直接 `add`。搜的过程仍用现有 `research` 状态牌（`src/dsh/index.ts` 的 `researching`），搜完收掉。

数字只来自素材的 `source` / 出处行。导演提示里已有「不编造事实」，服务端再加一条：`number|bars|line` 的 prepared 缺失时，禁止用这类 `device` 上屏，目标降为 `hold`，主持人口头说「我先核一下这个数」。

## 6. 人设与代码对齐

性格留在 `soul/whale-maid.md`。该文件没有画面规程，P0 不改它，也不把阶段机写进去。

### `packages/dsh-livestream/cordis.patch.yml` 主持人前缀

删掉或改写这些和现网相反的教法：

- 「讲到就 `[[draw]]`」「每段一两下画面动作」「你不写就不会有新画面」。
- 「`[[circle]]` `[[swap]]` `[[cross]]` `[[count]]` `[[page]]` `[[erase]]` 由你来」。说明类强调归导演。
- 「布景按氛围换」「`[[fx]]` 写在那个字前面」。
- 「后台素材用 `[[show 编号]]` 上屏」。
- 把 `{{stage_layout}}` 讲成她要自己摆组件。布局不是升级手段。

保留并收紧：

- 口语、事实只讲查到的、互动优先、礼物只认快报、`speech_queue`、`research` 的种类。
- 互动写法只留 poll / score / tier / guess / timer / wall / soup 这一组，以及揭晓用的 `result` / `ans` / `judge` / `rank`。
- 明确写：说明画面、灯光、布景由舞台按「这一拍」执行；她看到 `【这一拍】` 就照着讲，不复述画面指令。

`{{stage_sets}}` 已由 `agent.ts` 注入「画面导演独立管理画布、灯光、布景」。这段保留，放在删改后的前缀里，避免前后矛盾。

### 同文件后台前缀

- 删掉「她念到时 `[[show 编号]]`」。
- 改为：visual 块交给舞台，服务器用 `visualToDraw` 变成说明组件；不要交 `poll`、`quiz`、代码场景和标注图。
- 保留出处、起步卡、`deliver start|cards`、3–5 个点。每个点增加可选 `hook`、`device`。不要求每点都有图；没有可画的感觉就 `hold`。

### `src/stage/cues.ts` 的 `CUE_HELP`

现状第 45 行已经禁止画面、灯光、布景。P0 加两句，避免模型从旧记忆里补回来：

- 禁止 `[[show]]`、说明类 `[[draw text/list/versus/…]]`、`[[fx]]`、`[[room]]`、`[[page]]`、`[[erase]]`。
- 互动七种和 `result/ans/judge/rank` 继续保留在 `KIND_HELP` 列表里。

`StageController.enqueue` 的 `host: true` 过滤保持，作为教法失效时的硬闸门。

### `src/dsh/agent.ts`

- `speak` 描述已接近目标，补上：看到 `【这一拍】` 时讲内容，不描述画布操作。
- `stage_place`、`stage_scene` 的描述改为「升级舞台时不要调用」。P0 不从 `register` 删除，避免误伤调试台和旧测试。
- `speakerNotes()` 继续把 `[[show]]` 和画面标记换成「画面导演管理」。

## 7. 抓眼行为原则

这些规则约束感觉到行动的一步，不规定栏目、环节或时长模板。

1. 一拍只有一个感觉。`hook` 是一句人话，`device` 只有一个。节目单可以有 3–5 个点，画面这一拍只服务最上面那个点。
2. 感觉没变，画面就不动。同一 `hook` + 同一 `materialIds` 只允许改退场和强调。新事实、对撞、换题才 `add`。
3. 眼睛先落到一个已经成立的东西上。开场或空画布用 `now+3500` 的短说明；有素材就用 prepared，没有就用正在说的原话里的词。不提前画还没查到的数。
4. 对撞用并置。数字和直觉相反、两边说法对不上、步骤前后打架，就用 `versus` / `bars` / `timeline` / `flow` 对齐到还没念到的那个词。灯光只打在揭晓的一个字上。
5. 收束是拿掉多余的，不是再上一页总结。`close` 只安排谁退出。口头收束由主持人说，不由一张「小结」卡片代替。
6. 急件先接话，舞台留在原来那一拍。接话短句不拿来做锚点。点单插到当前点后面，画面等那个点的字锚点到了再进。
7. 观众需要动手，才由主持人挂一个道具。导演不代发。一拍最多一个互动；说明组件给这个道具让位时，只用现有 `page` 收进挂件。
8. 换题先让旧的退出，再用新话题的素材开场。`archives` 只供以后接话，不作为本场画面来源。

例子（每例都是一次感觉，不是固定环节）：

- 感觉是「这个数和大家想的相反」。编导把带出处的 `chart` 或 `number` 放上架，`device` 为 `bars` 或 `number`，阶段进入 `clash`。导演把 prepared 锚到「其实」或数字前的 `available` 字。主持人用短的 `tone=reveal` 说这个反差，台词里不画。
- 感觉是「弹幕分成两派，但两边事实都还没核」。主持人先点名两派，45 字以内。编导把对撞排成当前点之后的 beat，`device: 'hold'`。查到两边各一条出处后，更新为 `versus`，导演此时才上屏。在此之前不上投票；只有主持人认定「现在就要他们站队」，才写 `[[draw … poll]]`。
- 感觉是「故事先把线索给眼睛，答案留在后面」。编导交 `list` 或 `card`，正文只有线索，答案写在给主持人的资料里，不写进 visual。导演按 `develop` 上线索。揭晓靠主持人讲出来，并在 `close` 时让线索退出。P0 不依赖 `[[flip]]`。P1 若要翻面，只允许导演对自己 prepared 的 `card` 加效果点 `[[flip alias]]`（`point()` 已允许同编号 `touch`），主持人仍不写这个标记。
- 感觉是「百元礼物，附言说想看刚才那个对比」。礼物附言进 `OrderBook` 后，编导把已有对比素材插到当前点之后，不新开话题。导演等该 beat，不在致谢句上换布景。没有附言的礼物只走现有软打断和致谢，`StageAim` 不动。

## 8. 落地顺序

每一步都可在不改 OBS 页面的前提下，用现有 Vitest 风格验证。未达到本步标准，不开始下一步。

### P0 对齐与接通

改动范围：`cordis.patch.yml`、`cues.ts` 的 `CUE_HELP`、`agent.ts` 提示句、`blackboard.ts`、`stagehost.ts` 的 `visual.put` / `blackboard.material`、`director.ts` 的输入 JSON 与提示、`remote.ts` 若需要包装 `blackboard.aim`。不改 `reducer` 车道，不执行布景和镜头。

标准：

- 主持人台词中的说明 `[[draw]]`、`[[show]]`、`[[fx]]`、`[[room]]` 仍被拒绝；互动七种仍能进队列。
- 一块 `compare` visual 入库后，素材上有 `alias` 与 `prepared.kind === 'versus'`；`poll` visual 被 `withheld`，导演输入里看不到它的 cue。
- `blackboard.aim` 在话题 id 不一致、素材不在架、`device` 非法时拒绝；合法写入后 `line()` 出现 `【这一拍】`。
- 换 `topic.id` 后旧 `StageAim.topicId` 不再等于当前话题，导演提示输入里的有效目标只有新话题。
- `soul/whale-maid.md` 无舞台规程。`cordis` 主持人前缀不再出现 `[[show]]` 和「你不写就没有画面」。

### P1 阶段机真正约束导演

改动范围：`Blackboard` 的阶段推算、`pictureDirector` 在 `track.edit` 之前的拒绝、换题时对旧 `topicId` 片段的 `delete` / `leave`、`aimNote`。

标准：

- `open` 每个话题只补一轮；`close` 的 `add` 被拒绝且 `note` 写明原因。
- `develop` 在 prepared 存在时，`add` 的正文与 prepared 一致；重复内容走 `edit`。
- `clash` 每个 beat 一次，第二个 fx 被 `lightingLimit` 或本拍额度拒绝。
- 软打断产生的短句不会成为 `exit` 锚点（用 `test/track.test.ts` 的时钟夹具）。
- 换题后，挂在旧 segment 上的 pending 变为 `void` 或被 `delete`；新开场板的素材 id 以前缀或 `materialIds` 属于新话题。
- 无附言礼物不改变 `stage`。带「讲讲」的附言会新增 beat，且 `device` 在素材到达前是 `hold`。

### P2 布景、镜头、互动交接

改动范围才触及执行权，仍然不交回主持人：

- `setHint` 仅在 `topic.id` 变化当次，由导演新增一个受控 op（建议 `{op:'room', id}`），`id` 必须属于 `SETS`，全场成功次数设上限（建议 4）。`reducer` 只接受来自该路径的 `room`，不接受主持人台词里的 `room`。
- `sceneHint` 由舞台在进入 `open` 时应用一次 `scene`。主持人 `stage_scene` 退出预设说明；代码可暂留。
- 互动交接的最小形式：`device` 仍不能是 poll。若编导在 beat 的 `reason` 里标明「需要观众动手」，`notices` 增加一句「这一拍若要站队，由你写一个 poll」。导演继续不代发。完整交接（导演或舞台代发互动）不在本设计的 P2 里自动打开。
- 音床、独立灯光岗位、`callLane` / `mergeCrew` 不接入直播。

标准：

- 同一话题内重复 `room` 被拒绝；换题后的第一次合法 `setHint` 能换成 `midnight-tales` 或 `ocean-study`。
- 主持人 `[[room]]` 仍失败。
- `page` 仍只在互动展开时成功，且互动正文、票数与揭晓状态保持。
- 一场直播的说明组件仍由 `VisualTrack` 执行，`/tracks` 能看到 enter/exit 锚点。

## 9. 改的时候不要做

- 不要把 `StageAim` 做成第二份 `beats`，也不要按「开场 30 秒、干货 3 分钟、互动 1 分钟」写死。
- 不要恢复逐段 `callLane`，不要让主持人收回说明画布。
- 不要让弹幕原文直接变成 `draw`。
- 不要为了热点新建爬虫或平行素材库。外网仍走编导的 `web_search` / `web_fetch` 和 `deliver`。
- 不要在 P0/P1 改 `src/page` 的布局来「配合升级」。升级应先被 `/tracks` 和画布状态证明。
- 不要把 `archives.remaining` 自动排回当前节目单。接回旧题必须是一次新的 `plan_update`，并重新写感觉。
