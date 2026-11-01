/** 每轮独立全过，且必须连续三轮；不能拿多数替代。 */
import {readFile,writeFile} from 'node:fs/promises';
const runs=process.argv.slice(2);
if(runs.length!==3)throw Error('必须给出三轮证据编号');
const rows=await Promise.all(runs.map(run=>readFile(`scripts/track-qa/verdict-${run}.json`,'utf8').then(JSON.parse)));
await writeFile('scripts/track-qa/strict.json',JSON.stringify(rows,null,2));
console.log(rows.map(r=>({run:r.run,passed:r.passed,checks:r.checks})));
if(new Set(rows.map(r=>r.productVersion)).size!==1||rows.some(r=>!r.passed))process.exitCode=1;
