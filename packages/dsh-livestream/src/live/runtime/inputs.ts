import type { EngineeringKernel } from '../kernel';
import { InputAggregator, aggregateSummary } from '../events/aggregate';
import { normalizeInput, type RawPlatformInput } from '../events/normalize';
import { routeAggregate } from '../events/route';
import type { AgentRole } from '../domain/codes';
/** Input commits precede deduplication; slow roles are never a synchronous dependency. */
export class RuntimeInputs {
  private readonly aggregate = new InputAggregator(2000);
  constructor(
    private readonly kernel: EngineeringKernel,
    private readonly wake: (role: AgentRole, text: string, urgent: boolean) => void,
    private readonly observe?: (eventId:string,receivedAt:number,urgent:boolean)=>void,
  ) {}
  ingest(raw: RawPlatformInput) {
    const input = normalizeInput(raw, this.kernel.epoch());
    if (this.kernel.view().audience.some((record) => record.eventId === input.eventId)) return;
    const checkpoint = this.aggregate.checkpoint();
    const decision = this.aggregate.accept(input);
    if (decision.duplicateEvent) return;
    const target = { kind: 'show' as const, id: this.kernel.view().project.id };
    const commandId = `platform-${input.eventId}`;
    const result = this.kernel.submit({
      commandId,
      idempotencyKey: commandId,
      actorId: 'live:input',
      directionEpoch: this.kernel.epoch(),
      expectedRevision: this.kernel.revision(target),
      target,
      payload: {
        type: 'ingestAudience',
        eventId: input.eventId,
        audienceId: input.audienceId,
        text: input.text,
        kind: input.kind,
        ...(input.kind === 'proposal'
          ? { proposalId: `proposal-${decision.item.bucketId}`, intent: input.text }
          : {}),
      },
    });
    if (!result.ok) {
      this.aggregate.restore(checkpoint);
      throw Error(result.message);
    }
    if (!decision.deliver) return;
    this.observe?.(input.eventId,input.receivedAt,input.urgent);
    for (const destination of routeAggregate(decision.item))
      if (destination.wake)
        this.wake(
          destination.role,
          `观众简报：${aggregateSummary(decision.item)}`,
          destination.priority === 'urgent',
        );
  }
}

export interface JournalBatch {
  journalId: string;
  oldest: number;
  latest: number;
  events: Array<{
    sequence: number;
    receivedAt: number;
    event: {
      platform: string;
      kind: string;
      at?: number;
      text?: string;
      room?: string;
      user?: { id?: string; name: string };
      gift?: { name: string };
    };
  }>;
}
/** Cursor belongs to one journal generation; reconnect never skips its beginning. */
export class StageJournalConsumer {
  private cursor = 0;
  private journalId = '';
  private polling = false;
  private stopped = false;
  constructor(
    private readonly read: (request: { after: number; journalId: string }) => Promise<JournalBatch>,
    private readonly consume: (input: RawPlatformInput) => void,
    private readonly gap: () => void = () => {},
  ) {}
  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      let batch = await this.read({ after: this.cursor, journalId: this.journalId });
      if (this.stopped) return;
      if (this.journalId && batch.journalId !== this.journalId) {
        batch = await this.read({ after: 0, journalId: batch.journalId });
        if (this.stopped) return;
        this.cursor = 0;
      }
      if (this.cursor && batch.oldest > this.cursor + 1) this.gap();
      this.journalId = batch.journalId;
      for (const record of batch.events) {
        const e = record.event,
          text = String(e.text ?? e.gift?.name ?? e.kind);
        this.consume({
          platform: e.platform,
          externalId: `${batch.journalId}:${record.sequence}`,
          audienceId: `${e.platform}:${e.user?.id ?? e.user?.name ?? 'anonymous'}`,
          text,
          receivedAt: record.receivedAt,
          kindHint: /(?:不想|不要|别再).{0,8}(?:这个方向|这个话题|继续)/.test(text)
            ? 'opposition'
            : undefined,
          urgent: ['gift', 'superchat', 'guard'].includes(e.kind),
        });
        this.cursor = record.sequence;
      }
    } finally {
      this.polling = false;
    }
  }
  close() {
    this.stopped = true;
  }
}
