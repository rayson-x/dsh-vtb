/**
 * 语音合成：ElevenLabs with-timestamps → mp3 落到 .cache/voice/，返回可播地址和真实时长。
 * 同文本同音色同模型复用文件；目录里 mp3 太多就删最旧的。
 * 密钥只从调用方给的读取函数拿，不进日志、不进文件名、不进抛出的错误。
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const API_KEY = 'ELEVENLABS_API_KEY';
const VOICE_ID = 'ELEVENLABS_VOICE_ID';
const MODEL_ID = 'ELEVENLABS_MODEL_ID';
const DEFAULT_MODEL = 'eleven_multilingual_v2';
/** 缓存里最多留这么多个 mp3，多了删最旧的 */
const MAX_CACHED = 80;
const REQUEST_MS = 15_000;

export interface SpeechClip {
  /** 缓存文件名 */
  file: string;
  /** 舞台页可播的地址 */
  url: string;
  /** 音频时长（毫秒） */
  ms: number;
  /** 每个字（按请求文本的字）开始念的时刻（毫秒）；拿不到就没有，调用方按字数平摊 */
  starts?: number[];
}

/** 一段话被拆开合成时，前后文给合成器参考，拼起来语气连贯 */
export interface SpeechContext { before?: string; after?: string }

export interface Voice {
  synthesize(text: string, signal: AbortSignal, context?: SpeechContext): Promise<SpeechClip>;
}

export type SecretReader = (name: string) => Promise<string | undefined> | string | undefined;

export interface ElevenLabsVoiceOptions {
  /** .cache/voice 目录，舞台服务器把它挂在 /voice/ */
  dir: string;
  secret: SecretReader;
  fetch?: typeof fetch;
  maxFiles?: number;
}

export class ElevenLabsVoice implements Voice {
  private readonly dir: string;
  private readonly secret: SecretReader;
  private readonly fetchImpl: typeof fetch;
  private readonly maxFiles: number;

  constructor(options: ElevenLabsVoiceOptions) {
    this.dir = options.dir;
    this.secret = options.secret;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxFiles = options.maxFiles ?? MAX_CACHED;
  }

