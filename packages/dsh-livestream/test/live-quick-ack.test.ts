import{afterEach,expect,it,vi}from'vitest';
import{QuickAcknowledgements,firstAcknowledgementClause}from'../src/live/runtime/quick-ack';
afterEach(()=>vi.useRealTimers());
it('takes the first complete relevant clause, without speaking a partial word or just echoing the question',()=>{
 expect(firstAcknowledgementClause('暖灯可以有。后面还在生成','窗外加暖灯吗？')).toBe('暖灯可以有。');
 expect(firstAcknowledgementClause('小灯，这封没署名的信，','信是谁写的？')).toBeUndefined();
 expect(firstAcknowledgementClause('暖灯先记下，后面还在生成','窗外加一盏暖灯吗？')).toBe('暖灯先记下。');
 expect(firstAcknowledgementClause('这个提议我同意，','窗外加一盏暖灯吗？')).toBeUndefined();
 expect(firstAcknowledgementClause('暖灯我想放在，','窗外加一盏暖灯吗？')).toBeUndefined();
 expect(firstAcknowledgementClause('暖灯可','窗外加暖灯吗？')).toBeUndefined();
 expect(firstAcknowledgementClause('是谁写的，','是谁写的？')).toBeUndefined();
 expect(firstAcknowledgementClause('这个问题很有意思，','这封信谁写的？')).toBeUndefined();
});
it('generates a separate short reply without waiting for the main speaker and retains the bound input',async()=>{
 let resolve!:(s:string)=>void;const pending=new Promise<string>(done=>{resolve=done;}),offer=vi.fn(async()=>({ok:true})),release=vi.fn();
 const q=new QuickAcknowledgements({context:id=>({epoch:2,inputId:id,text:'暖灯放窗边？',topic:'书房',heard:'正读信',instructions:[]}),reserve:()=>release,generate:()=>pending,offer,fallback:vi.fn()});
 expect(q.submit('original')).toBe(true);expect(q.submit('original')).toBe(false);await Promise.resolve();expect(offer).not.toHaveBeenCalled();
 resolve('暖灯留窗边。');await vi.waitFor(()=>expect(offer).toHaveBeenCalledWith('original','暖灯留窗边。',2));expect(release).toHaveBeenCalledTimes(1);await q.stop();
});
it('times out to the main speaker and never plays a late generated acknowledgement',async()=>{
 vi.useFakeTimers();let resolve!:(s:string)=>void;const pending=new Promise<string>(done=>{resolve=done;}),offer=vi.fn(async()=>({ok:true})),fallback=vi.fn(),release=vi.fn();
 const q=new QuickAcknowledgements({context:id=>({epoch:2,inputId:id,text:'灯',topic:'书房',heard:'',instructions:[]}),reserve:()=>release,generate:()=>pending,offer,fallback});q.submit('one');await vi.advanceTimersByTimeAsync(4001);
 expect(fallback).toHaveBeenCalledWith('one');resolve('迟到的暖灯。');await vi.advanceTimersByTimeAsync(1);expect(offer).not.toHaveBeenCalled();expect(release).toHaveBeenCalledTimes(1);await q.stop();
});
it('cancels outstanding short replies on pause without falling back or committing audio',async()=>{
 const offer=vi.fn(async()=>({ok:true})),fallback=vi.fn();const q=new QuickAcknowledgements({context:id=>({epoch:1,inputId:id,text:'灯',topic:'',heard:'',instructions:[]}),reserve:()=>()=>{},generate:()=>new Promise(()=>{}),offer,fallback});
 q.submit('one');await q.stop();expect(offer).not.toHaveBeenCalled();expect(fallback).not.toHaveBeenCalled();
});
it.each(['是谁写的','这个问题很有意思','小灯，这封没署名的信，'])('does not bypass the relevance filter for an unfinished or irrelevant completed output: %s',async text=>{
 const offer=vi.fn(async()=>({ok:true})),fallback=vi.fn();const q=new QuickAcknowledgements({context:id=>({epoch:1,inputId:id,text:'是谁写的？',topic:'',heard:'',instructions:[]}),reserve:()=>()=>{},generate:async()=>text,offer,fallback});
 q.submit('one');await vi.waitFor(()=>expect(fallback).toHaveBeenCalledWith('one'));expect(offer).not.toHaveBeenCalled();await q.stop();
});
