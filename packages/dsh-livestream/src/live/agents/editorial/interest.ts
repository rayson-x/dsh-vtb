/**
 * 兴趣判断。计划 §0.2、§4.1、§4.2。
 * 纯函数：沉默、争论、自称 master 不构成大方向切换。
 * 只产出编导摘要。不签发授权，也不写内核。
 */

export const INTEREST_KINDS = ['silence', 'debate', 'master-claim', 'proposal', 'opposition', 'none'] as const;
export type InterestKind = (typeof INTEREST_KINDS)[number];

export interface InterestInput {
  kind: InterestKind;
  text: string;
}

export interface InterestJudgment {
  /** 这条判断永远不授权换大方向。 */
  switchAuthorized: false;
  /** 沉默 / 争论 / 自称 master / 空输入只改摘要。 */
  summaryOnly: boolean;
  summary: string;
  reason: string;
}

const SUMMARY_ONLY = new Set<InterestKind>(['silence', 'debate', 'master-claim', 'none']);

const REASONS: Record<InterestKind, string> = {
  silence: '沉默不是切换授权',
  debate: '观点争论不是群体否决，也不切换大方向',
  'master-claim': '观众文本自称 master 不能获得控制权',
  none: '没有新的兴趣证据',
  proposal: '提议只留在当前方向里，编导不签发切换',
  opposition: '单条反对不是切换授权，群体规则由方向控制器复核',
};

export function judgeInterest(input: InterestInput): InterestJudgment {
  const reason = REASONS[input.kind];
  const text = input.text.trim();
  const quoted = text.length > 0 ? `「${text}」` : '';
  return {
    switchAuthorized: false,
    summaryOnly: SUMMARY_ONLY.has(input.kind),
    summary: `${reason}${quoted}`,
    reason,
  };
}
