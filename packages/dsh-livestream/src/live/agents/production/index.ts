/**
 * 制作池骨架。计划 §10 P6。不是完成：见 ../status.ts。
 * 后台提交只是候选。过期 epoch 可以入库，不能标成可 take。
 * 不接播放器，不 vendor 私有 SDK。
 */

export { ProductionDesk } from './desk';
export type { IntakeOk, IntakeResult, ReportOk } from './desk';
export { fixtureScenePackage } from './fixture-package';
export { assessTakeable, CandidateShelf } from './shelf';
export type { ShelfRecord } from './shelf';
