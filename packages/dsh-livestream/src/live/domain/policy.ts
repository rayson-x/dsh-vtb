/**
 * 尚未冻结的数字，以及可以配置、但不是验收门槛的产品起点。
 * 就绪与漂移：计划 §6.4 / §7.1，标「待 P2 冻结」。
 * 群体反对观察：计划 §4.2，试播须校准，不是行业标准，也不是 P2 就绪契约。
 */

export const PENDING_P2_LABEL = '待 P2 冻结' as const;

/** 备场就绪只命名要测的门闩，不给超时毫秒或「Promise 返回即可见」。 */
export const STANDBY_READINESS_PROTOCOL = {
  label: PENDING_P2_LABEL,
  section: '6.4',
  gates: ['moduleLoad', 'schemaAssets', 'firstFramePaint', 'businessVersionMatch'],
  distinctFromSdkSignals: ['ready', 'applied', 'assetsready', 'painted'],
  notes: [
    '四项彼此独立，不能互相冒充',
    '资源超时不能记为成功',
    'await Promise 返回不等于首帧可见',
    '隐藏/离屏备场可能被节流，P1 只定义测量协议',
  ],
} as const;

/** 漂移只记录样本。容限与校准策略没有数值。 */
export const DRIFT_PROTOCOL = {
  label: PENDING_P2_LABEL,
  section: '7.1',
  notes: [
    'P2 实测后才确定 adapter 漂移容限与校准策略',
    '禁止默认每帧对正在播放的 Player seek',
    '不得靠加速真实人声弥补图形漂移',
    'ProgrammeClock 是唯一节目时间，墙钟不是第二权威',
  ],
} as const;

/** 首版画面基准，不是重 shader 的实时承诺。计划 §7.1。 */
export const FRAME_BASELINE = {
  label: '首版基准，非实时能力承诺',
  section: '7.1',
  width: 1920,
  height: 1080,
  fps: 30,
} as const;

export interface GroupVetoPolicy {
  activeWindowMs: number;
  oppositionWindowMs: number;
  minDistinctOpponents: number;
  minOppositionRatio: number;
  minAssessments: number;
  minAssessmentSpanMs: number;
  label: '产品起点，试播须校准，非冻结验收数';
  section: '4.2';
}

/** 计划 §4.2 的建议初始观测。配置，不是模型提示词，也不是待 P2 冻结的就绪数字。 */
export const DEFAULT_GROUP_VETO_POLICY: GroupVetoPolicy = {
  activeWindowMs: 120_000,
  oppositionWindowMs: 30_000,
  minDistinctOpponents: 5,
  minOppositionRatio: 0.6,
  minAssessments: 2,
  minAssessmentSpanMs: 10_000,
  label: '产品起点，试播须校准，非冻结验收数',
  section: '4.2',
};

export interface GroupVetoAssessment {
  atShowTime: number;
  activeAudienceIds: readonly string[];
  oppositionIds: readonly string[];
}

export interface GroupVetoDecision {
  ok: boolean;
  reason: string;
}

function ratioOk(active: readonly string[], opposition: readonly string[], policy: GroupVetoPolicy): boolean {
  const audience = new Set(active);
  if (audience.size < policy.minDistinctOpponents) return false;
  const opposed = new Set(opposition.filter((id) => audience.has(id)));
  if (opposed.size < policy.minDistinctOpponents) return false;
  return opposed.size / audience.size >= policy.minOppositionRatio;
}

/**
 * 确定性复核。小房间人数不够时，不凭一两个人的高比例换大方向。
 * 调用方传入的反对名单若没有落在对应活跃集合里，不计数。
 */
export function evaluateGroupVeto(
  assessments: readonly GroupVetoAssessment[],
  policy: GroupVetoPolicy = DEFAULT_GROUP_VETO_POLICY,
): GroupVetoDecision {
  if (assessments.length < policy.minAssessments) {
    return { ok: false, reason: '评估次数不足，不换大方向' };
  }
  const times = assessments.map((item) => item.atShowTime).sort((a, b) => a - b);
  const span = times[times.length - 1]! - times[0]!;
  if (span < policy.minAssessmentSpanMs) {
    return { ok: false, reason: '两次评估跨度不足，不换大方向' };
  }
  for (const assessment of assessments) {
    if (assessment.activeAudienceIds.length < policy.minDistinctOpponents) {
      return { ok: false, reason: '活跃去重观众不足绝对人数，不凭高比例自动换方向' };
    }
    if (!ratioOk(assessment.activeAudienceIds, assessment.oppositionIds, policy)) {
      return { ok: false, reason: '明确反对人数或比例不足，不换大方向' };
    }
  }
  return { ok: true, reason: '群体反对证据达到当前配置' };
}
