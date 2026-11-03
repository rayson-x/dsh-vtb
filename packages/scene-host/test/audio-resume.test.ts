import {afterEach,expect,it,vi} from 'vitest';
import {resumeProgrammeAudio} from '../src/recording/audio';
afterEach(()=>vi.useRealTimers());
it('turns an autoplay-suspended context into a bounded enable-audio response, rather than waiting forever',async()=>{
 vi.useFakeTimers();const context:{state:AudioContextState;resume:()=>Promise<void>}={state:'suspended',resume:()=>new Promise(()=>{})};
 let finished=false;const promise=resumeProgrammeAudio(context).finally(()=>{finished=true;});
 const rejected=expect(promise).rejects.toMatchObject({name:'NotAllowedError'});
 await vi.advanceTimersByTimeAsync(251);expect(finished).toBe(true);await rejected;
});
it('allows a context that actually resumes to continue normal media playback',async()=>{
 const context:{state:AudioContextState;resume:()=>Promise<void>}={state:'suspended',resume:async()=>{context.state='running';}};
 await expect(resumeProgrammeAudio(context)).resolves.toBeUndefined();
});
