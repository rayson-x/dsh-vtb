/** Adapter contract: real tool schema validation and canonical role/call identity. */
import{afterEach,expect,it,vi}from'vitest';
vi.mock('../src/dsh/runtime',()=>({SOULS:'/unused-persona-fixture'}));
import{applyRoleAgent}from'../src/live/runtime/agent-plugin';
import{DshLiveTeam}from'../src/live/runtime/dsh-team';
import{bindTeam}from'../src/live/runtime/link';
afterEach(()=>{bindTeam(undefined);vi.restoreAllMocks();});
it.each(['object','string','direct','mixed'])('accepts a production payload object or legacy JSON without trusting client identity: wire=%s',async wire=>{
 const registered=new Map<string,any>(),restrict=vi.fn(()=>()=>{});
 const ctx={effect:(fn:()=>unknown)=>fn(),tools:{register:(d:any)=>{registered.set(d.name,d);return()=>{};},restrict}};
 applyRoleAgent(ctx,'production');
 const team=new DshLiveTeam({get:()=>undefined},{brief:()=>({}),invoke:async()=>({})},process.cwd());bindTeam(team);
 const invoke=vi.spyOn(team,'invoke').mockResolvedValue({ok:true});
 const payload={directionEpoch:2,taskId:'base',taskVersion:1,source:'export default {}',_callId:'untrusted'};
 if(wire==='mixed'){await expect(registered.get('workspaceBuildPreview').execute({payload,taskId:'conflict'},{callId:'bound-call',agent:{session:{id:'production-session'}}})).rejects.toThrow('Do not mix');return;}
 await registered.get('workspaceBuildPreview').execute(wire==='direct'?payload:{payload:wire==='string'?JSON.stringify(payload):payload},{callId:'bound-call',agent:{session:{id:'production-session'}}});
 expect(invoke).toHaveBeenCalledWith('production-session','production','workspaceBuildPreview',{...payload,_callId:'bound-call'});
});
