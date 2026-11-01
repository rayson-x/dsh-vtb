const r=await fetch('http://127.0.0.1:3812/trace');const reader=r.body.getReader();let buffer=''; const d=new TextDecoder();
while(!buffer.includes('\n\n')) { const {value}=await reader.read(); buffer+=d.decode(value,{stream:true}); }
await reader.cancel();const j=JSON.parse(buffer.split('\n\n')[0].slice(6));
console.log(JSON.stringify(j.items.filter(x=>x.kind==='auto'||x.kind==='error'||x.kind==='call'&&x.title==='调用 speak').slice(-20),null,2));
