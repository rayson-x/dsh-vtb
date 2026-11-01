/** lineup会把同原段的正在念部分和尾部合并；只有说话轨能分清真实未念parts。 */
export function retractionCandidate(speech,lineup=[]) {
  const groups=new Map();
  for(const part of speech??[]){
    if(!['queued','held'].includes(part.status)||part.startedAt!==undefined||typeof part.segment!=='string'||!part.segment||!part.text?.trim())continue;
    if(!groups.has(part.segment))groups.set(part.segment,[]);
    groups.get(part.segment).push({text:part.text,positions:[...part.positions],status:part.status});
  }
  const pending=new Set(lineup.filter(l=>!l.playing).map(l=>l.id));
  const choices=[...groups];
  const choice=choices.filter(([id])=>pending.has(id)).at(-1)??choices.at(-1);
  return choice?{id:choice[0],text:choice[1].map(p=>p.text).join(''),parts:choice[1]}:undefined;
}
