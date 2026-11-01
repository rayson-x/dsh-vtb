import {heardAt} from './common.mjs';
const subtitleText=text=>String(text??'').replace(/\s+/gu,' ').trim();
/** 使用同一真实开口时钟的最新快照，旧speaking快照不能替最终未念出的字作证。 */
export function wordProof(entry,clip,raw,observed) {
  const anchor=clip?.enter?.anchor;
  if(!anchor||!('segment'in anchor))return {spoken:false,reason:'不是字锚点'};
  let latest, clock, aligned=false;
  for(const sample of [...raw.tracks].reverse()){
    const matches=sample.speech.filter(p=>p.segment===anchor.segment&&p.startedAt!==undefined&&p.positions.includes(anchor.char));
    const exact=matches.find(p=>{const offset=p.starts?.[p.positions.indexOf(anchor.char)];return Number.isFinite(offset)&&Number.isFinite(entry.target)&&Math.abs(p.startedAt+offset-entry.target)<1;});
    if(exact){clock=exact;break;}
    // 无starts也保留在分母，后面明确判缺少真实逐字证据。
    latest??=matches.find(p=>p.startedAt<=entry.now);
  }
  if(clock){
    for(const sample of [...raw.tracks].reverse()){
      const part=sample.speech.find(p=>p.segment===clock.segment&&p.startedAt===clock.startedAt&&p.text===clock.text&&p.positions.includes(anchor.char));
      if(part){latest=part;break;}
    }
    const offset=latest?.starts?.[latest.positions.indexOf(anchor.char)];
    aligned=Number.isFinite(offset)&&Math.abs(latest.startedAt+offset-entry.target)<1;
  }
  if(!latest)return {spoken:false,reason:'缺少对应的说话轨快照'};
  const index=latest.positions.indexOf(anchor.char),offset=latest.starts?.[index];
  if(!aligned||!Number.isFinite(offset))return {spoken:false,reason:'缺少对应真实逐字starts',part:latest};
  const subtitle=raw.subtitles.find(s=>s.id.replace(/-\d+$/,'')===latest.segment&&subtitleText(s.text)===subtitleText(latest.text)&&Math.abs(s.startedAt-latest.startedAt)<=10);
  const audioStart=subtitle?heardAt(subtitle,observed):undefined;
  if(!subtitle?.audio||audioStart===undefined)return {spoken:false,reason:'缺少真实音频playing证据',part:latest};
  const wordAt=audioStart+offset;
  const end=Math.min(raw.finishedAt,subtitle.endedAt??Infinity,audioStart+subtitle.ms);
  const limit=Math.min(latest.limit??latest.positions.length,['done','retracted'].includes(latest.status)?latest.spoken??0:latest.positions.length);
  const spoken=!latest.muted&&['speaking','done','retracted'].includes(latest.status)&&index<limit&&wordAt>=audioStart&&wordAt<end;
  return {spoken,wordAt,audioStart,audioEnd:end,reason:spoken?undefined:'最终spoken/limit或真实音频区间没有覆盖该字',part:latest,subtitle};
}
export const hasSuccessfulExit=(entry,executions)=>executions.some(x=>x.id===entry.id&&x.ok===true&&['exit','invalidated','disabled','page','external'].includes(x.phase));
export function crossesSpokenSegments(entry,exitAt,raw,observed) {
  const appearance=observed.find(o=>o.type==='enter'&&o.id===entry.id)?.at;
  if(appearance===undefined||!Number.isFinite(exitAt))return false;
  return new Set(raw.subtitles.filter(s=>{
    const start=s.audio?heardAt(s,observed):undefined;
    return start!==undefined&&Math.min(s.endedAt??Infinity,start+s.ms,raw.finishedAt)>appearance&&start<exitAt;
  }).map(s=>s.id.replace(/-\d+$/,''))).size>=2;
}
export function archiveComplete(archive) {
  if(!archive||!Array.isArray(archive.beats)||!Array.isArray(archive.remaining))return false;
  const pending=archive.beats.filter(b=>b.status==='pending').map(b=>b.id).sort();
  const remaining=archive.remaining.map(b=>b.id).sort();
  return archive.remaining.every(b=>b.status==='pending')&&new Set(remaining).size===remaining.length&&JSON.stringify(pending)===JSON.stringify(remaining)&&(!pending.length||!!archive.summary?.trim());
}
