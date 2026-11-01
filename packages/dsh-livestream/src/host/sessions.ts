/**
 * 场次：每次开播是一场。这一场的弹幕（右栏信息流）和观众簿跟着场次存在磁盘上，
 * 下次开播前主人可以选：接着某一场（数据恢复回来）、开新的一场（清空）、或者保持现在的不动。
 *
 * 一场一个文件 <dir>/<id>.json，开着的那场每隔一会儿存一次。
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Danmaku } from '../stage/protocol';
import type { AudienceSnapshot } from './input';

export interface SessionFile {
  id: string;
  /** 这一场的方向（节目名取第一句） */
  direction?: string;
  startedAt: number;
  savedAt: number;
  danmaku: Danmaku[];
  audience: AudienceSnapshot;
}

/** 给控制台列表看的一行 */
export interface SessionSummary {
  id: string;
  title: string;
  startedAt: number;
  savedAt: number;
  danmaku: number;
  people: number;
}

/** 场次编号：开播的时刻，本地时间（2026-10-31-0152） */
export function sessionId(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
}

export const sessionTitle = (direction?: string) => direction?.split(/[：:。\n]/)[0]?.trim() || '没定方向';

export class Sessions {
  constructor(private readonly dir: string) {}

  save(file: SessionFile): void {
    mkdirSync(this.dir, { recursive: true });
    // 先写临时文件再改名：存到一半崩了也不会留下半个文件
    const path = join(this.dir, `${file.id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(file));
    renameSync(`${path}.tmp`, path);
  }

  load(id: string): SessionFile | undefined {
    if (!/^[\w-]+$/.test(id)) return undefined;
    try {
      return JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf8')) as SessionFile;
    } catch {
      return undefined;
    }
  }

  /** 最近的几场，新的在前；空场（没弹幕也没观众）不列 */
  list(limit = 8): SessionSummary[] {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    return names.sort().reverse().map((n) => this.load(n.slice(0, -5))).filter((f): f is SessionFile => !!f)
      .filter((f) => f.danmaku.length || f.audience.people.length)
      .slice(0, limit)
      .map((f) => ({ id: f.id, title: sessionTitle(f.direction), startedAt: f.startedAt, savedAt: f.savedAt, danmaku: f.danmaku.length, people: f.audience.people.length }));
  }
}
