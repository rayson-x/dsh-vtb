/**
 * 计划 §9.3 的自动化负控。
 * 这里只判断「有人把不诚实的状态写进来」。
 * 不接播放器，不制造试播分钟数。
 *
 * 判定里的 fail 表示抓住了故障。
 * 判定里的 pass 表示这份声明和证据一致，负控不报警。
 * 矩阵行的 pass 另有含义：负控本身有效。不要把两者混成试播通过。
 */

export const NEGATIVE_CODES = [
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
] as const;
export type NegativeCode = (typeof NEGATIVE_CODES)[number];

export interface NegativeVerdict {
  status: 'pass' | 'fail';
  code: NegativeCode | 'CLEAN';
  detail: string;
}

export interface GhostCueClaim {
  cueId: string;
  claimed: 'future' | 'invalidated' | 'dispatched' | 'executed';
  bound: boolean;
  anchor?:
    | { kind: 'speech'; charIndex: number; spokenChars: number; speechState: string }
    | { kind: 'showTime'; due: boolean }
    | { kind: 'event'; eventSeen: boolean };
}

export interface AudioClaim {
  partId: string;
  markedPlaying: boolean;
  audioRef: string | null;
  mediaObservation: 'playing' | 'timeupdate' | 'pause' | 'ended' | 'aborted' | null;
  alignment: 'real' | 'estimated' | 'none';
  starts: readonly number[] | null;
}

export interface PaintClaim {
  sceneInstanceId: string;
  markedPainted: boolean;
  paintReceipt: { id: string; kind: 'painted' } | null;
}

export interface ExitClaim {
  instanceId: string;
  exitResult: 'success' | 'failed';
  recorded: 'success' | 'failed';
}

export interface CrossSegmentClaim {
  fromSegmentId: string;
  toSegmentId: string;
  claimedVoicedHandoff: boolean;
  boundaryObservation: AudioClaim['mediaObservation'];
}

export interface RemountClaim {
  instanceId: string;
  claimedInPlacePatch: boolean;
  generationBefore: number;
  generationAfter: number;
  reloaded: boolean;
}

export interface ArchiveClaim {
  claimedArchiveOk: boolean;
  mustRetainIds: readonly string[];
  retainedAfter: readonly string[];
}

export interface SamplingClaim {
  raw: readonly { t: number; ok: boolean }[];
  /** 被质疑的那份压缩报告所用的桶宽，不是产品阈值。 */
  bucketSpan: number;
  claimedDiscontinuity: boolean;
}

export interface PollClaim {
  reportedHealthy: boolean;
  pollOk: boolean;
  error: string | null;
}

function caught(code: NegativeCode, detail: string): NegativeVerdict {
  return { status: 'fail', code, detail };
}

function clean(detail: string): NegativeVerdict {
  return { status: 'pass', code: 'CLEAN', detail };
}

export function judgeGhostCue(claim: GhostCueClaim): NegativeVerdict {
  const fired = claim.claimed === 'dispatched' || claim.claimed === 'executed';
  if (!fired) return clean(`${claim.cueId} 没有被标成已派发或已执行`);
  if (!claim.bound || !claim.anchor) {
    return caught('GHOST_CUE', `${claim.cueId} 未绑定却标成 ${claim.claimed}`);
  }
  if (claim.anchor.kind === 'speech') {
    const spoken = claim.anchor.speechState === 'playing' || claim.anchor.speechState === 'ended';
    if (!spoken || claim.anchor.charIndex >= claim.anchor.spokenChars) {
      return caught('GHOST_CUE', `${claim.cueId} 锚在未念字上却标成 ${claim.claimed}`);
    }
  }
  if (claim.anchor.kind === 'showTime' && !claim.anchor.due) {
    return caught('GHOST_CUE', `${claim.cueId} 节目时间未到却标成 ${claim.claimed}`);
  }
  if (claim.anchor.kind === 'event' && !claim.anchor.eventSeen) {
    return caught('GHOST_CUE', `${claim.cueId} 事件未出现却标成 ${claim.claimed}`);
  }
  return clean(`${claim.cueId} 的派发有绑定和已到达锚点`);
}

export function judgeAudio(claim: AudioClaim): NegativeVerdict {
  if (claim.markedPlaying && (claim.audioRef == null || claim.audioRef === '' || claim.mediaObservation == null)) {
    return caught('MISSING_AUDIO', `${claim.partId} 标成 playing，但没有 audioRef 或媒体观察`);
  }
  if (claim.alignment === 'real' && (claim.starts == null || claim.starts.length === 0)) {
    return caught('MISSING_REAL_STARTS', `${claim.partId} 标成 real，但没有逐字 starts`);
  }
  return clean(`${claim.partId} 的口播标记和音频证据一致`);
}

export function judgePaint(claim: PaintClaim): NegativeVerdict {
  const receipt = claim.paintReceipt;
  if (claim.markedPainted && (receipt == null || receipt.kind !== 'painted' || receipt.id === '')) {
    return caught('PAINTED_WITHOUT_RECEIPT', `${claim.sceneInstanceId} 标成 painted，但没有 paintReceipt`);
  }
  return clean(`${claim.sceneInstanceId} 的绘制标记和回执一致`);
}

