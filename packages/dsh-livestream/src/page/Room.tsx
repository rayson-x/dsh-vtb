/**
 * 直播间的房间和墙上挂的东西：海底女仆小书房。
 *
 * 背景是一整张插画（assets/ui/bg-room），框、牌、便签都是同一套生成的组件图（assets/ui/README.md 有每张的内区），
 * 字由这里叠上去。画面明亮、可爱，暖光从她身后的台灯来。
 */

import type { MutableRefObject } from 'react';
import type { Scene, StageState } from '../stage/protocol';
import { programCard } from './board';

/** 房间：背景插画，底下压一道很淡的暗角，让字幕条和弹幕框跟房间分得开 */
export function Room() {
  return (
    <div className="layer room">
      <div className="room-bg" />
      <div className="room-vignette" />
    </div>
  );
}

/**
 * 左上角：节目牌（节目名）和下面一张便签（正在聊什么、怎么点题）。
 * 只在杂谈时挂；主画面上了东西，便签收起来给展示板让位，节目牌留着。
 */
export function ProgramWall({ state, nowRef, layout }: { state: StageState; nowRef: MutableRefObject<number>; layout: Scene }) {
  const { title, topic } = state.program;
  if (layout !== 'chat' || (!title && !topic)) return null;
  const note = programCard(state, nowRef.current);
  return (
    <>
      {title && <div className="plaque">{title}</div>}
      <div className={`note ${note ? 'on' : 'off'}`}>
        {topic && <p className="note-topic"><small>正在聊</small>{topic}</p>}
        <p className="note-hint">弹幕发「想听……」点题</p>
      </div>
    </>
  );
}
