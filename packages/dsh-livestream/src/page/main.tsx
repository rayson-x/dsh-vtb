/** 舞台页入口：OBS 浏览器源打开的就是这个 */

import { useEffect, useState, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import {setPlaying} from './mouth';
import type {Subtitle as SubtitleData} from '../stage/protocol';
import { SET_IDS } from '../stage/sets';
import { Stage } from './Stage';
import { useNow, useStage } from './useStage';
import { useSfx } from './sfx';
import { useAudioBlocked, useVoice, setAudioBlocked, audioContext } from './voice';
import { useProgrammeRecording } from './recording';

function App() {
  const [sceneUrl, setSceneUrl] = useState<string>();
  const frame=useRef<HTMLIFrameElement>(null);
  useProgrammeRecording(frame, sceneUrl);
  const [voice,setVoice]=useState<{subtitle:SubtitleData;playing:boolean}|null>(null);
  const actualMediaTime=useRef(0);
  useEffect(()=>{
    const receive=(event:MessageEvent)=>{
      if(!sceneUrl||event.origin!==sceneUrl||event.source!==frame.current?.contentWindow||event.data?.type!=='aivtb-v2-voice')return;
      const data=event.data;if(typeof data.partId!=='string')return;
      if(data.kind==='blocked'){setAudioBlocked(true);return;}
      if(data.kind==='playing')setAudioBlocked(false);
      if(['ended','aborted','error'].includes(data.kind)){setAudioBlocked(false);setVoice(null);setPlaying(undefined);return;}
      if(Number.isFinite(data.mediaTimeMs))actualMediaTime.current=data.mediaTimeMs;
      if(data.kind==='playing'&&typeof data.text==='string'){setPlaying({id:data.partId,ms:()=>actualMediaTime.current});setVoice({playing:true,subtitle:{id:data.partId,text:data.text,startedAt:Date.now()-actualMediaTime.current,ms:Number(data.ms)||1000,...(Array.isArray(data.starts)?{starts:data.starts}:{})}});}
      if(data.kind==='pause')setVoice(previous=>previous?{...previous,playing:false}:null);
    };
    window.addEventListener('message',receive);return()=>{window.removeEventListener('message',receive);setPlaying(undefined);};
  },[sceneUrl]);
  useEffect(() => {
    const controller = new AbortController();
    const check = async () => {
      try {
        const response = await fetch('/harness' + location.search, { signal: controller.signal });
        if (!response.ok) return;
        const data = await response.json();
        const url = data.sceneUrl ? new URL(data.sceneUrl) : undefined;
        setSceneUrl(data.mode === 'v2' && url?.protocol === 'http:' && url.hostname === '127.0.0.1' ? url.origin : undefined);
      } catch { /* A disconnected stage keeps its last image. */ }
    };
    void check(); const timer = setInterval(() => void check(), 2000);
    return () => { controller.abort(); clearInterval(timer); };
  }, []);
  const live = useStage();
  const now = useNow(live.offset);
  const presented=useMemo(()=>sceneUrl&&live.state?{...live.state,subtitle:voice?.subtitle??null,avatar:{...live.state.avatar,speaking:voice?.playing??false}}:live.state,[sceneUrl,live.state,voice]);
  useVoice(sceneUrl?null:live.state);
  useSfx(presented);
  const blocked = useAudioBlocked();
  if (!presented) return null;
  return (
    <>
      <Stage state={presented} now={now}
        programme={sceneUrl ? <iframe ref={frame} title="节目场景" referrerPolicy="origin" src={sceneUrl} allow="autoplay" style={{ width: '100%', height: '100%', border: 0, display: 'block', background: 'transparent' }} /> : undefined} />
      {/* 浏览器拦着不让出声：提示点一下（点了就消失）。OBS 浏览器源、带自动播放参数的窗口不会出现 */}
      {blocked && <div className="audio-blocked" onPointerDown={()=>{void audioContext().resume();frame.current?.contentWindow?.postMessage({type:'aivtb-audio-unlock'},sceneUrl??location.origin);}}>🔇 点一下页面开声音</div>}
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
