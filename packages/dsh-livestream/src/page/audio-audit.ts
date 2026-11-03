/** Observe native media outside our explicit mix; never silently omit it from capture. */
const routed=new WeakSet<HTMLMediaElement>(),watched=new WeakSet<HTMLMediaElement>(),untracked=new Set<HTMLMediaElement>();
let active=false,violation=false;
export function routedProgrammeMedia(element:HTMLMediaElement){routed.add(element);untracked.delete(element);}
function watch(element:HTMLMediaElement){
 if(watched.has(element))return;watched.add(element);
 element.addEventListener('playing',()=>{if(!routed.has(element)&&!element.muted&&element.volume>0){untracked.add(element);if(active){violation=true;element.pause();}}});
 const remove=()=>untracked.delete(element);
 element.addEventListener('pause',remove);element.addEventListener('ended',remove);element.addEventListener('error',remove);
}
if(typeof HTMLMediaElement!=='undefined'){
 const nativePlay=HTMLMediaElement.prototype.play;
 HTMLMediaElement.prototype.play=function(){
  watch(this);
  if(!routed.has(this)&&!this.muted&&this.volume>0&&active){violation=true;return Promise.reject(Error('Unrouted programme media cannot play during recording'));}
  return nativePlay.call(this);
 };
 document.addEventListener('playing',event=>{if(event.target instanceof HTMLMediaElement){watch(event.target);if(!routed.has(event.target)&&!event.target.muted&&event.target.volume>0){untracked.add(event.target);if(active){violation=true;event.target.pause();}}}},true);
 const NativeAudio=window.Audio;
 window.Audio=new Proxy(NativeAudio,{construct(target,args,newTarget){const element=Reflect.construct(target,args,newTarget) as HTMLAudioElement;watch(element);return element;}});
}
export function beginAudioAudit(){
 if([...untracked].some(element=>!element.paused&&!element.ended&&!element.muted&&element.volume>0))throw Error('Unrouted media is playing; use the programme audio bus');
 violation=false;active=true;
}
export function endAudioAudit(){active=false;const valid=!violation;violation=false;return valid;}
