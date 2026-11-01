/** 压缩采样是覆盖区间，不能把同一区间的首尾当成断采。 */
export function coverageGap(rows, from, to, windowStart, windowEnd) {
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || windowEnd < windowStart) return Infinity;
  const spans=rows.map(row=>({from:from(row),to:to(row)})).filter(s=>Number.isFinite(s.from)&&Number.isFinite(s.to)&&s.to>=windowStart&&s.from<=windowEnd).sort((a,b)=>a.from-b.from);
  let cursor=windowStart,max=0;
  for(const span of spans){const begin=Math.max(windowStart,span.from),end=Math.min(windowEnd,span.to);if(begin>cursor)max=Math.max(max,begin-cursor);cursor=Math.max(cursor,end);}
  return Math.max(max,windowEnd-cursor);
}
export const collectionClean=raw=>Array.isArray(raw.pollErrors)&&raw.pollErrors.length===0&&!raw.events.some(e=>e.error);
