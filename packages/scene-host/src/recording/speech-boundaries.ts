export interface SpeechPauseWindow {fromMs:number;toMs:number;firstUnreadChar:number}
/** Only an observed pause between punctuation and the next timed word is usable. */
export function speechPauseWindows(text:string,starts:readonly number[]):SpeechPauseWindow[]{
  const chars=[...text],windows:SpeechPauseWindow[]=[];
  if(starts.length>chars.length||starts.some((at,i)=>!Number.isFinite(at)||at<0||(i>0&&at<starts[i-1])))return windows;
  for(let i=0;i<starts.length;i++){
    if(!/[，,。！？!?；;：:\n]/.test(chars[i]))continue;
    let next=i+1;while(next<chars.length&&/[\s，,。！？!?；;：:」』”’)]/.test(chars[next]))next++;
    if(next>=starts.length)continue;
    const fromMs=starts[i]+10,toMs=starts[next]-10;
    if(toMs-fromMs>=10)windows.push({fromMs,toMs,firstUnreadChar:next});
    i=next-1;
  }
  return windows;
}
