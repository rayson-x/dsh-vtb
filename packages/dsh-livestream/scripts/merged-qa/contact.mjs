import sharp from 'sharp';
import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
for(const run of process.argv.slice(2)) {
 const dir=resolve(`scripts/merged-qa/shots-${run}`), out=resolve(`scripts/merged-qa/contact-${run}`);
 await mkdir(out,{recursive:true});
 const files=(await readdir(dir)).filter(s=>s.endsWith('.jpg')).sort();
 await writeFile(`${out}/frames.json`, JSON.stringify(files.map((name,i)=>({frame:i+1,at:Number(name.slice(0,-4)),name})),null,2));
 for(let from=0;from<files.length;from+=12) {
  const layers=[];
  for(const [i,name] of files.slice(from,from+12).entries()) {
   const at=Number(name.slice(0,-4)), label=`${from+i+1}  ${new Date(at).toISOString().slice(11,19)} UTC`;
   const thumb=await sharp(`${dir}/${name}`).resize(480,270).toBuffer();
   const text=Buffer.from(`<svg width="480" height="24"><rect width="480" height="24" fill="white"/><text x="8" y="17" font-size="15" fill="black">${label}</text></svg>`);
   layers.push({input:thumb,left:i%3*480,top:Math.floor(i/3)*294},{input:text,left:i%3*480,top:Math.floor(i/3)*294+270});
  }
  await sharp({create:{width:1440,height:Math.ceil(Math.min(12,files.length-from)/3)*294,channels:3,background:'#ddd'}}).composite(layers).jpeg({quality:85}).toFile(`${out}/${String(from/12+1).padStart(2,'0')}.jpg`);
 }
 console.log({run,shots:files.length,contact:out});
}
