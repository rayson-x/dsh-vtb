/** Live input patches preserve unrelated object controls. Arrays/null are explicit replacements. */
export function mergeSceneInputs(base:Record<string,unknown>,patch:Record<string,unknown>):Record<string,unknown>{
 const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
 return Object.fromEntries([...new Set([...Object.keys(base),...Object.keys(patch)])].map(key=>{
  if(!Object.hasOwn(patch,key))return[key,structuredClone(base[key])];
  const prior=Object.hasOwn(base,key)?base[key]:undefined,value=patch[key];
  return[key,record(prior)&&record(value)?mergeSceneInputs(prior,value):structuredClone(value)];
 }));
}
export interface SceneInputChange {inputs:Record<string,unknown>;snapshot?:boolean}
/** Replay old shallow recordings explicitly; new scenes use the same recursive patch contract. */
export function resolveSceneInputs(base:Record<string,unknown>,changes:readonly SceneInputChange[],semantics:'deep-merge'|'shallow-merge'='deep-merge'){
 return changes.reduce((props,p)=>p.snapshot?structuredClone(p.inputs):semantics==='deep-merge'?mergeSceneInputs(props,p.inputs):{...props,...structuredClone(p.inputs)},structuredClone(base));
}
