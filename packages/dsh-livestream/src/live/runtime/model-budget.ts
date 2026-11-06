import { LlmError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';

export interface ModelLimits {
  requests: number;
  inputBytes: number;
  requestBytes: number;
  outputTokens: number;
  durationMs: number;
}
const defaults: ModelLimits = { requests: 300, inputBytes: 10_000_000, requestBytes: 300_000, outputTokens: 150_000, durationMs: 3_600_000 };
export function modelLimits(env: NodeJS.ProcessEnv): ModelLimits {
  const limits = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof ModelLimits)[]) {
    const name = 'AIVTB_MODEL_' + key.replace(/[A-Z]/g, x => '_' + x).toUpperCase();
    if (env[name] === undefined) continue;
    const value = Number(env[name]);
    if (!Number.isSafeInteger(value) || value <= 0) throw Error('Invalid model limit: ' + name);
    limits[key] = value;
  }
  return limits;
}

/** Process-lifetime admission budget shared by every role, quick reply and retry. */
export class ModelBudget {
  private requests = 0;
  private inputBytes = 0;
  private outputTokens = 0;
  private reservedOutputTokens = 0;
  private unknownOutputTokens = 0;
  private reason?: string;
  private readonly startedAt = Date.now();
  constructor(readonly limits: ModelLimits, private readonly onExhausted: (reason: string) => void) {}
  exhaust(reason: string) {
    if (!this.reason) { this.reason = reason; this.onExhausted(reason); }
  }
  snapshot() {
    return { limits: this.limits, requests: this.requests, inputBytes: this.inputBytes, outputTokens: this.outputTokens,
      reservedOutputTokens: this.reservedOutputTokens, unknownOutputTokens: this.unknownOutputTokens,
      startedAt: this.startedAt, blocked: !!this.reason, reason: this.reason };
  }
  async *stream(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const bytes = Buffer.byteLength(JSON.stringify({ system: options.system, messages: options.messages, tools: options.tools, toolHistory: options.toolHistory }));
    const cap = options.maxTokens;
    let problem = this.reason;
    if (!problem && Date.now() - this.startedAt >= this.limits.durationMs) problem = 'duration';
    if (!problem && this.requests >= this.limits.requests) problem = 'requests';
    if (!problem && (bytes > this.limits.requestBytes || this.inputBytes + bytes > this.limits.inputBytes)) problem = 'input-bytes';
    if (!problem && (!Number.isSafeInteger(cap) || cap! <= 0)) problem = 'missing-output-cap';
    if (!problem && this.outputTokens + this.reservedOutputTokens + this.unknownOutputTokens + cap! > this.limits.outputTokens) problem = 'output-tokens';
    if (problem) { this.exhaust(problem); throw new LlmError('Live model budget exhausted: ' + problem, 'QUOTA'); }
    this.requests++; this.inputBytes += bytes; this.reservedOutputTokens += cap!;
    let usage: number | undefined, completed = false;
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage' && Number.isSafeInteger(chunk.usage.outputTokens) && chunk.usage.outputTokens >= 0)
          usage = chunk.usage.outputTokens;
        if (chunk.type === 'finish') completed = ['stop', 'tool-calls', 'max-tokens'].includes(chunk.reason.kind);
        yield chunk;
      }
    } finally {
      this.reservedOutputTokens -= cap!;
      // Failed, cancelled, truncated or unmetered responses may still be billed.
      if (completed && usage !== undefined) this.outputTokens += usage;
      else this.unknownOutputTokens += cap!;
    }
  }
}
