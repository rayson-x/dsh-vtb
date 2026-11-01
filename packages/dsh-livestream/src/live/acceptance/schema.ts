/**
 * P9 验收骨架的行状态与完整性。计划 §9、§12。
 * pass 只留给「负控注入被抓住」。
 * 夹具测试名不能把 §9.3 行为行或未跑的试播写成 pass。
 */

export const ROW_STATUSES = ['pass', 'fail', 'skip', 'blocked'] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];

export const EVIDENCE_KINDS = ['unit-fixture', 'negative-control', 'runtime-trial', 'gap'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const PLAN_SECTIONS = ['9.3', '9.3-negative', '9.4', '11', '12'] as const;
export type PlanSection = (typeof PLAN_SECTIONS)[number];

export const BLOCKER_CODES = ['P0_SDK', 'P2_RUNTIME', 'REAL_DSH', 'REAL_TRIAL', 'REAL_CONSOLE'] as const;
export type BlockerCode = (typeof BLOCKER_CODES)[number];

export const INTEGRITY_CODES = [
  'PASS_WITHOUT_EVIDENCE',
  'PASS_FROM_FIXTURE_ONLY',
  'BLOCKED_SILENT_PROMOTION',
  'BLOCKED_WITHOUT_REASON',
  'EVIDENCE_MISSING',
  'GAP_MISSING',
  'FABRICATED_METRIC',
  'SCAFFOLD_OVERCLAIM',
  'UNKNOWN_STATUS',
] as const;
export type IntegrityCode = (typeof INTEGRITY_CODES)[number];

export interface EvidencePointer {
  kind: EvidenceKind;
  /** 测试名、负控代号，或缺口编号。 */
  ref: string;
  file?: string;
  note: string;
}

export interface Blocker {
  code: BlockerCode;
  detail: string;
}

export interface AcceptanceRow {
  id: string;
  planSection: PlanSection;
  scene: string;
  mustProve: string;
  status: RowStatus;
  blockers: Blocker[];
  evidence: EvidencePointer[];
  gap: string;
}

export interface NegativeSummary {
  id: string;
  rowId: string;
  code: string;
  /** 注入故障后的判定。有效负控这里必须是 fail。 */
  injection: 'pass' | 'fail';
  /** 干净样本的判定。有效负控这里必须是 pass，表示不误报。 */
  clean: 'pass' | 'fail';
  effective: boolean;
  detail: string;
}

export interface ScaffoldReport {
  kind: 'scaffold';
  title: string;
  trialReport: false;
  issues: { number: 26; parent: 7 };
  plan: 'docs/plans/co-creative-live-harness.md';
  planSections: ['9', '12', 'P9'];
  baseline: 'cursor/p8-thin-adapter-skeleton-2dd4';
  disclaimer: string[];
  acceptance: typeof P9_ACCEPTANCE;
  dependency: 'P0 SDK + P2 运行验收';
  rows: AcceptanceRow[];
  negatives: NegativeSummary[];
}

export const OLD_SUITE_NOTE =
  '旧全量测试绿不等于新架构验收。单元测试名只是夹具证据指针，不能把 §9.3 行为行写成 pass。';

/**
 * Issue #26 的完成条件保持未勾。
 * 骨架可审查，也不等于真实试播和资源趋势已经做完。
 */
export const P9_ACCEPTANCE = {
  passed: false as const,
  headline: 'P9 证据骨架，不是试播完成',
  statement: '行为矩阵、负控和 scaffold 报告可审查。Issue #26 的两条完成条件都未勾。真实试播未跑。',
  checklist: {
    /** 证据可审查，关键缺口不隐藏。全量 P9 仍未完成。 */
    evidenceReviewable: false as const,
    /** 代码、文档与已知限制一致。运维说明和试播记录都还没有。 */
    docsMatchLimits: false as const,
  },
  blockers: [
    '真实 Agent 试播未跑',
    '连续 100 次真实 live patch 未跑',
    '30 分钟资源趋势未测',
    '依赖 P0 SDK + P2 运行验收',
  ],
} as const;

export class AcceptanceIntegrityError extends Error {
  readonly code: IntegrityCode;

  constructor(code: IntegrityCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'AcceptanceIntegrityError';
    this.code = code;
  }
}

export interface IntegrityFailure {
  code: IntegrityCode;
  detail: string;
}

const FORBIDDEN_METRIC_KEYS = new Set([
  'trialminutes',
  'p50',
  'p95',
  'p99',
  'maxlatency',
  'framedistribution',
  'framehistogram',
  'fpsobserved',
  'switchcount',
  'patchcount',
]);

export function lintRow(row: AcceptanceRow): IntegrityFailure | null {
  if (!ROW_STATUSES.includes(row.status)) {
    return { code: 'UNKNOWN_STATUS', detail: `${row.id} 的 status 不在 pass|fail|skip|blocked` };
  }
  if (row.gap.trim() === '') {
    return { code: 'GAP_MISSING', detail: `${row.id} 没有缺口说明` };
  }
  if (row.evidence.length === 0) {
    return { code: 'EVIDENCE_MISSING', detail: `${row.id} 没有证据指针` };
  }
  if (row.evidence.some((item) => item.kind === 'runtime-trial')) {
    return { code: 'SCAFFOLD_OVERCLAIM', detail: `${row.id} 的 scaffold 报告不能携带试播证据` };
  }
  if (row.status === 'pass' && row.blockers.length > 0) {
    return { code: 'BLOCKED_SILENT_PROMOTION', detail: `${row.id} 仍有阻塞，不能标 pass` };
  }
  if (row.status === 'pass' && row.planSection !== '9.3-negative') {
    return { code: 'SCAFFOLD_OVERCLAIM', detail: `${row.id} 不是负控行，scaffold 不能标 pass` };
  }
  if (row.status === 'pass' && !row.evidence.some((item) => item.kind === 'negative-control')) {
    return { code: 'PASS_WITHOUT_EVIDENCE', detail: `${row.id} 没有负控证据却标 pass` };
  }
  if (
    row.status === 'pass'
    && row.evidence.every((item) => item.kind === 'unit-fixture' || item.kind === 'gap')
  ) {
    return { code: 'PASS_FROM_FIXTURE_ONLY', detail: `${row.id} 只有夹具或缺口指针，不能标 pass` };
  }
  if (row.status === 'blocked' && row.blockers.length === 0) {
    return { code: 'BLOCKED_WITHOUT_REASON', detail: `${row.id} 标了 blocked，但没有阻塞原因` };
  }
  if (row.status !== 'blocked' && row.blockers.length > 0) {
    return { code: 'SCAFFOLD_OVERCLAIM', detail: `${row.id} 带着阻塞却不是 blocked` };
  }
  if (row.planSection === '9.4' && row.status !== 'blocked') {
    return { code: 'SCAFFOLD_OVERCLAIM', detail: `${row.id} 是未跑的 §9.4 测量，不能离开 blocked` };
  }
  return null;
}

function lintMetrics(value: unknown, path: string): IntegrityFailure | null {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = lintMetrics(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_METRIC_KEYS.has(key.toLowerCase())) {
      return { code: 'FABRICATED_METRIC', detail: `${path}.${key} 是未测量的指标字段` };
    }
    const found = lintMetrics(child, `${path}.${key}`);
    if (found) return found;
  }
  return null;
}

