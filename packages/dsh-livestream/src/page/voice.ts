/**
 * 舞台页出声：字幕换成带 audio 的新 id 就播，字幕没了或换了 id 立刻停。
 * 用 AnalyserNode 算音量，每帧写嘴型；停了归 0。
 * 只在舞台页挂。调试台不挂，所以不出声。
 * 浏览器拦自动播放时，点一下页面就能恢复（OBS 的浏览器源不受这个限制）。
 */

import { useEffect, useState } from 'react';
import type { StageState } from '../stage/protocol';
import { setMouth, setPlaying } from './mouth';

let shared: AudioContext | undefined;

/** 浏览器拦着不让出声（没点过页面）：页面上挂个提示 */
let blocked = false;
const watchers = new Set<(b: boolean) => void>();
function setBlocked(value: boolean): void {
  if (blocked === value) return;
  blocked = value;
  for (const w of watchers) w(value);
}

/** 声音被浏览器拦住了没有（拦住时页面提示「点一下开声音」） */
export function useAudioBlocked(): boolean {
  const [value, set] = useState(blocked);
  useEffect(() => {
    watchers.add(set);
    return () => void watchers.delete(set);
  }, []);
  return value;
}

export function audioContext(): AudioContext {
  if (!shared || shared.state === 'closed') shared = new AudioContext();
  return shared;
}

/** 时间域均方根，放大到 0–1，安静时闭嘴 */
function levelOf(samples: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = ((samples[i] ?? 128) - 128) / 128;
    sum += v * v;
  }
  return Math.max(0, Math.min(1, Math.sqrt(sum / samples.length) * 5));
}

export function playable(url: string): string {
  const q = location.search;
  if (!q) return url;
  return url.includes('?') ? `${url}&${q.slice(1)}` : `${url}${q}`;
}

export function useVoice(state: StageState | null): void {
  const id = state?.subtitle?.id ?? '';
  const src = state?.subtitle?.audio ?? '';
  const rate = state?.subtitle?.rate ?? 1;

  useEffect(() => {
    if (!id || !src.startsWith('/voice/') || src.includes('..')) {
      setMouth(0);
      return;
    }
    const ctx = audioContext();
    const player = new Audio(playable(src));
    // 语速：倍速放，音高不变（时长和字幕时刻服务端已经按这个倍速算好了）
    player.preservesPitch = true;
    player.playbackRate = rate;
    // 声音真的开始放了，字幕才按它的进度点亮（媒体时间按语速换算成字幕时间）
    player.addEventListener('playing', () => setPlaying({ id, ms: () => (player.currentTime * 1000) / rate }));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    const node = ctx.createMediaElementSource(player);
    node.connect(analyser);
    analyser.connect(ctx.destination);
    const samples = new Uint8Array(analyser.fftSize);
    let raf = 0;
    let alive = true;

    const tick = () => {
      if (!alive) return;
      if (!player.paused && !player.ended) {
        analyser.getByteTimeDomainData(samples);
        setMouth(levelOf(samples));
      } else {
        setMouth(0);
      }
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (!alive) return;
      void ctx.resume();
      // 浏览器拦了自动出声：记下来，页面上提示点一下（点了就放）
      void player.play().then(() => { setBlocked(false); if (!alive) player.pause(); }).catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'NotAllowedError') setBlocked(true);
      });
    };
    const onGesture = () => start();
    window.addEventListener('pointerdown', onGesture);
    start();
    raf = requestAnimationFrame(tick);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('pointerdown', onGesture);
      setPlaying(undefined);
      player.onended = null;
      player.pause();
      player.removeAttribute('src');
      player.load();
      node.disconnect();
      analyser.disconnect();
      setMouth(0);
    };
  }, [id, src, rate]);
}
