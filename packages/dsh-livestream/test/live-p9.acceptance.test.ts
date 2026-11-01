/**
 * P9 证据骨架。
 * 负控必须抓住注入的幽灵 cue、缺音频却标 playing、无 paintReceipt 却标 painted。
 * 没有证据不能标 pass。blocked 行不能静默升成 pass。
 * 样例报告是 scaffold，不是试播报告。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MATRIX_ROWS } from '../src/live/domain/index';
import {
  AcceptanceIntegrityError,
  CATALOG,
  OLD_SUITE_NOTE,
  P9_ACCEPTANCE,
  REQUIRED_COVERAGE,
  assertReportIntegrity,
  buildScaffoldReport,
  judgeAudio,
  judgeGhostCue,
  judgePaint,
  lintReport,
  lintRow,
  promoteRow,
  renderJson,
  renderMarkdown,
  runNegativeSuite,
  type AcceptanceRow,
  type ScaffoldReport,
} from '../src/live/acceptance/index';

const reportJsonPath = fileURLToPath(new URL('../../../docs/acceptance/scaffold-report.json', import.meta.url));
const reportMdPath = fileURLToPath(new URL('../../../docs/acceptance/scaffold-report.md', import.meta.url));

function row(report: ScaffoldReport, id: string): AcceptanceRow {
  const found = report.rows.find((item) => item.id === id);
  if (!found) throw new Error(`缺少矩阵行 ${id}`);
  return found;
}

describe('矩阵 schema', () => {
  const report = buildScaffoldReport();

  it('覆盖计划 §9.3 的每一行，并带上候选不上播和 legacy/v2', () => {
    const behavior = report.rows.filter((item) => item.planSection === '9.3').map((item) => item.id);
    expect(behavior.slice(0, MATRIX_ROWS.length)).toEqual(MATRIX_ROWS.map((item) => item.id));
    for (const id of REQUIRED_COVERAGE) {
      expect(report.rows.some((item) => item.id === id), id).toBe(true);
    }
    expect(CATALOG.map((item) => item.id)).toEqual(expect.arrayContaining([...REQUIRED_COVERAGE.filter((id) => !id.startsWith('neg-'))]));
  });

  it('每一行都有合法 status、证据指针和缺口', () => {
    expect(report.rows.length).toBeGreaterThan(MATRIX_ROWS.length);
    for (const item of report.rows) {
      expect(['pass', 'fail', 'skip', 'blocked']).toContain(item.status);
      expect(item.gap.trim().length).toBeGreaterThan(0);
      expect(item.evidence.length).toBeGreaterThan(0);
      expect(item.mustProve.trim().length).toBeGreaterThan(0);
    }
  });

  it('§9.3 行为行没有 pass，负控行的 pass 带负控指针', () => {
    for (const item of report.rows.filter((entry) => entry.planSection === '9.3')) {
      expect(item.status, item.id).not.toBe('pass');
    }
    const passes = report.rows.filter((item) => item.status === 'pass');
    expect(passes.length).toBeGreaterThan(0);
    for (const item of passes) {
      expect(item.planSection).toBe('9.3-negative');
      expect(item.evidence.some((pointer) => pointer.kind === 'negative-control')).toBe(true);
    }
  });

  it('完成条件不勾，报告标明是 scaffold', () => {
    expect(P9_ACCEPTANCE.passed).toBe(false);
    expect(P9_ACCEPTANCE.checklist.evidenceReviewable).toBe(false);
    expect(P9_ACCEPTANCE.checklist.docsMatchLimits).toBe(false);
    expect(report.kind).toBe('scaffold');
    expect(report.trialReport).toBe(false);
    expect(report.issues).toEqual({ number: 26, parent: 7 });
    expect(report.disclaimer).toContain(OLD_SUITE_NOTE);
  });
});

describe('负控抓得到', () => {
  it('注入幽灵 cue 时判定 fail，已念锚点不误报', () => {
    const ghost = judgeGhostCue({ cueId: 'ghost-1', claimed: 'executed', bound: false });
    expect(ghost.status).toBe('fail');
    expect(ghost.code).toBe('GHOST_CUE');
    const unsaid = judgeGhostCue({
      cueId: 'unsaid',
      claimed: 'dispatched',
      bound: true,
      anchor: { kind: 'speech', charIndex: 3, spokenChars: 1, speechState: 'playing' },
    });
    expect(unsaid).toMatchObject({ status: 'fail', code: 'GHOST_CUE' });
    const heard = judgeGhostCue({
      cueId: 'heard',
      claimed: 'executed',
      bound: true,
      anchor: { kind: 'speech', charIndex: 0, spokenChars: 2, speechState: 'playing' },
    });
    expect(heard.status).toBe('pass');
  });

  it('缺真实 audio 却标 playing 时判定 fail，estimated 且有媒体观察时不误报', () => {
    const missing = judgeAudio({
      partId: 'line',
      markedPlaying: true,
      audioRef: null,
      mediaObservation: null,
      alignment: 'none',
      starts: null,
    });
    expect(missing).toMatchObject({ status: 'fail', code: 'MISSING_AUDIO' });
    const fakeReal = judgeAudio({
      partId: 'line',
      markedPlaying: true,
      audioRef: 'clip',
      mediaObservation: 'playing',
      alignment: 'real',
      starts: [],
    });
    expect(fakeReal).toMatchObject({ status: 'fail', code: 'MISSING_REAL_STARTS' });
    const estimated = judgeAudio({
      partId: 'line',
      markedPlaying: true,
      audioRef: 'clip',
      mediaObservation: 'playing',
      alignment: 'estimated',
      starts: null,
    });
    expect(estimated.status).toBe('pass');
  });

  it('无 paintReceipt 却标 painted 时判定 fail，有回执时不误报', () => {
    const missing = judgePaint({ sceneInstanceId: 'scene', markedPainted: true, paintReceipt: null });
    expect(missing).toMatchObject({ status: 'fail', code: 'PAINTED_WITHOUT_RECEIPT' });
    const painted = judgePaint({
      sceneInstanceId: 'scene',
      markedPainted: true,
      paintReceipt: { id: 'paint-1', kind: 'painted' },
    });
    expect(painted.status).toBe('pass');
    const pending = judgePaint({ sceneInstanceId: 'scene', markedPainted: false, paintReceipt: null });
    expect(pending.status).toBe('pass');
  });

  it('计划点名的注入都会 fail，干净样本不会，矩阵行因此为 pass', () => {
    const report = buildScaffoldReport();
    const suite = runNegativeSuite();
    expect(suite.map((item) => item.code)).toEqual([
      'GHOST_CUE',
      'MISSING_AUDIO',
      'MISSING_REAL_STARTS',
      'FAILED_EXIT_AS_SUCCESS',
      'SILENT_CROSS_SEGMENT',
      'INPUT_REMOUNT',
      'EMPTY_LEGAL_REMAINDER',
      'DOWNSAMPLED_FALSE_GAP',
      'SWALLOWED_POLL_ERROR',
      'PAINTED_WITHOUT_RECEIPT',
    ]);
    for (const item of suite) {
      expect(item.injection.status, item.code).toBe('fail');
      expect(item.clean.status, item.code).toBe('pass');
      expect(item.effective, item.code).toBe(true);
      expect(row(report, item.rowId).status).toBe('pass');
    }
  });
});

describe('不能无证据标 pass，blocked 不能静默升级', () => {
  const report = buildScaffoldReport();

  it('空证据不能标 pass', () => {
    const result = promoteRow(row(report, 'editorial-gap'), { status: 'pass', evidence: [] });
    expect(result).toMatchObject({ ok: false, code: 'PASS_WITHOUT_EVIDENCE' });
  });

  it('只有夹具指针不能把行为行标成 pass', () => {
    const source = row(report, 'direction-switch');
    const result = promoteRow(source, { status: 'pass', evidence: source.evidence });
    expect(result).toMatchObject({ ok: false, code: 'PASS_FROM_FIXTURE_ONLY' });
    const forged: AcceptanceRow = { ...source, status: 'pass' };
    expect(lintRow(forged)?.code).toBe('SCAFFOLD_OVERCLAIM');
  });

  it('blocked 行不能静默升成 pass，点名清障也不行', () => {
    const source = row(report, 'live-patch');
    expect(source.status).toBe('blocked');
    expect(source.blockers.map((item) => item.code)).toEqual(expect.arrayContaining(['P0_SDK', 'P2_RUNTIME']));
    const silent = promoteRow(source, {
      status: 'pass',
      evidence: [{ kind: 'negative-control', ref: 'NOT_A_TRIAL', note: '这不是清障' }],
    });
    expect(silent).toMatchObject({ ok: false, code: 'BLOCKED_SILENT_PROMOTION' });
    const named = promoteRow(source, {
      status: 'pass',
      evidence: [{ kind: 'runtime-trial', ref: 'fabricated', note: '未跑的试播' }],
      clearBlockers: ['P0_SDK', 'P2_RUNTIME', 'REAL_TRIAL'],
    });
    expect(named).toMatchObject({ ok: false, code: 'BLOCKED_SILENT_PROMOTION' });
    const forged: AcceptanceRow = { ...source, status: 'pass' };
    expect(lintRow(forged)?.code).toBe('BLOCKED_SILENT_PROMOTION');
  });

  it('未跑的试播、一百次更新和资源趋势保持 blocked，报告里没有测量字段', () => {
    for (const id of ['trial-15min', 'interaction-latency', 'switches-30', 'input-updates-100', 'resource-trend-30min', 'frame-distribution']) {
      const item = row(report, id);
      expect(item.status, id).toBe('blocked');
      expect(item.planSection, id).toBe('9.4');
      expect(item.gap, id).toMatch(/未/);
    }
    expect(row(report, 'live-patch').gap).toMatch(/不是连续 100 次真实输入更新/);
    for (const id of ['trial-15min', 'input-updates-100', 'resource-trend-30min']) {
      expect(row(report, id).gap, id).toMatch(/P0 SDK \+ P2 运行验收/);
      expect(row(report, id).blockers.map((item) => item.code), id).toEqual(expect.arrayContaining(['P0_SDK', 'P2_RUNTIME']));
    }
    expect(row(report, 'input-updates-100').evidence.some((item) => item.ref.includes('100 次协议记录不是 live patch'))).toBe(true);
    const illegal = { ...report, p50: 1, trialMinutes: 15 } as ScaffoldReport;
    expect(lintReport(illegal)?.code).toBe('FABRICATED_METRIC');
    expect(() => assertReportIntegrity(illegal)).toThrow(AcceptanceIntegrityError);
    expect(JSON.stringify(report)).not.toMatch(/"p50"|"p95"|"trialMinutes"|"frameDistribution"/);
  });
});

describe('样例报告', () => {
  it('docs/acceptance 里的 scaffold 报告与收集器一致，并写明不是试播', () => {
    const report = buildScaffoldReport();
    expect(readFileSync(reportJsonPath, 'utf8')).toBe(renderJson(report));
    const markdown = readFileSync(reportMdPath, 'utf8');
    expect(markdown).toBe(renderMarkdown(report));
    expect(markdown).toContain('scaffold 报告，不是试播报告');
    expect(markdown).toContain(OLD_SUITE_NOTE);
    expect(markdown).toContain('Issue #26');
    expect(markdown).toContain('父 issue #7');
    expect(markdown).toContain('两者都不是试播通过');
    expect(markdown).not.toContain('试播已通过');
  });
});
