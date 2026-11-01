// 与 crew-live-qa 相同的实际字幕时间口径；缺证据即失败，每轮分别判断。
import { readFile, writeFile } from 'node:fs/promises';
import {archiveComplete} from './speech-proof.mjs';
const base = new URL('./', import.meta.url);
const runs = process.argv.slice(2);
const results = [];
for (const run of runs) {
  const r = JSON.parse(await readFile(new URL(`derived-${run}.json`, base)));
  r.subtitles=r.subtitles.filter(s=>s.heardAt!==undefined);
  const start=r.openedAt, end=r.events.find(e=>e.kind==='crew-off')?.at??r.finishedAt;
  const track=JSON.parse(await readFile(new URL(`track-verdict-${run}.json`,base)));
  let version; try { version=JSON.parse(await readFile(new URL(`version-${run}.json`,base))); } catch {}
  const normal = text => (text??'').replace(/\[\[[\s\S]*?\]\]/g,'').replace(/\*/g,'').replace(/\s+/g,'').trim();
  const boardAt = at => r.boards.filter(b => b.at <= at).at(-1)?.board;
  const requests = r.events.filter(e => ['question','gift','owner'].includes(e.kind)).map(e => {
    const who = e.kind === 'owner' ? '主人' : e.kind === 'gift' ? e.body[0].user.name : e.body.user.name;
    const snapshots = r.boards.filter(b => b.at >= e.at);
    const planned = snapshots.find(s => s.board.beats.some(b => b.order && s.board.orders.find(o => o.id === b.order)?.who === who));
    const order = planned?.board.orders.find(o => o.who === who);
    const done = snapshots.find(s => s.board.orders.some(o => o.who === who && o.status === 'done'));
    const measured = r.metrics.find(m => m.kind === e.kind);
    const firstOwn = measured?.ownMs == null ? undefined : r.subtitles.find(s=>s.openedAt===e.at+measured.ownMs);
    const ownId = firstOwn?.id.replace(/-\d+$/,'');
    const fullResponse = ownId ? r.subtitles.filter(s=>s.id.replace(/-\d+$/,'')===ownId).map(s=>s.text).join('') : undefined;
    const speech = measured ? {...measured,response:fullResponse||measured.response} : undefined;
    const close = r.traces.find(t => t.time >= e.at && ((t.title === `点单关闭 ${order?.id} done`) || (t.title.startsWith('节目点关闭 ') && t.body?.includes(who))));
    const before = boardAt(e.at);
    const oldIds = new Set((e.lineup ?? []).map(l => l.id));
    const oldAfter = e.kind === 'owner' ? new Set(r.subtitles.filter(s => (s.endedAt??s.openedAt+s.ms)>e.at && oldIds.has(s.id.replace(/-\d+$/, ''))).map(s => s.id.replace(/-\d+$/, ''))) : undefined;
    const newTopic = e.kind === 'owner' ? snapshots.find(s => s.board.topic && s.board.topic.id !== before?.topic?.id && s.board.beats.length >= 3) : undefined;
    const archive = newTopic?.board.archives.filter(a => a.title === before?.topic?.title).at(-1);
    // 承诺之后真正开讲：先找关闭对应的整段字幕，不能把安排句冒充开讲。
    const spokenAtClose = close ? r.subtitles.filter(s => s.openedAt >= e.at && s.openedAt <= close.time && s.text.includes(who) && close.body?.replace(/\s+/g,'').includes(s.text.replace(/\s+/g,''))).at(0) : undefined;
    // 同一点可以分几段讲：以第一段实际展开的开口计时，不把最后关单那段当成起点。
    // 排除短承诺，并保留完整原话供人工核对它是否真的展开了要求。
    const expanded = close ? r.traces.filter(t=>t.title==='调用 speak'&&t.time>=e.at&&t.time<=close.time&&t.body?.includes(who)&&normal(t.body).length>=60&&!/^(?:[^。！？!?]{0,18})?(?:稍后|待会|等会|我会)/.test(normal(t.body))).map(t=>({call:t,sub:r.subtitles.find(s=>s.openedAt>=t.time&&s.openedAt<=close.time&&normal(t.body).includes(normal(s.text))&&normal(s.text).includes(who))})).find(x=>x.sub) : undefined;
    const spoken = expanded?.sub ?? spokenAtClose;
    return { beganText: expanded?.call.body ?? spokenAtClose?.text, oldAfter: oldAfter ? [...oldAfter] : undefined, kind: e.kind, who, order: order?.id, planMs: planned ? planned.at-e.at : null, doneMs: done ? done.at-e.at : null, beganMs: spoken ? spoken.openedAt-e.at : null, speech, before: before?.beats, after: planned?.board.beats, close: close?.body, newTopicMs: newTopic ? newTopic.at-e.at : null, archive, newTopic: newTopic?.board.topic };
  });
  let sparseStart, sparseSpans=[];
  const previous=r.sparse.filter(s=>s.at<=start).at(-1);
  for (const s of [...(previous?[{...previous,at:start}]:[]),...r.sparse.filter(s=>s.at>start&&s.at<=end)]) {
    if(s.count<=1) sparseStart??=s.at;
    else if(sparseStart!==undefined) { if(s.at-sparseStart>=20000)sparseSpans.push({from:sparseStart,to:s.at}); sparseStart=undefined; }
  }
  if(sparseStart!==undefined&&end-sparseStart>=20000)sparseSpans.push({from:sparseStart,to:end});
  const audible=r.subtitles.filter(s=>s.openedAt>=start&&s.openedAt<=end);
  const gaps=audible.slice(1).map((s,i)=>Math.max(0,s.openedAt-(audible[i].endedAt??audible[i].openedAt+audible[i].ms)));
  if(audible.length)gaps.push(Math.max(0,end-(audible.at(-1).endedAt??audible.at(-1).openedAt+audible.at(-1).ms)));
  const ids=new Set(audible.map(s=>s.id.replace(/-\d+$/,'')));
  const plans=r.traces.filter(t=>t.title==='舞台团队'&&t.time>=start&&t.time<=end).map(t=>JSON.parse(t.body)).filter(p=>ids.has(p.id));
  // 新架构已删除逐段beforeStart；准点以真实字音/浏览器首帧计算。
  const timely=track.word?track.timely/track.word:null;
  const doubleThanks=requests.filter(q=>/谢/.test(q.speech?.acknowledgement??'')&&/^(?:[^，,。！？]{1,10}[，,]\s*)?(?:谢谢|感谢|多谢|谢啦|谢了|谢你)/.test(q.speech?.response??''));
  const closed=r.traces.filter(t=>t.time>=start&&t.time<=end&&/^节目点关闭 b\d+$/.test(t.title));
  const duplicate=closed.filter((t,i)=>closed.slice(0,i).some(c=>c.title===t.title));
  const final=r.boards.at(-1)?.board;
  const deleted=[...(final?.beats??[]),...(final?.archives??[]).flatMap(a=>a.beats??a.remaining)].filter(b=>b.status==='deleted');
  const q=requests.find(q=>q.kind==='question'), g=requests.find(q=>q.kind==='gift'), o=requests.find(q=>q.kind==='owner');
  const acceptedCalls=r.traces.filter(t=>/后台 .*调用 deliver$/.test(t.title)).filter(t=>{ const prefix=t.title.replace('调用 deliver',''); const result=r.traces.find(x=>x.time>=t.time&&x.title===prefix+'结果 · deliver'); return result?.body?.startsWith('交上去了'); });
  const delivered=acceptedCalls.flatMap(t=>{try{return [JSON.parse(t.body)];}catch{return [];}}).filter(d=>!['fail','progress'].includes(d.kind));
  const deliveredVisuals=delivered.flatMap(d=>[...d.text.matchAll(/^```visual[ \t]+(\S+)(?:[ \t]+(\S+))?[ \t]*$/gm)].map(m=>({kind:m[1],id:m[2]})));
  const materials=final?.materials??[];
  const checks={
    version: !!version?.end?.sha256 && version.start.sha256===version.end.sha256,
    complete: end-start>=360000&&!r.events.some(e=>e.error),
    questionReply: q?.speech?.ownMs!=null&&q.speech.ownMs<=10000&&/先|接着|排|讲完|后面|接下来|安排|马上|下一|等/.test(q.speech.response??''),
    questionPlan: q?.planMs!=null&&q.planMs<=20000,
    questionFulfilled: q?.beganMs!=null&&q.beganMs<=120000&&!!q.close,
    giftPlan: g?.planMs!=null&&!!g.order,
    giftFulfilled: g?.doneMs!=null&&g.doneMs<end-r.events.find(e=>e.kind==='gift').at&&!!g.close,
    switchFinish: o?.oldAfter !== undefined && o.oldAfter.length <= 1,
    switchPlan: o?.newTopicMs!=null&&o.newTopicMs<=30000,
    switchArchive: archiveComplete(o?.archive),
    noDuplicate: duplicate.length===0,
    deletions: deleted.every(b=>!!b.deletionReason?.trim()),
    materials: materials.length>0&&delivered.length>0&&acceptedCalls.every(t=>materials.some(m=>typeof m.data?.text==='string'&&t.body?.includes(JSON.stringify(m.data.text).slice(1,101))))&&deliveredVisuals.every(v=>materials.some(m=>v.id?m.id.endsWith('-'+v.id):m.data?.kind===v.kind)),
    sparse: sparseSpans.length===0,
    acknowledgement: requests.length===3&&requests.every(q=>q.speech?.ackMs!=null&&q.speech.ackMs<=2500),
    response: requests.length===3&&requests.every(q=>q.speech?.ownMs!=null&&q.speech.ownMs<=10000),
    silence: audible.length>0&&Math.max(0,...gaps)<=6000,
    thanks: doubleThanks.length===0,
    timely: !!track.checks.wordTiming,
  };
  const row={run,codeFingerprint:version?.start?.sha256,passed:Object.values(checks).every(Boolean),checks,requests,sparseSpans,maxGapMs:Math.max(0,...gaps),timely,segments:plans.length,duplicate,deleted,materials:materials.map(m=>({id:m.id,description:m.description})),deliveredVisuals};
  results.push(row);
  await writeFile(new URL(`plan-verdict-${run}.json`,base),JSON.stringify(row,null,2));
  console.log(JSON.stringify({run,passed:row.passed,checks,maxGapMs:row.maxGapMs,timely,requests:requests.map(q=>({kind:q.kind,planMs:q.planMs,beganMs:q.beganMs,doneMs:q.doneMs,newTopicMs:q.newTopicMs,ackMs:q.speech?.ackMs,ownMs:q.speech?.ownMs,response:q.speech?.response}))},null,2));
}
await writeFile(new URL('strict.json',base),JSON.stringify(results,null,2));
if(results.some(r=>!r.passed))process.exitCode=1;
