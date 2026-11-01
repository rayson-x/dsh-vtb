/** 本副本交接报告；历史六分钟脚本不能替代协调者的集成验收。 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const base = new URL('./', import.meta.url), pkg = new URL('../../', base), repo = new URL('../../../../', base);
const hash = x => createHash('sha256').update(x).digest('hex');
const files = [...(await readdir(new URL('src/dsh/',pkg))).filter(n=>n.endsWith('.ts')).map(n=>'src/dsh/'+n), ...['blackboard','gate','input','stagehost'].map(n=>`src/host/${n}.ts`), 'src/stage/cues.ts'].sort();
const sources = Object.fromEntries(await Promise.all(files.map(async f=>['packages/dsh-livestream/'+f,hash(await readFile(new URL(f,pkg)))])));
const build = Object.fromEntries(await Promise.all(['lib/index.js','lib/agent.js','lib/console.js'].map(async f=>[f,hash(await readFile(new URL(f,pkg)))])));
const fingerprint = hash(JSON.stringify({sources,build}));
const records = [];
for(const f of ['strict-before-resume.json','strict-11.json','strict-14.json','strict-18.json']) {
  try { records.push(...JSON.parse(await readFile(new URL(f,base)))); } catch { /* 不补造缺失证据 */ }
}
const sec = n => n == null ? '缺证据/未关单' : (n/1000).toFixed(3);
const history = records.map(r=>{
  const q=r.requests.find(x=>x.kind==='question'),g=r.requests.find(x=>x.kind==='gift'),o=r.requests.find(x=>x.kind==='owner');
  return `|${r.run}|${sec(q?.speech?.ownMs)} / ${sec(q?.planMs)} / ${sec(q?.beganMs)}|${sec(g?.doneMs)}|${sec(o?.newTopicMs)}|${sec(r.maxGapMs)}|${((r.timely??0)*100).toFixed(1)}%|${r.run==='8'?'旧版历史通过，不计当前验收':Object.entries(r.checks).filter(([,v])=>!v).map(([k])=>k).join('、')}|`;
}).join('\n');
const gift=records.find(r=>r.run==='18')?.requests.find(r=>r.kind==='gift');
const report=`# 舞台黑板与节目单：本副本交接报告

**未独立完成连续三轮，最终由协调者统一同版本验收接管。**

协调者最新收尾安排取代原各副本独立三轮流程：最终由 aivtb-integrate 中的统一脚本，在同一个集成产品版本连续三轮，每轮六分钟团队开加一分钟关，同时覆盖 plan 与 track。本文不宣称当前代码端到端全过，也不把旧版通过当作新版通过。

工作目录/Git 根为 \`/Users/Ruihan/orca/projects/aivtb-plan\`，只改本副本，不修改主仓库，不 push。代码、脚本和报告本地提交；大体积原始 JSON、失败证据、联系表及时间轴保留磁盘供协调者复制，不提交 Git，不删除副本。

## 实际实现

- 舞台 Blackboard 持有话题、完整节目单、素材架、点单、通知和旧题归档；read/subscribe 返回冻结的隔离快照。桥接推送版本，大脑缓存最新版交付并在重连后补送，交付键幂等，旧话题改单拒绝。
- 编导 start/cards 提交 3–5 点，每点包含内容、素材编号、位置理由；支持数组或 JSON 字符串。回执只列可讲前五点，其余保留。图片、数字、对比及原始批次资料进入素材架；漏编号素材块补批次编号，不在本任务决定如何绘制。
- 快报识别显式点题、礼物附言及主人要求，自动交编导改单。换题请求按点单编号去重，编导读取精简黑板、素材目录与已关闭状态，避免反复传素材全文拖慢改单或重开旧要求。
- \`[[beat done b编号]]\` 校验编号、段末及顺序；排播先占位，实际播放到标记才结点并关联关单，撤回恢复待讲。旧点单关闭标记也可结掉关联节目点。普通讲述漏标记在排播前拒绝，短回应不冒充兑现。
- 插点不丢旧安排，删点需理由；换题保留未讲摘要及完整旧单。显式“兑现某人点单”的点必须关联有效 pending 编号。
- 优先级入口拒绝把未要求推迟的点单压到资料长队后，其他点保留；**观众明确说“稍后再讲”仍允许后排**。want 包含“稍后/晚点/不急/最后再/回头再/等会儿/以后再”时可 later。回归同时验证默认长队拒绝、after-current 成功、明确稍后放队尾；没有硬编码具体话题。
- \`/bridge/call\` 已 await 异步结果，防止 Promise 变成 {} 和主持人收到 [object Object]。修复“这就是”误判承诺、迟到礼物更新原点单，并以已预合成短句兜住现编垫话未回的冷场。

未改 host/crew、controller、draw/reducer/protocol、page、sets 或原 QA 目录；未扩展画面导演，主持人原有画面/灯光/布景/意图说明保留。协调者的集成补丁未在本副本重复实现。

## 最终检查与代码指纹

|检查|实际结果|磁盘日志|
|---|---|---|
|npx vitest run|31 文件、220 测试全过|scripts/plan-qa/unit-final.log|
|npx tsc --noEmit -p .|退出0，无诊断|scripts/plan-qa/types-final.log|
|node build.mjs|退出0|scripts/plan-qa/build-final.log|
|git diff --check|退出0|收尾实际执行|

当前源码及构建聚合 SHA-256：\`${fingerprint}\`。计算方式为 JSON.stringify({sources,build}) 后取 SHA-256；sources 为下表有序映射，build 为 lib/index.js、lib/agent.js、lib/console.js 的文件 SHA-256 映射。历史 version-N.json 保留各轮实际前后指纹。最新优先级与精简黑板修复未完成独立长轮验证。

|源码|SHA-256|
|---|---|
${Object.entries(sources).map(([f,h])=>`|${f}|${h}|`).join('\n')}

## 历史实测与失败修复

下面只读取保留的历史判定快照，不改写原始 JSON；原数值门槛未放宽，缺证据判失败。每轮属于其当时的源码/构建，不能混成当前版本三轮。

|轮次|点题回应/进单/开讲 秒|礼物关单 秒|换题出单 秒|最长冷场 秒|车道赶上|当时结论|
|---|---|---|---|---|---|---|
${history}

1. pilot：素材编号不存在、plan 结构不一致；补可用编号反馈、缺省当前批次引用，兼容数组和字符串。
2. 第1轮：关单把“这就是”当承诺、安排不明确、换题过慢和冷场超限。修正误判、短回应必须说明相对安排、直接叫醒编导与预合成垫话兜底。regression-before.log 保留修复前失败。
3. 第2轮：时间指标过，但失败稿占住素材幂等键，重试后架上仍是失败稿。修复重试键、提前校验点单编号类型。真实编导工具→HTTP回归修复前失败见 delivery-retry-before.log。
4. 第5轮：漏结点、重复换题。新增排播前校验、占位防重讲、按请求编号去重和起步卡优先。
5. 第8轮为旧版历史通过，第9轮意外中断，均不计当前最终验收。
6. 第11轮仅稀疏失败：284.17–309.19 秒约25.02秒。待卡重复排无节目点过场，现有车道该段有对点短语错误，只剩标题。修复限于节目单入口：待卡仅一次短回应，拒绝重复无点过场，不改车道/绘制时机。waiting-plan-before.log 为修复前失败。第12轮中断保留。
7. 第14轮开场浏览器自动播放被拦截，仅作预热诊断；另礼物 ackMs=null，严格失败。增加计时前声音准备，不把生成缺失武断归因外部服务不可用。
8. 同期发现异步桥接把 Promise 序列化成 {}。真实 HTTP 回归修复前收到 object、修复后返回实际 string；async-bridge-before.log 为证。async bridge await 保留，第15轮为修复中断。
9. 第18轮礼物4.844秒进单却排第9，主持人承诺当前点后讲，换题后补讲赶不上本轮关单。新增长队优先级入口、明确稍后例外、有效点单关联编号及已关闭状态上下文。order-priority-before.log 两项修复前均失败，当前通过。第19轮中断保留。

中断或无完整结果的3、6、9、12、15、19轮不计通过；未启动轮次不补造数据。第21–23轮在协调者暂停交接后未再启动。

### 第18轮安排与节目单原证据

主持人承诺（该轮未关单，承诺不算兑现）：

> ${gift?.speech?.response??'见run-18.json'}

改单前未讲点（截取前五点）：

${(gift?.before??[]).filter(b=>b.status==='pending').slice(0,5).map((b,i)=>`${i+1}. ${b.id} ${b.text}`).join('\n')}

改单后的礼物点：

${(gift?.after??[]).filter(b=>b.order===gift?.order).map(b=>`- ${b.id} ${b.text}；第 ${(gift.after??[]).filter(x=>x.status==='pending').findIndex(x=>x.id===b.id)+1} 个；理由：${b.reason}`).join('\n')}

完整前后单、开讲/关单原话见 strict-18.json、run-18.json。素材原文载荷在 boards 和“舞台黑板”轨迹中；工具长正文可能被系统截断，完整数据仍在黑板快照。时间轴为 shots-N/shots.jsonl、contact-N/frames.json，单张图转为 jpg 联系表后清理。原始 JSON、日志、联系表不纳入提交，仍留本副本磁盘供复制。

## 当前遗留与集成注意

- **未独立完成连续三轮，最终由协调者统一同版本验收接管。** 此目录历史脚本仅六分钟团队开诊断，不是最终六分钟开加一分钟关的集成验收入口。
- 协调者另修“待起步卡时新 urgent wake 可再短回应”和“空正文不消费回应机会”；本副本不重复实现。合并 agent.ts 时保留这些集成补丁，不整文件覆盖。
- 显式句式识别及兑现语义校验不能代替完整语义理解，复杂隐含要求仍需结合原话人工复核。
- 黑板为进程内状态，已测试桥接断线和重连补送，不声称舞台进程崩溃有磁盘恢复。画面导演职责留待后续任务。

## 收尾

交接时3821/3921已无监听，3941遗留本目录孤儿大脑；核实cwd后SIGTERM终止。收尾复查三口无监听，无本任务runner/sim。ego-browser对本任务TaskSpace90成功finish({keep:[]})，未操作track91或其他空间。没有再启动长轮或大脑。

仅本副本提交代码、脚本及本报告，不提交.env、密钥或海量证据；证据保留磁盘，不删副本、不push。最终由协调者复核、合并及统一验收。
`;
await writeFile(new URL('.deps/tasks/plan-report.md',repo),report);
console.log('已写交接报告，明确未独立完成连续三轮。');
