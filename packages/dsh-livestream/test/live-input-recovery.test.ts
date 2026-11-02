import { expect, it } from 'vitest';
import { StageJournalConsumer, RuntimeInputs, type JournalBatch } from '../src/live/runtime/inputs';
import { EngineeringKernel } from '../src/live/kernel';
import { MemoryEventLog } from '../src/live/events/log';
const actors = { 'live:input': { actorId: 'live:input', role: 'input' as const, trustedMaster: false } };
const record = (sequence: number, text: string) => ({
  sequence,
  receivedAt: 100,
  event: { platform: 'test', kind: 'danmaku', at: 50, user: { id: 'viewer', name: 'viewer' }, text },
});
it('preserves distinct same-timestamp messages and starts at zero after a journal generation changes', async () => {
  let batch: JournalBatch = {
    journalId: 'a',
    oldest: 1,
    latest: 2,
    events: [record(1, 'first'), record(2, 'second')],
  };
  const received: string[] = [];
  const reader = new StageJournalConsumer(
    async ({ after }) => ({ ...batch, events: batch.events.filter((e) => e.sequence > after) }),
    (input) => received.push(input.externalId + ':' + input.text),
  );
  await reader.poll();
  batch = {
    journalId: 'b',
    oldest: 1,
    latest: 3,
    events: [record(1, 'new-first'), record(2, 'new-second'), record(3, 'new-third')],
  };
  await reader.poll();
  expect(received).toEqual(['a:1:first', 'a:2:second', 'b:1:new-first', 'b:2:new-second', 'b:3:new-third']);
});
it('does not block replay at the first already committed input after process recovery', () => {
  const log = new MemoryEventLog();
  const kernel = new EngineeringKernel({ log, actors });
  const raw = {
    platform: 'test',
    externalId: 'journal:1',
    audienceId: 'viewer',
    text: 'first',
    receivedAt: 100,
  };
  new RuntimeInputs(kernel, () => {}).ingest(raw);
  const restored = EngineeringKernel.hydrate(MemoryEventLog.fromSnapshot(log.snapshot()), { actors });
  const router = new RuntimeInputs(restored, () => {});
  expect(() => router.ingest(raw)).not.toThrow();
  router.ingest({ ...raw, externalId: 'journal:2', text: 'second' });
  expect(restored.view().audience.map((a) => a.text)).toEqual(['first', 'second']);
});
