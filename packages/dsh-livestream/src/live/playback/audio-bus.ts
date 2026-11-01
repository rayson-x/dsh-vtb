/**
 * AudioBus 契约。计划 §7.2。
 * 只记录声道归属和调用方送来的媒体观察。不合成、不播放、不把字幕当成发声。
 * 人声速率不会在这里被改掉去追画面。漂移容限仍是 pending-p2。
 */

import type { RejectCode } from '../domain/codes';
import type { SceneInstance } from '../domain/entities';

export const BUS_LANES = ['voice', 'music', 'sfx'] as const;
export type BusLane = (typeof BUS_LANES)[number];
export type BusPlace = 'bus' | 'scene';

export interface BusClaim {
  lane: BusLane;
  place: BusPlace;
  surface: 'program' | 'preview';
  instanceId?: string;
}

export const MEDIA_OBSERVATIONS = ['playing', 'timeupdate', 'pause', 'ended', 'aborted'] as const;
export type MediaObservationKind = (typeof MEDIA_OBSERVATIONS)[number];

export interface MediaObservation {
  id: string;
  lane: BusLane;
  observation: MediaObservationKind;
  showTime: number;
  rate: number;
  partId?: string;
  audioRef?: string;
}

export function judgeClaim(
  input: { claims: readonly BusClaim[]; scenes: Readonly<Record<string, SceneInstance>> },
  request: BusClaim,
): { ok: true } | { ok: false; reject: RejectCode; message: string } {
  if (request.surface === 'preview') {
    return { ok: false, reject: 'PREVIEW_AUDIO_FORBIDDEN', message: '场景预览不发声' };
  }
  if (request.place === 'scene') {
    const scene = request.instanceId ? input.scenes[request.instanceId] : undefined;
    if (!scene) return { ok: false, reject: 'UNKNOWN_TARGET', message: '没有这个场景实例' };
    if (scene.surface !== 'program' || !scene.audioAllowed) {
      return { ok: false, reject: 'PREVIEW_AUDIO_FORBIDDEN', message: '备场或未确认在播的场景不能发声' };
    }
  }
  const conflict = input.claims.find((claim) => claim.lane === request.lane && claim.place !== request.place);
  if (conflict) {
    return { ok: false, reject: 'ILLEGAL_TRANSITION', message: '同一音轨不能在总线和场景里重复发声' };
  }
  return { ok: true };
}
