import {readFile,writeFile} from 'node:fs/promises';
const runs=process.argv.slice(2),base='scripts/merged-qa/';
if(runs.length!==3||runs.some(r=>!/^\d+$/.test(r))||runs.some((r,i)=>i&&Number(r)!==Number(runs[i-1])+1))throw Error('必须提供连续三个数字证据编号');
const rows=await Promise.all(runs.map(run=>readFile(`${base}verdict-${run}.json`,'utf8').then(JSON.parse)));
const passed=rows.every(r=>r.passed)&&new Set(rows.map(r=>r.productVersion)).size===1;
await writeFile(base+'strict.json',JSON.stringify({passed,runs,productVersion:passed?rows[0].productVersion:undefined,rows},null,2));
console.log(JSON.stringify({passed,rows:rows.map(r=>({run:r.run,passed:r.passed,failed:{plan:Object.keys(r.plan).filter(k=>!r.plan[k]),track:Object.keys(r.track).filter(k=>!r.track[k]),guard:Object.keys(r.guard).filter(k=>!r.guard[k])}}))},null,2));
if(!passed)process.exitCode=1;
