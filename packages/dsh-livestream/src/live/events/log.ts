/**
 * 工程事件库。计划 §3.3、§8.3。
 * 端口可替换；MemoryEventLog 只是进程内实现，不是播放器，也不是全场快照。
 * 活动事件和已归档事件分开。tick 不应来读历史页。
 */

import type { EventKind } from '../domain/codes';
import type { DomainEvent, ShowTimeMs } from '../domain/entities';

export interface EventDraft {
  eventId: string;
  type: EventKind;
  source: string;
  receivedAt: number;
  showTime: ShowTimeMs;
  directionEpoch: number;
  correlationId?: string;
  causationId?: string;
  payload: unknown;
}

/** 已提交执行。恢复时只靠这份索引抑制重放，不把命令再跑一遍。 */
export interface CommittedExecution {
  kind: 'cue' | 'speech' | 'take';
  id: string;
  sequence: number;
  directionEpoch: number;
}

export interface EventLogSnapshot {
  events: DomainEvent[];
  archivedSequences: number[];
  committed: CommittedExecution[];
  nextSequence: number;
}

export interface EventLogPort {
  peekNext(): number;
  has(eventId: string): boolean;
  get(eventId: string): DomainEvent | undefined;
  /** 相同 eventId 返回原事件，不另起序号。 */
  append(draft: EventDraft): DomainEvent;
  active(): DomainEvent[];
  historyPage(afterSequence: number, limit: number): DomainEvent[];
  /** 把序号不大于给定值的事件移出活动集。返回新归档条数。 */
  archiveThrough(sequence: number): number;
  markCommitted(record: CommittedExecution): void;
  committed(): readonly CommittedExecution[];
  snapshot(): EventLogSnapshot;
}

export class MemoryEventLog implements EventLogPort {
  private events: DomainEvent[] = [];
  private archived = new Set<number>();
  private byId = new Map<string, DomainEvent>();
  private commits: CommittedExecution[] = [];
  private nextSequence = 0;

  static fromSnapshot(snapshot: EventLogSnapshot): MemoryEventLog {
    const log = new MemoryEventLog();
    log.nextSequence = snapshot.nextSequence;
    log.archived = new Set(snapshot.archivedSequences);
    log.commits = snapshot.committed.map((item) => ({ ...item }));
    for (const event of snapshot.events) {
      const copy = structuredClone(event);
      log.events.push(copy);
      log.byId.set(copy.eventId, copy);
      if (copy.sequence > log.nextSequence) log.nextSequence = copy.sequence;
    }
    return log;
  }

  peekNext(): number {
    return this.nextSequence + 1;
  }

  has(eventId: string): boolean {
    return this.byId.has(eventId);
  }

  get(eventId: string): DomainEvent | undefined {
    const found = this.byId.get(eventId);
    return found ? structuredClone(found) : undefined;
  }

  append(draft: EventDraft): DomainEvent {
    const existing = this.byId.get(draft.eventId);
    if (existing) return structuredClone(existing);
    this.nextSequence += 1;
    const event: DomainEvent = {
      eventId: draft.eventId,
      type: draft.type,
      sequence: this.nextSequence,
      source: draft.source,
      receivedAt: draft.receivedAt,
      showTime: draft.showTime,
      directionEpoch: draft.directionEpoch,
      ...(draft.correlationId !== undefined ? { correlationId: draft.correlationId } : {}),
      ...(draft.causationId !== undefined ? { causationId: draft.causationId } : {}),
      payload: structuredClone(draft.payload),
    };
    this.events.push(event);
    this.byId.set(event.eventId, event);
    return structuredClone(event);
  }

  active(): DomainEvent[] {
    return this.events.filter((event) => !this.archived.has(event.sequence)).map((event) => structuredClone(event));
  }

  historyPage(afterSequence: number, limit: number): DomainEvent[] {
    return this.events
      .filter((event) => this.archived.has(event.sequence) && event.sequence > afterSequence)
      .slice(0, limit)
      .map((event) => structuredClone(event));
  }

  archiveThrough(sequence: number): number {
    let added = 0;
    for (const event of this.events) {
      if (event.sequence <= sequence && !this.archived.has(event.sequence)) {
        this.archived.add(event.sequence);
        added += 1;
      }
    }
    return added;
  }

  markCommitted(record: CommittedExecution): void {
    if (this.commits.some((item) => item.kind === record.kind && item.id === record.id)) return;
    this.commits.push({ ...record });
  }

  committed(): readonly CommittedExecution[] {
    return this.commits.map((item) => ({ ...item }));
  }

  snapshot(): EventLogSnapshot {
    return {
      events: this.events.map((event) => structuredClone(event)),
      archivedSequences: [...this.archived].sort((a, b) => a - b),
      committed: this.commits.map((item) => ({ ...item })),
      nextSequence: this.nextSequence,
    };
  }
}
