/**
 * 人物层：Live2D，失败或 ?avatar=svg 时退回 SVG 占位。
 *
 * 实例只建一次。场景、表情、说话都只改参数，不换模型，所以切场景不会闪白。
 * 卸载（包括 avatar.visible=false 把整层拿掉）时释放 PIXI 和 WebGL。
 * vendor 脚本从 /characters/ 动态插入，不打进 stage.js。
 */

import { useEffect, useRef, useState } from 'react';
import type { Mood, Look } from '../../stage/protocol';
import { Avatar } from '../Avatar';
import { AVATAR } from '../layout';
import { mouth } from '../mouth';
import {
  approach,
  blinkOpen,
  fitAvatar,
  FULL_CANVAS,
  gazeTarget,
  LIVE2D_CHARACTER,
  MOOD_POSE,
  mouthOpen,
  opaqueBounds,
  preferSvgAvatar,
  registeredExpressions,
  rewriteModelSettings,
  withToken,
  type ModelSettings,
  type NormRect,
} from './logic';

interface CharacterManifest {
  renderer?: string;
  live2d?: { model: string; vendor: string[] };
}

interface CoreModel {
  setParameterValueById: (id: string, value: number) => void;
  addParameterValueById: (id: string, value: number) => void;
}

interface PixiModel {
  anchor: { set: (x: number, y: number) => void };
  scale: { set: (scale: number) => void };
  position: { set: (x: number, y: number) => void };
  update: (dt: number) => void;
  expression: (name: string) => Promise<unknown>;
  destroy: (options: { texture: boolean; baseTexture: boolean }) => void;
  parent?: unknown;
  internalModel: {
    width: number;
    height: number;
    originalWidth: number;
    originalHeight: number;
    coreModel: CoreModel;
    focusController?: { focus: (x: number, y: number, instant?: boolean) => void };
    motionManager?: { expressionManager?: { resetExpression: () => unknown } };
    on: (event: string, fn: () => void) => void;
  };
}

interface PixiApp {
  stage: { addChild: (child: PixiModel) => void };
  view: HTMLCanvasElement;
  renderer: {
    backgroundAlpha: number;
    resize: (w: number, h: number) => void;
    render: (stage: unknown) => void;
    extract?: { canvas?: (stage: unknown) => HTMLCanvasElement };
    plugins?: { extract?: { canvas?: (stage: unknown) => HTMLCanvasElement } };
  };
  destroy: (removeView: boolean, options: { children: boolean; texture: boolean; baseTexture: boolean }) => void;
  ticker: { maxFPS: number };
}

interface PixiLive2D {
  utils?: { skipHello?: () => void };
  Application: new (options: Record<string, unknown>) => PixiApp;
  live2d: { Live2DModel: { from: (settings: ModelSettings, options: { autoInteract: boolean; autoUpdate: boolean }) => Promise<PixiModel> } };
}

const scripts = new Map<string, Promise<void>>();

function pageToken(): string | null {
  return new URLSearchParams(location.search).get('token');
}

function absUrl(path: string): string {
  return withToken(new URL(path, location.href).href, pageToken());
}

function loadScript(src: string): Promise<void> {
  const cached = scripts.get(src);
  if (cached) return cached;
  const pending = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => {
      scripts.delete(src);
      reject(new Error(`运行时脚本加载失败：${src}`));
    };
    document.head.appendChild(script);
  });
  scripts.set(src, pending);
  return pending;
}

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
  } catch {
    return false;
  }
}

function destroyModel(model: PixiModel | undefined): void {
  try {
    model?.destroy({ texture: true, baseTexture: true });
  } catch {
    // 已经卸过
  }
}

function destroyApp(app: PixiApp | undefined): void {
  try {
    app?.destroy(true, { children: true, texture: true, baseTexture: true });
  } catch {
    // 已经卸过
  }
}

