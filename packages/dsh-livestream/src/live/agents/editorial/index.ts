/**
 * 编导骨架。计划 §10 P6。不是完成：见 ../status.ts。
 * 不审批全部发言。prepare 只建候选。不接播放器。
 */

export { EditorialDesk } from './desk';
export type { SupplyReceipt } from './desk';
export { judgeInterest, INTEREST_KINDS } from './interest';
export type { InterestInput, InterestJudgment, InterestKind } from './interest';
export { adoptIntoCurrent, emptyPools, projectPools, POOL_LANES } from './pools';
export type { CandidateRef, ContentPools, PoolEntry, PoolLane } from './pools';
export { compareRundownRevision, parseRundown, reviseRundown, serializeRundown } from './rundown';
export type { ElasticRundown, RundownBeat } from './rundown';
