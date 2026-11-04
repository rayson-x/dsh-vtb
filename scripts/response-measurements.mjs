/** First contact, substantive answer, verbal finish and visual fulfilment are separate evidence. */
export function projectResponseMeasurements(inputs,state,timings){
  const parts=Object.values({...state.speechArchive,...state.speech});
  const at=(phase,id)=>timings.find(e=>e.phase===phase&&e.fields.partId===id)?.at;
  return inputs.map(input=>{
    const spoken=parts.filter(p=>input.eventId&&p.responseTo===input.eventId&&at('audio-playing',p.partId)!==undefined)
      .map(p=>({partId:p.partId,stage:p.responseStage,text:p.text,state:p.state,firstAudibleMs:at('audio-playing',p.partId)-input.at,completedMs:p.state==='ended'&&at('audio-ended',p.partId)!==undefined?at('audio-ended',p.partId)-input.at:null}))
      .sort((a,b)=>a.firstAudibleMs-b.firstAudibleMs);
    const proposals=Object.values(state.proposals??{}).filter(p=>p.eventIds.includes(input.eventId));
    const visual=proposals.filter(p=>p.status==='presented'&&p.fulfillment&&state.playback?.some(e=>e.id===p.fulfillment.playbackEventId&&e.kind==='painted'&&!e.orphan));
    const completed=spoken.filter(p=>p.completedMs!==null);
    const effective=spoken.filter(p=>p.state==='playing'||p.state==='ended');
    return {index:input.index,eventId:input.eventId,firstResponse:effective[0]??null,acknowledgement:effective.find(p=>p.stage==='ack')??null,
      firstAnswer:effective.find(p=>p.stage==='answer'||p.stage==='finish')??null,
      verbalCompletion:completed.find(p=>p.stage==='finish')??null,spokenParts:spoken,
      visualStatus:!proposals.length?'unlinked':visual.length===proposals.length?'presented':'pending',
      visualFulfilledMs:visual.length===proposals.length&&visual.length?Math.max(...visual.map(p=>timings.find(e=>e.phase==='proposal-presented'&&e.fields.playbackEventId===p.fulfillment.playbackEventId)?.at??NaN))-input.at:null};
  });
}
export function summarizeResponseMeasurements(rows){
  const stats=values=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?{count:a.length,p50:a[Math.floor(a.length*.5)],p95:a[Math.min(a.length-1,Math.floor(a.length*.95))],max:a.at(-1)}:{count:0};};
  return {firstResponse:stats(rows.filter(r=>r.firstResponse?.completedMs!==null).map(r=>r.firstResponse?.firstAudibleMs)),
    acknowledgement:stats(rows.filter(r=>r.acknowledgement?.completedMs!==null).map(r=>r.acknowledgement?.firstAudibleMs)),
    firstAnswer:stats(rows.filter(r=>r.firstAnswer?.completedMs!==null).map(r=>r.firstAnswer?.firstAudibleMs)),
    verbalCompletion:stats(rows.map(r=>r.verbalCompletion?.completedMs)),visualFulfilment:stats(rows.map(r=>r.visualFulfilledMs)),
    unfinished:rows.filter(r=>!r.verbalCompletion).map(r=>r.index),note:'Only completed actual speech counts in latency summaries; a first short response is not a full answer or visual fulfilment. Content relevance requires a separate audit.'};
}
