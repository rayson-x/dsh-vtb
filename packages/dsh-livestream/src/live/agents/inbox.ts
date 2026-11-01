/**
 * 内存收件箱。每个角色一份。
 * 没有 clear：取消生成时 keepInbox 是结构，不是事后补一个标志。
 */

import type { InboxEntry, RoleInboxPort } from './ports';

const PRIORITY_RANK = { urgent: 0, live: 1, background: 2 } as const;

export class MemoryInbox implements RoleInboxPort {
  private readonly entries: InboxEntry[] = [];

  push(entry: InboxEntry): void {
    if (this.entries.some((item) => item.id === entry.id)) {
      throw new Error(`收件箱已有 ${entry.id}`);
    }
    this.entries.push({ ...entry, eventIds: [...entry.eventIds], audienceIds: [...entry.audienceIds] });
  }

  update(id: string, patch: Pick<InboxEntry, 'summary' | 'eventIds' | 'audienceIds' | 'count'>): void {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) throw new Error(`收件箱没有 ${id}`);
    entry.summary = patch.summary;
    entry.eventIds = [...patch.eventIds];
    entry.audienceIds = [...patch.audienceIds];
    entry.count = patch.count;
  }

  pending(): readonly InboxEntry[] {
    return this.entries
      .map((entry) => ({ ...entry, eventIds: [...entry.eventIds], audienceIds: [...entry.audienceIds] }))
      .sort((left, right) => {
        const rank = PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority];
        if (rank !== 0) return rank;
        if (left.at !== right.at) return left.at - right.at;
        return left.id.localeCompare(right.id);
      });
  }
}
