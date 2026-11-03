/**
 * 舞台：1920×1080 的画布。背景之上的每样东西（工位、人物、字幕、右栏、角标、礼物、组件）都是画布元素，
 * 位置大小来自 state.canvas，由她（DSH）摆；我们只给初始布局（stage/canvas.ts 的 PRESETS）。
 *
 * 转场：
 *   cut   直接落到新版式
 *   slide 工位和人物滑到新位置
 *   fade  移动的图层先淡出，在暗处换版式，再淡入
 *   wipe  一道暗幕扫过，扫到一半换版式
 * 弹幕和任务角不参与转场，一直留在原地；包装换场景时挪到新场景的空地。
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AVATAR_BASE, WORKSPACE_BASE, type Element, type ElementId } from '../stage/canvas';
import { STAGE_H, STAGE_W, type Scene, type StageState } from '../stage/protocol';
import { BOARD, BOARD_EDGE } from '../stage/regions';
import { programmeBox } from '../stage/programme-layout';
import { mainOccupied } from './board';
import { ProgramWall, Room } from './Room';
import { Canvas } from './draw/Canvas';
import { Ambience, SetFx, SetTransition, setPhase, shakeOf } from './SetFx';
import { Panels } from './Panel';
import { StageAvatar } from './live2d/avatar';
import { Alerts, Celebration, Danmaku, Emotes, OnAir, Rundown, Searching, Subtitle, Tasks } from './Overlays';
import { Workspace } from './Workspace';

/** 现在按哪个场景摆、转场处在哪一相 */
function staging(state: StageState, now: number): { layout: Scene; phase: string; wipe: number | null } {
  const t = state.transition;
  if (!t) return { layout: state.scene, phase: '', wipe: null };
  const p = Math.min(1, Math.max(0, (now - t.startedAt) / Math.max(1, t.ms)));
  if (t.kind === 'slide') return { layout: t.to, phase: 'slide', wipe: null };
  if (t.kind === 'fade') return { layout: p < 0.5 ? t.from : t.to, phase: p < 0.5 ? 'fade-out' : 'fade-in', wipe: null };
  if (t.kind === 'wipe') return { layout: p < 0.5 ? t.from : t.to, phase: 'wipe', wipe: p };
  return { layout: t.to, phase: '', wipe: null };
}

/** 画布上的一个元素：按她摆的框定位；挪动时 CSS 过渡滑过去。mover 的元素参与淡入淡出转场 */
function Place({ state, id, mover, children }: { state: StageState; id: ElementId; mover?: boolean; children: (e: Element) => ReactNode }) {
  const e = state.canvas[id];
  if (!e?.visible) return null;
  return (
    <div className={`el el-${id} ${mover ? 'mover' : ''}`} style={{ left: e.x, top: e.y, width: e.w, height: e.h, zIndex: e.z }}>
      {children(e)}
    </div>
  );
}

/** 浏览器窗口不是 1920×1080 时整体缩放（OBS 里正好是 1，不缩） */
/** 舞台按窗口等比缩放并居中（全屏时不是 16:9，多出来的上下或左右两边一样宽） */
function useFit(): { scale: number; x: number; y: number } {
  const [fitted, setFitted] = useState({ scale: 1, x: 0, y: 0 });
  useEffect(() => {
    const fit = () => {
      const scale = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
      setFitted({ scale, x: (window.innerWidth - STAGE_W * scale) / 2, y: (window.innerHeight - STAGE_H * scale) / 2 });
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return fitted;
}

export function Stage({ state, now, fit = true, programme }: { state: StageState; now: number; fit?: boolean; programme?: ReactNode }) {
  const { scale, x, y } = useFit();
  const { layout, phase, wipe } = staging(state, now);
  const nowRef = useRef(now);
  nowRef.current = now;
  // 布景：转场过半前用旧皮；特效里的「震」作用在整个舞台上
  const skin = setPhase(state, now).set;
  const shake = shakeOf(state, now);
  const programmeFrame=programmeBox(state,layout);
  return (
    <div className="stage-frame" style={fit ? { transform: `translate(${x}px, ${y}px) scale(${scale})` } : undefined}>
      <div className={`stage scene-${layout} ${phase} ${shake ? 'vfx-shaking' : ''}`} data-set={skin} style={shake ? { ['--shake' as string]: shake } : undefined}>
        <Room />
        <Ambience set={skin} />
        <ProgramWall state={state} nowRef={nowRef} layout={layout} />

        {/* 展示板：素材、翻资料都上在这块板上；没东西时收起来 */}
        <div
          className={`board at-${layout} ${programme || mainOccupied(state, now) ? 'on' : 'off'}`}
          style={{ left: BOARD[layout].x, top: BOARD[layout].y, width: BOARD[layout].w, height: BOARD[layout].h, borderWidth: BOARD_EDGE[layout].map((n) => `${n}px`).join(' ') }}
        />

        {!programme && <Place state={state} id="workspace" mover>
          {(e) => (
            <div className="el-inner" style={{ width: WORKSPACE_BASE.w, height: WORKSPACE_BASE.h, transform: `scale(${Math.min(e.w / WORKSPACE_BASE.w, e.h / WORKSPACE_BASE.h)})` }}>
              <Workspace state={state} now={now} />
            </div>
          )}
        </Place>}

        {programme && <div className="el programme-surface mover" style={{
          left: programmeFrame.x,
          top: programmeFrame.y,
          width: programmeFrame.w,
          height: programmeFrame.h,
          zIndex: 2,
          overflow: 'hidden',
        }}>{programme}</div>}

        <Place state={state} id="onair">{() => <OnAir now={now} viewers={state.viewers} away={state.away} />}</Place>

        <Place state={state} id="avatar" mover>
          {(e) => (
            <div className="el-inner" style={{ width: AVATAR_BASE.w, height: AVATAR_BASE.h, transform: `scale(${e.w / AVATAR_BASE.w})` }}>
              <StageAvatar mood={state.avatar.mood} speaking={state.avatar.speaking} look={state.avatar.look} />
            </div>
          )}
        </Place>

        <Panels state={state} scene={layout} now={now} />
        {!programme && <Canvas draw={state.draw} now={now} />}

        <Place state={state} id="subtitle" mover>{() => <Subtitle state={state} now={now} />}</Place>

        <Place state={state} id="side">
          {() => (
            <div className="side">
              <Searching state={state} />
              <Rundown state={state} />
              {/* 任务进度是剪片节目用的；知识直播里不挂 */}
              {(state.mode === 'edit' || state.mode === 'fx' || state.mode === 'code') && <Tasks state={state} />}
              <Danmaku state={state} now={now} />
            </div>
          )}
        </Place>

        <Place state={state} id="alerts">{() => <Alerts state={state} now={now} />}</Place>
        <Celebration state={state} now={now} />
        <Emotes state={state} now={now} />
        <SetFx state={state} now={now} />
        <SetTransition state={state} now={now} />

        {wipe !== null && <div className="wipe" style={{ transform: `translateX(${(wipe * 2 - 1) * 100}%)` }} />}
      </div>
    </div>
  );
}
