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
    return k.submit({ commandId: id, idempotencyKey: id, actorId: actor, target, payload, directionEpoch: k.epoch(), expectedRevision: k.revision(target) });
  };
}
describe('review regressions at their owner boundaries', () => {
  it('keeps different actors command IDs independent in the durable log',()=>{
    const k=new EngineeringKernel(); const send=(actorId:string,payload:ShowCommand,target:CommandTarget)=>k.submit({commandId:'same-provider-call',idempotencyKey:'same-provider-call',actorId,payload,target,directionEpoch:k.epoch(),expectedRevision:k.revision(target)});
    expect(send(A.performer,{type:'offerSpeech',partId:'part',text:'Hello'},{kind:'speechPart',id:'part'}).ok).toBe(true);
    expect(send(A.editorial,{type:'prepareDirection',directionId:'next',commitment:'A next direction',coreQuestion:'Question'},{kind:'direction',id:'next'}).ok).toBe(true);
    expect(new Set(k.allEvents().map(e=>e.eventId)).size).toBe(2);
  });
  it('routes an urgent repeated input and a new direction as separate buckets', () => {
    const a = new InputAggregator(2000);
    const raw = { platform: 'test', audienceId: 'viewer', text: 'change', receivedAt: 100 };
    a.accept(normalizeInput({ ...raw, externalId: 'a' }, 1));
    expect(a.accept(normalizeInput({ ...raw, externalId: 'b', urgent: true }, 1))).toMatchObject({ deliver: true, item: { priority: 'urgent' } });
    expect(a.accept(normalizeInput({ ...raw, externalId: 'c' }, 2))).toMatchObject({ deliver: true, item: { directionEpoch: 2 } });
  });
  it('retries an uncommitted platform event after reconnect instead of dropping it', () => {
    const h = new MemoryAgentHarness();
    const raw = { platform: 'test', externalId: 'retry', audienceId: 'viewer', text: 'hello', receivedAt: 100 };
    h.kernel.disconnect(); expect(() => h.ingest(raw)).toThrow();
    sender(h.kernel)(A.runtime, { kind: 'show', id: h.kernel.view().project.id }, { type: 'reconnect' });
    expect(h.ingest(raw)).toMatchObject({ duplicateEvent: false, woken: expect.arrayContaining(['performer']) });
    expect(h.kernel.view().audience.filter(a => a.eventId === 'test:retry')).toHaveLength(1);
  });
  it('restores show time and accepted idempotency without repeating execution', () => {
    const log = new MemoryEventLog(); const clock = new ManualProgrammeClock(); clock.advance(12000);
    const k = new EngineeringKernel({ log, clock });
    const command = { commandId: 'persisted-speech', idempotencyKey: 'persisted-speech', actorId: A.performer, directionEpoch: k.epoch(), expectedRevision: 0, target: { kind: 'speechPart' as const, id: 'p' }, payload: { type: 'offerSpeech' as const, partId: 'p', text: 'Hello' } };
    const accepted = k.submit(command); expect(accepted.ok).toBe(true);
    const recovered = EngineeringKernel.hydrate(MemoryEventLog.fromSnapshot(log.snapshot()));
    expect(recovered.clock.now()).toBe(12000);
    expect(recovered.submit(command)).toEqual(accepted);
    expect(recovered.view().speech.p.text).toBe('Hello');
  });
  it('advances a word anchor from real media progress while audio is still playing', () => {
    const k = new EngineeringKernel(); const send = sender(k); const target: CommandTarget = { kind: 'speechPart', id: 'p' };
    expect(send(A.performer, target, { type: 'offerSpeech', partId: 'p', text: '甲乙丙丁' }).ok).toBe(true);
    for (const type of ['acceptSpeech','queueSpeech','startSpeech'] as const) expect(send(A.runtime, target, { type, partId: 'p' }).ok).toBe(true);
    expect(send(A.runtime, target, { type: 'receiptSpeech', partId: 'p', kind: 'playing', audioRef: '/real.mp3', alignment: 'real', starts: [0,100,200,300], spokenChars: 0 }).ok).toBe(true);
    expect(send(A.runtime, target, { type: 'progressSpeech', partId: 'p', audioRef: '/real.mp3', mediaTimeMs: 150 }).ok).toBe(true);
    expect(k.view().speech.p).toMatchObject({ state: 'playing', spokenChars: 2 });
    expect(send(A.runtime, target, { type: 'progressSpeech', partId: 'p', audioRef: '/other.mp3', mediaTimeMs: 250 }).ok).toBe(false);
  });
  it('reviews recorded distinct opposition before issuing group authorization', () => {
    const clock = new ManualProgrammeClock(); const k = new EngineeringKernel({ clock }); const send = sender(k);
    const show: CommandTarget = { kind: 'show', id: k.view().project.id };
    for (let i = 0; i < 5; i++) expect(send(A.input, show, { type: 'ingestAudience', eventId: `v${i}`, audienceId: `v${i}`, text: 'Do not continue this direction', kind: 'opposition' }).ok).toBe(true);
    clock.advance(10000);
    const target: CommandTarget = { kind: 'direction', id: k.view().project.currentDirectionId };
    expect(send(A.controller, target, { type: 'issueSwitchAuthorization', authorizationId: 'veto', kind: 'group-veto', reason: 'Recorded opposition', assessmentTimes: [0,10000] }).ok).toBe(true);
    expect(send(A.controller, target, { type: 'issueSwitchAuthorization', authorizationId: 'future', kind: 'group-veto', reason: 'Future cannot be evidence', assessmentTimes: [0,99999] }).ok).toBe(false);
  });
});
