/**
 * 共创直播域契约的状态与拒绝码。
 * 计划 §3。这些名字是本项目的域语言，不是 Scene SDK 的原生 API。
 */

/** 提议生命周期。制作完成或语音入队不能跳到 presented。计划 §3.1。 */
export const PROPOSAL_STATUSES = [
  'received',
  'accepted',
  'creating',
  'ready',
  'presented',
  'deferred',
  'cancelled',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * SpeechPart：offered → accepted → queued → starting → playing → ended，
 * 另有 rejected / cancelled / aborted / failed。计划 §3.5。
 */
export const SPEECH_PART_STATES = [
  'offered',
  'accepted',
  'queued',
  'starting',
  'playing',
  'ended',
  'rejected',
  'cancelled',
  'aborted',
  'failed',
] as const;
export type SpeechPartState = (typeof SPEECH_PART_STATES)[number];

/** 已过 starting 的口播视为已提交。此后改词返回 TOO_LATE。 */
export const SPEECH_COMMITTED_STATES = ['starting', 'playing', 'ended', 'aborted', 'failed'] as const;

/**
 * 计划 §3.2 点名的冲突码。静默覆盖不在此列。
 * STALE_DIRECTION：epoch 拒过期。命令 epoch 不是当前 epoch，
 * 或过期 task / scene 试图 take、派发、改输入时用这一枚。旧产物可入库，不能上播。
 */
export const CONFLICT_CODES = [
  'STALE_DIRECTION',
  'REVISION_CONFLICT',
  'SCENE_NOT_READY',
  'UNSUPPORTED_LIVE_PATCH',
  'CUE_ALREADY_EXECUTED',
  'TOO_LATE',
] as const;
export type ConflictCode = (typeof CONFLICT_CODES)[number];

/**
 * 冲突码加上域规则拒绝。后半不是 §3.2 的并发冲突，
 * 但事件序列需要把「没权限 / 假锚点 / 未兑现」和冲突分开。
 */
export const REJECT_CODES = [
  ...CONFLICT_CODES,
  'NOT_AUTHORIZED',
  'ANCHOR_INVALID',
  'FULFILLMENT_UNPROVEN',
  'IMMUTABLE_VERSION',
  'POLICY_REJECTED',
  'DISCONNECTED',
  'VOICE_DRIFT_COMPENSATION_FORBIDDEN',
  'PREVIEW_AUDIO_FORBIDDEN',
  'UNKNOWN_TARGET',
  'ILLEGAL_TRANSITION',
] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

export const ROLES = [
  'editorial',
  'director',
  'performer',
  'production',
  'directionController',
  'master',
  'input',
  'runtime',
] as const;
export type Role = (typeof ROLES)[number];

/** 低延迟角色。方向控制器、master、输入与 Runtime 不是模型岗位。 */
export const AGENT_ROLES = ['editorial', 'director', 'performer', 'production'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const EVENT_KINDS = [
  'audience.input',
  'content.proposal',
  'production.result',
  'show.command',
  'execution.receipt',
  'direction.switched',
  'session.reconnected',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const READINESS_GATES = [
  'moduleLoad',
  'schemaAssets',
  'firstFramePaint',
  'businessVersionMatch',
] as const;
export type ReadinessGate = (typeof READINESS_GATES)[number];

/** SDK 信号与上面四项门闩不是一回事，不能互相冒充。计划 §6.4。 */
export const SDK_READY_SIGNALS = ['ready', 'applied', 'assetsready', 'painted'] as const;
export type SdkReadySignal = (typeof SDK_READY_SIGNALS)[number];
