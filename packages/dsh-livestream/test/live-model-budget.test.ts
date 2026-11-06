import { expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { ModelBudget, modelLimits } from '../src/live/runtime/model-budget';
const limits = { requests: 5, requestBytes: 10000, inputBytes: 50000, outputTokens: 10, durationMs: 10000 };
const options: GenerateOptions = Object.freeze({provider:'fixture',model:'fixture',maxTokens:5,messages:[]});
async function collect(stream: AsyncIterable<StreamChunk>) { const chunks=[]; for await(const chunk of stream)chunks.push(chunk);return chunks; }
it('reserves concurrent calls at the real LLM boundary and refuses excess dispatch, including frozen requests',async()=>{
 const ctx=new Context(),exhausted=vi.fn(),budget=new ModelBudget(limits,exhausted);await ctx.plugin(LlmRuntime);
 ctx.on('llm/stream',(request,next)=>budget.stream(request,next));
 let release!:()=>void,calls=0;const gate=new Promise<void>(done=>{release=done;});
 class Adapter extends LlmAdapter {async *stream():AsyncIterable<StreamChunk>{calls++;await gate;yield{type:'usage',usage:{inputTokens:2,outputTokens:1}};yield{type:'finish',reason:{kind:'stop'}};}}
 const registration=ctx.llm.registerAdapter(['fixture'],new Adapter());
 try{
  const a=collect(ctx.llm.stream(options)),b=collect(ctx.llm.stream(options));await vi.waitFor(()=>expect(calls).toBe(2));
  await expect(collect(ctx.llm.stream(options))).rejects.toThrow(/budget exhausted/);expect(calls).toBe(2);expect(exhausted).toHaveBeenCalledTimes(1);
  release();await Promise.all([a,b]);expect(budget.snapshot()).toMatchObject({requests:2,outputTokens:2,reservedOutputTokens:0,blocked:true});
 }finally{release();registration();}
});
it('settles successful usage but retains the full reservation for a failed response even when it reports zero usage',async()=>{
 const budget=new ModelBudget(limits,()=>{}),request={...options,maxTokens:8};
 await collect(budget.stream(request,async function*(){yield{type:'usage',usage:{inputTokens:3,outputTokens:2}};yield{type:'finish',reason:{kind:'tool-calls'}};}));
 await collect(budget.stream(request,async function*(){yield{type:'usage',usage:{inputTokens:0,outputTokens:0}};yield{type:'finish',reason:{kind:'error',failure:{code:'UNKNOWN',message:'Disconnected'}}};}));
 expect(budget.snapshot()).toMatchObject({requests:2,outputTokens:2,unknownOutputTokens:8,reservedOutputTokens:0});
 const dispatch=vi.fn(async function*(){yield{type:'finish',reason:{kind:'stop'}} as StreamChunk;});
 await expect(collect(budget.stream(request,dispatch))).rejects.toThrow(/output-tokens/);expect(dispatch).not.toHaveBeenCalled();
});
it('fails closed on invalid configuration, missing output caps, oversized requests and expired budgets',async()=>{
 expect(()=>modelLimits({AIVTB_MODEL_REQUESTS:'NaN'})).toThrow(/Invalid model limit/);
 for(const [overrides,request,reason] of [[{}, {...options,maxTokens:undefined}, 'missing-output-cap'],[{requestBytes:1},options,'input-bytes'],[{durationMs:0},options,'duration']] as const){
  const dispatch=vi.fn(async function*(){}),budget=new ModelBudget({...limits,...overrides},()=>{});
  await expect(collect(budget.stream(request,dispatch))).rejects.toThrow(reason);expect(dispatch).not.toHaveBeenCalled();
 }
});