export function judgeExit(claim: ExitClaim): NegativeVerdict {
  if (claim.exitResult === 'failed' && claim.recorded === 'success') {
    return caught('FAILED_EXIT_AS_SUCCESS', `${claim.instanceId} 退出失败却记成成功`);
  }
  return clean(`${claim.instanceId} 的退出记录和结果一致`);
}

export function judgeCrossSegment(claim: CrossSegmentClaim): NegativeVerdict {
  if (claim.claimedVoicedHandoff && claim.boundaryObservation == null) {
    return caught('SILENT_CROSS_SEGMENT', `${claim.fromSegmentId} 到 ${claim.toSegmentId} 声称有声衔接，边界没有媒体观察`);
  }
  return clean('跨段声明和边界上的媒体观察一致');
}

export function judgeRemount(claim: RemountClaim): NegativeVerdict {
  const generationChanged = claim.generationAfter !== claim.generationBefore;
  if (claim.claimedInPlacePatch && (claim.reloaded || generationChanged)) {
    return caught('INPUT_REMOUNT', `${claim.instanceId} 输入更新换了实例或重载，却标成原地 patch`);
  }
  return clean(`${claim.instanceId} 的输入更新声明和实例代数一致`);
}

export function judgeArchive(claim: ArchiveClaim): NegativeVerdict {
  if (!claim.claimedArchiveOk) return clean('归档没有被标成成功');
  const kept = new Set(claim.retainedAfter);
  const dropped = claim.mustRetainIds.filter((id) => !kept.has(id));
  if (claim.mustRetainIds.length > 0 && claim.retainedAfter.length === 0) {
    return caught('EMPTY_LEGAL_REMAINDER', `应留下 ${claim.mustRetainIds.join('、')}，归档后剩余为空却标成功`);
  }
  if (dropped.length > 0) {
    return caught('EMPTY_LEGAL_REMAINDER', `应留下 ${dropped.join('、')}，剩余里没有`);
  }
  return clean('依法应留下的口播仍在');
}

export function judgeSampling(claim: SamplingClaim): NegativeVerdict {
  if (!claim.claimedDiscontinuity) return clean('报告没有声称断档');
  const raw = [...claim.raw].sort((left, right) => left.t - right.t);
  if (raw.some((sample) => !sample.ok)) return clean('原始样本里有失败点，断档声明不按压缩假象处理');
  let maxStep = 0;
  for (let index = 1; index < raw.length; index += 1) {
    maxStep = Math.max(maxStep, raw[index]!.t - raw[index - 1]!.t);
  }
  if (raw.length >= 2 && maxStep <= claim.bucketSpan) {
    return caught('DOWNSAMPLED_FALSE_GAP', '原始样本连续且都正常，压缩后的断档是假的');
  }
  if (raw.length < 2) {
    return caught('DOWNSAMPLED_FALSE_GAP', '没有足够原始样本却声称断档');
  }
  return clean('原始序列本身有间隔，不断成压缩假断档');
}

export function judgePoll(claim: PollClaim): NegativeVerdict {
  if (!claim.pollOk && claim.reportedHealthy) {
    const suffix = claim.error ? `：${claim.error}` : '';
    return caught('SWALLOWED_POLL_ERROR', `poll 失败被写成健康${suffix}`);
  }
  return clean('poll 结果和健康标记一致');
}

export interface NegativeRun {
  id: string;
  rowId: string;
  code: NegativeCode;
  scene: string;
  mustProve: string;
  injection: NegativeVerdict;
  clean: NegativeVerdict;
  effective: boolean;
}

function evaluate(
  id: string,
  rowId: string,
  code: NegativeCode,
  scene: string,
  mustProve: string,
  injection: NegativeVerdict,
  cleanVerdict: NegativeVerdict,
): NegativeRun {
  const effective = injection.status === 'fail' && injection.code === code && cleanVerdict.status === 'pass';
  return { id, rowId, code, scene, mustProve, injection, clean: cleanVerdict, effective };
}

