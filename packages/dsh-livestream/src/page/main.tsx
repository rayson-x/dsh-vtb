/** 舞台页入口：OBS 浏览器源打开的就是这个 */

import { createRoot } from 'react-dom/client';
import { SET_IDS } from '../stage/sets';
import { Stage } from './Stage';
import { useNow, useStage } from './useStage';
import { useSfx } from './sfx';
import { useAudioBlocked, useVoice } from './voice';

function App() {
  const live = useStage();
  const now = useNow(live.offset);
  useVoice(live.state);
  useSfx(live.state);
  const blocked = useAudioBlocked();
  if (!live.state) return null;
  return (
    <>
      <Stage state={live.state} now={now} />
      {/* 浏览器拦着不让出声：提示点一下（点了就消失）。OBS 浏览器源、带自动播放参数的窗口不会出现 */}
      {blocked && <div className="audio-blocked">🔇 点一下页面开声音</div>}
    </>
  );
}

// 每个布景的皮（sets/<id>/set.css，在 .stage[data-set=id] 下覆盖变量）；没有这个文件的布景用默认值
for (const id of SET_IDS) {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `/sets/${id}/set.css${location.search}`;
  document.head.appendChild(link);
}

createRoot(document.getElementById('root')!).render(<App />);
