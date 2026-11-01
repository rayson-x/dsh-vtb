/**
 * Live2D 角色的纯逻辑：表情映射、嘴型、视线、把模型放进 780×1010 的人物框。
 * 运行时（PIXI、模型）在 avatar.tsx 里按需加载，这里不碰浏览器。
 *
 * 表情映射（avatar.mood → 模型 exp3，没有对应脸的用参数近似）：
 *   neutral   不叠加。看镜头。
 *   happy     开心兴奋。眯眼、挑眉、嘴角上扬。
 *   surprised 感叹号。模型没有惊讶脸，挂感叹号，眉再往上挑。
 *   thinking  呆呆眼。头微倾，近似在想。
 *   sad       悲伤。眼泪、眉眼下压、嘴角下撇。
 * 看片时视线和头朝左（片子在左边），杂谈时回到镜头。空闲动作是模型里的 idle 组。
 */

import type { Mood, Look } from '../../stage/protocol';

export const LIVE2D_CHARACTER = 'deepseek-live2d';

/** 整张画布都算内容（量不到不透明像素时用这个） */
export const FULL_CANVAS = { x0: 0, y0: 0, x1: 1, y1: 1 };

export interface NormRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ParamDelta {
  id: string;
  value: number;
}

export interface MoodPose {
  /** model3 Expressions 里的 Name；null 表示卸掉表情 */
  expression: string | null;
  /** 表情文件没写到的，每帧再 Add 上去 */
  add: ParamDelta[];
  /** 这张脸自己在写眼睛开合，就不要再眨 */
  claimsEyes: boolean;
  note: string;
}

export const MOOD_POSE: Record<Mood, MoodPose> = {
  neutral: { expression: null, add: [], claimsEyes: false, note: '不叠加表情，看镜头' },
  happy: { expression: '开心兴奋', add: [], claimsEyes: true, note: '眯眼、挑眉、嘴角上扬（expressions/开心兴奋.exp3.json）' },
  surprised: {
    expression: '感叹号',
    add: [
      { id: 'ParamBrowLY', value: 0.8 },
      { id: 'ParamBrowRY', value: 0.8 },
      { id: 'ParamBrowLAngle', value: 0.5 },
      { id: 'ParamBrowRAngle', value: -0.5 },
    ],
    claimsEyes: false,
    note: '模型没有惊讶脸：挂感叹号，眉往上挑近似（expressions/感叹号.exp3.json）',
  },
  thinking: {
    expression: '呆呆眼',
    add: [{ id: 'ParamAngleZ', value: 6 }],
    claimsEyes: false,
    note: '呆眼，头微倾，近似思考（expressions/呆呆眼.exp3.json）',
  },
  sad: { expression: '悲伤', add: [], claimsEyes: false, note: '眼泪、眉眼下压、嘴角下撇（expressions/悲伤.exp3.json）' },
};

/** 要写进 model3 的表情（名字 → 相对模型目录的文件） */
export function registeredExpressions(): { name: string; file: string }[] {
  const seen = new Set<string>();
  const out: { name: string; file: string }[] = [];
  for (const pose of Object.values(MOOD_POSE)) {
    if (!pose.expression || seen.has(pose.expression)) continue;
    seen.add(pose.expression);
    out.push({ name: pose.expression, file: `expressions/${pose.expression}.exp3.json` });
  }
  return out;
}

/** 地址带 ?avatar=svg 时强制用占位，方便和 Live2D 对比 */
export function preferSvgAvatar(search: string): boolean {
  return new URLSearchParams(search).get('avatar') === 'svg';
}

export function withToken(href: string, token: string | null): string {
  const url = new URL(href);
  if (token) url.searchParams.set('token', token);
  return url.href;
}

/** 模型目录下的相对路径 → 绝对地址。每个文件自己带 token，query 不会从模型 URL 继承。 */
export function fileUrl(modelUrl: string, relative: string, token: string | null): string {
  const clean = modelUrl.split('?')[0] ?? modelUrl;
  const base = clean.slice(0, clean.lastIndexOf('/') + 1);
  return withToken(new URL(relative, base).href, token);
}

export interface MotionFile {
  File: string;
  FadeInTime?: number;
  FadeOutTime?: number;
}

export interface ModelSettings {
  Version?: number;
  FileReferences: {
    Moc?: string;
    Physics?: string;
    DisplayInfo?: string;
    Pose?: string;
    Textures?: string[];
    Motions?: Record<string, MotionFile[]>;
    Expressions?: { Name: string; File: string }[];
  };
  Groups?: unknown;
  HitAreas?: unknown;
  url?: string;
}

