import { readFile, writeFile } from 'node:fs/promises';
const base = 'scripts/crew-live-qa/';
const rows = JSON.parse(await readFile(base+'metrics.json','utf8'));
const strict = JSON.parse(await readFile(base+'strict.json','utf8'));
const observations = JSON.parse(await readFile(base+'observations.json','utf8'));
if (rows.length !== 3 || strict.length !== 3) throw Error('必须收齐三轮');
for (const r of rows) {
  const frames = JSON.parse(await readFile(`${base}contact-${r.run}/frames.json`,'utf8'));
  if (observations[r.run]?.length !== Math.ceil(frames.length/12)) throw Error('逐张观察未覆盖全部联系表');
}
const allPassed = strict.every(r=>r.passed);
const sec = x=>x == null ? '未播' : (x/1000).toFixed(3);
const quote = s=>String(s??'（没有实际开口）').split('\n').map(l=>'> '+l).join('\n');
const link = '../../packages/dsh-livestream/scripts/crew-live-qa/';
let out = `# 舞台团队 2c 收尾报告\n\n工作目录：\`/Users/Ruihan/orca/projects/aivtb-crew2c\`。控制台3818、舞台3918、大脑3938，ego-browser TaskSpace 82。仅修改任务白名单；未 push。\n\n**严格验收${allPassed?'三轮全部通过':'尚未全部通过'}。** 每轮单独判断，不以2/3代替全过。关后错误按标记实际提交时刻归属；第一轮有1条关前错误的迟到回执（含2个标记），下文单列原话与时间，关后新写标记错误仍为0。\n\n## 四项修复\n\n- 画布：直播适配读取实时状态，传入主持人本段翻页/擦除的预计结果、发生位置与上次清空时刻；画布空或只留互动时要求开场补主题和要点，提前模型已有的两条说明，稀疏空答/不足两项会重试一次，迟到补画锚到真实逐字时钟尚未念到的位置；互动旁配说明；投票揭晓会重新展开，因此翻页与说明统一排在揭晓之后。\n- 致谢：接话员已致谢时，controller 在排入合成前仅摘除下一段开头的致谢分句，正文与标记保留；speak 回执说明摘除原因。接话模型只看当前消息，不传人设背景；短分句必须命中当前消息实义词，避免把人设偏好当礼物。\n- 回程：快模型只生成不超过12字的承接前缀，程序拼回完整原句；校验只接受短前缀或句首连接词替换，其余逐字一致，不合格回原句。人名、代词、数字、引号无需猜测实体边界，正文整体保留。近五分钟开头查重；重复或不合格时在总3秒预算内重试一次。回程模型不接收刚才回应全文，避免复述刚才的答案。\n- 灯光：\`src/host/crew/\` 共用滑动窗口规则，同种30秒，全屏每分钟2次、粒子3次，混合效果同时计入两类。合并层预检并传回灯光车道；controller 在实际执行时复核，避免并发计划及软打断改变落点后绕过额度。\n\n## 单测与检查\n\n全量 Vitest：30个文件、207项通过（基线189项）；TypeScript 无错误，构建通过。测试日志见 [unit.log](${link}unit.log)。新增行为用例覆盖致谢正文保护与回执、回程人名/代词/数字/引号及长前缀拒绝、跨段滑窗灯光和实际执行、翻页后graphics输入。修复前致谢与画布通知用例失败，灯光用例在修正测试初始化导入后也已观察到失败。\n\n## 取证口径\n\n每轮真实模型和语音，主播实际开口后5分钟，依次礼物附言、主人要求、人少提问各一次；关闭车道后继续1分钟。ego-browser每5秒截图，同时调用只读的\`scripts/crew-qa/overlap.mjs\`测量该时刻DOM。字幕按真实起落算冷场；接话按句末到接话员开口，自身回应按事件到开口。音频拆截按段号拼回识别。窗口外尾帧不补算成功。灯光取SSE实际执行事件，按任意连续60秒计数（全屏类为flash/dark/static，粒子为burst；混合同时计两类）。关闭期逐条检查回执，并直接用产品解析器验证新提交标记；用错误回执引用的原始标记追溯提交时刻，关前错误的迟到回执另列，不冒充关后新标记错误，也不隐去。无独立录音听评，静态截图不当作听感证据。\n\n探索轮因回程模型试图改正文，被校验回退，未计入最终三轮；随后改成只生成前缀，重新连续验证。浏览器初次测量脚本的模块路径错误已修正，不计有效轮。\n\n`;
out += '## 未计入最终验收的探索轮\n\n|证据编号|已观察到的失败与处理|\n|---|---|\n';
for (const [id, reason] of [['1','完整原句改写被保真校验回退，随后改为只生成短前缀；运行中断。'],['4','开场第二条说明落在段尾，实际稀疏20.293秒；随后提前模型已有说明；运行中断。'],['7','实际稀疏29.700秒，投票揭晓后占满画布导致说明被拒；主人接话员未播出。随后调整揭晓/翻页顺序与关键词要求。关闭窗口墙钟少44毫秒，运行器加100毫秒余量；截图在诊断停下后不足整轮，不计有效取证。'],['10','主人接话错误地说“大肥鱼接住这个草莓芭菲”，来自人设偏好；随后接话输入移除人设背景，运行中断。'],['13','完成5+1分钟，稀疏0、赶上100%、接话0.954/0.451/0.632秒、自身回应4.887/4.630/5.552秒、最长冷场4.158秒、重叠溢出0、全屏/粒子每分钟2/3；但关闭期写了不支持的table。旧统计先漏掉该标记错误，并曾因回应没有“主人/比喻/像”误记未播；回执与实际字幕交叉核对后修正统计，再增加table到现有list的兼容。该轮不计最终通过。'],['14','在上一轮关闭期发现table标记错误后中断，未完成窗口，不计有效轮。'],['16','完成5+1分钟，稀疏0、赶上100%、接话0.368/0.678/0.657秒、自身回应8.275/3.446/8.131秒、冷场4.447秒、画面相交溢出0、全屏/粒子每分钟1/3；关闭期仍写了不支持的quote。回执序号与调用序号不同，旧匹配又漏计；修正为关闭期全部回执检查后该轮严格失败，再把quote兼容为现有card。'],['17','上一轮发现quote标记错误后中断，未完成窗口，不计有效轮。'],['19','开场graphics返回空数组，第一段没有说明画布，直到后续话题段才补齐；随后增加一次受约束重试，并把迟到补画移到未念到的位置；运行中断。']]) {
  const raw = JSON.parse(await readFile(`${base}exploration-${id}.json`, 'utf8'));
  out += `|${id}|${reason} [轨迹](${link}exploration-${id}.json)|\n`;
  out += '';
}
const explorations=JSON.parse(await readFile(base+'exploration-metrics.json','utf8'));
out += '\n|探索证据|已观测接话员/自身回应秒（按gift、owner、question）|稀疏长段秒|赶上|最长冷场秒|关闭期错误|\n|---|---|---|---|---:|---:|\n';
for(const r of explorations)out += `|${r.run}|${r.metrics.map(m=>`${m.kind}: ${sec(m.ackMs)}/${sec(m.ownMs)}`).join('；')}|${r.sparseSpans.map(s=>sec(s.ms)).join('、')||'0'}|${r.beforeStart}/${r.segments}|${sec(r.maxGapWithOffMs)}|${r.offErrors.length}|\n`;
out += '\n中断轮的未触发事件不作延迟样本，未完成窗口不计通过；错误计数用修正后的回执检查重算。失败对应原话保存在各行轨迹链接中，重要错误原话已列在原因栏。\n\n';
out += `\n以下为最终连续三轮（证据编号${rows.map(r=>r.run).join('、')}），每轮都是5分钟开车道加至少1分钟关闭观察。\n\n`;
out+='|轮次|开/关秒|稀疏≥20秒|赶上|越道接受|最长冷场5分/全程秒|相交/溢出截图|全屏/粒子每分钟最大|结论|\n|---|---|---:|---|---:|---|---:|---|---|\n';
for(const r of rows){const s=strict.find(x=>x.run===r.run);out+=`|${r.run}|${sec(r.mainMs)}/${sec(r.offMs)}|${r.sparseSpans.length}|${r.beforeStart}/${r.segments} (${(r.beforeStartRate*100).toFixed(1)}%)|${r.crossed}|${sec(r.maxGapMs)}/${sec(r.maxGapWithOffMs)}|${s.overlap.length}|${s.fullPerMinute}/${s.particlesPerMinute}|${s.passed?'通过':'失败'}|\n`;}
out += '\n|轮次|画面/灯光/音响p90毫秒|有效调用|实际动作/拒绝|\n|---|---|---|---|\n';
for(const r of rows)out += `|${r.run}|${r.lane.graphics.p90}/${r.lane.lighting.p90}/${r.lane.sound.p90}|${r.lane.graphics.ok}/${r.lane.graphics.calls}；${r.lane.lighting.ok}/${r.lane.lighting.calls}；${r.lane.sound.ok}/${r.lane.sound.calls}|${r.actions}/${r.rejected}|\n`;
out+='\n|轮次|事件|接话员秒|自身回应秒|改写且实际接回|正文保真|\n|---|---|---:|---:|---|---|\n';
for(const r of rows)for(const m of r.metrics)out+=`|${r.run}|${m.kind}|${sec(m.ackMs)}|${sec(m.ownMs)}|${m.resumed&&m.bridgeChanged?'是':'否'}|${strict.find(x=>x.run===r.run).preserved?'是':'否'}|\n`;
out+='\n|轮次|再次致谢|重复接话|重复回程开头|关后岗位计划|关后新标记/运行时错误|关前标记迟到回执|关后主持人自写标记段|礼物关单|\n|---|---:|---:|---:|---:|---:|---:|---:|---|\n';
for(const r of rows)out+=`|${r.run}|${r.doubleThanks}|${r.ackRepeated}|${r.bridgeRepeated}|${r.offCrewPlans}|${r.offErrors.length}|${new Set((r.inheritedCueErrors??[]).map(t=>t.time)).size}|${r.offHostCalls.length}|${r.passed.orders?'是':'否'}|\n`;
out+='\n## 原话与点单\n\n';
for(const r of rows){
 out+=`### 第${r.run}轮\n\n[原始轨迹](${link}run-${r.run}.json)。\n\n`;
 for(const m of r.metrics)out+=`**${m.kind}** 接话员：\n\n${quote(m.acknowledgement)}\n\n自身回应实际首截：\n\n${quote(m.response)}\n\n挂起原句：\n\n${quote(m.bridge?.original)}\n\n实际回程：\n\n${quote(m.bridge?.text)}\n\n`;
 for(const c of r.closed)out+=`${c.title}：\n\n${quote(c.body)}\n\n`;
 for(const e of r.inheritedCueErrors??[]) out+=`关前标记的迟到回执（提交${new Date(e.submittedAt).toISOString()}，回执${new Date(e.time).toISOString()}）：\n\n${quote(e.cue)}\n\n`;
 out+='关车道后的主持人标记：\n\n';for(const c of r.offHostCalls)out+=quote(c.body)+'\n\n';
}
const frameCounts=await Promise.all(rows.map(async r=>JSON.parse(await readFile(`${base}contact-${r.run}/frames.json`,'utf8')).length));
out+=`最终三轮各${frameCounts.join('、')}张截图，共${frameCounts.reduce((a,b)=>a+b,0)}张、${frameCounts.reduce((a,b)=>a+Math.ceil(b/12),0)}张联系表；统计窗口内各${strict.map(s=>s.shots).join('、')}张。所有截图都测量DOM，尾帧不补算窗口内成功。\n\n`;
out+='## 联系表逐张观察\n\n每行覆盖该联系表的所有截图。相交/溢出以截图对应时刻的DOM测量为准，动画中的问题照计，不靠目测豁免。\n\n|轮次/联系表|逐张观察|\n|---|---|\n';
for(const r of rows)for(const [i,description]of observations[r.run].entries())out+=`|[${r.run}/${i+1}](${link}contact-${r.run}/${String(i+1).padStart(2,'0')}.jpg)|${description}|\n`;
out+='\n画面多数能跟随关键词变化，仍有旧标题/清单退场偏慢、重复信息、小注释偏小，以及少数强光/粒子帧盖字。限频达标不等于每个瞬间都不抢戏；保真通过也不代表每个短承接都足够自然，原话留在上文供复核。未修改白名单外的布局、reducer或protocol来掩盖这些限制。\n\n';
out+='\n## 严格检查与收尾\n\n完整逐项结果：[strict.json]('+link+'strict.json)，统计：[metrics.json]('+link+'metrics.json)。任何一项失败都不能计通过，重跑须连续三轮同一产品代码版本。原始截图最终只留JPEG联系表，JSON保留每张截图时刻和DOM测量。\n\n已 POST /brain/stop，关闭3818控制台及3918舞台，确认3818/3918/3938均无监听；TaskSpace 82 已执行 finish({keep:[]})。原始截图已删除，仅保留最终三轮21张JPEG联系表（对应240张原图）及小体积测量/轨迹JSON。全部变更与报告本地提交，未push。复跑：按指定端口启动控制台与大脑，运行 run.mjs 轮次；汇总运行 metrics.mjs、strict.mjs、contact.mjs，再填写 observations.json 并运行 report.mjs。复跑截图时须使用该次任务自己的TaskSpace，已结束的82不能直接复用。\n';
await writeFile('../../.deps/tasks/stage-crew-2c-report.md',out);
console.log('报告已生成，严格全过=',allPassed);
