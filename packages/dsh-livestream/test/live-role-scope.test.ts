/** Real DSH tool registry across preset/agent scopes; no model requests. */
import{expect,it,vi}from'vitest';
import{Context}from'@deepseek-ai/cordis';
import{createScope}from'@deepseek-ai/dsh-scope';
import SystemPrompt from'@deepseek-ai/dsh-system-prompt';
import ToolRuntime,{defineTool}from'@deepseek-ai/dsh-tools';
import{DshLiveTeam}from'../src/live/runtime/dsh-team';
import{ToolCallId}from'@deepseek-ai/dsh-llm';
import{bindTeam}from'../src/live/runtime/link';
import{applyRoleAgent}from'../src/live/runtime/agent-plugin';
vi.mock('../src/dsh/runtime',()=>({SOULS:'/unused-persona-fixture'}));
it('keeps preset-owned live tools callable on the real agent scope while hiding inherited coding tools',async()=>{
 const root=new Context();await root.plugin(SystemPrompt,{});await root.plugin(ToolRuntime);
 const calls:any[]=[];
 const scopes:ReturnType<typeof createScope>[]=[],agents=new Map<string,any>(),presets=new Map<any,any>();
 const globalTool=defineTool({name:'working_directory',description:'global coding tool',parameters:{},output:{schema:{type:'string'},render:()=>[]},execute:async()=>'/not-for-live'});root.tools.register(globalTool);
 let team:DshLiveTeam|undefined;
 try{
 await root.plugin(Object.assign((inner:Context)=>{
  team=new DshLiveTeam({get:name=>name==='agentDefaultModel'?{currentSelection:()=>({provider:'fixture',model:'fixture'})}:name==='agents'?{create:async(options:any)=>{
    const agent:any={session:{id:options.sessionId},status:'idle',followup:()=>{},steer:()=>{},cancel:()=>{},whenIdle:async()=>{}};
    const preset=createScope(inner,{}),seat=createScope(inner,agent,{parent:(await import('@deepseek-ai/dsh-scope')).scopeOf(preset.ctx)!});
    scopes.push(preset,seat);agent.ctx=seat.ctx;presets.set(agent,preset.ctx);agents.set(options.meta.agentPreset,agent);return{agent};
  }}:name==='agentPresets'?{select:async(agent:any,id:string)=>{applyRoleAgent(presets.get(agent),id.replace('live-v2-','') as 'production');}}:undefined},{brief:()=>({}),invoke:async(role,tool,args)=>{calls.push({role,tool,args});return{ok:true};}},process.cwd());
 },{inject:['tools','systemPrompt']}));
 await team!.start();bindTeam(team);const production=agents.get('live-v2-production');
 expect(root.tools.get('workspaceBuildPreview',production)).toBeDefined();
 expect(root.tools.get('working_directory',production)).toBeUndefined();
 expect(team!.snapshot().every(r=>r.ready)).toBe(true);
 const result=await root.tools.execute({agent:production,callId:ToolCallId('scoped-build'),name:'workspaceBuildPreview',arguments:{payload:{directionEpoch:1,taskId:'base',taskVersion:1,source:'export default {}'}},signal:new AbortController().signal});
 expect(result.isError,JSON.stringify(result.content)).toBe(false);expect(calls.at(-1)).toMatchObject({role:'production',tool:'workspaceBuildPreview',args:{taskId:'base',_callId:'scoped-build'}});
 }finally{bindTeam(undefined);await team?.stop();for(const s of scopes.reverse())await s.dispose();}
});
