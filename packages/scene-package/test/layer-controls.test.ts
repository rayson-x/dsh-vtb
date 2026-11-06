import{expect,it}from'vitest';
import{layeredStageProblem}from'../src/layer-controls';
it('rejects invisible no-op control shapes and incomplete rebuilt nodes before they can claim a painted update',()=>{
 const valid={layers:{lamp:{kind:'lamp',x:100,brightness:.4},cup:{kind:'cup',visible:true}},palette:'quiet'};
 expect(layeredStageProblem(valid)).toBeUndefined();
 expect(layeredStageProblem(valid,{params:{layers:{lamp:{brightness:.2}}}})).toContain('root');
 expect(layeredStageProblem({layers:{lamp:{brightness:.2}}})).toContain('kind');
 expect(layeredStageProblem({layers:{lamp:{kind:'lamp',brightness:'soft'}}})).toContain('numeric');
 expect(layeredStageProblem({layers:{lamp:{kind:'lamp',width:500}}})).toContain('unsupported');
});
