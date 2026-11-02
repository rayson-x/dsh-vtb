import type { LiveScenePackage } from './host';
type Slot = { pkg: LiveScenePackage; frame: HTMLIFrameElement; nonce: string; phase: 'preview' | 'program' | 'held'; state: Record<string, any>; pending: Map<string,{resolve(v:any):void;reject(e:Error):void;timer:ReturnType<typeof setTimeout>}>; loaded: Promise<void> };
const paint = () => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
/** Generated code never shares a realm/origin with the playback transport or control console. */
export class IsolatedSceneHost {
  private readonly slots = new Map<string,Slot>();
  private epoch = 0;
  private program?: string;
  private readonly startedAt = performance.now();
  constructor(private readonly root: HTMLElement, private readonly emit: (event: Record<string,unknown>)=>void) { window.addEventListener('message',this.receive); }
  now() { return performance.now()-this.startedAt; }
  private receive = (event: MessageEvent) => {
    if (event.origin !== 'null') return;
    const slot=[...this.slots.values()].find(s=>s.frame.contentWindow===event.source);
    if(!slot||event.data?.nonce!==slot.nonce||event.data?.source!=='live-scene')return;
    const data=event.data;
    if(data.type==='result'){
      const pending=slot.pending.get(data.opId);if(!pending)return;slot.pending.delete(data.opId);clearTimeout(pending.timer);
      if(data.ok===false)pending.reject(Error(String(data.error)));else {if(data.value&&typeof data.value==='object')slot.state=data.value;pending.resolve(data.value);}
    } else if(data.type==='error')this.emit({type:'error',instanceId:slot.pkg.instanceId,epoch:slot.pkg.directionEpoch,error:String(data.error)});
  };
  private require(id:string){const slot=this.slots.get(id);if(!slot||slot.pkg.directionEpoch!==this.epoch)throw Error('Unknown/stale scene');return slot;}
  private async call(slot:Slot,type:string,payload:unknown={}){
    await slot.loaded;if(!this.slots.has(slot.pkg.instanceId))throw Error('Scene retired');
    const opId=crypto.randomUUID();
    return new Promise<any>((resolve,reject)=>{
      const timer=setTimeout(()=>{slot.pending.delete(opId);reject(Error(`Scene ${type} timeout`));},20000);
      slot.pending.set(opId,{resolve,reject,timer});slot.frame.contentWindow!.postMessage({source:'live-scene-host',nonce:slot.nonce,opId,type,epoch:this.epoch,payload},'*');
    });
  }
  async setEpoch(epoch:number){
    if(!Number.isSafeInteger(epoch)||epoch<this.epoch)throw Error('Stale epoch');this.epoch=epoch;
    for(const [id,slot]of this.slots)if(slot.pkg.directionEpoch!==epoch)await this.dispose(id);
  }
  async prepare(pkg:LiveScenePackage){
    if(pkg.directionEpoch!==this.epoch||this.slots.has(pkg.instanceId))throw Error('Stale/duplicate scene');
    if(this.slots.size>=2)throw Error('Standby full');
    const frame=document.createElement('iframe');frame.sandbox.add('allow-scripts');frame.title='节目画面';
    frame.style.cssText='position:absolute;inset:0;width:100%;height:100%;border:0;opacity:0;pointer-events:none';
    const nonce=crypto.randomUUID();
    let resolveLoad!:()=>void,rejectLoad!:(e:Error)=>void;
    const loaded=new Promise<void>((resolve,reject)=>{resolveLoad=resolve;rejectLoad=reject;});
    const timer=setTimeout(()=>rejectLoad(Error('Scene document timeout')),15000);
    frame.onload=()=>{clearTimeout(timer);resolveLoad();};frame.onerror=()=>{clearTimeout(timer);rejectLoad(Error('Scene document load failed'));};
    const slot:Slot={pkg,frame,nonce,phase:'preview',state:{},pending:new Map(),loaded};this.slots.set(pkg.instanceId,slot);
    frame.src='/scene.html#'+nonce;this.root.append(frame);
    try{return await this.call(slot,'prepare',pkg);}catch(error){await this.dispose(pkg.instanceId);throw error;}
  }
  async take(id:string){
    const slot=this.require(id);if(slot.phase!=='preview')throw Error('Not standby');
    const previous=this.program;const result=await this.call(slot,'take',{instanceId:id});
    this.require(id);slot.frame.style.opacity='1';slot.phase='program';this.program=id;await paint();
    if(this.program!==id)throw Error('Take superseded');
    this.emit({type:'painted',operation:'take',instanceId:id,codeVersion:slot.pkg.codeVersion,epoch:this.epoch,showTime:this.now()});
    if(previous&&previous!==id)await this.dispose(previous);return result;
  }
  async updateInputs(input:any){const slot=this.require(input.instanceId);const result=await this.call(slot,'patch',input);this.emit({type:'painted',operation:'patch',instanceId:input.instanceId,codeVersion:slot.pkg.codeVersion,epoch:this.epoch,inputsRevision:result.inputsRevision,showTime:this.now()});return result;}
  async hold(id:string){const s=this.require(id);await this.call(s,'hold',{instanceId:id});s.phase='held';}
  async resume(id:string){const s=this.require(id);await this.call(s,'resume',{instanceId:id});s.phase='program';}
  async dispose(id:string){const s=this.slots.get(id);if(!s)return;this.slots.delete(id);for(const p of s.pending.values()){clearTimeout(p.timer);p.reject(Error('Scene retired'));}s.pending.clear();s.frame.remove();if(this.program===id)this.program=undefined;}
  async inspect(){for(const slot of this.slots.values())await this.call(slot,'inspect');return this.snapshot();}
  snapshot(){return{epoch:this.epoch,showTime:this.now(),program:this.program,scenes:[...this.slots.values()].map(s=>({...s.state,instanceId:s.pkg.instanceId,codeVersion:s.pkg.codeVersion,phase:s.phase}))};}
  async close(){window.removeEventListener('message',this.receive);for(const id of [...this.slots.keys()])await this.dispose(id);}
}
export const createBrowserSceneHost=(root:HTMLElement,emit:(event:Record<string,unknown>)=>void)=>new IsolatedSceneHost(root,emit);
