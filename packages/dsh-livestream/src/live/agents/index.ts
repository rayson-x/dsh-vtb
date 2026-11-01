/**
 * P5 角色运行与路由。计划 §2.2、§3.4–§3.5、§8。
 * 内存夹具实现端口。真实 DSH 接线留在 TODO(P5-wire)，不进入现有主持人主路径。
 * P6 编导 / 制作是这上面的骨架，不是模型决定循环，也不是上播。
 */

export { projectRoleBriefs } from './briefs';
export type { RoleBriefs } from './briefs';
export { cancelThenSteer, readScheduledAudio } from './cancel';
export { MemoryAgentHarness } from './harness';
export type { HarnessOptions, IngestReceipt, ProductionAssignment } from './harness';
export { MemoryInbox } from './inbox';
export { LiveBudget } from './limits';
export {
  PRODUCTION_POOL_DEFAULT,
  PRODUCTION_POOL_MAX,
  RESIDENT_ROLES,
  TASK_REPORT_STATUSES,
} from './ports';
export type {
  CancelSteerRequest,
  CancelSteerResult,
  GenerationPhase,
  InboxEntry,
  LimitDecision,
  ProductionJob,
  ReportDecision,
  ResidentRole,
  RoleContext,
  RoleInboxPort,
  RoleRegistration,
  RoleSessionPort,
  ScheduledAudio,
  TaskReportEnvelope,
  TaskReportStatus,
} from './ports';
export { ProductionQueue } from './queue';
export { RoleRegistry, RoleSession, residentRoles } from './registry';
export { acceptReport } from './reports';
export { EditorialDesk, judgeInterest } from './editorial/index';
export type { CandidateRef, ContentPools, ElasticRundown, InterestJudgment, SupplyReceipt } from './editorial/index';
export { editorialMandate, gateAction, productionMandate } from './gate';
export { openP6 } from './open';
export { ProductionDesk, assessTakeable, CandidateShelf, fixtureScenePackage } from './production/index';
export type { IntakeResult, ShelfRecord } from './production/index';
export { P6_ACCEPTANCE } from './status';
