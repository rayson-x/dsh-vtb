import type { ServerResponse } from 'node:http';
/** One bounded, replay-from-start stream for the current/prefetched speech item. */
export class ProgressiveAudio {
  private readonly chunks:Uint8Array[]=[];
  private readonly wake=new Set<()=>void>();
  private complete=false;
  private error?:Error;
  private clients=0;
  bytes=0;
  append(chunk:Uint8Array){
    if(this.complete)throw Error('Audio stream is already closed');
    if(!chunk.length)return;
    if(this.bytes+chunk.length>16*1024*1024)throw Error('Speech stream exceeds the bounded audio buffer');
    this.bytes+=chunk.length;this.chunks.push(chunk);this.notify();
  }
  finish(){this.complete=true;this.notify();}
  fail(){this.error=Error('Programme audio stream failed');this.complete=true;this.notify();}
  private notify(){for(const wake of this.wake)wake();this.wake.clear();}
  async serve(res:ServerResponse){
    if(this.clients>=4){res.writeHead(429).end();return;}this.clients++;
    res.writeHead(200,{'content-type':'audio/mpeg','cache-control':'no-store','access-control-allow-origin':'*','x-content-type-options':'nosniff','accept-ranges':'none'});
    let index=0;
    const closed=()=>this.notify();res.on('close',closed);
    try{
      while(!res.destroyed){
        if(this.error){res.destroy(this.error);return;}
        if(index<this.chunks.length){
          if(!res.write(this.chunks[index++]))await new Promise<void>(done=>{const finish=()=>{res.off('drain',finish);res.off('close',finish);done();};res.once('drain',finish);res.once('close',finish);});
        }else if(this.complete){res.end();return;}
        else await new Promise<void>(done=>this.wake.add(done));
      }
    }finally{res.off('close',closed);this.clients--;}
  }
}
