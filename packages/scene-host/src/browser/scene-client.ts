import { BrowserSceneHost } from './host';
const nonce=location.hash.slice(1),origin=new URL(import.meta.url).origin;
const host=new BrowserSceneHost(document.getElementById('stage')!,event=>{if(event.type==='error')parent.postMessage({...event,source:'live-scene',nonce},origin);});
window.addEventListener('message',event=>{
 if(event.source!==parent||event.origin!==origin||event.data?.nonce!==nonce||event.data?.source!=='live-scene-host')return;
 const op=event.data;
 void(async()=>{
  try{let value:unknown;switch(op.type){
   case 'prepare':await host.setEpoch(op.epoch);value=await host.prepare(op.payload);break;
   case 'take':value=await host.take(op.payload.instanceId);break;
   case 'patch':value=await host.updateInputs(op.payload);break;
   case 'inspect':value=host.snapshot().scenes[0]??null;break;
   case 'hold':host.hold(op.payload.instanceId);break;
   case 'resume':host.resume(op.payload.instanceId);break;
   default:throw Error('Unsupported scene operation');
  }parent.postMessage({source:'live-scene',nonce,type:'result',opId:op.opId,ok:true,value:value??null},origin);
  }catch(error){parent.postMessage({source:'live-scene',nonce,type:'result',opId:op.opId,ok:false,error:String(error)},origin);}
 })();
});
