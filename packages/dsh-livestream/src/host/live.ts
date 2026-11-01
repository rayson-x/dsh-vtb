/**
 * 舞台和大脑之间的口子：控制台开讲、主人跟她说话、看她在干嘛。
 *
 * 舞台服务器只认这个接口；实现在 DSH 插件里（src/dsh/live.ts），直接用 DSH 进程内的服务建会话、发消息，
 * 不经过 DSH 的客户端。单独起舞台（lib/dev.js）时没有大脑，控制台上就显示「没接大脑」。
 */

import type { SessionSummary } from './sessions';

export interface LiveStatus {
  /** 有没有接上 DSH */
  brain: boolean;
  /** 她现在：没开场、在想或在做事、闲着 */
  agent: 'none' | 'busy' | 'idle';
  /** 这一场的方向（主人开播时定的） */
  direction?: string;
  /** 现在这一场的编号（数据存在这个场次下） */
  session?: string;
}

export interface LiveHost {
  status(): Promise<LiveStatus>;
  /** 开播：没有会话就建一个；direction 是这一场的方向（主题和风格），她在这个方向里跟弹幕聊、自己找话题 */
  start(direction?: string, audience?: AudienceChoice): Promise<string>;
  /** 主人说话：cut 为真时先让她闭嘴、插进这一轮，否则排到她下一轮 */
  say(text: string, cut: boolean): Promise<string>;
  /** 清空她的记忆重新开始：换新会话，聊过的话题、素材不要了；audience 为真时观众簿也清 */
  reset?(audience: boolean): Promise<string>;
  /** 开播前先设好：方向（节目牌跟着换）、观众数据；不叫大脑。开播时就按这个开场 */
  prepare?(direction?: string, audience?: AudienceChoice): string;
  /** 存下来的最近几场（开播前选「接着哪一场」用） */
  sessions?(): SessionSummary[];
}

/** 开播时观众数据（右栏弹幕、观众簿）怎么办：keep 保持现在的、fresh 开新的一场清空、或者某一场的编号（恢复那一场的） */
export type AudienceChoice = 'keep' | 'fresh' | (string & {});
