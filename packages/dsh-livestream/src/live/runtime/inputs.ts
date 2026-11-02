import type { EngineeringKernel } from '../kernel';
import { InputAggregator, aggregateSummary } from '../events/aggregate';
import { normalizeInput, type RawPlatformInput } from '../events/normalize';
import { routeAggregate } from '../events/route';
import type { AgentRole } from '../domain/codes';
/** Input commits precede deduplication; slow roles are never a synchronous dependency. */
export class RuntimeInputs {
 private readonly aggregate = new InputAggregator(2000);
 constructor(private readonly kernel:EngineeringKernel,private readonly wake:(role:AgentRole,text:string,urgent:boolean)=>void){}
 ingest(raw:RawPlatformInput){
  const input=normalizeInput(raw,this.kernel.epoch());const checkpoint=this.aggregate.checkpoint();
  const decision=this.aggregate.accept(input);if(decision.duplicateEvent)return;
  const target={kind:'show' as const,id:this.kernel.view().project.id};
  const commandId=`platform-${input.eventId}`;
  const result=this.kernel.submit({commandId,idempotencyKey:commandId,actorId:'live:input',directionEpoch:this.kernel.epoch(),expectedRevision:this.kernel.revision(target),target,payload:{type:'ingestAudience',eventId:input.eventId,audienceId:input.audienceId,text:input.text,kind:input.kind,...(input.kind==='proposal'?{proposalId:`proposal-${decision.item.bucketId}`,intent:input.text}:{})}});
  if(!result.ok){this.aggregate.restore(checkpoint);throw Error(result.message);}
  if(!decision.deliver)return;
  for(const destination of routeAggregate(decision.item))if(destination.wake)this.wake(destination.role,`观众简报：${aggregateSummary(decision.item)}`,destination.priority==='urgent');
 }
}