/** 固定注入。改判定函数会让 effective 变成 false，对应矩阵行变成 fail。 */
export function runNegativeSuite(): NegativeRun[] {
  return [
    evaluate(
      'ghost-cue',
      'neg-ghost-cue',
      'GHOST_CUE',
      '幽灵 cue 负控',
      '未绑定，或锚在未念字上，却标成 dispatched / executed 时，harness 必须 fail。',
      judgeGhostCue({ cueId: 'ghost-1', claimed: 'executed', bound: false }),
      judgeGhostCue({
        cueId: 'heard',
        claimed: 'executed',
        bound: true,
        anchor: { kind: 'speech', charIndex: 0, spokenChars: 2, speechState: 'playing' },
      }),
    ),
    evaluate(
      'missing-audio',
      'neg-missing-audio',
      'MISSING_AUDIO',
      '缺真实 audio 却标 playing',
      '没有 audioRef 或媒体观察，却把口播标成 playing 时，harness 必须 fail。',
      judgeAudio({
        partId: 'line-ghost-audio',
        markedPlaying: true,
        audioRef: null,
        mediaObservation: null,
        alignment: 'none',
        starts: null,
      }),
      judgeAudio({
        partId: 'line-estimated',
        markedPlaying: true,
        audioRef: 'clip-estimated',
        mediaObservation: 'playing',
        alignment: 'estimated',
        starts: null,
      }),
    ),
    evaluate(
      'missing-real-starts',
      'neg-missing-real-starts',
      'MISSING_REAL_STARTS',
      '缺真实 starts 却标 real',
      'alignment 标成 real，但没有逐字 starts 时，harness 必须 fail。',
      judgeAudio({
        partId: 'line-fake-real',
        markedPlaying: true,
        audioRef: 'clip-real',
        mediaObservation: 'playing',
        alignment: 'real',
        starts: null,
      }),
      judgeAudio({
        partId: 'line-real',
        markedPlaying: true,
        audioRef: 'clip-real',
        mediaObservation: 'playing',
        alignment: 'real',
        starts: [0, 80],
      }),
    ),
    evaluate(
      'failed-exit',
      'neg-failed-exit',
      'FAILED_EXIT_AS_SUCCESS',
      '失败 exit 记成成功',
      '退出失败却记成 success 时，harness 必须 fail。',
      judgeExit({ instanceId: 'scene-a', exitResult: 'failed', recorded: 'success' }),
      judgeExit({ instanceId: 'scene-a', exitResult: 'failed', recorded: 'failed' }),
    ),
    evaluate(
      'silent-cross-segment',
      'neg-silent-cross-segment',
      'SILENT_CROSS_SEGMENT',
      '无声跨段',
      '声称有声衔接，但段边界没有媒体观察时，harness 必须 fail。',
      judgeCrossSegment({
        fromSegmentId: 'seg-a',
        toSegmentId: 'seg-b',
        claimedVoicedHandoff: true,
        boundaryObservation: null,
      }),
      judgeCrossSegment({
        fromSegmentId: 'seg-a',
        toSegmentId: 'seg-b',
        claimedVoicedHandoff: false,
        boundaryObservation: null,
      }),
    ),
    evaluate(
      'input-remount',
      'neg-input-remount',
      'INPUT_REMOUNT',
      '输入触发重挂',
      '输入更新换了实例代数或重载，却标成原地 patch 时，harness 必须 fail。',
      judgeRemount({
        instanceId: 'scene-a',
        claimedInPlacePatch: true,
        generationBefore: 1,
        generationAfter: 2,
        reloaded: true,
      }),
      judgeRemount({
        instanceId: 'scene-a',
        claimedInPlacePatch: true,
        generationBefore: 1,
        generationAfter: 1,
        reloaded: false,
      }),
    ),
    evaluate(
      'empty-legal-remainder',
      'neg-empty-legal-remainder',
      'EMPTY_LEGAL_REMAINDER',
      '空剩余合法归档',
      '未执行锚点仍引用的口播被归档空，却标成归档成功时，harness 必须 fail。',
      judgeArchive({
        claimedArchiveOk: true,
        mustRetainIds: ['pinned-speech'],
        retainedAfter: [],
      }),
      judgeArchive({
        claimedArchiveOk: true,
        mustRetainIds: ['pinned-speech'],
        retainedAfter: ['pinned-speech'],
      }),
    ),
    evaluate(
      'downsampled-false-gap',
      'neg-downsampled-false-gap',
      'DOWNSAMPLED_FALSE_GAP',
      '压缩采样假断档',
      '原始样本连续且正常，压缩报告却声称断档时，harness 必须 fail。',
      judgeSampling({
        raw: [
          { t: 0, ok: true },
          { t: 1, ok: true },
          { t: 2, ok: true },
        ],
        bucketSpan: 2,
        claimedDiscontinuity: true,
      }),
      judgeSampling({
        raw: [
          { t: 0, ok: true },
          { t: 10, ok: true },
        ],
        bucketSpan: 2,
        claimedDiscontinuity: true,
      }),
    ),
    evaluate(
      'swallowed-poll',
      'neg-swallowed-poll',
      'SWALLOWED_POLL_ERROR',
      '真实 poll 错误被吞',
      'poll 失败却把健康标记写成真时，harness 必须 fail。',
      judgePoll({ reportedHealthy: true, pollOk: false, error: 'platform-down' }),
      judgePoll({ reportedHealthy: false, pollOk: false, error: 'platform-down' }),
    ),
    evaluate(
      'painted-without-receipt',
      'neg-painted-without-receipt',
      'PAINTED_WITHOUT_RECEIPT',
      '无 paintReceipt 却标 painted',
      '没有 paintReceipt，却把场景标成 painted 时，harness 必须 fail。',
      judgePaint({ sceneInstanceId: 'scene-a', markedPainted: true, paintReceipt: null }),
      judgePaint({
        sceneInstanceId: 'scene-a',
        markedPainted: true,
        paintReceipt: { id: 'paint-1', kind: 'painted' },
      }),
    ),
  ];
}
