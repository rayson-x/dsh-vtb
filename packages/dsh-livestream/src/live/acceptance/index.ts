/**
 * P9 证据骨架。计划 §9、§12。
 * 收集矩阵、负控和 scaffold 报告。不是试播完成，也不接播放器。
 */

export { CATALOG, REQUIRED_COVERAGE } from './catalog';
export type { RowSpec } from './catalog';
export { citationsFor } from './evidence';
export { buildScaffoldReport } from './collect';
export {
  judgeArchive,
  judgeAudio,
  judgeCrossSegment,
  judgeExit,
  judgeGhostCue,
  judgePaint,
  judgePoll,
  judgeRemount,
  judgeSampling,
  runNegativeSuite,
} from './negatives';
export type {
  ArchiveClaim,
  AudioClaim,
  CrossSegmentClaim,
  ExitClaim,
  GhostCueClaim,
  NegativeRun,
  NegativeVerdict,
  PaintClaim,
  PollClaim,
  RemountClaim,
  SamplingClaim,
} from './negatives';
export { renderJson, renderMarkdown } from './report';
export {
  AcceptanceIntegrityError,
  BLOCKER_CODES,
  EVIDENCE_KINDS,
  INTEGRITY_CODES,
  OLD_SUITE_NOTE,
  P9_ACCEPTANCE,
  PLAN_SECTIONS,
  ROW_STATUSES,
  assertReportIntegrity,
  lintReport,
  lintRow,
  promoteRow,
} from './schema';
export type {
  AcceptanceRow,
  Blocker,
  BlockerCode,
  EvidenceKind,
  EvidencePointer,
  IntegrityCode,
  IntegrityFailure,
  NegativeSummary,
  PlanSection,
  PromotionAttempt,
  RowStatus,
  ScaffoldReport,
} from './schema';
