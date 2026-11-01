/**
 * 导播骨架。计划 §10 P7。不是完成：见 ../status.ts。
 * 命令进内核。SceneHost 只录制受理或 blocked，不制造 painted。
 */

export { DirectorDesk } from './desk';
export type { DirectorTurn, LoopPhase } from './desk';
export { decideDirector } from './policy';
export type { DirectorDecision, DirectorObservation } from './policy';
export { BlockedSceneHost } from './scene-host';
export type { HostOp, RecordedHostCall } from './scene-host';
