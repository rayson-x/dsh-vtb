import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { speechMs, StageController, type SpeakResult } from '../src/host/controller';
import { ElevenLabsVoice, mp3DurationMs, type SpeechClip, type Voice } from '../src/host/voice';
import { initialState } from '../src/stage/protocol';
import { reduce } from '../src/stage/reducer';

const KEY = 'unit-test-key';
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 两帧 MPEG1 Layer III 128kbps 44.1kHz，时长 52ms */
function tinyMp3(): Buffer {
  const frame = Buffer.alloc(417);
  frame[0] = 0xff;
  frame[1] = 0xfb;
  frame[2] = 0x90;
  return Buffer.concat([frame, Buffer.from(frame)]);
}

function jsonResponse(audio: Buffer, alignment?: { character_end_times_seconds: number[] }, status = 200): Response {
  return new Response(JSON.stringify({
    audio_base64: audio.toString('base64'),
    ...(alignment ? { alignment: { characters: ['啊'], character_start_times_seconds: [0], character_end_times_seconds: alignment.character_end_times_seconds } } : {}),
  }), { status, headers: { 'content-type': 'application/json' } });
}

async function tempVoice(fetchImpl: typeof fetch, maxFiles?: number): Promise<ElevenLabsVoice> {
  const dir = await mkdtemp(join(tmpdir(), 'aivtb-voice-'));
  dirs.push(dir);
  return new ElevenLabsVoice({
    dir,
    maxFiles,
    fetch: fetchImpl,
    secret: async (name) => {
      if (name === 'ELEVENLABS_API_KEY') return KEY;
      if (name === 'ELEVENLABS_VOICE_ID') return 'voice-test';
      return undefined;
    },
  });
}

describe('字幕带上音频', () => {
  it('有音频时 say 带 audio，时长用真实时长', async () => {
    let release!: (clip: SpeechClip) => void;
    const gate = new Promise<SpeechClip>((resolve) => { release = resolve; });
    const voice: Voice = { synthesize: () => gate };
    const stage = new StageController({ tickHz: 0, voice });
    const said = stage.speak('测试一下声音');
    expect(stage.state.subtitle).toBeNull();
    release({ file: 'a.mp3', url: '/voice/a.mp3', ms: 4321 });
    await delay(0);
    expect(stage.state.subtitle).toEqual({
      id: stage.state.subtitle?.id,
      text: '测试一下声音',
      startedAt: stage.state.subtitle?.startedAt,
      ms: 4321,
      audio: '/voice/a.mp3',
    });
    expect(stage.state.subtitle?.ms).not.toBe(speechMs('测试一下声音'));
    expect(stage.state.avatar.speaking).toBe(true);
    stage.apply({ type: 'interrupt' });
    await expect(said).resolves.toBe('interrupted');
  });

  it('合成失败退回按字数估时，不上音频', async () => {
    const logs: string[] = [];
    const stage = new StageController({
      tickHz: 0,
      log: (message) => logs.push(message),
      voice: { synthesize: async () => { throw new Error('没配 ElevenLabs 密钥或音色'); } },
    });
    const said = stage.speak('你好');
    await delay(0);
    expect(stage.state.subtitle?.text).toBe('你好');
    expect(stage.state.subtitle?.ms).toBe(speechMs('你好'));
    expect(stage.state.subtitle?.audio).toBeUndefined();
    expect(logs.join('\n')).toMatch(/估时/);
    expect(logs.join('\n')).not.toContain(KEY);
    stage.apply({ type: 'interrupt' });
    await expect(said).resolves.toBe('interrupted');
  });

  it('合成途中打断返回 interrupted，不上字幕', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const logs: string[] = [];
    let calls = 0;
    const stage = new StageController({
      tickHz: 0,
      log: (message) => logs.push(message),
      voice: {
        async synthesize(_text, signal) {
          calls++;
          await gate;
          if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          return { file: 'a.mp3', url: '/voice/a.mp3', ms: 5000 };
        },
      },
    });
    const said = stage.speak('别出声', { mood: 'happy' });
    expect(stage.state.subtitle).toBeNull();
    expect(stage.apply({ type: 'interrupt' })).toEqual({ ok: true });
    release();
    await delay(20);
    await expect(said).resolves.toBe('interrupted');
    expect(stage.state.subtitle).toBeNull();
    expect(stage.state.avatar).toMatchObject({ speaking: false, mood: 'neutral' });
    expect(logs).toEqual([]);
    expect(calls).toBe(1);
  });

  it('合成途中 signal 取消同样不上字幕；一开始就取消的不合成', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const voice: Voice = {
      async synthesize(_text, signal) {
        calls++;
        await gate;
        if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        return { file: 'a.mp3', url: '/voice/a.mp3', ms: 5000 };
      },
    };
    const stage = new StageController({ tickHz: 0, voice });
    const ac = new AbortController();
    const said = stage.speak('等等', { signal: ac.signal });
    ac.abort();
    release();
    await delay(20);
    await expect(said).resolves.toBe('interrupted');
    expect(stage.state.subtitle).toBeNull();

    const stopped = new AbortController();
    stopped.abort();
    await expect(stage.speak('不再说', { signal: stopped.signal })).resolves.toBe('interrupted');
    expect(calls).toBe(1);
    expect(stage.state.subtitle).toBeNull();
  });

  it('reducer 只透传 audio，正文照旧脱敏', () => {
    const withAudio = reduce(initialState(), { type: 'say', id: 's', text: '看 /tmp/a.mp4', ms: 1000, audio: '/voice/abc.mp3' }, 5);
    expect(withAudio.state.subtitle).toEqual({ id: 's', text: '看 …', startedAt: 5, ms: 1000, audio: '/voice/abc.mp3' });
    const plain = reduce(initialState(), { type: 'say', id: 's', text: '嗨', ms: 1000 }, 5);
    expect(plain.state.subtitle).toEqual({ id: 's', text: '嗨', startedAt: 5, ms: 1000 });
    expect(plain.state.subtitle).not.toHaveProperty('audio');
  });
});

