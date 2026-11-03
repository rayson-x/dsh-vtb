import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction';
type Session = Parameters<typeof toolPairingBalancedBefore>[0];
const HEAD = '【岗位工程便签】';
const lastUnique=(items:string[])=>[...new Set([...items].reverse())].reverse();
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const visibleBytes = (event: {type:string;data:any}) => bytes(event.type==='user/message' ? event.data : event.data?.message ?? event.data);
function compact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.slice(0, 240);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return Array.isArray(value) ? `[${value.length} items; read latest brief]` : '[read latest brief]';
  if (Array.isArray(value)) return value.slice(-4).map(v => compact(v, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 18).map(([k,v]) => [k,compact(v,depth+1)]));
}
/** Bound only the model surface; immutable session history and programme facts remain intact. */
export function boundRoleContext(session: Session, brief: unknown, budgetBytes = 96000) {
  const rows = session.surface.nodes.map(seq => ({seq,event:session.eventAt(seq)})).filter(row => !!row.event);
  const totalBytes = rows.reduce((n,row) => n + visibleBytes(row.event!),0);
  if (totalBytes <= budgetBytes && rows.length <= 160) return { changed:false,bytes:totalBytes };
  const requests:string[]=[],constraints:string[]=[];
  const remember=(text:string)=>{if(text.startsWith('主人：'))constraints.push(text);else if(!text.startsWith('现场观察点：'))requests.push(text.slice(0,700));};
  for (const row of rows) if (row.event?.type==='user/message') {
    const text=row.event.data.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
    if(text.startsWith(HEAD)) {
      try { const prior=JSON.parse(text.slice(text.indexOf('\n')+1));(prior.requests??[]).forEach(remember);constraints.push(...(prior.masterConstraints??[])); } catch {}
    } else remember(text);
  }
  const data = brief as {epoch?:number;role?:string;brief?:unknown;candidates?:unknown;masterNotes?:Array<{text:string}>};
  for(const note of data.masterNotes??[])constraints.push('主人：'+note.text);
  const note=HEAD+'：完整历史保留在日志；工程事实以当前岗位读取工具为准，不重演已播内容。主人指令按时间理解；一次性请求完成后不重复，新授权方向优先于旧准备建议。\n'+JSON.stringify({epoch:data.epoch,role:data.role,masterConstraints:lastUnique(constraints),requests:lastUnique(requests).slice(-8),facts:compact(data.brief),candidates:compact(data.candidates)});
  if(bytes(note)>budgetBytes*.8)throw Error('Standing master instructions exceed this role context budget; retained in the session and master notes');
  const first=rows.findIndex(row=>row.event?.type!=='system/message'&&toolPairingBalancedBefore(session,row.seq));
  if(first<0)return {changed:false,bytes:totalBytes};
  let keepBytes=0,keepStart=rows.length;
  while(keepStart>first&&rows.length-keepStart<24&&keepBytes+visibleBytes(rows[keepStart-1].event!)<Math.max(0,budgetBytes-bytes(note)-8000)){keepStart--;keepBytes+=visibleBytes(rows[keepStart].event!);}
  let end=-1;
  for(let i=Math.min(rows.length-1,keepStart-1);i>=first;i--)if(toolPairingBalancedAfter(session,rows[i].seq)){end=i;break;}
  if(end<first) for(let i=rows.length-1;i>=first;i--)if(toolPairingBalancedAfter(session,rows[i].seq)){end=i;break;}
  if(end<first)throw Error('Context budget reached during an unfinished tool exchange');
  const dropped=rows.slice(first,end+1);
  session.append('user/message',createUserMessage({content:[{type:'text',text:note}],source:{kind:'user'}}),{surfaceOp:{op:'replace',startSeq:dropped[0].seq,endSeq:dropped.at(-1)!.seq},sourceEventSeqs:dropped.map(row=>row.seq)});
  return {changed:true,bytes:session.surface.nodes.reduce((n,seq)=>n+visibleBytes(session.eventAt(seq)!),0),dropped:dropped.length};
}