/**
 * 把模型清单里的相对路径换成绝对地址，并补上表情。
 * 运行时只认组名 Idle 才会自动循环空闲动作，素材里写的是 idle，这里改名。
 */
export function rewriteModelSettings(settings: ModelSettings, modelUrl: string, token: string | null, expressions: { name: string; file: string }[]): ModelSettings {
  const refs = settings.FileReferences;
  if (!refs) throw new Error('模型清单没有 FileReferences');
  const abs = (relative: string) => fileUrl(modelUrl, relative, token);
  const motions: Record<string, MotionFile[]> = {};
  for (const [group, list] of Object.entries(refs.Motions ?? {})) {
    motions[group] = list.map((motion) => ({ ...motion, File: abs(motion.File) }));
  }
  if (motions.idle && !motions.Idle) {
    motions.Idle = motions.idle;
    delete motions.idle;
  }
  return {
    ...settings,
    url: withToken(modelUrl.split('?')[0] ?? modelUrl, token),
    FileReferences: {
      ...refs,
      ...(refs.Moc ? { Moc: abs(refs.Moc) } : {}),
      ...(refs.Physics ? { Physics: abs(refs.Physics) } : {}),
      ...(refs.DisplayInfo ? { DisplayInfo: abs(refs.DisplayInfo) } : {}),
      ...(refs.Pose ? { Pose: abs(refs.Pose) } : {}),
      ...(refs.Textures ? { Textures: refs.Textures.map(abs) } : {}),
      Motions: motions,
      Expressions: expressions.map((item) => ({ Name: item.name, File: abs(item.file) })),
    },
  };
}

/**
 * 嘴张开 0–1。
 * 不说话（包括被打断）立刻闭嘴。说话且音量有值就跟音量；音量是 0 时自己开合。
 */
export function mouthOpen(level: number, speaking: boolean, timeSec: number): number {
  if (!speaking) return 0;
  const volume = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  if (volume > 0) return volume;
  const wave = 0.5 + 0.5 * Math.sin(timeSec * Math.PI * 9);
  return 0.18 + 0.62 * wave;
}

/** 视线：看左边的内容、看右边、看镜头（她自己定，换摆法时有默认）。数值是焦点，-1..1，运行时再换成角度。 */
export function gazeTarget(look: Look): { x: number; y: number } {
  if (look === 'left') return { x: -1, y: 0.08 };
  if (look === 'right') return { x: 1, y: 0.08 };
  return { x: 0, y: 0 };
}

/**
 * 眨眼开合 0–1。大约每 4 秒一次，单次 0.16 秒，方便测试也方便对着时钟看。
 */
export function blinkOpen(timeMs: number): number {
  const period = 4200;
  const close = 160;
  const phase = ((timeMs % period) + period) % period;
  if (phase < period - close) return 1;
  const t = (phase - (period - close)) / close;
  return t < 0.5 ? 1 - t * 2 : (t - 0.5) * 2;
}

export function approach(current: number, target: number, dt: number, speed: number): number {
  const next = current + (target - current) * Math.min(1, Math.max(0, dt * speed));
  if (target === 0 && next < 0.02) return 0;
  return next;
}

/**
 * 把模型画布放进人物框。锚点在画布左上角。
 * 内容底边贴框底（脚或桌子的最低点在下面），水平居中，整张内容缩进框里。
 * content 是画布上的不透明范围，归一化，原点在左上。
 */
export function fitAvatar(canvas: { w: number; h: number }, box: { w: number; h: number }, content: NormRect = FULL_CANVAS, pad = 0.02): { scale: number; x: number; y: number } {
  const cw = Math.max(1, (content.x1 - content.x0) * canvas.w);
  const ch = Math.max(1, (content.y1 - content.y0) * canvas.h);
  const availW = box.w * (1 - pad * 2);
  const availH = box.h * (1 - pad * 2);
  const scale = Math.min(availW / cw, availH / ch);
  const x = (box.w - cw * scale) / 2 - content.x0 * canvas.w * scale;
  const y = box.h * (1 - pad) - content.y1 * canvas.h * scale;
  return { scale, x, y };
}

/** 采样不透明像素的外接框，归一化到 0–1。没有像素就返回 null。 */
export function opaqueBounds(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, alpha = 16, step = 4): NormRect | null {
  if (width < 1 || height < 1) return null;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += step) {
    const row = y * width;
    for (let x = 0; x < width; x += step) {
      if ((pixels[(row + x) * 4 + 3] ?? 0) <= alpha) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return {
    x0: minX / width,
    y0: minY / height,
    x1: Math.min(1, (maxX + step) / width),
    y1: Math.min(1, (maxY + step) / height),
  };
}
