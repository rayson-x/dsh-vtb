/**
 * 控制台（React 18）与场景宿主之间的消息。计划 §6.1。
 * 只接受纯 JSON。不携带 Window、React 元素或函数。
 * 真实浏览器要先 JSON.parse，再用这里的校验；本函数也会拒绝函数和元素标记。
 */

import { jsonProblem, type JsonValue } from './boundary';
import { LIFECYCLE_OPS, type LifecycleOp } from './status';
import { READINESS_GATES, SDK_READY_SIGNALS, type ReadinessGate, type SdkReadySignal } from '../../dsh-livestream/src/live/domain/codes';

export const SCENE_HOST_SCHEMA_VERSION = 1 as const;

export const HOST_MESSAGE_TYPES = [
  'handshake',
  'handshakeAck',
  'lifecycle',
  'readinessSample',
  'driftSample',
  'playbackReceipt',
  'protocolReject',
] as const;

export type HostMessageType = (typeof HOST_MESSAGE_TYPES)[number];

export interface HostSession {
  hostInstanceId: string;
  origin: string;
  schemaVersion: typeof SCENE_HOST_SCHEMA_VERSION;
}

export interface HostEnvelope {
  schemaVersion: typeof SCENE_HOST_SCHEMA_VERSION;
  messageId: string;
  hostInstanceId: string;
  origin: string;
  source: 'console' | 'scene-host';
  type: HostMessageType;
  payload: JsonValue;
}

type GateStatus = 'pending' | 'ok' | 'failed' | 'timedOut';

export type HostMessage =
  | { type: 'handshake'; envelope: HostEnvelope; payload: { hostInstanceId: string; origin: string } }
  | { type: 'handshakeAck'; envelope: HostEnvelope; payload: { hostInstanceId: string; origin: string; accepted: true } }
  | { type: 'lifecycle'; envelope: HostEnvelope; payload: { op: LifecycleOp; instanceId: string } }
  | {
      type: 'readinessSample';
      envelope: HostEnvelope;
      payload: { instanceId: string; gate: ReadinessGate; status: GateStatus; observedAtShowTime?: number; detail?: string };
    }
  | {
      type: 'driftSample';
      envelope: HostEnvelope;
      payload: { sceneInstanceId: string; programmeShowTime: number; adapterReportedTime: number };
    }
  | {
      type: 'playbackReceipt';
      envelope: HostEnvelope;
      payload: { instanceId: string; kind: 'painted' | 'failed'; showTime: number };
    }
  | { type: 'protocolReject'; envelope: HostEnvelope; payload: { code: string; detail: string } };

export type ParseResult =
  | { ok: true; message: HostMessage; session: HostSession }
  | { ok: false; reason: string };

const GATE_STATUS = new Set<GateStatus>(['pending', 'ok', 'failed', 'timedOut']);

export function parseHostMessage(
  raw: unknown,
  ctx: { session: HostSession | null; allowedOrigin: string; eventOrigin: string },
): ParseResult {
  if (ctx.eventOrigin !== ctx.allowedOrigin) return fail('实际消息来源 origin 不符');
  if (!isRecord(raw)) return fail('消息不是对象');
  const problem = jsonProblem(raw);
  if (problem) return fail(problem);
  const keys = Object.keys(raw);
  const expected = ['schemaVersion', 'messageId', 'hostInstanceId', 'origin', 'source', 'type', 'payload'];
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) {
    return fail('消息信封字段不符');
  }
  if (raw.schemaVersion !== SCENE_HOST_SCHEMA_VERSION) return fail('schemaVersion 不是 1');
  if (!isNonEmpty(raw.messageId) || !isNonEmpty(raw.hostInstanceId) || !isNonEmpty(raw.origin)) {
    return fail('信封标识为空');
  }
  if (raw.source !== 'console' && raw.source !== 'scene-host') return fail('source 非法');
  if (raw.origin !== ctx.allowedOrigin) return fail('origin 与允许的宿主源不一致');
  if (!HOST_MESSAGE_TYPES.includes(raw.type as HostMessageType)) return fail('未知消息类型');
  const type = raw.type as HostMessageType;
  if (type !== 'handshake' && !ctx.session) return fail('尚未完成实例握手');
  if (ctx.session && (raw.hostInstanceId !== ctx.session.hostInstanceId || raw.origin !== ctx.session.origin)) {
    return fail('hostInstanceId 或 origin 与握手不一致');
  }
  if (!isRecord(raw.payload)) return fail('payload 不是对象');
  const payload = parsePayload(type, raw.payload, raw.hostInstanceId, raw.origin);
  if (!payload.ok) return payload;
  const envelope: HostEnvelope = {
    schemaVersion: SCENE_HOST_SCHEMA_VERSION,
    messageId: raw.messageId,
    hostInstanceId: raw.hostInstanceId,
    origin: raw.origin,
    source: raw.source,
    type,
    payload: raw.payload as JsonValue,
  };
  const session: HostSession = ctx.session ?? {
    hostInstanceId: raw.hostInstanceId,
    origin: raw.origin,
    schemaVersion: SCENE_HOST_SCHEMA_VERSION,
  };
  return { ok: true, message: { type, envelope, payload: payload.value } as HostMessage, session };
}

