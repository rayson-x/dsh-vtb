/**
 * 布景（set）：直播间的一整套样子和戏法——房间、组件图、配色（sets/<id>/set.css）、环境氛围、底噪、转场，
 * 以及**这个布景配套的特效**。节目方向随便换，布景跟着氛围换；画布元素在每个布景里都能用。
 *
 * 特效由舞台页的几种基础效果（Prim）组合出来：闪白、骤暗、心跳暗角、震、雪花、起雾、粒子爆发、光扫、染色。
 * 每个布景用它们拼出自己的招牌特效，配上声音。她写 [[fx 名字]]，念到那个字时演一次。
 *
 * 这里是纯数据（舞台页、校验、给她的说明都从这里读），素材在 sets/<id>/。
 */

/** 基础效果：舞台页 src/page/SetFx.tsx 实现 */
export type Prim =
  | { prim: 'flash'; times?: number; color?: string }           // 闪白（或闪别的颜色）几下
  | { prim: 'dark'; level?: number; hold?: number }              // 画面骤暗，只留人物周围一圈，慢慢亮回来
  | { prim: 'pulse'; times?: number; color?: string }            // 暗角随心跳收缩几下
  | { prim: 'shake'; strength?: number }                         // 整个画面震一下
  | { prim: 'static' }                                           // 电视雪花、画面扭一下
  | { prim: 'fog'; color?: string }                              // 边缘起雾，慢慢散
  | { prim: 'burst'; particle: 'bubble' | 'spark' | 'petal' | 'ember'; count?: number } // 粒子从下往上涌
  | { prim: 'sweep'; color?: string }                            // 一道光从左扫到右
  | { prim: 'tint'; color: string };                             // 整个画面染一层色，慢慢退

export interface SetEffect {
  zh: string;
  /** 给她看：什么时候用 */
  use: string;
  /** 依次演的基础效果，at 是相对开始的毫秒 */
  steps: (Prim & { at?: number; ms?: number })[];
  /** 声音：sets/<id>/sfx/ 下的文件（几个就轮着放），at 对齐画面的落点 */
  sound?: { files: string[]; at?: number; volume?: number };
}

export type AmbientKind = 'rain' | 'dust' | 'bubbles' | 'flicker' | 'rays';

export interface SetDef {
  id: string;
  name: string;
  /** 一句话气质（给她和主人挑） */
  mood: string;
  /** 适合什么样的节目（氛围，不是话题） */
  fits: string;
  /** 会一直动的环境 */
  ambient: { kind: AmbientKind; amount?: number }[];
  /** 环境底噪：sets/<id>/sfx/bed.mp3 */
  bed?: { volume: number };
  /** 切进这个布景时的转场 */
  transition: 'fade-black' | 'flash' | 'wipe' | 'static';
  /** 通用动作的音效换成这个布景的（家族名 → sets/<id>/sfx/ 下的文件），没写的用默认 */
  sounds?: Record<string, string[]>;
  effects: Record<string, SetEffect>;
}

export const SETS: Record<string, SetDef> = {
  'ocean-study': {
    id: 'ocean-study',
    name: '海底小书房',
    mood: '明亮、可爱、暖',
    fits: '默认；知识、闲聊、轻松的节目',
    ambient: [{ kind: 'bubbles', amount: 18 }, { kind: 'rays' }],
    bed: { volume: 0.06 },
    transition: 'wipe',
    effects: {
      bubbles: { zh: '气泡涌', use: '开心、起哄、有好事', steps: [{ prim: 'burst', particle: 'bubble', count: 40, ms: 2600 }], sound: { files: ['bubbles.mp3'] } },
      shine: { zh: '光柱扫过', use: '「找到了」「原来如此」的那一下', steps: [{ prim: 'sweep', color: 'rgba(255, 251, 225, 0.75)', ms: 1400 }], sound: { files: ['shine.mp3'] } },
      splash: { zh: '水花', use: '吓一跳、反转', steps: [{ prim: 'shake', strength: 1, ms: 380 }, { prim: 'flash', color: 'rgba(200, 240, 255, 0.7)', times: 1, ms: 650 }, { prim: 'burst', particle: 'bubble', count: 18, ms: 1600, at: 0 }], sound: { files: ['splash.mp3'] } },
      sparkle: { zh: '闪闪发光', use: '夸人、好消息、礼物', steps: [{ prim: 'burst', particle: 'spark', count: 30, ms: 2000 }], sound: { files: ['sparkle.mp3'] } },
    },
  },
  'midnight-tales': {
    id: 'midnight-tales',
    name: '深夜怪谈',
    mood: '暗、慢、下着雨，只有一盏灯',
    fits: '讲故事、悬疑、怪谈、深夜聊天',
    ambient: [{ kind: 'rain', amount: 70 }, { kind: 'dust', amount: 24 }, { kind: 'flicker' }],
    bed: { volume: 0.14 },
    transition: 'fade-black',
    sounds: { hit: ['hit-low.mp3'], whoosh: ['whoosh-dark.mp3'], mallet: ['bell-low.mp3'], pop: ['tick.mp3'] },
    effects: {
      thunder: { zh: '打雷', use: '故事里关键的一句、真相揭开前', steps: [{ prim: 'flash', times: 2, color: '#dfe8ff', ms: 1000 }, { prim: 'shake', strength: 0.7, at: 500, ms: 450 }], sound: { files: ['thunder.mp3'], at: 380 } },
      blackout: { zh: '灯灭', use: '「然后……灯灭了」、停下来让观众屏住呼吸', steps: [{ prim: 'dark', level: 0.88, hold: 1800, ms: 3200 }], sound: { files: ['blackout.mp3'] } },
      flicker: { zh: '灯闪', use: '不对劲的细节、气氛开始变的时候', steps: [{ prim: 'dark', level: 0.75, hold: 500, ms: 800 }, { prim: 'dark', level: 0.85, hold: 260, ms: 600, at: 900 }, { prim: 'dark', level: 0.7, hold: 250, ms: 600, at: 1600 }], sound: { files: ['flicker.mp3'] } },
      static: { zh: '雪花干扰', use: '「信号断了」、记忆错乱、不该出现的东西', steps: [{ prim: 'static', ms: 900 }], sound: { files: ['static.mp3'] } },
      heartbeat: { zh: '心跳', use: '紧张、快要揭晓、观众在猜的时候', steps: [{ prim: 'pulse', times: 4, color: 'rgba(120, 0, 8, 0.9)', ms: 3200 }], sound: { files: ['heartbeat.mp3'] } },
      knock: { zh: '敲门', use: '「这时候，有人敲门」', steps: [{ prim: 'shake', strength: 0.6, ms: 360 }, { prim: 'shake', strength: 0.6, ms: 360, at: 420 }, { prim: 'shake', strength: 0.65, ms: 360, at: 840 }], sound: { files: ['knock.mp3'] } },
      chill: { zh: '寒气', use: '后背一凉、细思极恐的那一下', steps: [{ prim: 'fog', color: 'rgba(190, 215, 240, 0.85)', ms: 3600 }, { prim: 'tint', color: 'rgba(60, 120, 180, 0.35)', ms: 3600 }], sound: { files: ['chill.mp3'] } },
      candle: { zh: '烛光一晃', use: '轻轻的转折、换下一个故事', steps: [{ prim: 'tint', color: 'rgba(224, 180, 90, 0.18)', ms: 1600 }, { prim: 'burst', particle: 'ember', count: 14, ms: 1800 }], sound: { files: ['candle.mp3'] } },
    },
  },
};

