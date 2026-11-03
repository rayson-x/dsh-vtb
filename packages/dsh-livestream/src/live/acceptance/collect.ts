/**
 * 把目录、夹具指针和负控注入收成一份 scaffold 报告。
 * 不读取播放器，不填写试播数字。
 */

import { CATALOG, type RowSpec } from './catalog';
import { citationsFor } from './evidence';
import { runNegativeSuite, type NegativeRun } from './negatives';
import {
  OLD_SUITE_NOTE,
  P9_ACCEPTANCE,
  assertReportIntegrity,
  type AcceptanceRow,
  type EvidencePointer,
  type NegativeSummary,
  type ScaffoldReport,
} from './schema';

function materializeSpec(spec: RowSpec): AcceptanceRow {
  const cited = citationsFor(spec.id);
  const evidence: EvidencePointer[] = cited.length > 0
    ? cited
    : [{ kind: 'gap', ref: 'not-run', note: '没有可引用的夹具，也没有试播记录' }];
  return {
    id: spec.id,
    planSection: spec.planSection,
    scene: spec.scene,
    mustProve: spec.mustProve,
    status: spec.status,
    blockers: spec.blockers.map((blocker) => ({ ...blocker })),
    evidence,
    gap: spec.gap,
  };
}

function materializeNegative(run: NegativeRun): AcceptanceRow {
  const evidence: EvidencePointer[] = [
    {
      kind: 'negative-control',
      ref: run.code,
      note: run.effective
        ? `注入被判 fail：${run.injection.detail}`
        : `负控无效。注入判定 ${run.injection.status}，干净样本判定 ${run.clean.status}`,
    },
  ];
  return {
    id: run.rowId,
    planSection: '9.3-negative',
    scene: run.scene,
    mustProve: run.mustProve,
    status: run.effective ? 'pass' : 'fail',
    blockers: [],
    evidence,
    gap: run.effective
      ? '注入已被抓住，干净样本不误报。这只证明负控有效，不是试播记录，也不证明现场没有这类故障。'
      : '负控无效：注入没有被判 fail，或干净样本被误报。这一行保持 fail。',
  };
}

function summarize(run: NegativeRun): NegativeSummary {
  return {
    id: run.id,
    rowId: run.rowId,
    code: run.code,
    injection: run.injection.status,
    clean: run.clean.status,
    effective: run.effective,
    detail: run.injection.detail,
  };
}

export function buildScaffoldReport(): ScaffoldReport {
  const suite = runNegativeSuite();
  const report: ScaffoldReport = {
    kind: 'scaffold',
    title: 'P9 证据骨架报告',
    trialReport: false,
    issues: { number: 26, parent: 7 },
    plan: 'docs/plans/co-creative-live-harness.md',
    planSections: ['9', '12', 'P9'],
    baseline: 'cursor/p8-thin-adapter-skeleton-2dd4',
    disclaimer: [
      '这是 scaffold 报告，不是试播报告。',
      '未记录试播时长、P50、P95、最大值或 1080p/30fps 帧分布。',
      OLD_SUITE_NOTE,
      '真实试播、连续 100 次 live patch、30 次切场和 30 分钟资源趋势均为 blocked。依赖 P0 SDK + P2 运行验收。',
      'Issue #26 的完成条件未勾。',
    ],
    acceptance: P9_ACCEPTANCE,
    dependency: 'P0 SDK + P2 运行验收',
    rows: [...CATALOG.map(materializeSpec), ...suite.map(materializeNegative)],
    negatives: suite.map(summarize),
  };
  assertReportIntegrity(report);
  return report;
}
