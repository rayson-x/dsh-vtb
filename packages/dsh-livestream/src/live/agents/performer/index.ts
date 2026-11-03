/**
 * 主播骨架。计划 §10 P7。不是完成：见 ../status.ts。
 * 口播直接提交。不等编导逐句批准，也不把 playing 写成已发生。
 */

export { PerformerDesk } from './desk';
export type { LoopPhase, PerformerTurn } from './desk';
export { decidePerformer } from './policy';
export type { PerformerDecision, PerformerObservation } from './policy';