function parsePayload(
  type: HostMessageType,
  payload: Record<string, unknown>,
  hostInstanceId: string,
  origin: string,
): { ok: true; value: never } | { ok: false; reason: string } {
  const extra = unexpected(payload, payloadKeys(type));
  if (extra) return fail(extra);
  switch (type) {
    case 'handshake':
    case 'handshakeAck': {
      if (payload.hostInstanceId !== hostInstanceId || payload.origin !== origin) {
        return fail('握手载荷与信封不一致');
      }
      if (type === 'handshakeAck' && payload.accepted !== true) return fail('handshakeAck 未被接受');
      return { ok: true, value: payload as never };
    }
    case 'lifecycle':
      if (!LIFECYCLE_OPS.includes(payload.op as LifecycleOp) || !isNonEmpty(payload.instanceId)) {
        return fail('lifecycle 载荷非法');
      }
      return { ok: true, value: payload as never };
    case 'readinessSample':
      if (!isNonEmpty(payload.instanceId) || !READINESS_GATES.includes(payload.gate as ReadinessGate)) {
        return fail('readiness 载荷非法');
      }
      if (!GATE_STATUS.has(payload.status as GateStatus)) return fail('readiness 状态非法');
      if (payload.observedAtShowTime !== undefined && !isFiniteNumber(payload.observedAtShowTime)) {
        return fail('observedAtShowTime 非法');
      }
      if (payload.detail !== undefined && typeof payload.detail !== 'string') return fail('detail 非法');
      return { ok: true, value: payload as never };
    case 'driftSample':
      if (!isNonEmpty(payload.sceneInstanceId)) return fail('drift 缺少场景');
      if (!isFiniteNumber(payload.programmeShowTime) || !isFiniteNumber(payload.adapterReportedTime)) {
        return fail('drift 时间非法');
      }
      return { ok: true, value: payload as never };
    case 'playbackReceipt':
      if (!isNonEmpty(payload.instanceId) || (payload.kind !== 'painted' && payload.kind !== 'failed')) {
        return fail('绘制回执载荷非法');
      }
      if (!isFiniteNumber(payload.showTime)) return fail('绘制回执时间非法');
      return { ok: true, value: payload as never };
    case 'protocolReject':
      if (!isNonEmpty(payload.code) || typeof payload.detail !== 'string') return fail('拒绝载荷非法');
      return { ok: true, value: payload as never };
    default:
      return fail('未知消息类型');
  }
}

function payloadKeys(type: HostMessageType): readonly string[] {
  switch (type) {
    case 'handshake':
      return ['hostInstanceId', 'origin'];
    case 'handshakeAck':
      return ['hostInstanceId', 'origin', 'accepted'];
    case 'lifecycle':
      return ['op', 'instanceId'];
    case 'readinessSample':
      return ['instanceId', 'gate', 'status', 'observedAtShowTime', 'detail'];
    case 'driftSample':
      return ['sceneInstanceId', 'programmeShowTime', 'adapterReportedTime'];
    case 'playbackReceipt':
      return ['instanceId', 'kind', 'showTime'];
    case 'protocolReject':
      return ['code', 'detail'];
    default:
      return [];
  }
}

function unexpected(payload: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      if (key === 'tolerance' || key === 'toleranceMs' || key === 'timeoutMs') {
        return `${key} 不能出现在消息里：超时和容限尚未冻结`;
      }
      return `payload 含未知字段 ${key}`;
    }
  }
  if ('timeoutMs' in payload || 'toleranceMs' in payload || 'tolerance' in payload) {
    return '超时或容限字段不能出现在消息里';
  }
  return null;
}

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** 供调用方对照：SDK 信号名不是四门闩。消息 schema 不把它们写成 readiness。 */
export const MESSAGE_SDK_SIGNALS: readonly SdkReadySignal[] = SDK_READY_SIGNALS;
