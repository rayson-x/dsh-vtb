/** Fast structural checks at the generative write boundary; no model/production wait. */
export function editorialProposalProblem(value:unknown):string|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return'proposal must be an object';
 const p=value as Record<string,unknown>,fields=['id','segmentIntent','viewingValue','participation','handoff'];
 const missing=fields.filter(k=>typeof p[k]!=='string');
 if(missing.length)return'proposal missing string fields: '+missing.join(', ');
 if(!(p.id as string).trim()||!(p.segmentIntent as string).trim())return'proposal id and segmentIntent must not be empty';
 for(const key of['minimumMaterials','alternatives'])if(!Array.isArray(p[key])||!(p[key] as unknown[]).every(v=>typeof v==='string'))return'proposal '+key+' must be string[]';
}
