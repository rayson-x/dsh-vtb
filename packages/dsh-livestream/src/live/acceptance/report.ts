/**
 * scaffold 报告的 markdown / json。
 * 文本里可以提到计划中的测量口径，但不能出现测量结果字段。
 */

import type { AcceptanceRow, ScaffoldReport } from './schema';

function cell(value: string): string {
  return value.replace(/\|/g, '/').replace(/\r?\n/g, ' ').trim();
}

function evidenceCell(row: AcceptanceRow): string {
  return row.evidence.map((item) => `${item.kind}: ${item.ref}`).join('；');
}

function blockerCell(row: AcceptanceRow): string {
  if (row.blockers.length === 0) return '—';
  return row.blockers.map((blocker) => blocker.code).join('、');
}

function summaryTable(rows: AcceptanceRow[]): string {
  const header = '| id | 章节 | 场景 | status | 阻塞 | 缺口 |\n| --- | --- | --- | --- | --- | --- |';
  const body = rows.map((row) => (
    `| ${cell(row.id)} | ${cell(row.planSection)} | ${cell(row.scene)} | ${row.status} | ${cell(blockerCell(row))} | ${cell(row.gap)} |`
  ));
  return [header, ...body].join('\n');
}

function evidenceSections(rows: AcceptanceRow[]): string {
  return rows.map((row) => {
    const lines = [
      `### ${row.id}`,
      '',
      `${row.scene}。status=\`${row.status}\`。`,
      '',
      row.mustProve,
      '',
      `缺口：${row.gap}`,
      '',
      '证据：',
      '',
      ...row.evidence.map((item) => `- \`${item.kind}\` ${item.ref}。${item.note}`),
    ];
    return lines.join('\n');
  }).join('\n\n');
}

export function renderMarkdown(report: ScaffoldReport): string {
  const negativeRows = report.negatives.map((item) => (
    `| ${item.id} | ${item.code} | ${item.injection} | ${item.clean} | ${item.effective ? '是' : '否'} | ${cell(item.detail)} |`
  ));
  const parts = [
    '# P9 证据骨架报告',
    '',
    '这是 scaffold 报告，不是试播报告。没有真实 Agent 试播，也没有把未跑的测量写成 pass。',
    '',
    `- Issue #${report.issues.number}，父 issue #${report.issues.parent}`,
    `- 计划：\`${report.plan}\` §9、§12、P9`,
    `- 基线：\`${report.baseline}\``,
    `- 依赖：${report.dependency}`,
    `- 完成条件：证据可审查（未勾）；代码、文档与已知限制一致（未勾）`,
    '',
    ...report.disclaimer.map((line) => `- ${line}`),
    '',
    'status=`pass` 只出现在负控行，表示注入的故障被 harness 抓住，并且干净样本没有被误报。§9.3 行为行、§9.4 运行行和 §12 交付行都不是 pass。',
    '',
    '## 矩阵',
    '',
    summaryTable(report.rows),
    '',
    '## 负控',
    '',
    '注入判定的 fail 表示抓住了故障。干净样本的 pass 表示这份声明和证据一致，负控不报警。两者都不是试播通过。',
    '',
    '| id | code | 注入判定 | 干净样本 | 负控有效 | 说明 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...negativeRows,
    '',
    '## 未测量',
    '',
    '§9.4 各行 status=blocked。本报告不含试播时长、P50、P95、最大值或帧分布。',
    '',
    '## 逐行证据',
    '',
    evidenceSections(report.rows),
    '',
  ];
  return parts.join('\n');
}

export function renderJson(report: ScaffoldReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
