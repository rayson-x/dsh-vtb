/**
 * 舞台页拿状态：SSE 收宿主的每一版状态，按服务器时间对表；再给一个逐帧走的「现在」。
 */

import { useEffect, useRef, useState } from 'react';
import type { StageState } from '../stage/protocol';

export interface Live {
  state: StageState | null;
  /** 服务器时间 - 本机时间 */
  offset: number;
  connected: boolean;
}

/** 这个页面加载时服务端的页面脚本版本 */
let loadedBuild: string | undefined;

export function useStage(): Live {
  const [live, setLive] = useState<Live>({ state: null, offset: 0, connected: false });
  useEffect(() => stream(`/events${location.search}`, (data: { now: number; state: StageState; build?: string }) => {
    // 服务端换了新版页面脚本（重新构建过）：刷新一下，旧页面配新服务端会对不上
    if (data.build) {
      if (loadedBuild === undefined) loadedBuild = data.build;
      else if (loadedBuild !== data.build) return location.reload();
    }
    setLive({ state: data.state, offset: data.now - Date.now(), connected: true });
  }, () => setLive((prev) => ({ ...prev, connected: false }))), []);
  return live;
}

/**
 * 订阅一条 SSE，断了就自己重连。
 * 浏览器的 EventSource 碰到非 SSE 的回复（比如大脑没开时控制台回的 502）会永久放弃，所以不能靠它自带的重连。
 */
export function stream<T>(url: string, onData: (data: T) => void, onDown?: () => void): () => void {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const open = () => {
    source = new EventSource(url);
    source.onmessage = (event) => onData(JSON.parse(event.data) as T);
    source.onerror = () => {
      onDown?.();
      source?.close();
      if (!stopped) timer = setTimeout(open, 1_500);
    };
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    source?.close();
  };
}

/** 按服务器时间逐帧走的现在（最多每秒 fps 次） */
export function useNow(offset: number, fps = 30): number {
  const [now, setNow] = useState(() => Date.now() + offset);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  useEffect(() => {
    let frame = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last >= 1000 / fps) {
        last = t;
        setNow(Date.now() + offsetRef.current);
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [fps]);
  return now;
}

/** 下指令（调试台用） */
export async function send(cmd: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/command${location.search}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  const body = (await res.json()) as { results: { ok: boolean; error?: string }[] };
  return body.results[0] ?? { ok: false, error: '没有结果' };
}

export async function post(path: string, body: unknown = {}): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${path}${location.search}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json()) as { ok: boolean; error?: string };
}
