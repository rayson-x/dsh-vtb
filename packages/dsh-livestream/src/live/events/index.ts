export { MemoryEventLog } from './log';
export type { CommittedExecution, EventDraft, EventLogPort, EventLogSnapshot } from './log';

export { InputAggregator, aggregateSummary, classifyInput } from './aggregate';
export type { AggregateDecision, AggregatedInput, RoutePriority } from './aggregate';
export { normalizeInput } from './normalize';
export type { NormalizedInput, RawPlatformInput } from './normalize';
export { routeAggregate } from './route';
export type { AudienceDelivery } from './route';
