export interface QuickAckContext {epoch:number;inputId:string;text:string;topic:string;heard:string;instructions:string[];recentHeard?:unknown;visualStatus?:string}
export interface QuickAckPorts {
  context(id:string):QuickAckContext|undefined;
  reserve(id:string):()=>void;
  generate(context:QuickAckContext,signal:AbortSignal):Promise<string>;
  offer(id:string,text:string,epoch:number):Promise<{ok:boolean}>;
  fallback(id:string):void;
}
function usefulAcknowledgement(text:string,input:string){
  const plain=text.replace(/[\s，,。！？!?；;？：“”"'「」]/g,'');
  if([...plain].length<4||input.replace(/[\s，,。！？!?；;？：“”"'「」]/g,'').includes(plain))return false;
  if (/^(这个问题|这问题|问题)(问得)?(很|真)?(好|有意思)/.test(plain)) return false;
  return !/^(好的|收到|我看看|我想想|这(个问题|个|问题)(很|真)?(好|不错|有意思))$/.test(plain)&&!/问题(问得)?(真|很)?好[啊呀呢]*$/.test(plain);
}
/** Sentence punctuation is safe; early commas additionally require a grounded affirmative predicate. */
export function firstAcknowledgementClause(output:string,input:string){
  const source=input.replace(/^[^:：]{1,24}[:：]/,'').split(/[?？。!！]/,1)[0].replace(/[\s，,：:]/g,'');
  const ignored=new Set(['可以','一下','一点','这个','那个','我们','你们','刚才','我想','是否','好吗','怎么','什么','你的','回应','节奏','继续','主意','不错']);
  const points=[...source],words=points.slice(1).map((c,i)=>points[i]+c).filter(w=>!ignored.has(w));
  for(const match of output.matchAll(/[，,：:。！？!?；;]/g)){
    const clause=output.slice(0,match.index!+1).trim(),plain=clause.replace(/[\s，,。！？!?；;：:]/g,'');
    if([...plain].length<5||[...clause].length>28||!usefulAcknowledgement(clause,input))continue;
    if(/[，,：:]/.test(match[0])){
      if([...clause].length>18||!/(可以|合适|同意|记下|记着|留在|留给|放在|放到|摆在|摆到|好主意|不错)/.test(plain)||/[的得地把被给在到和与但而或就先再却也还]$/.test(plain)||!words.some(w=>plain.includes(w)))continue;
      return clause.slice(0,-1)+'。';
    }
    return clause;
  }
}
/** Event-driven, one-shot speech generation; never an idle filler loop. */
export class QuickAcknowledgements {
  private enabled=true;
  private readonly jobs=new Map<string,{controller:AbortController;promise:Promise<void>;epoch:number}>();
  constructor(private readonly ports:QuickAckPorts){}
  submit(id:string){
    const context=this.ports.context(id);
    if(!this.enabled||!context||this.jobs.has(id)||this.jobs.size>=2)return false;
    const controller=new AbortController(),reserved=this.ports.reserve(id);let released=false;
    const release=()=>{if(!released){released=true;reserved();}};
    const promise=Promise.resolve().then(async()=>{
      if(controller.signal.aborted){release();this.jobs.delete(id);return;}
      const timer=setTimeout(()=>controller.abort('deadline'),4000);timer.unref?.();
      let rejectAbort!:()=>void;
      const cancelled=new Promise<never>((_,reject)=>{rejectAbort=()=>reject(Error('ack cancelled'));controller.signal.addEventListener('abort',rejectAbort,{once:true});});
      try{
        const result=await Promise.race([this.ports.generate(context,controller.signal),cancelled]);
        if(controller.signal.aborted||!this.enabled||this.ports.context(id)?.epoch!==context.epoch)return;
        const text=result.trim().replace(/^[“「"]|[”」"]$/g,'').trim();
        if(!text||/[，,：:]$/.test(text)||[...text].length>32||/[\n`]|\[\[/.test(text)||!usefulAcknowledgement(text,context.text)||/^(收到|好的|嗯|我想想|我看看|稍等|等一下)[。！!…\s]*$/.test(text))throw Error('not a grounded short response');
        if(!(await this.ports.offer(id,text,context.epoch)).ok)throw Error('ack not accepted');
      }catch{
        release();
        if(this.enabled&&this.ports.context(id)?.epoch===context.epoch&&(!controller.signal.aborted||controller.signal.reason==='deadline'))this.ports.fallback(id);
      }finally{clearTimeout(timer);controller.signal.removeEventListener('abort',rejectAbort);release();this.jobs.delete(id);}
    });
    this.jobs.set(id,{controller,promise,epoch:context.epoch});return true;
  }
  setEnabled(enabled:boolean){this.enabled=enabled;if(!enabled)for(const job of this.jobs.values())job.controller.abort('disabled');}
  cancelStale(){for(const[id,job]of this.jobs)if(this.ports.context(id)?.epoch!==job.epoch)job.controller.abort('stale');}
  async stop(){this.setEnabled(false);await Promise.all([...this.jobs.values()].map(job=>job.promise));}
}
