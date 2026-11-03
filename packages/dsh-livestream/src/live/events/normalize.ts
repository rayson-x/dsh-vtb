/**
 * 平台输入归一。计划 §2.3、§8.1。
 * 观众文本里的「我是 master」只归一成 master-claim，不签发控制权。
 */

import type { AudienceInputRecord } from '../domain/entities';

const AUDIENCE_KINDS = new Set<AudienceInputRecord['kind']>([
  'proposal',
  'silence',
  'debate',
  'opposition',
  'master-claim',
]);

const MASTER_CLAIM = /我是\s*master/i;

export interface RawPlatformInput {
  platform: string;
  externalId: string;
  audienceId: string;
  text: string;
  receivedAt: number;
  kindHint?: AudienceInputRecord['kind'];
  /**
   * 现场已经判定的急件。本骨架不跑模型做这个判断。
   * 自称为 master 的文本不会因为这个标记升级成控制消息。
   */
  urgent?: boolean;
}

export interface NormalizedInput {
  eventId: string;
  audienceId: string;
  text: string;
  kind: AudienceInputRecord['kind'];
  receivedAt: number;
  source: string;
  directionEpoch: number;
  urgent: boolean;
}

export function normalizeInput(raw: RawPlatformInput, directionEpoch: number): NormalizedInput {
  const platform = raw.platform.trim();
  const externalId = raw.externalId.trim();
  const audienceId = raw.audienceId.trim();
  if (!platform || !externalId || !audienceId) {
    throw new Error('平台、外部编号和观众编号都要有');
  }
  if (!Number.isFinite(raw.receivedAt)) throw new Error('receivedAt 不是有限数值');
  const text = raw.text.replace(/\s+/g, ' ').trim();
  let kind: AudienceInputRecord['kind'] = raw.kindHint && AUDIENCE_KINDS.has(raw.kindHint) ? raw.kindHint : 'proposal';
  if (!text) kind = 'silence';
  if (MASTER_CLAIM.test(text)) kind = 'master-claim';
  const urgent = raw.urgent === true && kind !== 'master-claim' && kind !== 'silence' && kind !== 'debate';
  return {
    eventId: `${platform}:${externalId}`,
    audienceId,
    text,
    kind,
    receivedAt: raw.receivedAt,
    source: platform,
    directionEpoch,
    urgent,
  };
}
