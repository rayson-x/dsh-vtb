/**
 * Agent 控制舞台的工具。挂在「直播舞台」预设下。
 *
 * 工具只给意图：切到哪个场景、软切还是硬切、插旗、选段、派活……具体怎么画、用哪种转场由舞台和导播定。
 * 每个工具做完回一份薄情报（舞台现在大概什么样），不回整包状态。被拒绝时回理由，她照着改。
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { defineTool, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools';
import { brief } from '../stage/brief';
import { clockNow } from './clock';
import { setHelp } from '../stage/sets';
import { DRAW_HELP } from '../stage/draw/cue';
import { CUE_HELP, parseCues } from '../stage/cues';
import { ELEMENT_IDS, LAYOUT_NAMES, type Box, type ElementId, type LayoutName } from '../stage/canvas';
import { STAGE_REGIONS, layoutText, type StageRegion } from '../stage/regions';
import { VISUAL_KINDS, VISUAL_NAMES, VISUAL_SYNTAX, parseVisual, parseVisualBlocks, type Visual } from '../stage/visual';
import { EFFECT_LAYERS, effectBrief, searchEffects } from '../stage/effects';
import { GRAPHIC_SLOTS, graphicMenu, type GraphicSlot } from '../stage/graphics';
import { MAX_RUNNING, sceneCatalog, type Task, type TaskKind, type Topic } from './desk';
import { TONES, type Command, type Look, type Mood, type Tone } from '../stage/protocol';
import { askJudge, bindCredentials, desk, effectsReady, HELD_NOTE, said, liveInput, PACKAGE_ROOT, SOULS, show, stage, wake } from './runtime';

export const name = 'dsh-livestream-agent';
export const inject = ['tools', 'systemPrompt'];

interface AgentContext {
  effect(effect: () => () => void, label?: string): unknown;
  [service: string]: any;
}

const MOODS = ['neutral', 'happy', 'surprised', 'thinking', 'sad'] as const;
/** 语气没配表情时，脸跟着语气走 */
const TONE_MOOD: Partial<Record<Tone, Mood>> = { excited: 'happy', reveal: 'surprised', serious: 'neutral', aside: 'thinking', question: 'thinking' };
/** 语速：她可以每段指定；没指定就跟着语气（兴奋、嘀咕快一点，认真、揭晓慢一点） */
const PACES = { slow: 0.88, normal: 1, fast: 1.12 } as const;
const TONE_PACE: Partial<Record<Tone, number>> = { excited: 1.06, aside: 1.08, serious: 0.94, reveal: 0.92 };
/**
 * 嘴和手分开：speak 只是往嘴（说话队列）里写，写进去就回来，她接着搜、查、摆画面，嘴自己念。
 * 嘴的水位：低于 lead() 算快空了（闲着就推她）；高于 full() 时 speak 才等着，免得她写得太靠前。
 * 合成慢时提前叫她补话，满水位固定，避免把等待变成更长的排队。
 */
const LEAD_MS = 5_000;
const lead = () => Math.min(8_000, Math.max(LEAD_MS, 2_000 + stage.synthMs()));
/** 最多提前排约十秒，额外冷场由嘴替托住 */
const full = () => 10_000;
/** 有新弹幕时 speak 可以提前回来，但嘴里超过这么多就不回：热闹的直播间弹幕不断，不设上限她会一直往后排（实测排到过四分钟） */
const cap = () => 15_000;
/** speak 等水位时，有新弹幕最多多久回来看一次 */
const NEWS_GAP_MS = 6_000;
/** 后台：预设、推理等级（后台慢一点没关系，她在台上撑着）、最长干多久 */
/**
 * 剪辑那一套工具（工位模式、片子、时间轴、细看、代码条、特效块、任务角、B-roll）先不给她：
 * 现在只做正常直播，工具少、她不会被带偏。舞台那边的实现留着，要用时从这里放出来。
 */
const EDIT_TOOLS = new Set(['stage_work', 'clip_control', 'timeline', 'look_closer', 'code_strip', 'fx_block', 'task_corner', 'broll',
  // 包装停用：画面都上画布（[[draw …]]）；旧特效库也不给后台搜
  'graphic', 'graphic_clear', 'graphic_search', 'graphic_pick']);

const WORKER_PRESET = 'dsh-livestream-worker';
const WORKER_REASONING = 'low';
const WORKER_TIMEOUT_MS = 180_000;
/** 查多久就该交：到点提醒后台别再搜了，用手上的资料马上交（话题：起步卡 / 补一批） */
const WORKER_BUDGET_MS = { start: 20_000, cards: 30_000, answer: 25_000, visual: 25_000 } as const;
/** 她说了这么久（毫秒）就给话题补一批料 */
const REFILL_SPOKEN_MS = 45_000;
/** 一个话题后台最多跟多久；连着几批没交上就算这个话题查不下去了 */
const TOPIC_LIFETIME_MS = 20 * 60_000;
const TOPIC_MAX_MISSES = 2;
const RESEARCH_KINDS = ['topic', 'more', 'answer', 'visual'] as const;
/** 话题素材的记录：每个话题一份 markdown，以后可以当素材库 */
const TOPICS = join(PACKAGE_ROOT, '.cache', 'topics');

