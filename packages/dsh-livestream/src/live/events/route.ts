/**
 * 按优先级把聚合结果送到角色收件箱。计划 §8.1。
 * 制作池不收原始弹幕。编导不在主播响应的同步链上：投递只是入队，不调用编导。
 */

import type { AgentRole } from '../domain/codes';
import type { AggregatedInput, RoutePriority } from './aggregate';

export interface AudienceDelivery {
  role: AgentRole;
  priority: RoutePriority;
  wake: boolean;
}

/** 固定顺序：现场角色先入队，编导在后。没有制作池。 */
export function routeAggregate(item: AggregatedInput): AudienceDelivery[] {
  const deliveries: AudienceDelivery[] = [];
  if (item.wakeLive) {
    deliveries.push(
      { role: 'performer', priority: item.priority, wake: true },
      { role: 'director', priority: item.priority, wake: true },
    );
  }
  if (item.wakeEditorial) {
    deliveries.push({ role: 'editorial', priority: item.priority, wake: item.priority !== 'background' });
  }
  return deliveries;
}
