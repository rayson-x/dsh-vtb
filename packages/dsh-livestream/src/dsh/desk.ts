/**
 * 前台和后台之间的桌子：她（前台，表演）在台上聊，后台（另一个看不见的 agent）查资料、挑画面，
 * 把素材一批批放到桌上；她下一次说话回来（或闲着被推）时拿走。
 *
 * 不是课：没有节、没有讲义。单位是「话题」——她定一个话题，后台先交一张起步卡（钩子和两三条事实，够她开口），
 * 她讲的时候再按需一批批补（事实、故事、数字、画面）。话题跟着观众走，换了就换。
 * 查观众的问题、挑一个画面是一次性的小活。
 *
 * 后台不碰舞台、不说话，只交素材；用不用、怎么讲还是她定。都在一个进程里，桌子就是内存里的一张表。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Visual } from '../stage/visual';

export type TaskKind = 'topic' | 'answer' | 'visual';
export type TaskStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  kind: TaskKind;
  /** 她派活时说的话 */
  ask: string;
  startedAt: number;
  status: TaskStatus;
  /** 后台会话 */
  sessionId?: string;
  /** 后台在干什么（最近几条），给她跟观众聊用 */
  progress: string[];
}

/** 正在聊的话题：跟着它的那个后台一直在 */
export interface Topic {
  task: Task;
  /** 起步卡到了才有名字 */
  title?: string;
  /** 交过几批（含起步卡） */
  batches: number;
  /** 上一批交到时她已经说了多久（毫秒）：说了一阵就该补料了 */
  spokenAtLastBatch: number;
  /** 她点名要的（方向、角度）；交下一批时带给后台，交了就清掉 */
  wants: string[];
}

export interface Packet {
  task: string;
  kind: 'start' | 'cards' | 'answer' | 'visual' | 'progress' | 'fail';
  text: string;
  at: number;
}

const KIND_NAMES: Record<TaskKind, string> = { topic: '跟话题', answer: '查问题', visual: '挑画面' };
/** 一次性的小活最多同时干几件（话题后台另算） */
export const MAX_RUNNING = 2;

export class Desk {
  private tasks = new Map<string, Task>();
  private bySession = new Map<string, string>();
  private outbox: Packet[] = [];
  private seq = 0;
  /** 后台交来的素材，她用 [[show 编号]] 上屏 */
  readonly visuals = new Map<string, Visual>();
  /** 正在聊的话题；今晚聊过的话题名 */
  topic: Topic | undefined;
  readonly topics: string[] = [];

  private topicStarter: ((ask: string) => void) | undefined;
  requestedUntil = 0;
  private requestedTopics = new Set<string>();
  setTopicStarter(start: (ask: string) => void): () => void {
    this.topicStarter = start;
    return () => { if (this.topicStarter === start) this.topicStarter = undefined; };
  }
  /** 换题请求直接叫醒编导，不等主持人把回应和工具串行做完。 */
  requestTopic(ask: string, key?: string): boolean {
    if (!this.topicStarter || (key && this.requestedTopics.has(key))) return false;
    if (key) this.requestedTopics.add(key);
    this.requestedUntil = this.now() + 90_000;
    this.topicStarter(ask);
    return true;
  }
  private cardPoints: string[] = [];
  constructor(private readonly now: () => number = Date.now, private readonly publish?: (card: { title: string; hook?: string; points?: string[] } | undefined) => void, private readonly instance = '') {}
  private publishTopic(): void {
    this.publish?.(this.topic ? { title: this.topic.title ?? this.topic.task.ask, hook: this.topic.task.ask, points: this.cardPoints.slice(-5) } : undefined);
  }

  open(kind: TaskKind, ask: string): Task {
    const task: Task = { id: `t${++this.seq}${this.instance ? '-' + this.instance : ''}`, kind, ask, startedAt: this.now(), status: 'running', progress: [] };
    this.tasks.set(task.id, task);
    return task;
  }

  /** 换话题：旧的话题后台作废，新的开起来 */
  openTopic(ask: string, spoken: number): Topic {
    if (this.topic) this.cancel(this.topic.task.id);
    const topic: Topic = { task: this.open('topic', ask), batches: 0, spokenAtLastBatch: spoken, wants: [] };
    this.topic = topic;
    this.cardPoints = [];
    this.publishTopic();
    return topic;
  }

