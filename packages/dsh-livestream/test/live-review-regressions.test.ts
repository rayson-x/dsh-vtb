import { describe, expect, it } from 'vitest';
import { EngineeringKernel } from '../src/live/kernel';
import { MemoryEventLog } from '../src/live/events/log';
import { ManualProgrammeClock } from '../src/live/playback/manual-clock';
import { MemoryAgentHarness } from '../src/live/agents/harness';
import { InputAggregator } from '../src/live/events/aggregate';
import { normalizeInput } from '../src/live/events/normalize';
import { FIXTURE_ACTORS as A } from '../src/live/domain/fixture';
import type { CommandTarget, ShowCommand } from '../src/live/domain/commands';

function sender(k: EngineeringKernel) {
  let seq = 0;
  return (actor: string, target: CommandTarget, payload: ShowCommand) => {
    const id = `regression-${++seq}`;
    return k.submit({
      commandId: id,
      idempotencyKey: id,
      actorId: actor,
      target,
      payload,
      directionEpoch: k.epoch(),
      expectedRevision: k.revision(target),
    });
  };
}
describe('review regressions at their owner boundaries', () => {
  it('keeps A resumable across a real boundary stop, invalidates unread cues atomically and consumes resume only on playback',()=>{
    const log=new MemoryEventLog(),k=new EngineeringKernel({log}),send=sender(k),target:CommandTarget={kind:'speechPart',id:'A'};
    const text='窗边有盏灯，接着聊来信。';
    expect(send(A.input,{kind:'show',id:k.view().project.id},{type:'ingestAudience',eventId:'question',audienceId:'viewer',text:'灯光换暖色？',kind:'proposal',priority:'urgent'}).ok).toBe(true);
    expect(send(A.performer,target,{type:'offerSpeech',partId:'A',text}).ok).toBe(true);
    for(const type of['acceptSpeech','queueSpeech','startSpeech']as const)send(A.runtime,target,{type,partId:'A'});
    send(A.runtime,target,{type:'receiptSpeech',partId:'A',kind:'playing',audioRef:'/A.mp3',alignment:'real',starts:[...text].map((_,i)=>i*100)});
    send(A.director,{kind:'cue',id:'tail'},{type:'bindCue',cue:{cueId:'tail',anchor:{kind:'speech',partId:'A',charIndex:8},payload:{}}});
    expect(send(A.runtime,target,{type:'requestSpeechInterrupt',partId:'A',interruptId:'interrupt-1',responseTo:'question'}).ok).toBe(true);
    expect(k.view().cues.tail.status).toBe('future');expect(Object.keys(k.view().continuations)).toHaveLength(0);
    expect(send(A.runtime,target,{type:'receiptSpeechInterrupted',partId:'A',interruptId:'interrupt-1',audioRef:'/A.mp3',mediaTimeMs:550}).ok).toBe(true);
    const continuation=Object.values(k.view().continuations)[0];
    expect(k.view().speech.A).toMatchObject({state:'aborted',spokenChars:6,unreadFrom:6});expect(k.view().cues.tail.status).toBe('invalidated');
    expect(continuation).toMatchObject({sourcePartId:'A',firstUnreadChar:6,unreadText:'接着聊来信。',status:'pending',boundaryReached:true});
    expect(send(A.performer,{kind:'speechPart',id:'wrong-reply'},{type:'offerSpeech',partId:'wrong-reply',text:'接着读信。',responseTo:'question',responseStage:'finish',resumesContinuationIds:[continuation.id]}).ok).toBe(false);
    const newTarget:CommandTarget={kind:'speechPart',id:'resume-A'};
    expect(send(A.performer,newTarget,{type:'offerSpeech',partId:'resume-A',text:'灯光定了，我们接着读信。',resumesContinuationIds:[continuation.id]}).ok).toBe(true);
    expect(k.view().continuations[continuation.id].status).toBe('resuming');
    send(A.runtime,newTarget,{type:'rejectSpeech',partId:'resume-A',reason:'fixture synthesis failed'});
    expect(k.view().continuations[continuation.id].status).toBe('pending');
    const retry:CommandTarget={kind:'speechPart',id:'resume-new'};send(A.performer,retry,{type:'offerSpeech',partId:'resume-new',text:'暖灯留在窗边，刚才的信继续读。',resumesContinuationIds:[continuation.id]});
    for(const type of['acceptSpeech','queueSpeech','startSpeech']as const)send(A.runtime,retry,{type,partId:'resume-new'});
    send(A.runtime,retry,{type:'receiptSpeech',partId:'resume-new',kind:'playing',audioRef:'/new.mp3',alignment:'real',starts:[...'暖灯留在窗边，刚才的信继续读。'].map((_,i)=>i*100)});
    expect(k.view().continuations[continuation.id].status).toBe('resumed');
    const recovered=EngineeringKernel.hydrate(MemoryEventLog.fromSnapshot(log.snapshot()));expect(recovered.view().continuations[continuation.id].status).toBe('resumed');
    send(A.runtime,retry,{type:'progressSpeech',partId:'resume-new',audioRef:'/new.mp3',mediaTimeMs:150});
    send(A.runtime,retry,{type:'receiptSpeech',partId:'resume-new',kind:'failed',audioRef:'/new.mp3',mediaTimeMs:250});
    expect(Object.values(k.view().continuations).filter(n=>n.status==='pending')).toHaveLength(1);
    const pending=Object.values(k.view().continuations).find(n=>n.status==='pending')!;
    expect(pending).toMatchObject({sourcePartId:'resume-new',firstUnreadChar:3,parentContinuationIds:[continuation.id]});
    const direction:CommandTarget={kind:'direction',id:k.view().project.currentDirectionId};
    expect(send(A.master,direction,{type:'issueSwitchAuthorization',authorizationId:'next',kind:'master-soft',reason:'new direction'}).ok).toBe(true);
    expect(send(A.controller,direction,{type:'switchDirection',authorizationId:'next',strategy:'soft',next:{commitment:'海底邮局',coreQuestion:'下一封信'}}).ok).toBe(true);
    expect(k.view().continuations[pending.id].status).toBe('superseded');
    expect(send(A.performer,{kind:'speechPart',id:'stale-resume'},{type:'offerSpeech',partId:'stale-resume',text:'旧A不能回来了',resumesContinuationIds:[pending.id]}).ok).toBe(false);
  });
  it('keeps different actors command IDs independent in the durable log', () => {
    const k = new EngineeringKernel();
    const send = (actorId: string, payload: ShowCommand, target: CommandTarget) =>
      k.submit({
        commandId: 'same-provider-call',
        idempotencyKey: 'same-provider-call',
        actorId,
        payload,
        target,
        directionEpoch: k.epoch(),
        expectedRevision: k.revision(target),
      });
    expect(
      send(
        A.performer,
        { type: 'offerSpeech', partId: 'part', text: 'Hello' },
        { kind: 'speechPart', id: 'part' },
      ).ok,
    ).toBe(true);
    expect(
      send(
        A.editorial,
        {
          type: 'prepareDirection',
          directionId: 'next',
          commitment: 'A next direction',
          coreQuestion: 'Question',
        },
        { kind: 'direction', id: 'next' },
      ).ok,
    ).toBe(true);
    expect(new Set(k.allEvents().map((e) => e.eventId)).size).toBe(2);
  });
  it('routes an urgent repeated input and a new direction as separate buckets', () => {
    const a = new InputAggregator(2000);
    const raw = { platform: 'test', audienceId: 'viewer', text: 'change', receivedAt: 100 };
    a.accept(normalizeInput({ ...raw, externalId: 'a' }, 1));
    expect(a.accept(normalizeInput({ ...raw, externalId: 'b', urgent: true }, 1))).toMatchObject({
      deliver: true,
      item: { priority: 'urgent' },
    });
    expect(a.accept(normalizeInput({ ...raw, externalId: 'c' }, 2))).toMatchObject({
      deliver: true,
      item: { directionEpoch: 2 },
    });
  });
  it('retries an uncommitted platform event after reconnect instead of dropping it', () => {
    const h = new MemoryAgentHarness();
    const raw = {
      platform: 'test',
      externalId: 'retry',
      audienceId: 'viewer',
      text: 'hello',
      receivedAt: 100,
    };
    h.kernel.disconnect();
    expect(() => h.ingest(raw)).toThrow();
    sender(h.kernel)(A.runtime, { kind: 'show', id: h.kernel.view().project.id }, { type: 'reconnect' });
    expect(h.ingest(raw)).toMatchObject({
      duplicateEvent: false,
      woken: expect.arrayContaining(['performer']),
    });
    expect(h.kernel.view().audience.filter((a) => a.eventId === 'test:retry')).toHaveLength(1);
  });
  it('restores show time and accepted idempotency without repeating execution', () => {
    const log = new MemoryEventLog();
    const clock = new ManualProgrammeClock();
    clock.advance(12000);
    const k = new EngineeringKernel({ log, clock });
    const command = {
      commandId: 'persisted-speech',
      idempotencyKey: 'persisted-speech',
      actorId: A.performer,
      directionEpoch: k.epoch(),
      expectedRevision: 0,
      target: { kind: 'speechPart' as const, id: 'p' },
      payload: { type: 'offerSpeech' as const, partId: 'p', text: 'Hello' },
    };
    const accepted = k.submit(command);
    expect(accepted.ok).toBe(true);
    const recovered = EngineeringKernel.hydrate(MemoryEventLog.fromSnapshot(log.snapshot()));
    expect(recovered.clock.now()).toBe(12000);
    expect(recovered.submit(command)).toEqual(accepted);
    expect(recovered.view().speech.p.text).toBe('Hello');
  });
  it('advances a word anchor from real media progress while audio is still playing', () => {
    const k = new EngineeringKernel();
    const send = sender(k);
    const target: CommandTarget = { kind: 'speechPart', id: 'p' };
    expect(send(A.performer, target, { type: 'offerSpeech', partId: 'p', text: '甲乙丙丁' }).ok).toBe(true);
    for (const type of ['acceptSpeech', 'queueSpeech', 'startSpeech'] as const)
      expect(send(A.runtime, target, { type, partId: 'p' }).ok).toBe(true);
    expect(
      send(A.runtime, target, {
        type: 'receiptSpeech',
        partId: 'p',
        kind: 'playing',
        audioRef: '/real.mp3',
        alignment: 'real',
        starts: [0, 100],
        spokenChars: 0,
      }).ok,
    ).toBe(true);
    expect(send(A.runtime,target,{type:'progressSpeech',partId:'p',audioRef:'/real.mp3',mediaTimeMs:350}).ok).toBe(true);
    expect(k.view().speech.p.spokenChars).toBe(2);
    expect(send(A.runtime,target,{type:'appendSpeechTiming',partId:'p',audioRef:'/real.mp3',starts:[0,110,200,300]}).ok).toBe(false);
    expect(send(A.runtime,target,{type:'appendSpeechTiming',partId:'p',audioRef:'/wrong.mp3',starts:[0,100,200,300]}).ok).toBe(false);
    expect(send(A.runtime,target,{type:'appendSpeechTiming',partId:'p',audioRef:'/real.mp3',starts:[0,100,200,300]}).ok).toBe(true);
    expect(
      send(A.runtime, target, {
        type: 'progressSpeech',
        partId: 'p',
        audioRef: '/real.mp3',
        mediaTimeMs: 150,
      }).ok,
    ).toBe(true);
    expect(k.view().speech.p).toMatchObject({ state: 'playing', spokenChars: 2 });
    expect(
      send(A.runtime, target, {
        type: 'progressSpeech',
        partId: 'p',
        audioRef: '/other.mp3',
        mediaTimeMs: 250,
      }).ok,
    ).toBe(false);
  });
  it('reviews recorded distinct opposition before issuing group authorization', () => {
    const clock = new ManualProgrammeClock();
    const k = new EngineeringKernel({ clock });
    const send = sender(k);
    const show: CommandTarget = { kind: 'show', id: k.view().project.id };
    for (let i = 0; i < 5; i++)
      expect(
        send(A.input, show, {
          type: 'ingestAudience',
          eventId: `v${i}`,
          audienceId: `v${i}`,
          text: 'Do not continue this direction',
          kind: 'opposition',
        }).ok,
      ).toBe(true);
    clock.advance(10000);
    const target: CommandTarget = { kind: 'direction', id: k.view().project.currentDirectionId };
    expect(
      send(A.controller, target, {
        type: 'issueSwitchAuthorization',
        authorizationId: 'veto',
        kind: 'group-veto',
        reason: 'Recorded opposition',
        assessmentTimes: [0, 10000],
      }).ok,
    ).toBe(true);
    expect(
      send(A.controller, target, {
        type: 'issueSwitchAuthorization',
        authorizationId: 'future',
        kind: 'group-veto',
        reason: 'Future cannot be evidence',
        assessmentTimes: [0, 99999],
      }).ok,
    ).toBe(false);
  });
});
