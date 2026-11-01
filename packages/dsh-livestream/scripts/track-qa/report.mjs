/** 只生成历史证据清单；旧轮次不能冒充当前代码或集成产品最终通过。 */
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const base='scripts/track-qa/';
const hash=createHash('sha256');
for(const path of ['src/host/controller.ts','src/host/timeline.ts','src/host/track.ts','src/host/crew/director.ts','src/host/stagehost.ts','src/dsh/agent.ts','src/stage/cues.ts','src/page/control.tsx']) hash.update(await readFile(path));
const currentFingerprint=hash.digest('hex');
const runs=[];
for(const file of (await readdir(base)).filter(n=>/^verdict-\d+\.json$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]))) {
 const v=JSON.parse(await readFile(base+file,'utf8'));
 runs.push({run:v.run,sourceFingerprint:v.productVersion??null,sameAsCurrentCode:v.productVersion===currentFingerprint,historicalPassed:v.passed,checks:v.checks,word:v.word,timely:v.timely,cross:v.cross,edits:v.edits,orphan:v.orphan?.length,hostMarkers:v.forbidden?.length,sparseSpans:v.legacy?.sparseSpans??[],realGap:v.realGap,voiceFallbacks:v.voiceFallbacks});
}
const result={status:'未独立完成连续三轮，最终由协调者统一同版本验收接管',currentFingerprint,finalAcceptance:'集成产品同一版本连续三轮，每轮团队开6分钟、关1分钟，同时覆盖plan和track全部门槛；本脚本不运行长测、不判定最终通过',validationEvidence:{note:'本清单不执行检查或推断通过；检查结论与对应源码指纹见track-report.md，原始日志留磁盘',logs:['final-focused.log','final-unit.log','final-types.log','final-build.log','final-diff-check.log']},historicalRuns:runs,interruptedRun9:'只有30帧截图元数据与联系表，没有完整raw/判定；见interrupted-9.json',evidence:'raw JSON、历史失败、截图联系表、时间轴PNG和日志仅留磁盘；不把旧版本成功样本当作当前代码通过证据'};
await writeFile(base+'handoff-summary.json',JSON.stringify(result,null,2));
console.log({status:result.status,currentFingerprint,historicalRuns:runs.length,output:base+'handoff-summary.json'});