/** 她多久没动静（没调工具、嘴也停了）算闲着 */
const IDLE_MS = 5_000;
/** 直播间安静时：闲多久才算闲、多久推一次（像真人，停一停） */
const IDLE_QUIET_MS = 12_000;
const NUDGE_QUIET_MS = 40_000;
/** 闲着时最多多久推她一次 */
const NUDGE_GAP_MS = 20_000;
/** 观众触发的软打断（送礼、提问）最短隔多久：太频繁她什么都讲不完 */
const BREAK_GAP_MS = 20_000;
const REGIONS = ['center', 'left', 'right', 'top', 'bottom', 'top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;
const TIME = { oneOf: [{ type: 'number' }, { type: 'string' }] } as const;

/** 秒数或「1:30」→ 秒；认不出返回 undefined */
export function seconds(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const parts = String(value).trim().split(':');
  if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return undefined;
  return parts.reduce((sum, n) => sum * 60 + Number(n), 0);
}

const now = () => stage.now();
const state = () => `现在：${clockNow()}\n${brief(stage.state, now())}`;

/** 下一串指令：任一条被拒就停下，回理由和现状 */
function act(...cmds: Command[]): string {
  for (const cmd of cmds) {
    const r = stage.apply(cmd);
    if (!r.ok) return `没做成：${r.error}\n\n${state()}`;
  }
  return `好了。\n\n${state()}`;
}

function bad(message: string): string {
  return `${message}\n\n${state()}`;
}

/** 弹幕收件箱：上次告诉她以后新来的 */
/** 直播间快报：平台事件经过放行（打分、挑几条、其余合并）后给她 */
let lastRoomBreakAt = 0;
async function roomNews(): Promise<string> {
  const worthBreak = liveInput.hasBreak() || liveInput.hasUrgent();
  const st = stage.state;
  const r = st.rundown;
  const topic = [desk.topic?.title ?? '', r && r.at >= 0 ? r.steps[r.at] : ''].join(' ');
  const text = (await liveInput.take({ mode: 'chat', topic, names: ['大肥鱼', '肥鱼', '主播', 'DeepSeek', 'ds娘'] })).text;
  // 有人提问：闲聊直接接；要用事实的，查到的资料里有就答，没有先回一句再派去查，别凭记忆答
  let interruption = '';
  if (text && worthBreak && Date.now() - lastRoomBreakAt >= BREAK_GAP_MS) {
    lastRoomBreakAt = Date.now();
    const checkpoint = await stage.call<string>('speech.break', { news: text });
    wake.at = Date.now();
    interruption = `\n${checkpoint}\n当前话题：${desk.topic?.title ?? show.direction ?? '未定'}\n${HELD_NOTE}`;
  }
  const report = text + interruption;
  return text && text.includes('［提问') ? `${report}\n（有人问你：闲聊、梗、看法直接接；要用到事实（年份、数字、研究结论）的，查到的资料里有就照着答，没有就先回一句「我查一下」再 research kind=answer。）` : report;
}

const seen = new Set<string>();
function inboxWaiting(): boolean {
  return stage.state.danmaku.some((d) => !seen.has(d.id) && (d.platform === 'owner' || d.platform === 'sim'));
}

function inbox(): string {
  // 平台（抖音、B 站）的弹幕走放行快报，这里只管主人和测试弹幕
  const fresh = stage.state.danmaku.filter((d) => !seen.has(d.id) && (d.platform === 'owner' || d.platform === 'sim'));
  for (const d of fresh) seen.add(d.id);
  if (!fresh.length) return '';
  const pf = { douyin: '抖音', bilibili: 'B站', tiktok: 'TikTok', owner: '主人', sim: '测试' } as const;
  return `新弹幕：\n${fresh.map((d) => `- ${d.id} ${pf[d.platform]}·${d.user}：${d.text}`).join('\n')}`;
}


export interface Config {
  /** 她的性格文件：soul/<名字>.md，作为人设里的 {{soul}} */
  soul?: string;
  /** performer：台上的她（默认）；worker：后台，只查资料、挑画面、交素材，不说话不碰舞台 */
  role?: 'performer' | 'worker';
}

/** 后台交来的文字里的 ```visual``` 块：收进桌上（编号加任务前缀免得撞），正文里换成一行「[[show 编号]] 标题」 */
function takeVisuals(task: Task, text: string): { text: string; error?: string } {
  const { visuals, errors } = parseVisualBlocks(text);
  if (errors.length) return { text, error: `素材块写错了：${errors.join('；')}` };
  for (const v of visuals) {
    if (v.kind === 'image') return { text, error: '不能交图片素材（图片要核实许可）' };
    if (v.kind === 'scene' && !v.src.startsWith('@')) return { text, error: `代码场景只能用通用场景库里的（src: @名字.html）：${v.id}` };
  }
  let i = 0;
  const out = text.replace(/```visual\s+(\S+)\s+(\S+)\s*\n[\s\S]*?```/g, () => {
    const v = visuals[i++]!;
    const id = `${task.id}-${v.id}`;
    desk.visuals.set(id, { ...v, id });
    // 舞台那边登记上，[[show 编号]] 才找得到
    stage.putVisual({ ...v, id });
    const controls = v.kind === 'scene' && v.controls ? `（${v.controls}）` : '';
    return `素材 [[show ${id}]]：${VISUAL_NAMES[v.kind]}${'title' in v && v.title ? `「${v.title}」` : ''}${controls}`;
  });
  return { text: out };
}

/** 读性格文件；名字不合法或读不到就用一句兜底，不让提示词组装失败 */
function readSoul(name: string): string {
  if (!/^[\w-]+$/.test(name)) return '你是一位 AI 主播。';
  try {
    return readFileSync(join(SOULS, `${name}.md`), 'utf8').trim();
  } catch {
    return '你是一位 AI 主播。';
  }
}

export function apply(ctx: AgentContext, config: Config = {}): void {
  bindCredentials(ctx);
  // 性格：每次组装提示词时读一次文件，改了 soul 不用重启（内容不变时提示词前缀不变，缓存照样命中）
  const soulName = config.soul ?? 'whale-maid';
  ctx.effect(() => ctx.systemPrompt.variable('soul', () => readSoul(soulName)), 'dsh-livestream 性格');
  // 直播间布局：跟舞台页摆位置用的是同一张表
  ctx.effect(() => ctx.systemPrompt.variable('stage_layout', () => layoutText()), 'dsh-livestream 布局');
  ctx.effect(() => ctx.systemPrompt.variable('stage_sets', () => stage.crewEnabled() ? setHelp(stage.state.set).split('\n').slice(1).join('\n') : `舞台团队已关闭：现在你自己按台词写画布和灯光标记。draw 种类只能用下面帮助列出的名字；后台交付的素材类型不是 draw 种类，已有素材用 [[show 编号]]。\n${DRAW_HELP}\n${setHelp(stage.state.set)}`), 'dsh-livestream 布景');
  // 今天这场的方向：主人开播时定（控制台填），没定就跟着弹幕聊
  ctx.effect(() => ctx.systemPrompt.variable('direction', () => show.direction || '主人还没定方向：先跟弹幕聊，聊出感兴趣的再找话题。'), 'dsh-livestream 方向');
  /** 最近一次调工具的时刻和会话：推进时找她用 */
  let lastToolAt = 0;
  let sessionId: string | undefined;
  let lastNudgeAt = 0;
  let running = 0;
  let lastNewsAt = 0;
  let handledWake = 0;
  const register = (tool: { name: string; description: string; parameters: ParameterSchemaSpec; run: (args: any, exec: any) => string | Promise<string> }) =>
    EDIT_TOOLS.has(tool.name) ? undefined : ctx.effect(() => ctx.tools.register(defineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] },
      // 同一步里的几个调用一起跑：speak 嘴满时会等，别让同一步里的 research、切镜头排在它后面干等。
      // 舞台和桌子的改动都是同步的一下，交错不了；结果仍按她写的顺序回给她
      isConcurrencySafe: () => true,
      execute: async (args: any, exec: any) => {
        lastToolAt = Date.now();
        sessionId = exec?.agent?.session?.id ?? sessionId;
        running++;
        try {
          const result = await tool.run(args, exec);
          // 台上的她：查到的资料、直播间快报跟着任何一个工具的回执到，不用只等 speak（嘴排满时她会去调别的）
          if (config.role === 'worker' || tool.name === 'speak') return result;
          const news = [inbox(), await roomNews(), desk.take()].filter(Boolean).join('\n');
          return news ? `${result}\n\n${news}` : result;
        } finally {
          running--;
          lastToolAt = Date.now();
        }
      },
    } as any)), tool.name);

  /**
   * 往她的会话推一条消息并唤醒她：插进她这一轮的下一步（她闲着就马上开一轮）。
   * 不能排到下一轮：直播时她一轮能说半小时，排到下一轮就等于丢了。找不到会话返回 false
   */
  const push = async (text: string): Promise<boolean> => {
    const id = show.sessionId ?? sessionId;
    if (!id) return false;
    const found = ctx.get?.('agents')?.get?.(id);
    const agent = found?.followup ? found : found?.agent;
    if (!agent?.followup) return false;
    const message = Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-livestream' } });
    if (agent.steer) await agent.steer(message);
    else await agent.followup(message);
    return true;
  };

  if (config.role === 'worker') {
    // 后台：看得到通用代码场景目录和特效短名字，搜特效、查资料、交素材；不说话、不碰舞台
    ctx.effect(() => ctx.systemPrompt.variable('scenes', () => sceneCatalog(join(PACKAGE_ROOT, 'scenes'))), 'dsh-livestream 场景目录');
    ctx.effect(() => ctx.systemPrompt.variable('graphic_menu', () => graphicMenu()), 'dsh-livestream 包装短名字');
    ctx.effect(() => ctx.systemPrompt.variable('visual_syntax', () => VISUAL_SYNTAX), 'dsh-livestream 素材写法');
    const mine = (exec: any): Task | undefined => desk.ofSession(exec?.agent?.session?.id);

    register({
      name: 'graphic_search',
      description: '按中文需求在特效库里搜包装，返回最接近的 6 个：id、名字、画面、适用、能填的字段。'
        + '不要凭空编 id。layer 可以限 overlay、full-frame、transition、background、footage-treatment。',
      parameters: {
        need: { type: 'string', required: true, description: '想要的画面，用中文说' },
        layer: { type: 'string', description: '只看这一层' },
      },
      async run(args) {
        await effectsReady;
        const need = String(args.need ?? '').trim();
        if (!need) return bad('说一下想要什么样的画面');
        const layer = args.layer === undefined ? undefined : String(args.layer);
        if (layer && !EFFECT_LAYERS.includes(layer as typeof EFFECT_LAYERS[number])) return bad(`layer 只能是 ${EFFECT_LAYERS.join('、')}`);
        const hits = searchEffects(need, layer, 6);
        if (!hits.length) return '没搜到。换个说法，或者用短名字（notice、headline、slam、highlight 这些）。';
        return hits.map(effectBrief).join('\n\n');
      },
    });

    register({
      name: 'graphic_pick',
      description: '先按中文需求搜出几个特效，再挑最合适的一个，返回它的 id 和字段。打分不可用时用搜索第一名。',
      parameters: {
        need: { type: 'string', required: true, description: '想要的画面，用中文说' },
        layer: { type: 'string', description: '只看这一层' },
      },
      async run(args) {
        await effectsReady;
        const need = String(args.need ?? '').trim();
        if (!need) return bad('说一下想要什么样的画面');
        const layer = args.layer === undefined ? undefined : String(args.layer);
        if (layer && !EFFECT_LAYERS.includes(layer as typeof EFFECT_LAYERS[number])) return bad(`layer 只能是 ${EFFECT_LAYERS.join('、')}`);
        const hits = searchEffects(need, layer, 10);
        if (!hits.length) return '没搜到。换个说法。';
        const questions = Object.fromEntries(hits.map((item) => [item.id, {
          type: 'noul' as const,
          instructions: `这个特效最适合这个需求吗？需求：${need}。特效「${item.name}」：${item.summary}。适用：${item.use || '没写'}`,
        }]));
        const scored = await askJudge({ need, layer }, questions, 8_000);
        let best = hits[0]!;
        if (scored) {
          let top = scored.scores[best.id] ?? 0;
          for (const item of hits) {
            const value = scored.scores[item.id] ?? 0;
            if (value > top) { best = item; top = value; }
          }
        }
        return `${effectBrief(best)}${scored ? '' : '\n（没能打分，先用搜索第一名）'}`;
      },
    });

    register({
      name: 'deliver',
      description: '把东西交给主播。kind：'
        + 'start 话题的起步卡（要填 title：话题名）——钩子一句、直觉以为什么、两三条带出处的事实，够她开口就行；'
        + 'cards 给话题补一批素材（3–5 条：事实、故事、数字、类比，能配画面就配一个）；'
        + 'answer 查到的答案（一句话结论 + 带出处的事实）；visual 给她挑的画面；progress 报一句进度（她会拿去跟观众聊）；fail 查不到或做不成，说清为什么。\n'
        + '事实一条一行「- 事实（出处：网站或机构名, 网址）」，只写网页里真的读到的；不是事实的（钩子、类比、问观众的话）写成「资料：……」。'
        + '画面写法：```visual 类型 编号``` 素材块（类型：' + VISUAL_KINDS.filter((k) => k !== 'image').join('、') + '；代码场景 src 只能是 @名字.html），'
        + '或者现成的特效标记 [[graphic id 字段=值]]（id 用 graphic_search / graphic_pick 搜到的）。她照抄就能用，所以要写对。交完一批就停下等她叫你。',
      parameters: {
        kind: { type: 'string', enum: ['start', 'cards', 'answer', 'visual', 'progress', 'fail'], required: true },
        text: { type: 'string', required: true, description: '交的内容' },
        title: { type: 'string', description: '话题名（交 start 时必填，短，观众一看就懂）' },
      },
      async run(args, exec) {
        const task = mine(exec);
        if (!task) return '你现在没有在干的活';
        if (task.status !== 'running') return `这件活已经${task.status === 'cancelled' ? '被她撤了（话题换了）' : '交过了'}，停下吧`;
        const kind = String(args.kind ?? '') as 'start' | 'cards' | 'answer' | 'visual' | 'progress' | 'fail';
        const raw = String(args.text ?? '').trim();
        if (!raw) return '交的内容是空的';
        const topic = desk.topic?.task === task ? desk.topic : undefined;
        if ((kind === 'start' || kind === 'cards') && !topic) return '这不是话题的活，交 answer 或 visual';
        if ((kind === 'answer' || kind === 'visual') && topic) return '话题的活交 start（第一批）或 cards（后面的）';
        if (kind === 'start' && topic?.batches) return '起步卡交过了，后面的交 cards';
        if (kind === 'cards' && topic && !topic.batches) return '第一批交 start（带 title）';
        const title = String(args.title ?? '').trim().slice(0, 24);
        if (kind === 'start' && !title) return 'start 要填 title（话题名）';
        if (kind === 'progress' || kind === 'fail') {
          desk.deliver(task, kind, raw);
          return kind === 'progress' ? '报上去了，接着干' : '交上去了，停下吧';
        }
        // 事实要带出处：「- 」开头的行（素材块外）都算事实
        const facts = raw.replace(/```[\s\S]*?```/g, '').split('\n').filter((l) => l.trim().startsWith('- '));
        const unsourced = facts.filter((l) => !/出处|来源|https?:\/\//.test(l));
        const problems: string[] = [];
        if (unsourced.length) problems.push(`这些「- 」行没写出处：是事实就补上出处；不是事实就改成「资料：……」开头，或者删掉：\n${unsourced.slice(0, 8).join('\n')}`);
        if (kind !== 'visual' && !facts.length) problems.push('至少要有一条带出处的事实（「- 事实（出处：网站, 网址）」）');
        const taken = takeVisuals(task, raw);
        if (taken.error) problems.push(`${taken.error}（写法见提示里的速查）`);
        if (problems.length) return `没收，一次改好再交：\n${problems.join('\n\n')}`;
        if (topic) {
          if (kind === 'start') {
            desk.name(topic, title);
            stage.setShow({ topic: title });
            // 右栏的「今晚聊过」跟着话题走（像弹幕栏一样是界面上的记录，不是她的画面安排）
            stage.apply({ type: 'rundown', title: '今晚聊过', steps: desk.topics.slice(-6) });
            stage.apply({ type: 'rundown', at: Math.min(desk.topics.length, 6) - 1 });
          }
          await mkdir(TOPICS, { recursive: true });
          await appendFile(join(TOPICS, `${task.id}-${new Date().toISOString().slice(0, 10)}.md`), `${kind === 'start' ? `# ${title}\n\n` : ''}${raw}\n\n`);
        }
        desk.deliver(task, kind, taken.text, stage.speechStats().spokenMs);
        // 查资料的状态牌收掉
        if (stage.state.status && /^(查资料|在读)/.test(stage.state.status)) stage.apply({ type: 'status', label: null });
        return topic ? '交上去了。这一批就到这儿，停下等她叫你补下一批。' : '交上去了，这件活结束，停下就行';
      },
    });
    return;
  }

  /**
   * 推进：她闲着（嘴停了、几秒没调工具）时，有新弹幕就推弹幕，课没讲完就推「接着讲」。
   * 只推消息，讲什么、怎么演还是她定。
   */
  ctx.effect(() => {
    const timer = setInterval(() => {
      const t = Date.now();
      // 还没开场（没有她的会话）就别动快报，取走了也送不到；嘴还够念一阵、她有工具在跑、刚动过，都不算闲。
      // 直播间安静时多等等再推：真人主播没人说话时也会停一停
      const quiet = stage.isQuiet() && !liveInput.hasNews();
      if (!show.sessionId || stage.remainingMs() > lead() || running > 0 || t - lastToolAt < (quiet ? IDLE_QUIET_MS : IDLE_MS) || t - lastNudgeAt < (quiet ? NUDGE_QUIET_MS : NUDGE_GAP_MS)) return;
      const chatting = desk.topic?.batches ? desk.topic : undefined;
      lastNudgeAt = t;
      void (async () => {
        const news = [inbox(), await roomNews(), desk.take()].filter(Boolean).join('\n');
        if (!chatting && !news) return;
        const lines = ['【直播间】'];
        if (news) lines.push(news);
        if (quiet && !news) lines.push('直播间这会儿挺安静，没人发弹幕。不用急着填满：可以停一下、问观众一个问题等等回应，或者慢慢接着刚才的话题说一句。');
        else if (chatting) lines.push(`接着聊「${chatting.title}」：有要回的弹幕先回，然后用你手上的素材往下讲；想往哪个方向走、缺料了，research kind=more。聊够了就换个话题（research kind=topic）。`);
        await push(lines.join('\n'));
      })().catch(() => undefined);
    }, 1_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'dsh-livestream 推进');

  /**
   * 值得马上回的（主人发的弹幕、送礼、醒目留言、上船、人少时的提问）不等她这段念完：
   * 念完正在念的这句就停（软打断），后面的话挂起，事情马上插进她这一轮的下一步；她回完，挂着的自动接着念。
   * 观众触发的隔 BREAK_GAP_MS 才能再停一次，免得一直被礼物打断（这期间的照常进快报）；主人随时。
   */
  ctx.effect(() => {
    let lastBreakAt = 0;
    let busy = false;
    const timer = setInterval(() => {
      if (!show.sessionId || busy) return;
      const owner = inboxWaiting();
      if (!owner && !liveInput.hasUrgent() && !liveInput.hasBreak()) return;
      if (Date.now() - lastBreakAt < (owner ? 3_000 : BREAK_GAP_MS)) return;
      busy = true;
      void (async () => {
        const ownerNews = inbox();
        const news = [ownerNews, await roomNews()].filter(Boolean).join('\n');
        if (!news) return;
        lastBreakAt = wake.at = Date.now();
        const checkpoint = ownerNews ? await stage.call<string>('speech.break', { news: ownerNews }) : '';
        await push(`【直播间·马上回】\n${news}${checkpoint ? `\n${checkpoint}\n${HELD_NOTE}` : ''}`);
      })().catch(() => undefined).finally(() => { busy = false; });
    }, 500);
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'dsh-livestream 马上回');

  register({
    name: 'speak',
    description: '向观众公开讲话的唯一入口。一次交一小段（平常二至四句口语，每句尽量不超过20字，最多 300 字；马上回时先只交一句短回应，内容再分小段往下讲），写进嘴里（说话队列）就回来，嘴自己念，你接着做别的：'
      + '要查资料、找素材，先 speak 一句回应观众，再去调工具（查资料、挑画面派给后台：research），查的时候嘴还在说（同一步里一起调也行）。队里攒得太多时才会等一会儿；有新弹幕或后台交东西会提前回来。'
      + '要先回观众、不想等排着的话念完，传 next=true：念完正在念的这段就说这句，排着的接着念。'
      + '嘴比手慢：工具是马上生效的，跟某个字对齐的动作写成台词里的标记，念到那个字时发生：\n' + CUE_HELP + '\n'
      + '字幕会自己演：你只管标语气（tone）和重音——要强调的词用 *星号* 包起来（一段一两处），念到时字幕上那个词会放大变色，里面有数字会滚上去；'
      + '想做个表情就写 [[emote laugh]]（笑出声，还有 shock、cry、love、think、fire、clap、sweat、star、question、party……也可以直接写一个 emoji），点到为止，一段最多一个。tone=reveal（揭晓、反转）的句子会跳到画面中间砸出来，只有 24 个字以内才砸——揭晓那句单独成段、说短，铺垫和解释放到前后段。别把台词再写到画布上。'
      + '例：「结果呢？*这个数*，后来查下来，*一个都对不上*。」标记和星号都不念出来。'
      + '要等这段念完再做别的（比如要切走），传 wait=true。不要念路径、报告、代码或工具结果。',
    parameters: {
      text: { type: 'string', required: true, description: '给观众听的一段话，可带 [[标记]]，最多 300 字（不算标记）' },
      mood: { type: 'string', description: `念这段时的表情（${MOODS.join(' ')}），默认跟着语气；写成语气名也认` },
      pace: { type: 'string', enum: Object.keys(PACES), description: '语速：slow 慢一点（讲关键、讲难懂的、等观众跟上）、normal、fast 快一点（带过、吐槽、气氛热的时候）。不给就跟着语气走' },
      tone: { type: 'string', enum: TONES, description: '这段的语气：plain 平常（默认）、excited 兴奋、reveal 揭晓反转（短句最有劲）、serious 认真、aside 小声嘀咕、question 提问、quote 念原话' },
      wait: { type: 'boolean', description: '等这段念完再返回' },
      next: { type: 'boolean', description: '插队：念完正在念的这段就说这句（回弹幕、回主人用），排着的照念' },
    },
    async run(args, exec) {
      const text = String(args.text ?? '').trim();
      if (!text) return '请给一段要说的话';
      const tone = TONES.includes(args.tone as Tone) ? (args.tone as Tone) : undefined;
      // 表情写错（实测写成语气名 plain）不整段退回：认成最接近的表情，认不出就跟着语气
      const given = String(args.mood ?? '');
      const mood = (MOODS.includes(given as Mood) ? (given as Mood) : TONES.includes(given as Tone) ? TONE_MOOD[given as Tone] : undefined) ?? (tone ? TONE_MOOD[tone] : undefined);
      const pace = (PACES as Record<string, number>)[String(args.pace)] ?? (tone ? TONE_PACE[tone] : undefined);
      const queued = stage.enqueue(text, { ...(mood ? { mood } : {}), ...(tone ? { tone } : {}), ...(pace && pace !== 1 ? { rate: pace } : {}), ...(args.next ? { next: true } : {}) });
      const plain = parseCues(text).text;
      if (plain) {
        said.push(plain);
        if (said.length > 8) said.shift();
      }
      if (queued.errors.some((e) => e === '没有要念的字')) return `没排上：${queued.errors.join('；')}`;
      const signal: AbortSignal | undefined = exec?.signal;
      // 嘴没攒满就马上回；攒满了等到念下去一些。等的时候有新弹幕就提前回来让她看（最多隔几秒一次）
      let result: string | undefined;
      void queued.done.then((r) => { result = r; });
      const since = Date.now();
      for (;;) {
        if (signal?.aborted) break;
        // 有人值得马上回（主人发话、送礼、提问）：不等嘴，马上回来让她看
        if (wake.at > since || wake.at > handledWake) { handledWake = wake.at; break; }
        if (result !== undefined) break;
        if (!args.wait) {
          if (stage.remainingMs() <= full()) break;
          if (stage.remainingMs() <= cap() && Date.now() - lastNewsAt >= NEWS_GAP_MS && (inboxWaiting() || liveInput.hasNews() || desk.hasNews())) { lastNewsAt = Date.now(); break; }
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const notes: string[] = [];
      if (result === 'interrupted') {
        const unsaid = await stage.takeUnsaid();
        notes.push(`被打断了。观众没听到的：${unsaid.length ? unsaid.join(' / ') : '这一段'}。先看看发生了什么，别急着原样重说。`);
      } else {
        const left = Math.round(stage.remainingMs() / 1000);
        notes.push(args.wait && result === 'done' ? '这段念完了。' : `排上了，嘴里还有约 ${left} 秒的话。${
          left * 1000 > full() ? '这段排上了，不过嘴里已经排得够多：下一段先缓缓，先处理回执里的事（查到的资料、弹幕）；要回观众就用 next=true 插到前面。别为了等资料去反复看舞台，资料到了会跟着任何一个工具的回执来。'
          : left * 1000 > lead() ? '要查什么、摆什么现在去做，嘴不会停；没别的事就接着写下一段。'
          : stage.isQuiet() ? '嘴快空了。直播间这会儿安静，不用急着接：可以停一下、等等弹幕，有想说的再说。' : '嘴快空了，接着写下一段。'}`);
      }
      const errors = [...queued.errors, ...(await stage.takeCueErrors())];
      // 上了代码场景却没驱动：画面停在初始状态，跟她说的对不上（实测「机身上密密麻麻的孔」配着「还没标弹孔」）
      const cues = parseCues(text).cues;
      const scenes = cues.map((c) => (c.cmd.type === 'show' && c.cmd.id ? desk.visuals.get(c.cmd.id) : undefined)).filter((v): v is Extract<Visual, { kind: 'scene' }> => v?.kind === 'scene');
      if (scenes.length && !cues.some((c) => c.cmd.type === 'drive')) {
        notes.push(`你上了代码场景「${scenes.map((v) => v.title ?? v.id).join('、')}」但没驱动它，画面停在初始状态，跟你说的可能对不上。讲到对应的那句时写上动作：${scenes.map((v) => v.controls ?? '（看素材说明）').join('；')}（[[set 参数=值]] [[do 动作]]）。`);
      }
      if (errors.length) notes.push(`标记有问题（没生效）：${errors.join('；')}`);
      const news = inbox();
      if (news) notes.push(news);
      const room = await roomNews();
      if (room) notes.push(room);
      const back = desk.take();
      if (back) notes.push(back);
      // 嘴里排着的（有两段以上才列）：她可以撤、改、提前（speech_queue）
      const lineup = (await stage.lineup()).filter((l) => !l.playing);
      if (lineup.length >= 2) notes.push(`嘴里排着（按顺序）：${lineup.map((l) => `${l.id}「${l.text.length > 18 ? `${l.text.slice(0, 18)}…` : l.text}」`).join(' → ')}。说过时了、跟弹幕对不上，用 speech_queue 撤掉或改掉。`);
      const orders = await stage.call<string>('orders.pending');
      if (orders) notes.push(orders);
      notes.push(`现在 ${clockNow()}。`);
      const filled = await stage.takeFilled();
      if (filled.length) notes.push(`（你嘴空的时候顺嘴垫了：${filled.map((x) => `「${x}」`).join('')}。接着说，别重复）`);
      const busy = desk.line();
      if (busy) notes.push(busy);
      return notes.join('\n');
    },
  });

  register({
    name: 'speech_queue',
    description: '管你嘴里排着、还没念出去的话：list 看排着哪些（编号、内容）；drop 撤回一段（话题变了、弹幕已经把这事聊过去了）；'
      + 'edit 把一段改成新的话（原位置、原语气，重新合成，标记照写）；first 把一段提到最前面，念完正在念的就说它。正在念的那段收不回来。',
    parameters: {
      action: { type: 'string', enum: ['list', 'drop', 'edit', 'first'], required: true },
      id: { type: 'string', description: '那段话的编号（list 或 speak 回执里的 say12 这种）' },
      text: { type: 'string', description: 'edit 时的新内容' },
    },
    async run(args) {
      const show = async () => {
        const all = await stage.lineup();
        if (!all.length) return '嘴里没有排着的话。';
        return all.map((l) => `${l.playing ? '正在念' : l.ready ? '排着' : '合成中'} ${l.id}：${l.text}`).join('\n');
      };
      const id = String(args.id ?? '').trim();
      if (args.action === 'list') return show();
      if (!id) return '要给 id（先 list 看编号）';
      if (args.action === 'drop') {
        const text = await stage.retract(id);
        return text ? `撤了 ${id}：「${text}」。\n${await show()}` : `${id} 不在排队里（念过了、正在念或者编号不对）。\n${await show()}`;
      }
      if (args.action === 'first') return (await stage.hoist(id)) ? `${id} 提到最前了。\n${await show()}` : `${id} 不在排队里。\n${await show()}`;
      const text = String(args.text ?? '').trim();
      if (!text) return 'edit 要给 text';
      const q = await stage.revise(id, text);
      if (!q) return `${id} 不在排队里，没改成。\n${await show()}`;
      const plain = parseCues(text).text;
      if (plain) {
        said.push(plain);
        if (said.length > 8) said.shift();
      }
      return `改好了，新编号 ${q.id}${q.errors.length ? `；标记有问题：${q.errors.join('；')}` : ''}。\n${await show()}`;
    },
  });

  register({
    name: 'stage_scene',
    description: '切镜头：chat 杂谈（你占半屏，素材摆在你旁边）或 watch 展示（素材铺满主画面，你缩到右下）。'
      + 'cut 选 soft 软切（默认）或 hard 硬切，具体转场由导播定。两次切换至少隔几秒；主人锁镜头时不能切。',
    parameters: {
      scene: { type: 'string', enum: ['chat', 'watch'], required: true },
      cut: { type: 'string', enum: ['soft', 'hard'] },
    },
    run: (args) => act({ type: 'scene', scene: args.scene, cut: args.cut ?? 'soft', by: 'agent' }),
  });

  register({
    name: 'stage_work',
    description: '工位模式和状态牌。mode：watch 看片、edit 剪辑、code 写代码、fx 写特效、lesson 讲东西。status 是挂在画面上的一个短状态（如「正在看」「细看」「切开」「验货」），传空串收掉。',
    parameters: {
      mode: { type: 'string', enum: ['watch', 'edit', 'code', 'fx', 'lesson'] },
      status: { type: 'string', description: '最多 12 个字；空串收掉' },
    },
    run(args) {
      if (args.mode) return act({ type: 'mode', mode: args.mode, ...(args.status !== undefined ? { status: args.status || null } : {}) });
      if (args.status !== undefined) return act({ type: 'status', label: args.status || null });
      return bad('mode 和 status 至少给一个');
    },
  });

  register({
    name: 'stage_avatar',
    description: '换表情，或者隐藏/显示角色。隐藏角色后节目照常，只剩主内容台。',
    parameters: {
      mood: { type: 'string', enum: MOODS },
      visible: { type: 'boolean' },
    },
    run(args) {
      if (!args.mood && args.visible === undefined) return bad('mood 和 visible 至少给一个');
      return act({ type: 'avatar', ...(args.mood ? { mood: args.mood } : {}), ...(args.visible !== undefined ? { visible: args.visible } : {}) });
    },
  });

  register({
    name: 'clip_control',
    description: '主画面的片子：load 上一段新片子（换片会清掉旗、选区、切点和特效块）、play、pause、seek 跳到某处、unload 撤下。'
      + '时间可以写秒数或「1:30」。',
    parameters: {
      action: { type: 'string', enum: ['load', 'play', 'pause', 'seek', 'unload'], required: true },
      title: { type: 'string', description: 'load 用：片子的名字（给观众看的）' },
      duration: { ...TIME, description: 'load 用：片长' },
      at: { ...TIME, description: 'seek 用：跳到哪' },
    },
    run(args) {
      switch (args.action) {
        case 'load': {
          const duration = seconds(args.duration);
          if (!args.title || !duration) return bad('load 要给 title 和 duration');
          return act({ type: 'clip', title: args.title, durationSec: duration });
        }
        case 'seek': {
          const at = seconds(args.at);
          return at === undefined ? bad('seek 要给 at') : act({ type: 'seek', at });
        }
        case 'unload': return act({ type: 'unclip' });
        default: return act({ type: args.action });
      }
    },
  });

  register({
    name: 'timeline',
    description: '在播放进度条上做标记：mark 插旗（不给 at 就插在播放头）、unmark 拔旗（给 id 拔一面，不给全拔）、'
      + 'select 选一段（from、to）、unselect 清选区、split 在某处切开（不给 at 就切在播放头）、zoom 只看一窗（from、to）、unzoom 回到全片。',
    parameters: {
      action: { type: 'string', enum: ['mark', 'unmark', 'select', 'unselect', 'split', 'zoom', 'unzoom'], required: true },
      at: TIME,
      from: TIME,
      to: TIME,
      label: { type: 'string', description: '旗或选区上的短字' },
      id: { type: 'string', description: 'unmark 用：旗的编号（情报里括号里那个）' },
    },
    run(args) {
      const at = seconds(args.at), from = seconds(args.from), to = seconds(args.to);
      const range = () => (from === undefined || to === undefined ? undefined : { from, to, ...(args.label ? { label: args.label } : {}) });
      switch (args.action) {
        case 'mark': return act({ type: 'mark', label: args.label ?? '旗', ...(at !== undefined ? { at } : {}) });
        case 'unmark': return act({ type: 'unmark', ...(args.id ? { id: args.id } : {}) });
        case 'select': return range() ? act({ type: 'select', range: range()! }) : bad('select 要给 from 和 to');
        case 'unselect': return act({ type: 'select', range: null });
        case 'split': return act({ type: 'split', ...(at !== undefined ? { at } : {}) });
        case 'zoom': return range() ? act({ type: 'view', range: range()! }) : bad('zoom 要给 from 和 to');
        default: return act({ type: 'view', range: null });
      }
    },
  });

  register({
    name: 'look_closer',
    description: '细看：把主画面放大到某一块（你看不到画面细节，只是演「凑近看」）。不给 region 就收回。',
    parameters: {
      region: { type: 'string', enum: REGIONS },
      label: { type: 'string', description: '画面上标的短字，如「右上角」' },
    },
    run: (args) => act({ type: 'focus', focus: args.region ? { region: args.region, ...(args.label ? { label: args.label } : {}) } : null }),
  });

  register({
    name: 'code_strip',
    description: '代码条：写代码模式下在主画面上打出一小段代码摘录（最多 12 行，会一行行打出来）。只放给观众看的几行，不放路径、密钥、整份文件。不给 code 就收起。',
    parameters: {
      code: { type: 'string', description: '几行代码' },
      title: { type: 'string', description: '这段在做什么，如「慢动作曲线」' },
      lang: { type: 'string', description: '语言，如 ts' },
      highlight: { type: 'integer', description: '高亮第几行（从 1 数）' },
    },
    run(args) {
      if (!args.code) return act({ type: 'code', code: null });
      return act({ type: 'code', code: { title: args.title ?? '代码', lang: args.lang ?? 'code', lines: String(args.code).split('\n'), ...(args.highlight ? { highlight: args.highlight } : {}) } });
    },
  });

  register({
    name: 'fx_block',
    description: '特效块（画在进度条下面一条）：add 加一块（name、from、to）、move 挪（id、from、to）、status 改状态（draft 草稿、rendering 渲染中、ready 预览已更新、failed）、remove 删。',
    parameters: {
      action: { type: 'string', enum: ['add', 'move', 'status', 'remove'], required: true },
      id: { type: 'string' },
      name: { type: 'string' },
      from: TIME,
      to: TIME,
      status: { type: 'string', enum: ['draft', 'rendering', 'ready', 'failed'] },
    },
    run(args) {
      const from = seconds(args.from), to = seconds(args.to);
      if (args.action === 'add') return from === undefined || to === undefined ? bad('add 要给 from 和 to') : act({ type: 'fx', op: 'add', name: args.name ?? '特效', from, to });
      if (!args.id) return bad('要给特效块的 id（情报里括号里那个）');
      if (args.action === 'move') return from === undefined || to === undefined ? bad('move 要给 from 和 to') : act({ type: 'fx', op: 'move', id: args.id, from, to });
      if (args.action === 'status') return args.status ? act({ type: 'fx', op: 'status', id: args.id, status: args.status }) : bad('status 要给新状态');
      return act({ type: 'fx', op: 'remove', id: args.id });
    },
  });

  register({
    name: 'task_corner',
    description: '角落的任务进度：start 派出一个任务（kind：generate 生成、export 导出、render 渲染、sandbox 工位启动；title 给观众看的短名）、'
      + 'progress 更新进度（0–100）、done 完成、fail 失败、remove 撤掉。派出去以后可以切回杂谈陪观众聊，进度留在角落。',
    parameters: {
      action: { type: 'string', enum: ['start', 'progress', 'done', 'fail', 'remove'], required: true },
      kind: { type: 'string', enum: ['generate', 'export', 'render', 'sandbox'] },
      title: { type: 'string' },
      id: { type: 'string', description: '任务编号（情报里括号里那个）' },
      progress: { type: 'number', description: '0–100' },
    },
    run(args) {
      if (args.action === 'start') return act({ type: 'task', op: 'start', kind: args.kind ?? 'generate', title: args.title ?? '任务' });
      if (!args.id) return bad('要给任务编号');
      if (args.action === 'progress') return act({ type: 'task', op: 'progress', id: args.id, progress: Number(args.progress ?? 0) / 100 });
      return act({ type: 'task', op: args.action, id: args.id });
    },
  });

  register({
    name: 'broll',
    description: '插一段 B-roll（几秒钟的插片，比如验货时亮出新素材），只在看片场景能插，和切镜头共用频率上限。',
    parameters: {
      title: { type: 'string', required: true },
      caption: { type: 'string' },
    },
    run: (args) => act({ type: 'broll', title: args.title, ...(args.caption ? { caption: args.caption } : {}), by: 'agent' }),
  });

  register({
    name: 'graphic',
    description: '上一段包装动画，配合正在说的话。name 用查来的资料里给的特效 id，或者下面的短名字；要别的特效 research kind=visual 去挑。短名字和能填的字段：\n' + graphicMenu() + '\n'
      + 'fields 按搜到的字段填短中文；文字不填就空着，不要把英文默认文案填上去。同一位置新的会顶掉旧的。说话时用来配合，不要连发。',
    parameters: {
      name: { type: 'string', required: true, description: '特效 id 或短名字' },
      fields: { type: 'object', additionalProperties: true, description: '字段名到值，名字和类型以 graphic_search 的结果为准' },
      slot: { type: 'string', enum: GRAPHIC_SLOTS, description: '放在哪。不填时，盖满画面的用满屏，叠在上面的放中间' },
      seconds: { type: 'number', description: '停留秒数，不填就按动画时长再多留一会儿' },
    },
    async run(args) {
      await effectsReady;
      const name = String(args.name ?? '');
      let fields: Record<string, string> | undefined;
      if (args.fields !== undefined) {
        if (!args.fields || typeof args.fields !== 'object' || Array.isArray(args.fields)) return bad('fields 要是对象');
        fields = {};
        for (const [key, value] of Object.entries(args.fields as Record<string, unknown>)) {
          if (value === undefined || value === null) continue;
          fields[key] = typeof value === 'string' ? value : String(value);
        }
      }
      const seconds = args.seconds === undefined ? undefined : Number(args.seconds);
      if (seconds !== undefined && !Number.isFinite(seconds)) return bad('停留秒数要是数字');
      return act({
        type: 'graphic',
        name,
        ...(fields ? { fields } : {}),
        ...(args.slot ? { slot: String(args.slot) as GraphicSlot } : {}),
        ...(seconds !== undefined ? { seconds } : {}),
      });
    },
  });

  register({
    name: 'graphic_clear',
    description: '撤下包装。给 id 只撤那一段（情报里括号里那个），不给就全部撤下。',
    parameters: {
      id: { type: 'string', description: '要撤的那段；不给就全部撤下' },
    },
    run: (args) => act({ type: 'ungraphic', ...(args.id ? { id: String(args.id) } : {}) }),
  });

  /** 开一个后台会话（「直播后台」预设），绑到这件活上 */
  const spawn = async (task: Task): Promise<any> => {
    const registry = ctx.get?.('agents');
    const model = ctx.get?.('agentDefaultModel');
    if (!registry?.create || !model) throw new Error('后台还没准备好');
    const { provider, model: id } = model.currentSelection();
    const selection = { provider, model: id, reasoningEffort: WORKER_REASONING };
    const sessionId = `session-${randomUUID()}`;
    const { agent } = await registry.create({
      sessionId,
      meta: { cwd: PACKAGE_ROOT, agentPreset: WORKER_PRESET },
      agentOptions: { provider, model: id },
      // setup 的返回值会被当成要 commit 的东西，这里什么都不返回
      setup: (agentCtx: unknown) => {
        installModelSelection(agentCtx as never, { current: selection, assembled: undefined } as never);
      },
    });
    await ctx.get?.('agentPresets')?.select?.(agent, WORKER_PRESET);
    await agent.whenIdle?.();
    desk.bind(task, sessionId);
    return agent;
  };
  const note = (text: string) => Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'dsh-livestream-desk' } });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** 台上现在的情况：给后台的派活和补料都带上 */
  const scene = (): string[] => {
    const st = stage.state;
    const recent = st.danmaku.slice(-6).map((d) => `${d.user}：${d.text}`);
    const shown = st.draw.items.filter((x) => x.kind !== 'link' && x.kind !== 'group').map((x) => `${x.id}(${x.kind}${x.text ? ` ${x.text.slice(0, 12)}` : ''})`);
    return [
      ...(show.direction ? [`今天这场直播的方向：${show.direction}`] : []),
      ...(said.length ? [`她最近说的：\n${said.slice(-5).map((t) => `- ${t.slice(0, 120)}`).join('\n')}`] : []),
      ...(shown.length ? [`画面上：${shown.join('、')}`] : []),
      ...(recent.length ? [`最近的弹幕：\n${recent.join('\n')}`] : []),
    ];
  };
  const budgetNote = (ms: number, what: string) => note(`【主播】${Math.round(ms / 1000)} 秒了，别再搜了，就用手上已经读到的资料马上交（deliver ${what}）。读不到全文的论文别追，用摘要和二手介绍里读到的就行，出处照实写。要是这一批刚交上去了，就不用管这条，停下。`);

  /** 一件活收尾（交了、撤了、没查成）：没别的在查，翻资料的画面就收掉 */
  const settle = () => {
    if (!desk.running().length && !(desk.topic && desk.topic.task.status === 'running' && !desk.topic.batches)) stage.apply({ type: 'research', done: true });
  };

  /** 一次性的小活：查一个问题、挑一个画面。交了、停了、超时都算完 */
  const oneShot = async (task: Task): Promise<void> => {
    const agent = await spawn(task);
    const kind = task.kind as 'answer' | 'visual';
    agent.followup(note([
      `【主播派活 ${task.id}】${kind === 'answer' ? '查一个问题（deliver answer 交）' : '给她正在讲的东西挑画面（deliver visual 交）'}`,
      `她说：${task.ask}`,
      ...scene(),
    ].join('\n')));
    const started = Date.now();
    let nudged = false;
    for (;;) {
      await sleep(500);
      if (task.status !== 'running') break;
      if (!nudged && Date.now() - started > WORKER_BUDGET_MS[kind]) { nudged = true; agent.steer?.(budgetNote(WORKER_BUDGET_MS[kind], kind)); }
      if (Date.now() - started > WORKER_TIMEOUT_MS) { desk.deliver(task, 'fail', `${WORKER_TIMEOUT_MS / 60_000} 分钟没交，撤了`); break; }
      if (agent.status === 'idle' && Date.now() - started > 3_000) { desk.deliver(task, 'fail', '没查出东西'); break; }
    }
    if (agent.status !== 'idle') agent.cancel?.({ kind: 'parent' });
    settle();
  };

  /**
   * 跟着一个话题：先要起步卡，之后她说了一阵（或点名要什么）就叫后台补一批，带上她刚讲了什么、观众说了什么。
   * 话题换了、撤了、跟太久了、连着几批没交上，就停。
   */
  const follow = async (topic: Topic): Promise<void> => {
    const task = topic.task;
    const agent = await spawn(task);
    let waiting: { kind: 'start' | 'cards'; at: number; batches: number; nudged: boolean } | undefined;
    let misses = 0;
    const ask = (kind: 'start' | 'cards', text: string) => {
      agent.followup(note(text));
      waiting = { kind, at: Date.now(), batches: topic.batches, nudged: false };
    };
    ask('start', [
      `【主播派活 ${task.id}】跟一个话题。先交起步卡（deliver start，带 title），之后她讲的时候会叫你补料（deliver cards）。`,
      `她说：${task.ask}`,
      ...scene(),
    ].join('\n'));
    for (;;) {
      await sleep(500);
      if (task.status !== 'running' || desk.topic !== topic) break;
      if (Date.now() - task.startedAt > TOPIC_LIFETIME_MS) break;
      if (waiting) {
        const elapsed = Date.now() - waiting.at;
        if (topic.batches > waiting.batches) {
          waiting = undefined;
          misses = 0;
        } else if (!waiting.nudged && elapsed > WORKER_BUDGET_MS[waiting.kind]) {
          waiting.nudged = true;
          agent.steer?.(budgetNote(WORKER_BUDGET_MS[waiting.kind], waiting.kind));
        } else if ((agent.status === 'idle' && elapsed > 3_000) || elapsed > 90_000) {
          if (agent.status !== 'idle') agent.cancel?.({ kind: 'parent' });
          waiting = undefined;
          if (++misses >= TOPIC_MAX_MISSES || !topic.batches) {
            desk.deliver(task, 'fail', topic.batches ? '连着几批没查出新东西，这个话题的料差不多了' : '没找到合适的话题');
            break;
          }
        }
        // 她中途点名要的，直接插给正在查的后台
        if (waiting && topic.wants.length) agent.steer?.(note(`【主播】她又要：${topic.wants.splice(0).join('；')}`));
        continue;
      }
      const talked = stage.speechStats().spokenMs - topic.spokenAtLastBatch;
      if (agent.status === 'idle' && (topic.wants.length || talked >= REFILL_SPOKEN_MS)) {
        const wants = topic.wants.splice(0);
        ask('cards', [
          `【主播】话题「${topic.title ?? ''}」补一批料（deliver cards，3–5 条，别重复已经交过的）。`,
          ...(wants.length ? [`她点名要：${wants.join('；')}`] : ['她没点名，你看她讲到哪了，补接下来用得上的：新的事实、故事、数字、能演出来的画面。']),
          ...scene(),
        ].join('\n'));
      }
    }
    if (agent.status !== 'idle') agent.cancel?.({ kind: 'parent' });
    settle();
  };

  register({
    name: 'research',
    description: '查资料、挑画面，派出去马上回来、不用等。kind：'
      + 'topic 换一个话题聊（主人让你自己找题、观众点了题、上一个聊完了）：很快先交来一张起步卡（话题名、钩子、两三条事实），够你开口，之后你讲着它会自己一批批补料；'
      + 'more 给正在聊的话题要料（想往哪个方向讲、缺什么故事数字画面）；answer 查一个观众的问题；visual 挑一个复杂画面（代码场景、特效库、要查数据才画得出来的图）。'
      + 'ask 写清楚要什么：观众原话、你想讲的角度、想演出来的那个机制或数字。查的时候你接着讲或跟观众聊（可以说一句「我查一下」），没拿到的事实别讲。'
      + '查到的出现在说话回执的【你查的资料】里：事实照着讲（用你自己的话）；素材用 [[show 编号]] 上屏，代码场景再用 [[set]] [[do]] 驱动；特效标记照抄进台词。answer、visual 最多同时 ' + MAX_RUNNING + ' 件。',
    parameters: {
      kind: { type: 'string', enum: [...RESEARCH_KINDS], required: true },
      ask: { type: 'string', required: true, description: '要查什么，越具体越好' },
    },
    run(args) {
      const kind = String(args.kind ?? '') as typeof RESEARCH_KINDS[number];
      if (!RESEARCH_KINDS.includes(kind)) return `kind 只能是 ${RESEARCH_KINDS.join('、')}`;
      const ask = String(args.ask ?? '').trim();
      if (!ask) return '说清楚要查什么';
      if (kind === 'more') {
        if (!desk.topic) return '现在没有在聊的话题，用 kind=topic 开一个';
        desk.topic.wants.push(ask);
        return `记下了，「${desk.topic.title ?? '这个话题'}」下一批料会往这个方向补。`;
      }
      if (kind === 'topic') {
        // 换话题：旧话题的后台撤掉
        const topic = desk.openTopic(ask, stage.speechStats().spokenMs);
        void follow(topic).catch((err: unknown) => desk.deliver(topic.task, 'fail', err instanceof Error ? err.message : '派不出去'));
        return `开始找了（${topic.task.id}）。起步卡一般二三十秒到；这期间跟观众聊（说说你想找什么样的题、问问大家想听什么），没拿到的事实别讲。`;
      }
      if (desk.running().length >= MAX_RUNNING) return `手上已经有 ${MAX_RUNNING} 件在查：${desk.line()}。等查完再派，或者 research_cancel 撤掉一件`;
      const task = desk.open(kind, ask);
      void oneShot(task).catch((err: unknown) => desk.deliver(task, 'fail', err instanceof Error ? err.message : '派不出去'));
      return `开始查了（${task.id}）。查的时候你接着讲或跟观众聊，没拿到的事实别讲；查到的会出现在说话回执的【你查的资料】里。`;
    },
  });

  register({
    name: 'research_cancel',
    description: '撤掉一件在查的事（观众换话题了、用不上了）。话题的编号也能撤，撤了就不再补料。',
    parameters: {
      id: { type: 'string', required: true, description: '编号，比如 t1' },
    },
    run(args) {
      const task = desk.cancel(String(args.id ?? ''));
      return task ? `撤了 ${task.id}` : '没有这件在查的事';
    },
  });

  register({
    name: 'stage_place',
    description: '摆直播间画布（1920×1080）：整套换摆法（layout），或者挪一个元素（el）——给区域名 at，或者给 x、y、w、h 里的几项；hide 藏起、show 亮出；look 转你的视线。'
      + '元素：avatar（你自己）、workspace（主画面：片子、翻资料）、subtitle（字幕）、side（右栏）、onair（角标）、alerts（礼物提示）。说话时更顺手的是台词里写 [[place …]] [[layout …]] [[look …]]。',
    parameters: {
      layout: { type: 'string', enum: LAYOUT_NAMES, description: '整套换摆法' },
      el: { type: 'string', enum: ELEMENT_IDS, description: '要挪的元素' },
      at: { type: 'string', enum: STAGE_REGIONS, description: '放到哪个命名区域' },
      x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
      hide: { type: 'boolean' }, show: { type: 'boolean' },
      look: { type: 'string', enum: ['camera', 'left', 'right'], description: '你的视线' },
    },
    run(args) {
      const cmds: Command[] = [];
      if (args.layout) cmds.push({ type: 'layout', name: String(args.layout) as LayoutName, by: 'agent' });
      if (args.el) {
        const box: Partial<Box> = {};
        for (const k of ['x', 'y', 'w', 'h'] as const) if (args[k] !== undefined && Number.isFinite(Number(args[k]))) box[k] = Number(args[k]);
        cmds.push({ type: 'place', el: String(args.el) as ElementId, ...(args.at ? { at: String(args.at) as StageRegion } : {}), ...(Object.keys(box).length ? { box } : {}), ...(args.hide ? { visible: false } : args.show ? { visible: true } : {}) });
      }
      if (args.look) cmds.push({ type: 'avatar', look: String(args.look) as Look });
      if (!cmds.length) return bad('给 layout、el 或 look');
      return act(...cmds);
    },
  });

  register({
    name: 'audience',
    description: '看直播间的观众簿：在线人数、本场弹幕/礼物/进场数、话最多的人、送礼的人、刚来的人；给名字就查这个人（第一次出现是什么时候、说了几条、送过什么、粉丝牌和等级）。叫人名字、感谢老观众前可以查一下。',
    parameters: {
      name: { type: 'string', description: '要查的人（名字里的一段就行）；不给就看全场' },
    },
    run: (args) => liveInput.audience(args.name ? String(args.name) : undefined),
  });

  register({
    name: 'stage_brief',
    description: '看一眼舞台现在大概什么样：场景、能不能切、画面上的组件和包装、画布怎么摆。',
    parameters: {},
    run: () => state(),
  });
}
