/**
 * 工位（主内容台）：片子、细看、B-roll、代码条、特效预览、状态牌、播放进度。
 * 看片时铺满主画面，杂谈时缩成桌上的显示器；元素一直在，不随场景卸载。
 */

import { useEffect, useRef } from 'react';
import { playhead, type Clip, type StageState } from '../stage/protocol';
import { FakeFilm } from './FakeFilm';
import { FOCUS_ZOOM, regionCenter } from './layout';
import { Timeline } from './Timeline';


/** 有可播地址就放真视频，跟着播放头对齐 */
function ClipVideo({ clip, head }: { clip: Clip; head: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (Math.abs(v.currentTime - head) > 0.6) v.currentTime = head;
    if (clip.playing && v.paused) v.play().catch(() => { v.muted = true; void v.play().catch(() => undefined); });
    if (!clip.playing && !v.paused) v.pause();
  }, [clip.playing, head]);
  return <video ref={ref} className="film" src={clip.src} playsInline preload="auto" />;
}

function Media({ state, head, now }: { state: StageState; head: number; now: number }) {
  const clip = state.clip;
  const [fx, fy] = state.focus ? regionCenter[state.focus.region] : [0.5, 0.5];
  const zoom = state.focus ? FOCUS_ZOOM : 1;
  // 正在播的那一段特效
  const activeFx = state.fx.find((b) => head >= b.from && head <= b.to);
  return (
    <div className={`media ${state.mode === 'code' && state.code ? 'dim' : ''}`}>
      <div className="media-zoom" style={{ transform: `scale(${zoom})`, transformOrigin: `${fx * 100}% ${fy * 100}%` }}>
        {clip && (clip.src ? <ClipVideo clip={clip} head={head} /> : <FakeFilm time={head} seed={clip.title.length} />)}
      </div>
      {state.focus && (
        <div className="focus-frame">
          <i className="c tl" /><i className="c tr" /><i className="c bl" /><i className="c br" />
          <span>细看{state.focus.label ? ` · ${state.focus.label}` : ''}</span>
        </div>
      )}
      {activeFx && state.mode === 'fx' && (
        <div className={`fx-badge ${activeFx.status} ${now - activeFx.at < 1200 && activeFx.status === 'ready' ? 'hot' : ''}`}>
          {activeFx.name} · {FX_NAMES[activeFx.status]}
        </div>
      )}
      {state.broll && <Broll state={state} now={now} />}
      {state.mode === 'code' && state.code && <CodeStrip state={state} now={now} />}
    </div>
  );
}

const FX_NAMES = { draft: '草稿', rendering: '渲染中', ready: '预览已更新', failed: '失败' } as const;

/** B-roll：从左擦入，到点擦出 */
function Broll({ state, now }: { state: StageState; now: number }) {
  const b = state.broll!;
  const left = b.startedAt + b.ms - now;
  const phase = now - b.startedAt < 450 ? 'in' : left < 450 ? 'out' : 'hold';
  return (
    <div className={`broll ${phase}`}>
      {b.src ? <video className="film" src={b.src} autoPlay muted playsInline loop /> : <FakeFilm time={(now - b.startedAt) / 1000 + 3} seed={b.title.length + 7} />}
      <div className="broll-caption">
        <span className="broll-tag">B-ROLL</span>
        <strong>{b.title}</strong>
        {b.caption && <span>{b.caption}</span>}
      </div>
    </div>
  );
}

/** 代码条：只有摘录，一行行打出来 */
function CodeStrip({ state, now }: { state: StageState; now: number }) {
  const code = state.code!;
  let budget = Math.floor(((now - code.at) / 1000) * 48);
  return (
    <div className="code-strip">
      <div className="code-head">
        <span className="code-lang">{code.lang}</span>
        <span>{code.title}</span>
      </div>
      <pre>
        {code.lines.map((line, i) => {
          const shown = budget >= line.length ? line : line.slice(0, Math.max(0, budget));
          const typing = budget >= 0 && budget < line.length;
          budget -= line.length + 1;
          return (
            <div key={i} className={`code-line ${code.highlight === i + 1 ? 'hl' : ''}`}>
              <span className="ln">{i + 1}</span>
              <span>{shown}{typing && <i className="caret" />}</span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

/** 工位这会儿画不画东西（环境层据此决定杂谈时那根屏幕立柱要不要出来） */
export function workspaceShown(state: StageState): boolean {
  return !!(state.clip || state.broll || (state.mode === 'code' && state.code));
}

/**
 * 工位上有没有东西：片子、B-roll、代码条。没有就整个不画（不挂「工位空闲」），
 * 查资料时换成翻资料的画面。
 */
export function Workspace({ state, now }: { state: StageState; now: number }) {
  const busy = !!(state.clip || state.broll || (state.mode === 'code' && state.code));
  // 工位缩成桌上的小显示器（杂谈）时翻资料换大字版，缩小了也看得清
  // 主画面已经摆着组件（对比、场景……）就不叠翻资料的画面，免得两层压在一起
  // 查资料是后台的事：不占主画面，右上角挂个「正在查」小气泡（Overlays 的 Searching）
  if (!busy) return null;
  const head = state.clip ? playhead(state.clip, now) : 0;
  return (
    <div className={`workspace mode-${state.mode}`}>
      <div className="ws-bar">
        {state.status && (
          <div className="ws-status" key={state.status}>
            <i />
            {state.status}
          </div>
        )}
      </div>
      <Media state={state} head={head} now={now} />
      {state.clip && <Timeline state={state} head={head} now={now} />}
    </div>
  );
}
