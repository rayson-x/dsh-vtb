import sharp from 'sharp';
import {readFile,writeFile} from 'node:fs/promises';
for(const run of process.argv.slice(2)) {
 const r=JSON.parse(await readFile(`scripts/track-qa/run-${run}.json`,'utf8'));
 const samples=(await readFile(`scripts/track-qa/shots-${run}/shots.jsonl`,'utf8')).trim().split('\n').map(JSON.parse);
 const observed=samples.flatMap(s=>s.observed?.events??[]);
 const audioStart=s=>{ const o=observed.filter(o=>o.type==='audio'&&s.audio&&new URL(o.src).pathname===s.audio).sort((a,b)=>Math.abs(a.at-s.startedAt)-Math.abs(b.at-s.startedAt))[0];return o?o.at-o.currentTime*1000/o.rate:s.startedAt; };
 const start=r.openedAt,end=r.finishedAt,width=1800,left=330,scale=(width-left-30)/(end-start);
 const x=t=>left+(t-start)*scale;
 const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
 const speech=r.subtitles.filter(s=>s.startedAt+s.ms>=start&&s.startedAt<=end);
 const entered = new Set(r.traces.filter(t=>t.title==='画面轨执行').map(t=>JSON.parse(t.body)).filter(t=>t.phase==='enter'&&t.ok).map(t=>t.id));
 for(const v of r.tracks[0]?.visual??[])if(v.status==='active'&&v.enter.firedAt!==undefined)entered.add(v.id);
 const clips=[...new Map(r.tracks.flatMap(t=>t.visual.map(v=>[v.id,v]))).values()].filter(v=>entered.has(v.id)&&v.enter.firedAt<=end&&(v.exit.firedAt??end)>=start);
 const speechHeight=s=>Math.max(30,Math.ceil([...s.text].length/23)*16+24);
 const height=190+speech.reduce((n,s)=>n+speechHeight(s),0)+clips.length*42;
 const lines=[`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#faf9f5"/><g font-family="sans-serif" font-size="13" fill="#252c32"><text x="18" y="25" font-size="20">历史第${run}轮 · 说话轨 / 画面轨（秒）· 指纹${r.productVersion?.slice(0,12)??'未记录'}</text>`];
 for(let t=0;t<=(end-start)/1000;t+=15)lines.push(`<path d="M${x(start+t*1000)} 45V${height}" stroke="#ddd"/><text x="${x(start+t*1000)}" y="43">${t}</text>`);
 for(const e of r.events.filter(e=>['revision','retraction'].includes(e.kind)))lines.push(`<path d="M${x(e.at)} 45V${height}" stroke="#c45848" stroke-dasharray="5 4"/><text x="${x(e.at)+3}" y="60" fill="#a23d30">${esc((e.kind==='revision'?'改写 ':'撤回 ')+e.id)}</text>`);
 let y=85;
 for(const s of speech){
   const a=Math.max(start,audioStart(s)),b=Math.min(end,s.endedAt??audioStart(s)+s.ms),h=speechHeight(s);
   lines.push(`<text x="10" y="${y+12}" fill="#4d6978">${esc(s.id)}${s.audio?'':'（无声估时）'} · ${((a-start)/1000).toFixed(1)}—${((b-start)/1000).toFixed(1)}s</text>`);
   const chars=[...s.text]; for(let i=0;i<chars.length;i+=23)lines.push(`<text x="10" y="${y+29+i/23*16}">${esc(chars.slice(i,i+23).join(''))}</text>`);
   lines.push(`<rect x="${x(a)}" y="${y+5}" width="${Math.max(1,x(b)-x(a))}" height="20" fill="${s.audio?'#5a8093':'#aaa'}"/><text x="${x(a)+3}" y="${y+19}" fill="white">${esc(s.id)}</text><path d="M10 ${y+h-5}H${width}" stroke="#e4e4dd"/>`); y+=h;
 }
 lines.push(`<text x="10" y="${y+20}" font-size="17">画面轨：进场—退场 / 橙点为效果</text>`);y+=35;
 for(const v of clips){const a=Math.max(start,observed.find(o=>o.type==='enter'&&o.id===v.id)?.at??v.enter.firedAt),b=v.exit.firedAt??end;const label=v.enter.command.text?.trim()||v.enter.command.rows?.map(r=>r.label).join(' / ')||v.enter.command.kind||v.id;lines.push(`<text x="10" y="${y+10}" font-size="10" fill="#637166">${v.enter.firedAt<start?'续 ':''}${esc(v.id)}</text><text x="10" y="${y+27}">${esc([...String(label)].slice(0,23).join(''))}</text><rect x="${x(a)}" y="${y}" width="${Math.max(2,x(Math.min(end,b))-x(a))}" height="18" fill="${v.status==='void'?'#ac8e7c':'#56886c'}"/><circle cx="${x(a)}" cy="${y+9}" r="3" fill="#183f2a"/><path d="M${x(Math.min(end,b))} ${y-2}v22" stroke="#183f2a"/>`);for(const p of v.effects)if(p.firedAt)lines.push(`<circle cx="${x(p.firedAt)}" cy="${y+9}" r="5" fill="#dc9230"/>`);y+=42;}
 lines.push('</g></svg>');await sharp(Buffer.from(lines.join(''))).png().toFile(`scripts/track-qa/timeline-${run}.png`);
 console.log({run,speech:speech.length,clips:clips.length});
}