export function lintReport(report: ScaffoldReport): IntegrityFailure | null {
  if (report.kind !== 'scaffold' || report.trialReport !== false) {
    return { code: 'SCAFFOLD_OVERCLAIM', detail: '报告必须标明 scaffold，且不是试播报告' };
  }
  if (report.acceptance.passed !== false) {
    return { code: 'SCAFFOLD_OVERCLAIM', detail: 'P9 完成标记不能勾上' };
  }
  if (report.acceptance.checklist.evidenceReviewable !== false || report.acceptance.checklist.docsMatchLimits !== false) {
    return { code: 'SCAFFOLD_OVERCLAIM', detail: 'Issue #26 的完成条件不能勾上' };
  }
  const metrics = lintMetrics(report, 'report');
  if (metrics) return metrics;
  for (const row of report.rows) {
    const failure = lintRow(row);
    if (failure) return failure;
  }
  return null;
}

export function assertReportIntegrity(report: ScaffoldReport): void {
  const failure = lintReport(report);
  if (failure) throw new AcceptanceIntegrityError(failure.code, failure.detail);
}

export interface PromotionAttempt {
  status: 'pass';
  evidence: readonly EvidencePointer[];
  /** 缺省表示想静默升级。点名清障也不会在本骨架里得到 pass。 */
  clearBlockers?: readonly BlockerCode[];
}

export function promoteRow(
  row: AcceptanceRow,
  attempt: PromotionAttempt,
): { ok: false; code: IntegrityCode; detail: string } {
  if (attempt.evidence.length === 0) {
    return { ok: false, code: 'PASS_WITHOUT_EVIDENCE', detail: `${row.id} 没有证据不能标 pass` };
  }
  const fixtureOnly = attempt.evidence.every((item) => item.kind === 'unit-fixture' || item.kind === 'gap');
  if (fixtureOnly) {
    return { ok: false, code: 'PASS_FROM_FIXTURE_ONLY', detail: `${row.id} 只有夹具或缺口指针，不能标 pass` };
  }
  if (row.status === 'blocked' || row.blockers.length > 0) {
    if (!attempt.clearBlockers || attempt.clearBlockers.length === 0) {
      return { ok: false, code: 'BLOCKED_SILENT_PROMOTION', detail: `${row.id} 是 blocked，不能静默升成 pass` };
    }
    return {
      ok: false,
      code: 'BLOCKED_SILENT_PROMOTION',
      detail: `${row.id} 即使点名清掉 ${attempt.clearBlockers.join('、')}，本骨架也不把未跑试播写成 pass`,
    };
  }
  return {
    ok: false,
    code: 'SCAFFOLD_OVERCLAIM',
    detail: `${row.id} 的 pass 只能来自负控注入，不能手工升级`,
  };
}
