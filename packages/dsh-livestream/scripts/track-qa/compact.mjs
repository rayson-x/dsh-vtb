/** 合并完全相同的连续采样，保留首末时刻和原始样本数，减少重复JSON。 */
import {readFile,writeFile} from 'node:fs/promises';
for(const run of process.argv.slice(2)) {
 const path=`scripts/track-qa/run-${run}.json`, r=JSON.parse(await readFile(path,'utf8'));
 const tracks=[];let prior;
 for(const t of r.tracks){const key=JSON.stringify({speech:t.speech,visual:t.visual});if(key===prior){tracks.at(-1).until=t.until??t.now;tracks.at(-1).samples+=(t.samples??1);}else{tracks.push({...t,until:t.until??t.now,samples:t.samples??1});prior=key;}}
 const before=r.tracks.length;r.tracks=tracks;await writeFile(path,JSON.stringify(r));console.log({run,before,after:tracks.length});
}
