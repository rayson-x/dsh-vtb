import { expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session';
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection';
import { createUserMessage, createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm';
import { toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction';
import { boundRoleContext } from '../src/live/runtime/context-window';
it('bounds repeated real session tool exchanges while retaining the latest request and immutable history', () => {
 const ctx=new Context();new SessionProjectionRegistry(ctx);new SessionStore(ctx);
 const session=ctx.sessions.create(SessionId('bounded-live'));
 session.append('user/message',createUserMessage({content:[{type:'text',text:'主人：保留窗边的灯，不要粉色'}],source:{kind:'user'}}),{surfaceOp:'append'});
 let firstResult;
 for(let i=0;i<40;i++){
  const id=ToolCallId('large-'+i);
  session.append('assistant/message',{turn:1,step:i,message:createAssistantMessage({source:{provider:'fixture',model:'fixture'},content:[{type:'tool-call',id,name:'readProgramme',arguments:'{}'}]}),stream:[]},{surfaceOp:'append'});
  const result=session.append('tool/result',{turn:1,step:i,message:createToolResultMessage({callId:id,content:[{type:'text',text:'large-result-'+i+'x'.repeat(20000)}],isError:false})},{surfaceOp:'append'});
  firstResult??=result;
  const bounded=boundRoleContext(session,{epoch:2,role:'director',brief:{direction:'海底邮局'},candidates:[]},64000);
  expect(bounded.bytes).toBeLessThan(64000);
  expect(toolPairingBalancedAfter(session,session.surface.nodes.at(-1)!)).toBe(true);
 }
 const texts=session.surface.nodes.map(seq=>JSON.stringify(session.eventAt(seq)!.data)).join('\n');
 expect(texts).toContain('不要粉色');expect(texts).toContain('海底邮局');
 expect(session.eventAt(firstResult!.seq)?.type).toBe('tool/result');
 expect(session.surface.nodes).not.toContain(firstResult!.seq);
});
it('never removes the unanswered tail of a tool exchange when compacting an older prefix',()=>{
 const ctx=new Context();new SessionProjectionRegistry(ctx);new SessionStore(ctx);const session=ctx.sessions.create(SessionId('balanced-tail'));
 for(let i=0;i<20;i++)session.append('user/message',createUserMessage({content:[{type:'text',text:'旧观察点'+i+'x'.repeat(5000)}],source:{kind:'user'}}),{surfaceOp:'append'});
 const id=ToolCallId('still-running');const pending=session.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({source:{provider:'fixture',model:'fixture'},content:[{type:'tool-call',id,name:'build',arguments:'{}'}]}),stream:[]},{surfaceOp:'append'});
 boundRoleContext(session,{epoch:3,role:'production',brief:{task:'current'}},64000);
 expect(session.surface.nodes).toContain(pending.seq);
 expect(toolPairingBalancedAfter(session,pending.seq)).toBe(false);
});
it('keeps standing master constraints across unrelated notifications and repeated replacements',()=>{
 const ctx=new Context();new SessionProjectionRegistry(ctx);new SessionStore(ctx);const session=ctx.sessions.create(SessionId('standing-rules'));
 const add=(text:string)=>session.append('user/message',createUserMessage({content:[{type:'text',text}],source:{kind:'user'}}),{surfaceOp:'append'});
 add('主人：窗边保留暖灯，不要粉色');
 for(let round=0;round<3;round++){
  for(let i=0;i<20;i++)add('观众消息'+round+'-'+i+'x'.repeat(5000));
  boundRoleContext(session,{epoch:2,role:'director',brief:{direction:'海底书房'}},64000);
  expect(session.surface.nodes.map(seq=>JSON.stringify(session.eventAt(seq)!.data)).join('\n')).toContain('不要粉色');
 }
});
