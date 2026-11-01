// 画布 UI 验收的场景：每个场景是一页真实会出现的画面（两三样东西 + 字幕说到一半），
// 两个布景各拍一张。capture.mjs（本机 ego-browser）和 capture-playwright.mjs（服务器）共用。
// 场景里 25 种元素（含连线、归组）和常用动作都出现至少一次；观众参与的用模拟弹幕投上票，看有数据的样子。

const dm = (user, text) => ({ type: "danmaku", platform: "bilibili", user, text });
const votes = (texts) => texts.map((t, i) => dm(`观众${i + 1}`, t));
// 字幕：一句话念 20 秒，截图时前面几个字亮、后面还没念到
const say = (text) => ({ type: "say", id: `qa-say-${text.length}`, text, ms: 20000 });

export const SETS = ["ocean-study", "midnight-tales"];
export const SETTLE_MS = 4000; // 画完等出场动画走完再拍

export const SCENES = {
  "title-number": [
    { type: "draw", id: "t1", kind: "text", text: "为什么狗没叫", size: "xl", enter: "slam", at: "top" },
    { type: "draw", id: "n1", kind: "number", text: "73%", note: "的人第一反应是熟人", at: "left" },
    { type: "draw", id: "t2", kind: "text", text: "熟人作案？", size: "l", at: "right" },
    { type: "touch", id: "t2", fx: "circle" },
    say("还有一个细节大家注意，那天晚上狗一声都没叫"),
  ],
  "list-card": [
    { type: "draw", id: "l1", kind: "list", text: "三个疑点", rows: [{ label: "门没锁" }, { label: "灯是关着的" }, { label: "狗没叫" }], at: "left" },
    { type: "draw", id: "cd", kind: "card", text: "提示", note: "注意那盏灯", at: "right" },
    { type: "draw", id: "st", kind: "sticker", text: "🕯️", at: "top-right" },
    { type: "touch", id: "l1", fx: "highlight" },
    say("我们一条一条看，先看第一个疑点"),
  ],
  "versus-ring": [
    { type: "draw", id: "v1", kind: "versus", text: "", rows: [{ label: "熟人", note: "狗认识他" }, { label: "陌生人", note: "狗被下药" }], at: "top" },
    { type: "draw", id: "rg", kind: "ring", text: "72", note: "选了熟人", at: "bottom" },
    say("两种说法，你站哪边"),
  ],
  charts: [
    { type: "draw", id: "b1", kind: "bars", text: "%", note: "示意数据", rows: [{ label: "熟人", value: 62 }, { label: "陌生人", value: 25 }, { label: "说不清", value: 13 }], at: "left" },
    { type: "draw", id: "ln", kind: "line", text: "起", rows: [{ label: "2019", value: 12 }, { label: "2020", value: 18 }, { label: "2021", value: 9 }, { label: "2022", value: 22 }], at: "right" },
    say("数据摆在这里，大部分人都猜熟人"),
  ],
  "ratio-race": [
    { type: "draw", id: "ra", kind: "ratio", text: "3/10", note: "十个人里三个会开门", at: "left" },
    { type: "draw", id: "rc", kind: "race", text: "票", rows: [{ label: "管家", value: 30 }, { label: "邻居", value: 20 }, { label: "女儿", value: 10 }], at: "right" },
    { type: "touch", id: "rc", fx: "count", arg: "管家:30 | 邻居:45 | 女儿:10" },
    say("十个人里只有三个会半夜开门"),
  ],
  "timer": [
    { type: "draw", id: "tm", kind: "timer", text: "60", note: "想清楚了也别打字", at: "center" },
    { type: "draw", id: "t3", kind: "text", text: "谁有钥匙？", size: "l", at: "top" },
    say("给大家一分钟，想清楚了也别打字"),
  ],
  clues: [
    { type: "draw", id: "c1", kind: "clue", text: "门没锁", note: "主人自己开的", at: "top-left" },
    { type: "draw", id: "c2", kind: "clue", text: "狗没叫", note: "认识来人", at: "top-right" },
    { type: "draw", id: "c3", kind: "clue", text: "灯是关的", note: "来人知道开关", at: "bottom" },
    { type: "link", from: "c1", to: "c2" },
    { type: "link", from: "c2", to: "c3", label: "都指向熟人" },
    { type: "touch", id: "c3", fx: "stamp", arg: "有争议" },
    say("这三条线索连起来，指向同一个人"),
  ],
  timeline: [
    { type: "draw", id: "t4", kind: "text", text: "那一夜", size: "xl", at: "top" },
    { type: "draw", id: "tl", kind: "timeline", text: "", rows: [{ label: "22:00", note: "关灯" }, { label: "23:30", note: "有人进门" }, { label: "02:00", note: "发现" }], at: "bottom" },
    { type: "group", id: "g1", members: ["t4", "tl"], label: "时间线" },
    say("把时间线排一下，十点关灯，十一点半有人进门"),
  ],
  flow: [
    { type: "draw", id: "fl", kind: "flow", text: "", rows: [{ label: "进门" }, { label: "关灯" }, { label: "离开" }], at: "top" },
    { type: "draw", id: "n2", kind: "number", text: "4分钟", note: "整个过程", at: "bottom" },
    say("进门、关灯、离开，前后只有四分钟"),
  ],
  poll: [
    { type: "draw", id: "t5", kind: "text", text: "凶手是谁", size: "xl", at: "top" },
    { type: "draw", id: "pl", kind: "poll", text: "你觉得是谁？", rows: [{ label: "管家" }, { label: "邻居" }, { label: "女儿" }], at: "bottom" },
    ...votes(["1", "1", "2", "3", "1", "2"]),
    say("弹幕投一下，发数字就行"),
  ],
  score: [
    { type: "draw", id: "t6", kind: "text", text: "吓人指数", size: "l", at: "top" },
    { type: "draw", id: "sc", kind: "score", text: "这个故事吓人吗", at: "bottom" },
    ...votes(["8", "6", "9", "7", "10", "5"]),
    say("给这个故事打个分，一到十"),
  ],
  "guess-wall": [
    { type: "draw", id: "gs", kind: "guess", text: "狗几岁了", answer: 7, at: "left" },
    ...votes(["3", "5", "7", "8", "12", "6"]),
    dm("夜猫子", "我赌是管家，他有钥匙"),
    { type: "draw", id: "wl", kind: "wall", text: "夜猫子", at: "right" },
    say("夜猫子说他赌是管家，有道理"),
  ],
  tier: [
    { type: "draw", id: "tr", kind: "tier", text: "嫌疑人排档" },
    { type: "rank", id: "tr", label: "管家", tier: "夯" },
    { type: "rank", id: "tr", label: "邻居", tier: "人上人" },
    { type: "rank", id: "tr", label: "快递员", tier: "拉完了" },
    { type: "judge", id: "tr", label: "女儿" },
    ...votes(["夯", "顶级", "夯", "NPC"]),
    say("女儿呢？你们给她放哪一档"),
  ],
  soup: [
    { type: "draw", id: "sp", kind: "soup", text: "男人回家，看见狗在门口，没叫。他当晚就报了警。", note: "狗是假的" },
    dm("观众1", "是不是狗死了"),
    dm("观众2", "是不是狗不是他家的"),
    dm("观众3", "是不是有人在家"),
    { type: "ans", id: "sp", answer: "不是" },
    { type: "ans", id: "sp", answer: "是" },
    say("这个问题问得好，是"),
  ],
  "marks-image": [
    { type: "draw", id: "im", kind: "image", text: "/sets/ocean-study/room.webp", note: "现场照片", at: "left" },
    { type: "draw", id: "k1", kind: "text", text: "管家有钥匙", size: "l", at: "right" },
    { type: "draw", id: "k2", kind: "text", text: "邻居在外地", size: "m", at: "bottom" },
    { type: "touch", id: "k1", fx: "underline" },
    { type: "touch", id: "k2", fx: "strike" },
    say("邻居那天在外地，可以排除"),
  ],
};
