/**
 * 播放进度条：不是剪辑软件，是给观众看的道具。
 * 播放头、旗、选区、切点、特效块都画在这一条上；跳到某一窗时只画那一窗，下面一条小缩略指出窗在哪。
 */

import { clock, type StageState } from '../stage/protocol';

export function Timeline({ state, head, now }: { state: StageState; head: number; now: number }) {
  const clip = state.clip;
  if (!clip) return null;
  const from = state.view?.from ?? 0;
  const to = state.view?.to ?? clip.durationSec;
  const span = Math.max(0.001, to - from);
  const pct = (sec: number) => `${((sec - from) / span) * 100}%`;
  const visible = (sec: number) => sec >= from && sec <= to;
  const clampPct = (sec: number) => pct(Math.max(from, Math.min(to, sec)));
  const segments = [from, ...state.splits.filter((x) => x > from && x < to), to];

  return (
    <div className="timeline">
      <div className="tl-head">
        <span className="tl-time">
          {clock(head)}
          <em> / {clock(clip.durationSec)}</em>
        </span>
        <span className="tl-title">{clip.title}</span>
        {state.view && <span className="tl-window">窗口 {clock(from)}–{clock(to)}</span>}
        <span className={`tl-play ${clip.playing ? 'on' : ''}`}>{clip.playing ? '▶ 播放' : '❚❚ 暂停'}</span>
      </div>

      <div className="tl-track">
        {segments.slice(0, -1).map((start, i) => (
          <div key={start} className={`tl-seg ${i % 2 ? 'alt' : ''} ${state.splits.length ? 'split' : ''}`} style={{ left: pct(start), width: `${((segments[i + 1]! - start) / span) * 100}%` }} />
        ))}
        <div className="tl-progress" style={{ width: clampPct(head) }} />
        {state.selection && (
          <div className="tl-selection" style={{ left: clampPct(state.selection.from), width: `calc(${clampPct(state.selection.to)} - ${clampPct(state.selection.from)})` }}>
            {state.selection.label && <span>{state.selection.label}</span>}
          </div>
        )}
        {state.splits.filter(visible).map((x) => (
          <div key={x} className="tl-split" style={{ left: pct(x) }} />
        ))}
        {state.marks.filter((m) => visible(m.at)).map((m) => (
          <div key={m.id} className="tl-mark" style={{ left: pct(m.at) }}>
            <span>{m.label}</span>
          </div>
        ))}
        {visible(head) && <div className="tl-head-line" style={{ left: pct(head) }} />}
      </div>

      {(state.fx.length > 0 || state.mode === 'fx') && (
        <div className="tl-fx">
          {state.fx.map((b) => (
            <div key={b.id} className={`tl-fx-block ${b.status} ${now - b.at < 900 ? 'fresh' : ''}`} style={{ left: clampPct(b.from), width: `calc(${clampPct(b.to)} - ${clampPct(b.from)})` }}>
              {b.name}
            </div>
          ))}
        </div>
      )}

      {state.view && (
        <div className="tl-overview">
          <div className="tl-overview-window" style={{ left: `${(from / clip.durationSec) * 100}%`, width: `${(span / clip.durationSec) * 100}%` }} />
          <div className="tl-overview-head" style={{ left: `${(head / clip.durationSec) * 100}%` }} />
        </div>
      )}
    </div>
  );
}
