import { describe, expect, it } from 'vitest';
import { AVATAR } from '../src/page/layout';
import {
  blinkOpen,
  fitAvatar,
  FULL_CANVAS,
  gazeTarget,
  MOOD_POSE,
  mouthOpen,
  opaqueBounds,
  preferSvgAvatar,
  registeredExpressions,
  rewriteModelSettings,
} from '../src/page/live2d/logic';

const moods = ['neutral', 'happy', 'surprised', 'thinking', 'sad'] as const;

describe('表情映射', () => {
  it('五种心情都有说明，开心、惊讶、思考、难过各自落到一张表情', () => {
    expect(MOOD_POSE.neutral.expression).toBeNull();
    expect(MOOD_POSE.happy.expression).toBe('开心兴奋');
    expect(MOOD_POSE.surprised.expression).toBe('感叹号');
    expect(MOOD_POSE.thinking.expression).toBe('呆呆眼');
    expect(MOOD_POSE.sad.expression).toBe('悲伤');
    for (const mood of moods) expect(MOOD_POSE[mood].note.length).toBeGreaterThan(0);
    expect(MOOD_POSE.happy.claimsEyes).toBe(true);
    expect(MOOD_POSE.surprised.add.map((p) => p.id)).toContain('ParamBrowLY');
  });

  it('注册进模型的就是这几张，文件在模型目录的 expressions/ 下', () => {
    const files = registeredExpressions();
    expect(files.map((item) => item.name)).toEqual(['开心兴奋', '感叹号', '呆呆眼', '悲伤']);
    expect(files.every((item) => item.file === `expressions/${item.name}.exp3.json`)).toBe(true);
  });
});

describe('嘴、视线、眨眼', () => {
  it('不说话立刻闭嘴；说话跟音量；没音量就自己开合', () => {
    expect(mouthOpen(0.8, false, 1)).toBe(0);
    expect(mouthOpen(1.4, true, 0)).toBe(1);
    expect(mouthOpen(0.4, true, 0)).toBeCloseTo(0.4);
    const shut = mouthOpen(0, true, 0);
    const open = mouthOpen(0, true, 0.12);
    expect(shut).toBeGreaterThan(0);
    expect(shut).toBeLessThanOrEqual(1);
    expect(open).not.toBeCloseTo(shut);
  });

  it('看片朝左，杂谈看镜头', () => {
    expect(gazeTarget('camera')).toEqual({ x: 0, y: 0 });
    expect(gazeTarget('left').x).toBeLessThan(0);
    expect(gazeTarget('right').x).toBeGreaterThan(0);
  });

  it('大部分时间眼睛是睁的，一个周期里会闭上一次', () => {
    expect(blinkOpen(0)).toBe(1);
    expect(blinkOpen(4200 - 80)).toBeLessThan(0.2);
    expect(blinkOpen(4190)).toBeGreaterThan(0.8);
  });
});

describe('人物框', () => {
  it('整张画布放进框里：底边贴底，水平居中，不超出', () => {
    const canvas = { w: 1000, h: 2000 };
    const box = { w: AVATAR.w, h: AVATAR.h };
    const fit = fitAvatar(canvas, box, FULL_CANVAS, 0);
    expect(fit.scale).toBeCloseTo(box.h / canvas.h);
    expect(fit.y + canvas.h * fit.scale).toBeCloseTo(box.h);
    expect(fit.x).toBeCloseTo((box.w - canvas.w * fit.scale) / 2);
    expect(canvas.w * fit.scale).toBeLessThanOrEqual(box.w + 0.01);
  });

  it('留白裁掉之后仍然底边贴底，并且比整张画布放得更大', () => {
    const canvas = { w: 1000, h: 2000 };
    const box = { w: 780, h: 1010 };
    const content = { x0: 0.2, y0: 0.25, x1: 0.8, y1: 0.9 };
    const fit = fitAvatar(canvas, box, content, 0);
    const full = fitAvatar(canvas, box, FULL_CANVAS, 0);
    expect(fit.scale).toBeGreaterThan(full.scale);
    expect(fit.y + content.y1 * canvas.h * fit.scale).toBeCloseTo(box.h);
    const contentW = (content.x1 - content.x0) * canvas.w * fit.scale;
    const left = fit.x + content.x0 * canvas.w * fit.scale;
    expect(left).toBeCloseTo((box.w - contentW) / 2);
  });

  it('宽内容按宽度缩小，窄内容按高度缩小', () => {
    const wide = fitAvatar({ w: 2000, h: 500 }, { w: 780, h: 1010 }, FULL_CANVAS, 0);
    expect(wide.scale).toBeCloseTo(780 / 2000);
    expect(wide.y + 500 * wide.scale).toBeCloseTo(1010);
    const tall = fitAvatar({ w: 400, h: 2000 }, { w: 780, h: 1010 }, FULL_CANVAS, 0);
    expect(tall.scale).toBeCloseTo(1010 / 2000);
  });

  it('不透明像素给出归一化外接框', () => {
    const pixels = new Uint8ClampedArray(4 * 4 * 4);
    pixels[(1 * 4 + 2) * 4 + 3] = 255;
    expect(opaqueBounds(pixels, 4, 4, 16, 1)).toEqual({ x0: 2 / 4, y0: 1 / 4, x1: 3 / 4, y1: 2 / 4 });
    expect(opaqueBounds(pixels, 4, 4, 16, 2)).toBeNull();
  });
});

describe('模型地址', () => {
  it('?avatar=svg 才强制占位', () => {
    expect(preferSvgAvatar('?avatar=svg')).toBe(true);
    expect(preferSvgAvatar('avatar=svg')).toBe(true);
    expect(preferSvgAvatar('?avatar=live2d')).toBe(false);
    expect(preferSvgAvatar('')).toBe(false);
  });

  it('子资源换成绝对地址并自带 token，idle 组改成运行时认识的 Idle', () => {
    const input = {
      Version: 3,
      FileReferences: {
        Moc: 'c_0120.moc3',
        Textures: ['c_0120.2048/texture_00.png'],
        Motions: { idle: [{ File: 'motions/idle.motion3.json', FadeInTime: 0.8 }] },
      },
    };
    const modelUrl = 'http://127.0.0.1:3902/characters/deepseek-live2d/model/c_0120.model3.json';
    const out = rewriteModelSettings(input, modelUrl, 'tok', registeredExpressions());
    expect(input.FileReferences.Motions.idle[0]?.File).toBe('motions/idle.motion3.json');
    expect(out.FileReferences.Motions?.idle).toBeUndefined();
    expect(out.FileReferences.Motions?.Idle?.[0]?.File).toContain('/model/motions/idle.motion3.json');
    expect(out.FileReferences.Motions?.Idle?.[0]?.File).toContain('token=tok');
    expect(out.FileReferences.Moc).toContain('/model/c_0120.moc3');
    expect(out.FileReferences.Textures?.[0]).toContain('token=tok');
    expect(decodeURIComponent(out.FileReferences.Expressions?.[0]?.File ?? '')).toContain('expressions/开心兴奋.exp3.json');
    expect(out.url).toContain('token=tok');
  });
});