  bind(task: Task, sessionId: string): void {
    task.sessionId = sessionId;
    this.bySession.set(sessionId, task.id);
  }

  /** 后台会话 → 它在干的活；不是后台会话返回 undefined */
  ofSession(sessionId: string | undefined): Task | undefined {
    const id = sessionId ? this.bySession.get(sessionId) : undefined;
    return id ? this.tasks.get(id) : undefined;
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /** 在干的一次性小活（不含话题后台） */
  running(): Task[] {
    return [...this.tasks.values()].filter((t) => t.status === 'running' && t.kind !== 'topic');
  }

  /**
   * 后台交东西放到桌上。小活交了答案、画面就算干完；话题后台交起步卡、一批素材都不算完，一直跟着话题。
   * 交 fail 就算这件活没做成。spoken：交到时她已经说了多久（话题用来算什么时候该补料）
   */
  deliver(task: Task, kind: Packet['kind'], text: string, spoken = 0): void {
    if (task.status !== 'running') return;
    // 进度只留最新一条，免得她一回来看到一串；交了正经东西，进度就不用看了
    this.outbox = this.outbox.filter((p) => !(p.task === task.id && p.kind === 'progress'));
    if (kind === 'progress') {
      task.progress = [...task.progress, text].slice(-3);
    } else if (kind === 'fail') {
      task.status = 'failed';
      if (this.topic?.task === task) this.topic = undefined;
    } else if (kind === 'start' || kind === 'cards') {
      const topic = this.topic?.task === task ? this.topic : undefined;
      if (topic) {
        topic.batches++;
        topic.spokenAtLastBatch = spoken;
      }
    } else {
      task.status = 'done';
    }
    if (this.topic?.task === task && (kind === 'start' || kind === 'cards')) this.cardPoints = [...this.cardPoints, text.slice(0, 2400)];
    if (task.kind === 'topic') this.publishTopic();
    this.outbox.push({ task: task.id, kind, text, at: this.now() });
  }

  /** 起步卡上的话题名：记进今晚聊过的话题 */
  name(topic: Topic, title: string): void {
    topic.title = title;
    this.topics.push(title);
    this.publishTopic();
  }

  cancel(id: string): Task | undefined {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return undefined;
    task.status = 'cancelled';
    this.outbox = this.outbox.filter((p) => p.task !== id);
    if (this.topic?.task === task) { this.topic = undefined; this.publishTopic(); }
    return task;
  }

  /** 清空：在查的全撤、聊过的话题和素材都不要了（主人「清空她的记忆」时） */
  reset(): void {
    this.requestedUntil = 0;
    this.requestedTopics.clear();
    for (const t of this.tasks.values()) if (t.status === 'running') t.status = 'cancelled';
    this.topic = undefined;
    this.cardPoints = [];
    this.publishTopic();
    this.topics.length = 0;
    this.visuals.clear();
    this.outbox = [];
  }

  /** 桌上有没有正经东西（不算进度）：有就让说话那边早点回来 */
  hasNews(): boolean {
    return this.outbox.some((p) => p.kind !== 'progress');
  }

  /** 她拿走桌上的东西；没有返回空串 */
  take(): string {
    if (!this.outbox.length) return '';
    const out = this.outbox.splice(0);
    const lines = ['【你查的资料】'];
    for (const p of out) {
      const task = this.tasks.get(p.task);
      const head = task?.kind === 'topic' ? `话题${this.topic?.task === task && this.topic.title ? `「${this.topic.title}」` : ''}（${p.task}）` : `${p.task}（${(task?.ask ?? '').slice(0, 30)}）`;
      if (p.kind === 'progress') lines.push(`${head} 还在查：${p.text}`);
      else if (p.kind === 'fail') lines.push(`${head} 没查成：${p.text}`);
      else if (p.kind === 'start') lines.push(`${head} 起步卡到了，够你开口了，后面边讲边补：\n${p.text}`);
      else if (p.kind === 'cards') lines.push(`${head} 又补了一批素材：\n${p.text}`);
      else lines.push(`${head} 查到了：\n${p.text}`);
    }
    return lines.join('\n');
  }

  /** 给她看的一行：在查什么 */
  line(): string {
    const secs = (t: Task) => Math.round((this.now() - t.startedAt) / 1000);
    const parts: string[] = [];
    const topic = this.topic;
    if (topic && !topic.batches) parts.push(`话题（${topic.task.id}）找了 ${secs(topic.task)} 秒${topic.task.progress.length ? `，${topic.task.progress.at(-1)}` : ''}`);
    for (const t of this.running()) parts.push(`${t.id} ${KIND_NAMES[t.kind]}「${t.ask.slice(0, 20)}」${secs(t)} 秒${t.progress.length ? `，${t.progress.at(-1)}` : ''}`);
    return parts.length ? `你还在查：${parts.join('；')}` : '';
  }
}

/** 通用代码场景的目录：读每个场景开头的注释（演示什么、参数、动作），给后台挑 */
export function sceneCatalog(dir: string): string {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.html') && f !== 'index.html').sort();
  } catch {
    return '（没有代码场景）';
  }
  const out: string[] = [];
  for (const f of files) {
    const head = /<!--([\s\S]*?)-->/.exec(readFileSync(join(dir, f), 'utf8'))?.[1] ?? '';
    const show = /演示[：:]\s*(.+)/.exec(head)?.[1]?.trim() ?? '';
    const params = [...head.matchAll(/^- (\w+)\s+(\w+)\s+(.+)$/gm)].filter((m) => !/^(reset|replay)$/.test(m[1]!));
    const block = (title: string) => {
      const at = head.indexOf(title);
      if (at < 0) return [] as string[];
      return head.slice(at + title.length).split(/\n\s*\n/)[0]!.split('\n').map((l) => /^- (\S+)/.exec(l.trim())?.[1]).filter((x): x is string => !!x);
    };
    const args = block('参数').map((name) => params.find((m) => m[1] === name)).filter(Boolean).map((m) => `${m![1]}（${m![3]!.replace(/\s+/g, ' ').slice(0, 40)}）`);
    const acts = block('动作');
    out.push(`- @${f}：${show}${args.length ? `；参数 ${args.join('、')}` : ''}${acts.length ? `；动作 ${acts.join('、')}` : ''}`);
  }
  return out.join('\n');
}