describe('ElevenLabs 合成（不打网络）', () => {
  it('用对齐信息的时长，同一句再合成不重复请求', async () => {
    const audio = tinyMp3();
    let calls = 0;
    const voice = await tempVoice(async (input, init) => {
      calls++;
      expect(String(input)).toContain('/with-timestamps');
      expect(new Headers(init?.headers).get('xi-api-key')).toBe(KEY);
      return jsonResponse(audio, { character_end_times_seconds: [1.25] });
    });
    const signal = new AbortController().signal;
    const first = await voice.synthesize('同一句', signal);
    const second = await voice.synthesize('同一句', signal);
    expect(first).toEqual({ file: first.file, url: `/voice/${first.file}`, ms: 1250 });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
    expect(mp3DurationMs(audio)).toBe(52);
  });

  it('没有对齐信息时用 mp3 帧数算时长', async () => {
    const audio = tinyMp3();
    const voice = await tempVoice(async () => jsonResponse(audio));
    const clip = await voice.synthesize('没有对齐', new AbortController().signal);
    expect(clip.ms).toBe(52);
    expect(clip.url).toBe(`/voice/${clip.file}`);
  });

  it('没配密钥不发请求；错误响应不把正文带出来', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'aivtb-voice-'));
    dirs.push(dir);
    let calls = 0;
    const missing = new ElevenLabsVoice({
      dir,
      fetch: async () => { calls++; return new Response('nope'); },
      secret: async () => undefined,
    });
    await expect(missing.synthesize('嗨', new AbortController().signal)).rejects.toThrow('没配 ElevenLabs 密钥或音色');
    expect(calls).toBe(0);

    const leaked = 'unit-test-key-in-body';
    const failing = await tempVoice(async () => new Response(leaked, { status: 401 }));
    await expect(failing.synthesize('嗨', new AbortController().signal)).rejects.toThrow(/^ElevenLabs HTTP 401$/);
    const invalid = await tempVoice(async () => new Response(`not-json ${leaked}`, { status: 200 }));
    await expect(invalid.synthesize('嗨', new AbortController().signal)).rejects.toThrow(/^ElevenLabs 返回无效响应$/);
  });

  it('缓存超过上限删最旧的，密钥不落盘', async () => {
    const audio = tinyMp3();
    const voice = await tempVoice(async () => jsonResponse(audio, { character_end_times_seconds: [0.4] }), 2);
    const clips: SpeechClip[] = [];
    for (const text of ['一', '二', '三']) clips.push(await voice.synthesize(text, new AbortController().signal));
    const dir = dirs[dirs.length - 1]!;
    const mp3s = (await readdir(dir)).filter((name) => name.endsWith('.mp3'));
    expect(mp3s).toHaveLength(2);
    expect(mp3s).toContain(clips[2]!.file);
    for (const name of await readdir(dir)) {
      const body = await readFile(join(dir, name));
      expect(body.includes(KEY)).toBe(false);
    }
  });

  it('取消进行中的请求', async () => {
    const voice = await tempVoice((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const ac = new AbortController();
    const pending = voice.synthesize('停', ac.signal);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('念完仍返回 done', () => {
  it('短音频放完返回 done', async () => {
    const stage = new StageController({
      tickHz: 0,
      voice: { async synthesize() { return { file: 'a.mp3', url: '/voice/a.mp3', ms: 30 }; } },
    });
    const result: SpeakResult = await stage.speak('短');
    expect(result).toBe('done');
    expect(stage.state.subtitle).toBeNull();
    expect(stage.state.avatar.speaking).toBe(false);
  });
});
