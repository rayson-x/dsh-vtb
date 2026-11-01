/**
 * 旧控制台入口到 v2 CommandEnvelope 的薄适配。
 * 只映射几条常见命令。映射结果是意图，不是播放回执。
 * 无法映射的返回 unsupported，不静默丢掉。
 * 旧 draw/graphic 不映射成 v2 的画面路径，避免变成新创作能力的上限。
 * 每段装饰、主持人覆盖所有车道、空闲强填词、未提交草稿都不引回。计划 §11。
 */

import type { CommandEnvelope } from '../domain/commands';
import { FIXTURE_ACTORS } from '../domain/index';
import { normalizeInput } from '../events/normalize';

export type LegacyEntryCommand =
  | { type: 'say'; id: string; text: string; ms?: number; audio?: string }
  | { type: 'enqueue'; id: string; text: string }
  | { type: 'danmaku'; platform: string; user: string; text: string; id?: string; at?: number }
  | { type: 'scene'; scene: string; cut?: 'soft' | 'hard' }
  | { type: 'graphic'; name: string; fields?: Record<string, string | number> }
  | { type: 'draw'; id: string; kind?: string; text: string }
  | { type: 'interrupt'; soft?: boolean }
  | { type: 'decorate-every-segment'; text?: string }
  | { type: 'cover-all-lanes' }
  | { type: 'idle-filler'; text?: string }
  | { type: 'publish-draft'; draftId: string };

export interface AdaptContext {
  showId: string;
  directionEpoch: number;
  /** 目标聚合的当前 revision。新口播是 0，节目是工程里的 show revision。 */
  expectedRevision: number;
  receivedAt: number;
  commandId: string;
}

export type AdaptResult =
  | { ok: true; commandType: string; envelope: CommandEnvelope }
  | { ok: false; code: 'unsupported'; commandType: string; reason: string };

const UNSUPPORTED: Record<string, string> = {
  graphic: '旧 graphic 不是 v2 的创作上限。本骨架不把它映射成画面命令。',
  draw: '旧 draw 不是 v2 的创作上限。本骨架不把它映射成画面命令。',
  scene: '旧 scene/cut 不是方向切换授权，也不映射成 take。',
  interrupt: '旧 interrupt 不映射成 abortSpeech。',
  'decorate-every-segment': '每段装饰不能重新引回。',
  'cover-all-lanes': '主持人覆盖所有车道不能重新引回。',
  'idle-filler': '空闲强填词不能重新引回。',
  'publish-draft': '旧未提交草稿不自动发布。',
};

export function adaptLegacyCommand(command: LegacyEntryCommand | { type: string }, ctx: AdaptContext): AdaptResult {
  const commandType = typeof command.type === 'string' ? command.type.trim() : '';
  if (!commandType) return unsupported('(empty)', '缺少命令类型，不会静默丢掉。');
  if (!ctx.commandId.trim()) return unsupported(commandType, '缺少 commandId，不会静默丢掉。');
  if (!Number.isFinite(ctx.directionEpoch) || !Number.isFinite(ctx.expectedRevision)) {
    return unsupported(commandType, 'epoch 或 revision 不是有限数值。');
  }

  switch (command.type) {
    case 'say':
    case 'enqueue':
      return adaptSpeech(command, ctx);
    case 'danmaku':
      return adaptDanmaku(command, ctx);
    case 'graphic':
    case 'draw':
    case 'scene':
    case 'interrupt':
    case 'decorate-every-segment':
    case 'cover-all-lanes':
    case 'idle-filler':
    case 'publish-draft':
      return unsupported(command.type, UNSUPPORTED[command.type]!);
    default:
      return unsupported(commandType, `旧入口 ${commandType} 没有 v2 映射，不会静默丢掉。`);
  }
}

function adaptSpeech(command: { type: string; id?: unknown; text?: unknown }, ctx: AdaptContext): AdaptResult {
  if (command.type !== 'say' && command.type !== 'enqueue') {
    return unsupported(command.type, `旧入口 ${command.type} 没有 v2 映射，不会静默丢掉。`);
  }
  if (typeof command.id !== 'string' || typeof command.text !== 'string') {
    return unsupported(command.type, '口播命令缺少编号或文本。');
  }
  const partId = command.id.trim();
  const text = command.text.replace(/\s+/g, ' ').trim();
  if (!partId) return unsupported(command.type, '缺少口播编号。');
  if (!text) return unsupported(command.type, '口播文本是空的，不映射成空 offer。');
  return {
    ok: true,
    commandType: command.type,
    envelope: {
      commandId: ctx.commandId,
      idempotencyKey: ctx.commandId,
      actorId: FIXTURE_ACTORS.performer,
      directionEpoch: ctx.directionEpoch,
      expectedRevision: ctx.expectedRevision,
      target: { kind: 'speechPart', id: partId },
      payload: { type: 'offerSpeech', partId, text },
    },
  };
}

function adaptDanmaku(command: { type: string; platform?: unknown; user?: unknown; text?: unknown; id?: unknown; at?: unknown }, ctx: AdaptContext): AdaptResult {
  if (command.type !== 'danmaku') return unsupported(command.type, `旧入口 ${command.type} 没有 v2 映射，不会静默丢掉。`);
  if (typeof command.platform !== 'string' || typeof command.user !== 'string' || typeof command.text !== 'string') {
    return unsupported('danmaku', '弹幕缺少平台、观众或文本。');
  }
  if (command.id !== undefined && typeof command.id !== 'string') return unsupported('danmaku', '弹幕编号不是字符串。');
  if (command.at !== undefined && typeof command.at !== 'number') return unsupported('danmaku', '弹幕时间不是数值。');
  const platform = command.platform;
  const user = command.user;
  const text = command.text;
  const id = command.id;
  const at = command.at;
  if (!ctx.showId.trim()) return unsupported('danmaku', '缺少节目编号。');
  if (!Number.isFinite(ctx.receivedAt)) return unsupported('danmaku', 'receivedAt 不是有限数值。');
  const externalId = id?.trim() || `legacy:${user}:${ctx.receivedAt}`;
  try {
    const normalized = normalizeInput(
      {
        platform,
        externalId,
        audienceId: user,
        text,
        receivedAt: at ?? ctx.receivedAt,
      },
      ctx.directionEpoch,
    );
    return {
      ok: true,
      commandType: 'danmaku',
      envelope: {
        commandId: ctx.commandId,
        idempotencyKey: ctx.commandId,
        actorId: FIXTURE_ACTORS.input,
        directionEpoch: ctx.directionEpoch,
        expectedRevision: ctx.expectedRevision,
        target: { kind: 'show', id: ctx.showId },
        payload: {
          type: 'ingestAudience',
          eventId: normalized.eventId,
          audienceId: normalized.audienceId,
          text: normalized.text,
          kind: normalized.kind,
        },
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : '弹幕无法归一';
    return unsupported('danmaku', reason);
  }
}

function unsupported(commandType: string, reason: string): AdaptResult {
  return { ok: false, code: 'unsupported', commandType, reason };
}
