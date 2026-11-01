/**
 * 她的输入输出轨迹：把 DSH 会话事件翻成控制台上一条条看得懂的记录。
 *
 * 只给主人看（控制台），不上舞台。工具结果和思考可能很长，截一截，完整的还在会话日志里。
 */

export type TraceKind = 'input' | 'notes' | 'thinking' | 'text' | 'call' | 'result' | 'turn' | 'usage' | 'error' | 'auto';

export interface TraceItem {
  seq: number;
  time: number;
  kind: TraceKind;
  /** 一行：谁、做了什么 */
  title: string;
  /** 正文：消息、台词、参数、结果 */
  body?: string;
}

const MAX_BODY = 1_500;
const cut = (text: string) => (text.length > MAX_BODY ? `${text.slice(0, MAX_BODY)}…（共 ${text.length} 字）` : text);
const texts = (content: unknown): string =>
  (Array.isArray(content) ? content : []).filter((c: any) => c?.type === 'text').map((c: any) => String(c.text)).join('\n');

/** 进来的消息是谁说的 */
function who(text: string): string {
  if (text.startsWith('【主人】')) return '主人';
  if (text.startsWith('【直播间')) return '直播间（推进）';
  if (text.startsWith('【直播便签】')) return '便签';
  return '开场指令';
}

/** 工具参数：speak 直接给台词，别的给 JSON */
function args(name: string, raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (name === 'speak') return `${String(parsed.text ?? '')}${parsed.mood ? `\n（表情：${String(parsed.mood)}）` : ''}${parsed.wait ? '（等念完）' : ''}`;
    return JSON.stringify(parsed, null, 1);
  } catch {
    return raw;
  }
}

export type Tracer = (event: { type: string; seq: number; time: number; data?: any }) => TraceItem[];

/** 一场的翻译器：记着每个调用编号是哪个工具（结果里只带编号） */
export function createTracer(): Tracer {
  const names = new Map<string, string>();
  return (event) => traceEvent(event, names);
}

/** 一个会话事件 → 零到多条轨迹 */
function traceEvent(event: { type: string; seq: number; time: number; data?: any }, names: Map<string, string>): TraceItem[] {
  const { seq, time, data } = event;
  switch (event.type) {
    case 'user/message': {
      const text = texts(data?.content);
      if (!text) return [];
      const from = who(text);
      return [{ seq, time, kind: from === '便签' ? 'notes' : 'input', title: from === '便签' ? '上下文换成便签' : `收到 · ${from}`, body: cut(text) }];
    }
    case 'assistant/message': {
      const out: TraceItem[] = [];
      for (const part of data?.message?.content ?? []) {
        if (part?.type === 'reasoning' && part.text) out.push({ seq, time, kind: 'thinking', title: '思考', body: cut(String(part.text)) });
        else if (part?.type === 'text' && part.text) out.push({ seq, time, kind: 'text', title: '回复（不朗读）', body: cut(String(part.text)) });
        else if (part?.type === 'tool-call') {
          names.set(String(part.id), String(part.name));
          out.push({ seq, time, kind: 'call', title: `调用 ${String(part.name)}`, body: cut(args(String(part.name), String(part.arguments ?? ''))) });
        }
      }
      const u = data?.usage;
      if (u) {
        const cached = Number(u.cacheReadTokens ?? 0);
        out.push({ seq, time, kind: 'usage', title: `用量：输入 ${Number(u.inputTokens ?? 0) + cached}（缓存命中 ${cached}）· 输出 ${Number(u.outputTokens ?? 0)}` });
      }
      return out;
    }
    case 'tool/result': {
      const name = names.get(String(data?.message?.source?.callId ?? '')) ?? '';
      return [{ seq, time, kind: 'result', title: `结果${name ? ` · ${name}` : ''}`, body: cut(texts(data?.message?.content)) }];
    }
    case 'turn/start':
      return [{ seq, time, kind: 'turn', title: `第 ${data?.turn ?? '?'} 轮开始` }];
    case 'turn/end': {
      const reason = data?.reason?.kind ?? data?.outcome ?? '';
      return [{ seq, time, kind: 'turn', title: `第 ${data?.turn ?? '?'} 轮结束${reason ? `（${reason}）` : ''}` }];
    }
    default:
      return [];
  }
}