/** 点单在念到关闭标记时才结账，排队、被打断都不算兑现。 */
export class OrderBook {
  private seq = 0;
  readonly entries: { id: string; who: string; gift: string; want: string; at: number; key?: string; status: 'pending' | 'done' | 'decline' }[] = [];
  add(who: string, gift: string, want: string, at = Date.now(), key?: string): void {
    if (!/请|讲|举|想听|想看|能不能|能否|可以|要|帮|来个|说说|解释|聊聊|慢|快|换|继续|别|停|再|把|求|给我/.test(want)) return;
    const updating = key ? this.entries.find((e) => e.key === key && e.status === 'pending') : undefined;
    if (updating) { updating.want = want; updating.gift = gift; return; }
    const paired = this.entries.find((e) => e.who === who && e.want === want && Math.abs(e.at - at) <= 15_000);
    if (paired) { if (gift) paired.gift = gift; if (key) paired.key = key; return; }
    this.entries.push({ id: `o${++this.seq}`, who, gift, want, at, ...(key ? { key } : {}), status: 'pending' });
  }
  close(id: string, status: 'done' | 'decline', spoken: string): string | undefined {
    const e = this.entries.find((e) => e.id === id);
    if (!e || e.status !== 'pending') return `点单 ${id} 不存在或已经关闭`;
    if (!spoken.includes(e.who)) return `关闭 ${id} 前要在这句里点名「${e.who}」`;
    const lastSentence = spoken.trim().match(/[^。！？!?]+[。！？!?]*$/)?.[0] ?? spoken;
    if (status === 'done' && /马上|稍后|待会|这就(?!是)|接下来|等会|我来|我会|给你(?:编|讲)/.test(lastSentence)) return `点单 ${id} 还没兑现：承诺要做不算已经讲出来，讲完内容再关闭`;
    e.status = status;
  }
  pending(): string {
    const rows = this.entries.filter((e) => e.status === 'pending');
    return rows.length ? `【未兑现点单】请尽快编进当前内容。排队不算兑现，只有观众听到内容后才关闭；兑现那句点名并在句末写 [[done 编号]]；婉拒用 [[decline 编号]]。\n${rows.map((e) => `${e.id} ${e.who}；送了 ${e.gift || (e.who === '主人' ? '（主人交代）' : '（观众点题）')}；要求：${e.want}；时间：${new Date(e.at).toISOString()}`).join('\n')}` : '';
  }
}
