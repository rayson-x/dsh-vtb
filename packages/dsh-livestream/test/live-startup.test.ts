import {afterEach,expect,it,vi} from 'vitest';
const ports=vi.hoisted(()=>({connect:undefined as undefined|((record:any)=>void),release:undefined as undefined|(()=>void),call:vi.fn(),stop:vi.fn(async()=>{})}));
vi.mock('../src/dsh/runtime',()=>({PACKAGE_ROOT:'/unused/packages/live',BRAIN_PORT:0,show:{},secret:()=>undefined,bindCredentials:()=>{},stage:{state:{danmaku:[]},connect:(fn:any)=>{ports.connect=fn;},close:()=>{},setShow:()=>{},call:ports.call}}));
vi.mock('../src/live/runtime/production',()=>({ProductionRuntime:class{
 kernel={view:()=>({project:{currentDirectionId:'current'},directions:{}})};
 gateway={origin:'http://127.0.0.1:3999'};
 start(){return new Promise<void>(done=>{ports.release=done;});}
 stop=ports.stop;
 recordTiming(){}
}}));
import {applyV2Root} from '../src/live/runtime/root-plugin';
const cleanup:Array<()=>unknown>=[];
afterEach(async()=>{for(const dispose of cleanup.splice(0).reverse())await dispose();ports.connect=undefined;ports.release=undefined;vi.clearAllMocks();});
it('advertises the iframe endpoint only after the scene server has completed startup',async()=>{
 ports.call.mockResolvedValue({protocol:1});
 const ctx={on:()=>()=>{},effect:(fn:()=>any)=>{const dispose=fn();if(typeof dispose==='function')cleanup.push(dispose);},logger:{warn:vi.fn(),info:vi.fn()}};
 applyV2Root(ctx,{brainPort:0});
 ports.connect!({show:{live:false}});await Promise.resolve();await Promise.resolve();
 expect(ports.call).not.toHaveBeenCalled();
 ports.release!();await vi.waitFor(()=>expect(ports.call).toHaveBeenCalledWith('harness.mode',{mode:'v2',sceneUrl:'http://127.0.0.1:3999',sceneGeneration:expect.any(String)}));
 const generation=ports.call.mock.calls[0][1].sceneGeneration;
 ports.connect!({show:{live:false}});await Promise.resolve();await Promise.resolve();
 expect(ports.call.mock.calls.at(-1)?.[1].sceneGeneration).toBe(generation);
});
