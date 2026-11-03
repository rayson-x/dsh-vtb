/** Visual scenes may analyse audio, but audible output belongs to the programme bus. */
export function blockUntrackedAudio(report: (message:string)=>void) {
  const message='UNTRACKED_SCENE_AUDIO: route sound through the programme AudioBus';
  const fail=()=>{report(message);throw Error(message);};
  const play=HTMLMediaElement.prototype.play;
  Object.defineProperty(HTMLMediaElement.prototype,'play',{configurable:false,writable:false,value:function(this:HTMLMediaElement){
    if(!this.muted&&this.volume>0){try{this.pause();}catch{}try{fail();}catch(error){return Promise.reject(error);}}
    return play.call(this);
  }});
  for(const key of ['muted','volume']){
    const descriptor=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,key);
    if(!descriptor?.get||!descriptor.set)continue;
    Object.defineProperty(HTMLMediaElement.prototype,key,{configurable:false,get:descriptor.get,set:function(this:HTMLMediaElement,value:unknown){
      const audible=key==='muted'?!value&&this.volume>0:Number(value)>0&&!this.muted;
      if(audible&&!this.paused){this.pause();fail();}
      descriptor.set!.call(this,value);
    }});
  }
  const autoplay=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'autoplay');
  if(autoplay?.get&&autoplay.set)Object.defineProperty(HTMLMediaElement.prototype,'autoplay',{configurable:false,get:autoplay.get,set:function(this:HTMLMediaElement,value:unknown){if(value&&!this.muted&&this.volume>0)fail();autoplay.set!.call(this,value);}});
  const attribute=HTMLMediaElement.prototype.setAttribute;
  Object.defineProperty(HTMLMediaElement.prototype,'setAttribute',{configurable:false,writable:false,value:function(this:HTMLMediaElement,name:string,value:string){if(name.toLowerCase()==='autoplay'&&!this.muted&&this.volume>0)fail();return attribute.call(this,name,value);}});
  const inspect=(root:Node)=>{
    const media:HTMLMediaElement[]=[];
    if(root instanceof HTMLMediaElement)media.push(root);
    if(root instanceof Element)media.push(...root.querySelectorAll<HTMLMediaElement>('audio,video'));
    for(const element of media)if(!element.muted&&element.volume>0&&element.autoplay){element.pause();element.muted=true;report(message);}
  };
  const observer=new MutationObserver(records=>{for(const record of records){record.addedNodes.forEach(inspect);if(record.type==='attributes')inspect(record.target);}});
  observer.observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['autoplay','src','muted']});
  inspect(document.documentElement);
  const connect=AudioNode.prototype.connect;
  Object.defineProperty(AudioNode.prototype,'connect',{configurable:false,writable:false,value:function(this:AudioNode,...args:unknown[]){
    const destination=args[0];
    if(destination instanceof AudioDestinationNode&&!(destination.context instanceof OfflineAudioContext))fail();
    return Reflect.apply(connect,this,args);
  }});
}
// Capture native source before any generated module can modify Window intrinsics.
export const AUDIO_POLICY_SCRIPT=Function.prototype.toString.call(blockUntrackedAudio);
