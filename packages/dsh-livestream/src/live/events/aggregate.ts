/**
 * 输入聚合。计划 §2.2、§8.1、§8.3。
 * 窗内重复合并成一条，不按弹幕条数唤醒。
 * 沉默、争论、自称 master 只进编导兴趣，不叫醒主播和导播。
 */

import type { AudienceInputRecord } from '../domain/entities';
import type { NormalizedInput } from './normalize';

export type RoutePriority = 'urgent' | 'live' | 'background';

export interface AggregatedInput {
  bucketId: string;
  eventIds: string[];
  audienceIds: string[];
  text: string;
  kind: AudienceInputRecord['kind'];
  priority: RoutePriority;
  wakeLive: boolean;
  wakeEditorial: boolean;
  firstReceivedAt: number;
  lastReceivedAt: number;
  directionEpoch: number;
  count: number;
}

export interface AggregateDecision {
  item: AggregatedInput;
  /** 新桶才投递。窗内重复只更新已有收件箱条目。 */
  deliver: boolean;
  merged: boolean;
  duplicateEvent: boolean;
}

interface Bucket {
  key: string;
  item: AggregatedInput;
}

export function aggregateSummary(item: Pick<AggregatedInput, 'kind' | 'text' | 'count'>): string {
  if (item.kind === 'silence') return `沉默 ×${item.count}`;
  if (item.kind === 'master-claim') return `自称 master ×${item.count}`;
  if (item.count === 1) return item.text.slice(0, 80);
  return `${item.text.slice(0, 60)} ×${item.count}`;
}

export function classifyInput(kind: AudienceInputRecord['kind'], urgent: boolean): {
  priority: RoutePriority;
  wakeLive: boolean;
  wakeEditorial: boolean;
} {
  if (kind === 'silence' || kind === 'debate' || kind === 'master-claim') {
    return { priority: 'background', wakeLive: false, wakeEditorial: true };
  }
  if (kind === 'opposition' || urgent) {
    return { priority: 'urgent', wakeLive: true, wakeEditorial: true };
  }
  return { priority: 'live', wakeLive: true, wakeEditorial: true };
}

function bucketKey(input: NormalizedInput): string {
  if (input.kind === 'silence' || input.kind === 'debate') return `${input.directionEpoch}:bg:${input.kind}`;
  return `${input.directionEpoch}:${input.urgent ? 'urgent' : 'normal'}:${input.kind}:${input.text.toLowerCase()}`;
}

export class InputAggregator {
  private readonly buckets: Bucket[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly windowMs: number) {
    if (!Number.isFinite(windowMs) || windowMs < 0) throw new Error('聚合窗不能为负');
  }

  accept(input: NormalizedInput): AggregateDecision {
    const key = bucketKey(input);
    const existing = this.findOpen(key, input.receivedAt);
    if (this.seen.has(input.eventId)) {
      const item = existing?.item ?? this.buckets.find((bucket) => bucket.item.eventIds.includes(input.eventId))?.item;
      if (!item) throw new Error(`事件 ${input.eventId} 已见过，但没有对应的聚合桶`);
      return { item, deliver: false, merged: true, duplicateEvent: true };
    }
    this.seen.add(input.eventId);
    if (existing) {
      const item = existing.item;
      if (!item.eventIds.includes(input.eventId)) item.eventIds = [...item.eventIds, input.eventId];
      if (!item.audienceIds.includes(input.audienceId)) item.audienceIds = [...item.audienceIds, input.audienceId];
      item.count += 1;
      item.lastReceivedAt = input.receivedAt;
      return { item, deliver: false, merged: true, duplicateEvent: false };
    }
    const route = classifyInput(input.kind, input.urgent);
    const item: AggregatedInput = {
      bucketId: `${key}@${input.receivedAt}`,
      eventIds: [input.eventId],
      audienceIds: [input.audienceId],
      text: input.text,
      kind: input.kind,
      priority: route.priority,
      wakeLive: route.wakeLive,
      wakeEditorial: route.wakeEditorial,
      firstReceivedAt: input.receivedAt,
      lastReceivedAt: input.receivedAt,
      directionEpoch: input.directionEpoch,
      count: 1,
    };
    this.buckets.push({ key, item });
    return { item, deliver: true, merged: false, duplicateEvent: false };
  }

  checkpoint(): { buckets: Bucket[]; seen: string[] } { return { buckets: structuredClone(this.buckets), seen: [...this.seen] }; }
  restore(snapshot: { buckets: Bucket[]; seen: string[] }): void { this.buckets.splice(0, this.buckets.length, ...snapshot.buckets); this.seen.clear(); for (const id of snapshot.seen) this.seen.add(id); }

  private findOpen(key: string, receivedAt: number): Bucket | undefined {
    for (let index = this.buckets.length - 1; index >= 0; index -= 1) {
      const bucket = this.buckets[index];
      if (!bucket || bucket.key !== key) continue;
      if (receivedAt < bucket.item.firstReceivedAt) continue;
      if (receivedAt - bucket.item.firstReceivedAt <= this.windowMs) return bucket;
    }
    return undefined;
  }
}
