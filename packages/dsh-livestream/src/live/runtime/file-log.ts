/** Append-only local WAL. Facts are fsynced before an execution may leave this process. */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { MemoryEventLog, type EventDraft, type EventLogPort, type CommittedExecution } from '../events/log';
import type { DomainEvent } from '../domain/entities';

type Row =
  | { kind: 'event'; event: DomainEvent }
  | { kind: 'commit'; record: CommittedExecution }
  | { kind: 'archive'; through: number };
export class FileEventLog implements EventLogPort {
  private readonly memory = new MemoryEventLog();
  private readonly fd: number;
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const bytes = readFileSync(path);
      const lastNewline = bytes.lastIndexOf(10);
      // A process crash can leave an incomplete final record. Never append after that fragment.
      if (lastNewline + 1 < bytes.length) truncateSync(path, lastNewline + 1);
      for (const line of bytes
        .subarray(0, lastNewline + 1)
        .toString('utf8')
        .split('\n')
        .filter(Boolean)) {
        const row = JSON.parse(line) as Row;
        if (row.kind === 'event') {
          if (row.event.sequence !== this.memory.peekNext()) throw new Error('WAL sequence gap');
          this.memory.append(row.event);
        } else if (row.kind === 'commit') this.memory.markCommitted(row.record);
        else if (row.kind === 'archive') this.memory.archiveThrough(row.through);
        else throw new Error('Unknown WAL record');
      }
    }
    this.fd = openSync(path, 'a', 0o600);
  }
  private persist(row: Row) {
    const bytes = Buffer.from(JSON.stringify(row) + '\n');
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset);
    fsyncSync(this.fd);
  }
  append(draft: EventDraft): DomainEvent {
    const previous = this.memory.get(draft.eventId);
    if (previous) return previous;
    const event = { ...structuredClone(draft), sequence: this.memory.peekNext() };
    this.persist({ kind: 'event', event });
    return this.memory.append(draft);
  }
  markCommitted(record: CommittedExecution) {
    if (this.memory.committed().some((r) => r.kind === record.kind && r.id === record.id)) return;
    this.persist({ kind: 'commit', record });
    this.memory.markCommitted(record);
  }
  archiveThrough(through: number) {
    this.persist({ kind: 'archive', through });
    return this.memory.archiveThrough(through);
  }
  peekNext() {
    return this.memory.peekNext();
  }
  has(id: string) {
    return this.memory.has(id);
  }
  get(id: string) {
    return this.memory.get(id);
  }
  active() {
    return this.memory.active();
  }
  historyPage(after: number, limit: number) {
    return this.memory.historyPage(after, limit);
  }
  committed() {
    return this.memory.committed();
  }
  snapshot() {
    return this.memory.snapshot();
  }
  close() {
    closeSync(this.fd);
  }
}
