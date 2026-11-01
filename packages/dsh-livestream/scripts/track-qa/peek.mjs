/** 读取当前轨迹的短摘要，不打印凭据或后台资料。 */
let buffer='',items=[];
try {
 const r=await fetch('http://127.0.0.1:3823/trace',{signal:AbortSignal.timeout(1000)});
 for await(const b of r.body){buffer+=new TextDecoder().decode(b);let end;
 while((end=buffer.indexOf('\n\n'))>=0){const f=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=f.split('\n').filter(l=>l.startsWith('data: ')).map(l=>l.slice(6)).join('\n');if(data){const d=JSON.parse(data);if(d.items)items.push(...d.items);}}}
}catch{}
console.log(items.filter(t=>t.title==='画面导演'||t.title==='画面导演错误').slice(-4));
const r=await fetch('http://127.0.0.1:3823/tracks').then(r=>r.json());
console.log({speech:r.speech.length,clips:r.visual.reduce((a,v)=>(a[v.status]=(a[v.status]??0)+1,a),{})});
