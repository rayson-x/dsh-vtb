import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const runs=process.argv.slice(2),base='scripts/merged-qa/';
const strict=spawnSync(process.execPath,[base+'strict.mjs',...runs],{encoding:'utf8'});
process.stdout.write(strict.stdout??'');process.stderr.write(strict.stderr??'');
if(strict.status)throw Error('未取得同版本连续三轮全部通过，不生成通过报告');
const rows=JSON.parse(await readFile(base+'strict.json','utf8')).rows;
const notes=JSON.parse(await readFile(base+'observations.json','utf8'));
for(const row of rows){
  const contacts=(await readdir(`${base}contact-${row.run}`)).filter(f=>f.endsWith('.jpg')).sort();
  const observations=notes[row.run];
  if(!contacts.length||!Array.isArray(observations)||observations.length!==contacts.length||observations.some(s=>typeof s!=='string'||!s.trim()))throw Error(`第${row.run}轮缺逐张联系表观察记录`);
  await readFile(`${base}timeline-${row.run}.png`);
}
const sec=n=>n==null?'缺证据':(n/1000).toFixed(3);
const link=(run,file)=>`../../packages/dsh-livestream/scripts/merged-qa/${file.replaceAll('{run}',run)}`;
const lines=[
  '# 黑板与画面轨统一验收报告','',
  '**同一产品版本连续三轮，各轮全部通过。** 只在严格判定与逐张观察齐全后生成本报告。','',
  `产品源码及构建指纹：\`${rows[0].productVersion}\`。指纹覆盖全部 src 与 lib 普通文件的路径和 SHA-256；每轮首尾、三轮之间一致。逐文件清单见 version-N.json。`,
  '', '## 验收范围与真实取证','',
  '这是 plan 与 track 两项的合并版本验收，不将旧副本通过轮次拼进新版本。每轮真实主播开口后保持团队开启至少六分钟，再关闭至少一分钟。约一分钟动态观众点题、三分钟礼物附言、四分半主人换泛化方向；另真实撤回一段尚未开口的排队话。没有注入主持人答案、模型画面计划或合成音频。',
  '', 'SSE保留字幕、执行、模型及编导工具轨迹；黑板每500ms读取、双轨每200ms读取，同状态压成带首末时刻及样本数的区间。覆盖检查算区间间空洞及起止边界，黑板空洞不得超过2秒、双轨不得超过1.5秒；任何轮询或SSE错误均失败。每五秒截图测DOM。浏览器仅观察真实 playing、媒体时间/倍速和组件首个至少2%可见的帧；不改播放/样式参数。',
  '', '接话员与主持人回应均以浏览器实际有声起点计时；冷场按真实有声区间计算，估时字幕不能掩盖静音。进场准点比较真实字音与浏览器首帧，目标±500ms、比例至少90%；缺媒体/首帧证据计不达标。声音元数据与真实播放覆盖均至少90%。',
  '', '旧 plan 的“车道赶上率”来自已删除的逐段 beforeStart 日志，本版本明确使用新版真实字音/首帧准点率≥90%作为相应标准，不构造旧日志。跨段按不同原段号计算；改轨只计成功且实际改变未来字段的 edit。团队关闭的一分钟不要求两个说明实体，改为必须无活动/待执行计划、保留当前主题且实体不超过两个、无关闭期错误。',
  '', '## 逐轮指标','',
  '|轮次|团队开/关秒|字锚点达标|跨段片段|实际改轨|未念误出|主持人画面标记|真实最长冷场秒|',
  '|---|---:|---|---:|---:|---:|---:|---:|',
];
for(const r of rows)lines.push(`|${r.run}|${sec(r.onMs)}/${sec(r.offMs)}|${r.timely}/${r.word}（${(100*r.timely/r.word).toFixed(1)}%）|${r.cross}|${r.edits}|${r.orphan.length}|${r.forbidden.length}|${sec(r.realGap)}|`);
lines.push('','|轮次|事件|接话员秒|自身回应秒|点题进单/展开秒|礼物兑现关单秒|换题出单秒|','|---|---|---:|---:|---|---:|---:|');
for(const r of rows)for(const q of r.requests){const metric=r.metrics.find(m=>m.kind===q.kind);lines.push(`|${r.run}|${q.kind}|${sec(metric?.ackMs)}|${sec(metric?.ownMs)}|${q.kind==='question'?`${sec(q.planMs)}/${sec(q.beganMs)}`:'—'}|${q.kind==='gift'?sec(q.doneMs):'—'}|${q.kind==='owner'?sec(q.newTopicMs):'—'}|`);}
lines.push('','## 原话与节目单证据','');
for(const r of rows){
  lines.push(`### 第${r.run}轮`,'',`[完整判定](${link(r.run,'verdict-{run}.json')}) · [原始取证](${link(r.run,'run-{run}.json')}) · [纯测量派生数据](${link(r.run,'derived-{run}.json')}) · [节目单判定](${link(r.run,'plan-verdict-{run}.json')}) · [画面轨判定](${link(r.run,'track-verdict-{run}.json')})`,'');
  for(const q of r.requests){
    lines.push(`**${q.kind}／${q.who}**`,'',`安排回应：${q.speech?.response??'缺证据'}`,'');
    if(q.kind==='owner')lines.push(`新话题：${q.newTopic?.title??'缺证据'}。旧话题未讲摘要：${q.archive?.summary??q.archive?.remaining?.map(b=>b.text).join('；')??'缺证据'}`,'');
    else lines.push(`真正展开：${q.beganText??'缺证据'}`,'',`实际关单原话：${q.close??'缺证据'}`,'',`改单前：${(q.before??[]).filter(b=>b.status==='pending').slice(0,5).map(b=>`${b.id} ${b.text}`).join('；')}`,'',`改单后：${(q.after??[]).filter(b=>b.status==='pending').slice(0,8).map(b=>`${b.id} ${b.text}（${b.reason}）`).join('；')}`,'');
  }
  lines.push(`[第${r.run}轮完整时间轴图](${link(r.run,'timeline-{run}.png')})`,'');
  for(const [i,note]of notes[r.run].entries())lines.push(`- [联系表${i+1}](${link(r.run,`contact-{run}/${String(i+1).padStart(2,'0')}.jpg`)})：${note}`);
  lines.push('');
}
lines.push('## 限制与收尾','',
  '自动检查保证时间、编号、队列、关单、布局等可观察行为；点题展开与承诺是否语义上兑现，仍须结合以上原话及联系表复核。没有独立录音听评，不能以图片或媒体事件替代声音自然度评价。',
  '', '本脚本不擅自停止控制台、大脑或结束父TaskSpace：协调者在所有验收完成后执行 POST /brain/stop，再完成fx/ui检查和TaskSpace.finish，并在最终交付说明确认服务与清理状态。', '');
const dest=resolve('../../.deps/tasks/unified-stage-report.md');await writeFile(dest,lines.join('\n'));console.log(`已生成 ${dest}`);