export const DEFAULT_SET = 'ocean-study';

/**
 * 基础特效：每个布景都能直接用（[[fx prim:flash]]），参数用默认值。布景的招牌特效是它们的组合。
 * 新增一种基础效果 = 在这里加一条 + 在 src/page/SetFx.tsx 的 Step 里画出来。
 */
export const PRIMS: Record<Prim['prim'], SetEffect> = {
  flash: { zh: '闪白', use: '', steps: [{ prim: 'flash', times: 2, ms: 900 }] },
  dark: { zh: '骤暗', use: '', steps: [{ prim: 'dark', level: 0.85, ms: 2600 }] },
  pulse: { zh: '心跳暗角', use: '', steps: [{ prim: 'pulse', times: 3, color: 'rgba(120, 0, 8, 0.9)', ms: 2400 }] },
  shake: { zh: '震', use: '', steps: [{ prim: 'shake', strength: 0.8, ms: 500 }] },
  static: { zh: '雪花', use: '', steps: [{ prim: 'static', ms: 900 }] },
  fog: { zh: '起雾', use: '', steps: [{ prim: 'fog', color: 'rgba(200, 220, 240, 0.85)', ms: 3000 }] },
  burst: { zh: '粒子涌', use: '', steps: [{ prim: 'burst', particle: 'spark', count: 60, ms: 2400 }] },
  sweep: { zh: '光扫', use: '', steps: [{ prim: 'sweep', color: 'rgba(255, 251, 225, 0.75)', ms: 1400 }] },
  tint: { zh: '染色', use: '', steps: [{ prim: 'tint', color: 'rgba(60, 120, 180, 0.35)', ms: 2400 }] },
};

/** 名字 → 特效：布景自己的，或者 prim:基础效果 */
export function effectOf(set: string, name: string): SetEffect | undefined {
  if (name.startsWith('prim:')) return PRIMS[name.slice(5) as Prim['prim']];
  return SETS[set]?.effects[name];
}
export const SET_IDS = Object.keys(SETS);

/** 她两次换布景至少隔这么久 */
export const SET_GAP_MS = 180_000;
/** 同一个特效连着放至少隔这么久 */
export const FX_GAP_MS = 4_000;

/** 特效演多久（最后一步结束） */
export function effectMs(e: SetEffect): number {
  return Math.max(...e.steps.map((s) => (s.at ?? 0) + (s.ms ?? 800)));
}

/** 给她看：现在的布景和它的特效、能换的布景 */
export function setHelp(current: string): string {
  const cur = SETS[current] ?? SETS[DEFAULT_SET]!;
  return [
    `布景：现在是「${cur.name}」（${cur.mood}）。这个布景的特效：${Object.entries(cur.effects).map(([k, e]) => `[[fx ${k}]] ${e.zh}（${e.use}）`).join('；')}。特效是戏剧节拍，一段话最多一个，关键时刻才用。基础效果也能单独用：${Object.entries(PRIMS).map(([k, e]) => `prim:${k} ${e.zh}`).join('、')}。`,
    `能换的布景（按节目氛围挑，不按话题）：${SET_IDS.map((id) => `${id} ${SETS[id]!.name}（${SETS[id]!.fits}）`).join('；')}。[[room 布景id]] 换（会翻页、走转场；两次至少隔 3 分钟）。`,
  ].join('\n');
}