/** 画一帧，量不透明像素，好把角色（而不是画布留白）放进人物框 */
function measureContent(app: PixiApp, model: PixiModel, canvasW: number, canvasH: number): NormRect {
  try {
    const sampleH = 480;
    const sampleScale = sampleH / canvasH;
    const sampleW = Math.max(16, Math.ceil(canvasW * sampleScale));
    model.anchor.set(0, 0);
    model.scale.set(sampleScale);
    model.position.set(0, 0);
    model.update(16);
    app.renderer.resize(sampleW, sampleH);
    app.renderer.render(app.stage);
    const extract = app.renderer.extract ?? app.renderer.plugins?.extract;
    const shot = extract?.canvas?.(app.stage);
    const ctx = shot?.getContext('2d');
    if (!shot || !ctx) return FULL_CANVAS;
    const image = ctx.getImageData(0, 0, shot.width, shot.height);
    const bounds = opaqueBounds(image.data, image.width, image.height);
    if (!bounds || bounds.x1 - bounds.x0 < 0.05 || bounds.y1 - bounds.y0 < 0.05) return FULL_CANVAS;
    return bounds;
  } catch {
    return FULL_CANVAS;
  }
}

/** Live2D 渲染帧率上限 */
const LIVE2D_FPS = 30;

function Live2DView({ mood, speaking, look, onFail }: { mood: Mood; speaking: boolean; look: Look; onFail: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef({ mood, speaking, look });
  live.current = { mood, speaking, look };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let app: PixiApp | undefined;
    let model: PixiModel | undefined;

    const fail = (err: unknown) => {
      if (disposed) return;
      console.warn('[live2d] 加载失败，退回 SVG 占位', err);
      onFailRef.current();
    };

    void (async () => {
      if (!hasWebGL()) throw new Error('WebGL 不可用');
      const manifestRes = await fetch(absUrl(`/characters/${LIVE2D_CHARACTER}/character.json`));
      if (disposed) return;
      if (!manifestRes.ok) throw new Error(`角色清单 HTTP ${manifestRes.status}`);
      const manifest = (await manifestRes.json()) as CharacterManifest;
      if (manifest.renderer !== 'live2d' || !manifest.live2d?.model || !manifest.live2d.vendor?.length) throw new Error('角色清单里没有 Live2D');
      const root = new URL(`/characters/${LIVE2D_CHARACTER}/`, location.href);
      for (const file of manifest.live2d.vendor) await loadScript(absUrl(new URL(file, root).href));
      if (disposed) return;

      const PIXI = (window as unknown as { PIXI?: PixiLive2D }).PIXI;
      if (!PIXI?.live2d?.Live2DModel) throw new Error('Live2D 运行时没有挂上');
      PIXI.utils?.skipHello?.();

      const modelUrl = absUrl(new URL(manifest.live2d.model, root).href);
      const modelRes = await fetch(modelUrl);
      if (disposed) return;
      if (!modelRes.ok) throw new Error(`模型 HTTP ${modelRes.status}`);
      const settings = rewriteModelSettings((await modelRes.json()) as ModelSettings, modelUrl, pageToken(), registeredExpressions());

      app = new PIXI.Application({
        width: 64,
        height: 64,
        transparent: true,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        // 舞台按 1920×1080 出画（OBS 也是），按屏幕倍率渲染是白费；帧率 30 够了，动作看不出差别，主线程省一半
        resolution: 1,
      });
      app.renderer.backgroundAlpha = 0;
      app.ticker.maxFPS = LIVE2D_FPS;

      model = await PIXI.live2d.Live2DModel.from(settings, { autoInteract: false, autoUpdate: true });
      if (disposed) {
        destroyModel(model);
        destroyApp(app);
        return;
      }
      app.stage.addChild(model);

      const canvasW = model.internalModel.width || model.internalModel.originalWidth;
      const canvasH = model.internalModel.height || model.internalModel.originalHeight;
      if (!(canvasW > 1) || !(canvasH > 1)) throw new Error('模型尺寸无效');

      const content = measureContent(app, model, canvasW, canvasH);
      const fit = fitAvatar({ w: canvasW, h: canvasH }, { w: AVATAR.w, h: AVATAR.h }, content);
      model.anchor.set(0, 0);
      model.scale.set(fit.scale);
      model.position.set(fit.x, fit.y);
      app.renderer.resize(AVATAR.w, AVATAR.h);

      const view = app.view;
      view.style.width = '100%';
      view.style.height = '100%';
      view.style.display = 'block';
      view.style.background = 'transparent';
      if (disposed) return;
      el.appendChild(view);
      el.dataset.ready = '1';

      const weights: Partial<Record<Mood, number>> = {};
      let applied: Mood | null = null;
      let last = performance.now();
      let warned = false;
      const current = model;
      current.internalModel.on('beforeModelUpdate', () => {
        const now = performance.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        const pose = live.current;
        const core = current.internalModel.coreModel;
        if (pose.mood !== applied) {
          applied = pose.mood;
          const name = MOOD_POSE[pose.mood].expression;
          const mgr = current.internalModel.motionManager?.expressionManager;
          if (mgr) {
            const job = name ? current.expression(name) : mgr.resetExpression();
            void Promise.resolve(job).catch(() => undefined);
          }
        }
        try {
          let eyesClaimed = false;
          for (const key of Object.keys(MOOD_POSE) as Mood[]) {
            const target = key === pose.mood ? 1 : 0;
            const next = approach(weights[key] ?? 0, target, dt, target > (weights[key] ?? 0) ? 6 : 10);
            weights[key] = next;
            const spec = MOOD_POSE[key];
            if (spec.claimsEyes && next > 0.35) eyesClaimed = true;
            if (next <= 0) continue;
            for (const param of spec.add) core.addParameterValueById(param.id, param.value * next);
          }
          if (!eyesClaimed) {
            const open = blinkOpen(now);
            if (open < 0.98) {
              core.setParameterValueById('ParamEyeLOpen', open);
              core.setParameterValueById('ParamEyeROpen', open);
            }
          }
          // 不说话时这里每帧写成 0，打断后嘴马上闭上
          core.setParameterValueById('ParamMouthOpenY', mouthOpen(mouth(), pose.speaking, now / 1000));
          // 焦点控制器每帧只加一点点，看片时直接写角度，头和眼珠马上朝左
          const gaze = gazeTarget(pose.look);
          core.addParameterValueById('ParamAngleX', gaze.x * 30);
          core.addParameterValueById('ParamAngleY', gaze.y * 30);
          core.addParameterValueById('ParamEyeBallX', gaze.x);
          core.addParameterValueById('ParamEyeBallY', gaze.y);
          core.addParameterValueById('ParamBodyAngleX', gaze.x * 10);
        } catch (err) {
          if (!warned) {
            warned = true;
            console.warn('[live2d] 参数写不进去', err);
          }
        }
      });
    })().catch((err) => {
      fail(err);
      destroyModel(model?.parent == null ? model : undefined);
      destroyApp(app);
      app = undefined;
      model = undefined;
    });

    return () => {
      disposed = true;
      destroyApp(app);
      if (model?.parent == null) destroyModel(model);
      app = undefined;
      model = undefined;
    };
  }, []);

  return <div ref={host} className="live2d-host" data-mood={mood} data-speaking={speaking ? '1' : '0'} data-look={look} />;
}

/** 人物：默认 Live2D，失败或 ?avatar=svg 时用占位 */
export function StageAvatar({ mood, speaking, look }: { mood: Mood; speaking: boolean; look: Look }) {
  const [failed, setFailed] = useState(false);
  if (preferSvgAvatar(location.search) || failed) return <Avatar mood={mood} speaking={speaking} look={look} />;
  return <Live2DView mood={mood} speaking={speaking} look={look} onFail={() => setFailed(true)} />;
}
