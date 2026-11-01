/**
 * 抖音 webcast 推送帧解码。
 *
 * 帧结构：PushFrame →（gzip）→ Response → Message[] → 具体消息体。
 * 字段号对照 DouyinLiveWebFetcher 的 protobuf/douyin.proto，只声明接入要用的字段。
 */

import { gunzipSync } from 'node:zlib';
import Long from 'long';
import protobuf from 'protobufjs';

protobuf.util.Long = Long;
protobuf.configure();

const SCHEMA = `
syntax = "proto3";
message PushFrame {
  uint64 seqId = 1;
  uint64 logId = 2;
  uint64 service = 3;
  uint64 method = 4;
  repeated HeadersList headersList = 5;
  string payloadEncoding = 6;
  string payloadType = 7;
  bytes payload = 8;
}
message HeadersList { string key = 1; string value = 2; }
message Response {
  repeated Message messagesList = 1;
  string cursor = 2;
  uint64 fetchInterval = 3;
  uint64 now = 4;
  string internalExt = 5;
  uint32 fetchType = 6;
  uint64 heartbeatDuration = 8;
  bool needAck = 9;
  string pushServer = 10;
  string liveCursor = 11;
}
message Message {
  string method = 1;
  bytes payload = 2;
  int64 msgId = 3;
  int32 msgType = 4;
}
message ChatMessage {
  Common common = 1;
  User user = 2;
  string content = 3;
}
message GiftMessage {
  Common common = 1;
  uint64 giftId = 2;
  uint64 groupCount = 4;
  uint64 repeatCount = 5;
  uint64 comboCount = 6;
  User user = 7;
  uint32 repeatEnd = 9;
  uint64 groupId = 11;
  GiftStruct gift = 15;
  uint64 sendType = 17;
  string traceId = 35;
}
message GiftStruct {
  Image image = 1;
  uint64 id = 5;
  bool combo = 10;
  uint32 diamondCount = 12;
  string name = 16;
  Image icon = 21;
}
message MemberMessage {
  Common common = 1;
  User user = 2;
  uint64 memberCount = 3;
}
message LikeMessage {
  Common common = 1;
  uint64 count = 2;
  uint64 total = 3;
  User user = 5;
}
message SocialMessage {
  Common common = 1;
  User user = 2;
  uint64 shareType = 3;
  uint64 action = 4;
  string shareTarget = 5;
}
message RoomUserSeqMessage {
  Common common = 1;
  int64 total = 3;
  int64 popularity = 6;
  int64 totalUser = 7;
  string totalStr = 9;
  string onlineUserForAnchor = 10;
}
message Common {
  string method = 1;
  uint64 msgId = 2;
  uint64 roomId = 3;
  uint64 createTime = 4;
}
message User {
  uint64 id = 1;
  uint64 shortId = 2;
  string nickName = 3;
  Image avatarThumb = 9;
  PayGrade payGrade = 23;
  FansClub fansClub = 24;
  string displayId = 38;
  string secUid = 46;
  string idStr = 1029;
}
message PayGrade {
  int64 level = 6;
}
message FansClub {
  FansClubData data = 1;
  map<int32, FansClubData> preferData = 2;
}
message FansClubData {
  string clubName = 1;
  int32 level = 2;
  int32 userFansClubStatus = 3;
  UserBadge badge = 4;
  int64 anchorId = 6;
}
message UserBadge {
  string title = 2;
}
message Image {
  repeated string urlList = 1;
}
`;

const root = protobuf.parse(SCHEMA).root;

function lookup(name: string): protobuf.Type {
  return root.lookupType(name);
}

export const MESSAGE_TYPES: Record<string, string> = {
  WebcastChatMessage: 'ChatMessage',
  WebcastGiftMessage: 'GiftMessage',
  WebcastMemberMessage: 'MemberMessage',
  WebcastLikeMessage: 'LikeMessage',
  WebcastSocialMessage: 'SocialMessage',
  WebcastRoomUserSeqMessage: 'RoomUserSeqMessage',
};

export interface RawFrame {
  logId: string;
  payloadType: string;
  needAck: boolean;
  internalExt: string;
  messages: RawMessage[];
}

export interface RawMessage {
  method: string;
  msgId: string;
  payload: Uint8Array;
}

function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object' && v && 'toString' in v) {
    const s = (v as { toString(): string }).toString();
    return s === '[object Object]' ? '' : s;
  }
  return String(v);
}

function headerMap(list: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!Array.isArray(list)) return headers;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { key?: unknown; value?: unknown };
    if (row.key) headers[String(row.key)] = String(row.value ?? '');
  }
  return headers;
}

function ungzip(buf: Uint8Array, headers: Record<string, string>, encoding: string): Uint8Array {
  const hinted = headers.compress_type === 'gzip' || encoding === 'gzip';
  const magic = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  if (!hinted && !magic) return buf;
  try {
    return gunzipSync(buf);
  } catch {
    return buf;
  }
}

/** 解码一帧。心跳帧没有消息；需要 ack 时把 needAck 和 internalExt 带回去。 */
export function decodeFrame(buf: Uint8Array): RawFrame {
  const frame = lookup('PushFrame').decode(buf) as protobuf.Message & {
    logId?: unknown;
    payloadType?: unknown;
    payloadEncoding?: unknown;
    payload?: Uint8Array;
    headersList?: unknown;
  };
  const headers = headerMap(frame.headersList);
  const payloadType = String(frame.payloadType ?? '');
  const payload = ungzip(frame.payload ?? new Uint8Array(0), headers, String(frame.payloadEncoding ?? ''));
  const messages: RawMessage[] = [];
  let needAck = false;
  let internalExt = '';
  if (payloadType === 'msg' || payloadType === 'push') {
    try {
      const resp = lookup('Response').decode(payload) as protobuf.Message & {
        needAck?: unknown;
        internalExt?: unknown;
        messagesList?: Array<{ method?: unknown; payload?: Uint8Array; msgId?: unknown }>;
      };
      needAck = Boolean(resp.needAck);
      internalExt = String(resp.internalExt ?? '');
      for (const m of resp.messagesList ?? []) {
        if (!m.method) continue;
        messages.push({
          method: String(m.method),
          msgId: asText(m.msgId),
          payload: m.payload ?? new Uint8Array(0),
        });
      }
    } catch {
      // ack / 心跳之外的杂帧
    }
  }
  return { logId: asText(frame.logId), payloadType, needAck, internalExt, messages };
}

export function decodeBody(method: string, payload: Uint8Array): protobuf.Message | null {
  const typeName = MESSAGE_TYPES[method];
  if (!typeName) return null;
  try {
    return lookup(typeName).decode(payload);
  } catch {
    return null;
  }
}

/** 解码后再转成普通对象（64 位整数用十进制字符串），方便落 fixture、打日志。 */
export function toPlainBody(method: string, payload: Uint8Array): Record<string, unknown> | null {
  const typeName = MESSAGE_TYPES[method];
  const body = decodeBody(method, payload);
  if (!typeName || !body) return null;
  return lookup(typeName).toObject(body, {
    longs: String,
    enums: String,
    bytes: String,
    defaults: false,
  }) as Record<string, unknown>;
}

/** 心跳和 ack 都是一条 PushFrame。 */
export function encodePushFrame(fields: { logId?: string; payloadType: string; payload?: Uint8Array }): Uint8Array {
  const message: Record<string, unknown> = { payloadType: fields.payloadType };
  if (fields.logId) message.logId = Long.fromString(fields.logId, true);
  if (fields.payload) message.payload = fields.payload;
  return lookup('PushFrame').encode(message).finish();
}
