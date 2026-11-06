import{expect,it}from'vitest';
import{mergeSceneInputs}from'../src/inputs';
it('preserves unrelated component controls while merging a partial live update',()=>{
 const before={layers:{lamp:{x:100,brightness:.6},cup:{x:500,visible:true}},palette:'warm',items:[1,2]};
 const after=mergeSceneInputs(before,{layers:{lamp:{brightness:.3},fish:{count:4}},items:[3]});
 expect(after).toEqual({layers:{lamp:{x:100,brightness:.3},cup:{x:500,visible:true},fish:{count:4}},palette:'warm',items:[3]});
 expect(before.layers.lamp.brightness).toBe(.6);
 expect(mergeSceneInputs(after,{layers:{cup:null}})).toMatchObject({layers:{lamp:{x:100},cup:null}});
 const hostile=mergeSceneInputs({},JSON.parse('{"__proto__":{"polluted":true}}'));expect(Object.getPrototypeOf(hostile)).toBe(Object.prototype);expect(({} as any).polluted).toBeUndefined();
});