  async synthesize(text: string, signal: AbortSignal, context: SpeechContext = {}): Promise<SpeechClip> {
    if (signal.aborted) throw abortError();
    const apiKey = await this.read(API_KEY);
    const voiceId = await this.read(VOICE_ID);
    const model = (await this.read(MODEL_ID)) || DEFAULT_MODEL;
    if (!apiKey || !voiceId) throw new Error('没配 ElevenLabs 密钥或音色');
    if (signal.aborted) throw abortError();

    const file = cacheName(voiceId, model, text);
    const cached = await this.readCache(file);
    if (cached) return cached;
    if (signal.aborted) throw abortError();

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), REQUEST_MS);
    timer.unref?.();
    try {
      return await this.request(text, voiceId, model, apiKey, file, signal, timeout.signal, context);
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(text: string, voiceId: string, model: string, apiKey: string, file: string, signal: AbortSignal, timeout: AbortSignal, context: SpeechContext): Promise<SpeechClip> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`,
        {
          method: 'POST',
          signal: AbortSignal.any([signal, timeout]),
          headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ text, model_id: model, ...(context.before ? { previous_text: context.before } : {}), ...(context.after ? { next_text: context.after } : {}) }),
        },
      );
    } catch {
      if (signal.aborted) throw abortError();
      if (timeout.aborted) throw new Error('ElevenLabs 超时');
      throw new Error('ElevenLabs 请求失败');
    }
    if (signal.aborted) throw abortError();
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`ElevenLabs HTTP ${response.status}`);
    }

    const raw = await response.text();
    let data: { audio_base64?: unknown; alignment?: unknown };
    try {
      data = JSON.parse(raw) as { audio_base64?: unknown; alignment?: unknown };
    } catch {
      throw new Error('ElevenLabs 返回无效响应');
    }
    if (typeof data.audio_base64 !== 'string' || !data.audio_base64) throw new Error('ElevenLabs 返回空音频');
    const audio = Buffer.from(data.audio_base64, 'base64');
    if (!audio.length) throw new Error('ElevenLabs 返回空音频');
    const ms = alignmentMs(data.alignment) || mp3DurationMs(audio);
    if (!ms) throw new Error('算不出音频时长');
    const starts = alignmentStarts(data.alignment, text);

    await this.writeCache(file, audio, ms, starts);
    if (signal.aborted) throw abortError();
    return clip(file, ms, starts);
  }

  private async read(name: string): Promise<string | undefined> {
    const value = await this.secret(name);
    const text = typeof value === 'string' ? value.trim() : '';
    return text || undefined;
  }

  private async readCache(file: string): Promise<SpeechClip | undefined> {
    const path = join(this.dir, file);
    const audio = await readFile(path).catch(() => undefined);
    if (!audio?.length) return;
    const meta = await readFile(metaPath(path), 'utf8').then((t) => JSON.parse(t) as { ms?: unknown; starts?: unknown }).catch(() => undefined);
    const saved = typeof meta?.ms === 'number' ? meta.ms : Number(await readFile(msPath(path), 'utf8').catch(() => ''));
    const ms = Number.isFinite(saved) && saved > 0 ? Math.round(saved) : mp3DurationMs(audio);
    if (!ms) return;
    const starts = Array.isArray(meta?.starts) && meta.starts.every((x) => typeof x === 'number') ? meta.starts as number[] : undefined;
    const now = new Date();
    await utimes(path, now, now).catch(() => {});
    return clip(file, ms, starts);
  }

  private async writeCache(file: string, audio: Buffer, ms: number, starts?: number[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, file);
    const partial = `${path}.partial`;
    await writeFile(partial, audio);
    await rename(partial, path);
    await writeFile(metaPath(path), JSON.stringify({ ms, ...(starts ? { starts } : {}) }));
    await this.evict(file);
  }

  /** 超过上限时删最旧的 mp3（刚写的这个留下） */
  private async evict(keep: string): Promise<void> {
    const names = await readdir(this.dir).catch(() => [] as string[]);
    const mp3s = names.filter((name) => name.endsWith('.mp3'));
    if (mp3s.length <= this.maxFiles) return;
    const ranked = await Promise.all(mp3s.map(async (name) => ({
      name,
      mtime: await stat(join(this.dir, name)).then((s) => s.mtimeMs).catch(() => 0),
    })));
    ranked.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
    let overflow = ranked.length - this.maxFiles;
    for (const entry of ranked) {
      if (overflow <= 0) break;
      if (entry.name === keep) continue;
      await unlink(join(this.dir, entry.name)).catch(() => {});
      await unlink(join(this.dir, entry.name.replace(/\.mp3$/, '.ms'))).catch(() => {});
      await unlink(join(this.dir, entry.name.replace(/\.mp3$/, '.json'))).catch(() => {});
      overflow--;
    }
  }
}

function clip(file: string, ms: number, starts?: number[]): SpeechClip {
  return { file, url: `/voice/${file}`, ms, ...(starts ? { starts } : {}) };
}

/** 旧缓存只记了时长 */
function msPath(mp3: string): string {
  return mp3.replace(/\.mp3$/, '.ms');
}

function metaPath(mp3: string): string {
  return mp3.replace(/\.mp3$/, '.json');
}

/** 对齐信息里每个字的开始时刻；字数对不上请求文本就不用 */
function alignmentStarts(alignment: unknown, text: string): number[] | undefined {
  if (!alignment || typeof alignment !== 'object') return undefined;
  const starts = (alignment as { character_start_times_seconds?: unknown }).character_start_times_seconds;
  if (!Array.isArray(starts) || starts.length !== [...text].length) return undefined;
  if (!starts.every((x) => typeof x === 'number' && Number.isFinite(x))) return undefined;
  return starts.map((x: number) => Math.round(x * 1000));
}

function cacheName(voiceId: string, model: string, text: string): string {
  const hash = createHash('sha256').update(voiceId).update('\0').update(model).update('\0').update(text).digest('hex');
  return `${hash}.mp3`;
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

/** 对齐信息最后一个字的结束时间，就是这句的时长 */
function alignmentMs(alignment: unknown): number {
  if (!alignment || typeof alignment !== 'object') return 0;
  const ends = (alignment as { character_end_times_seconds?: unknown }).character_end_times_seconds;
  if (!Array.isArray(ends) || !ends.length) return 0;
  const last = ends[ends.length - 1];
  if (typeof last !== 'number' || !Number.isFinite(last) || last <= 0) return 0;
  return Math.round(last * 1000);
}

const MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/** 数 MPEG Layer III 帧，得到毫秒。算不出返回 0 */
export function mp3DurationMs(buf: Buffer): number {
  let offset = 0;
  if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
    offset = 10 + size + ((buf[5]! & 0x10) ? 10 : 0);
  }
  let frames = 0;
  let sampleRate = 0;
  let samplesPerFrame = 0;
  while (offset + 4 <= buf.length) {
    const frame = mpegFrame(buf, offset);
    if (!frame) {
      offset++;
      continue;
    }
    if (!sampleRate) {
      sampleRate = frame.sampleRate;
      samplesPerFrame = frame.samples;
    }
    frames++;
    offset += frame.length;
  }
  if (!frames || !sampleRate) return 0;
  return Math.round((frames * samplesPerFrame * 1000) / sampleRate);
}

function mpegFrame(buf: Buffer, offset: number): { length: number; sampleRate: number; samples: number } | undefined {
  if (buf[offset] !== 0xff || (buf[offset + 1]! & 0xe0) !== 0xe0) return;
  const header = buf.readUInt32BE(offset);
  const version = (header >> 19) & 3;
  const layer = (header >> 17) & 3;
  const bitrateIndex = (header >> 12) & 0xf;
  const sampleIndex = (header >> 10) & 3;
  const padding = (header >> 9) & 1;
  if (version === 1 || layer !== 1 || sampleIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) return;
  const bitrate = (version === 3 ? MPEG1_L3 : MPEG2_L3)[bitrateIndex]! * 1000;
  const sampleRate = SAMPLE_RATES[version]?.[sampleIndex];
  if (!bitrate || !sampleRate) return;
  const length = Math.floor(((version === 3 ? 144 : 72) * bitrate) / sampleRate) + padding;
  if (length < 4 || offset + length > buf.length) return;
  if (offset + length < buf.length && buf[offset + length] !== 0xff) return;
  return { length, sampleRate, samples: version === 3 ? 1152 : 576 };
}
