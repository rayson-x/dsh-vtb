import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rename, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import{editorialProposalProblem}from'../domain/validation';
import{layeredStageProblem}from'../../../../scene-package/src/layer-controls';
import { EngineeringKernel } from '../kernel';
import { ManualProgrammeClock } from '../playback/manual-clock';
import { FileEventLog } from './file-log';
import { BrowserGateway } from './browser-gateway';
import { productionPriority,unmetProductionDependencies } from '../production/registry';
import { projectRoleBriefs,projectProductionBrief } from '../agents/briefs';
import { TOOL_PERMISSIONS } from '../domain/permissions';
import type { AgentRole } from '../domain/codes';
import type { ActorRecord } from '../domain/entities';
import type { CommandEnvelope, CommandTarget, ShowCommand } from '../domain/commands';
import type { RoleRuntime } from './dsh-team';
import { ElevenLabsVoice, type SpeechClip, type SecretReader } from '../../host/voice';
import { ProgressiveAudio } from './progressive-audio';
import { speechPauseWindows } from '../../../../scene-host/src/recording/speech-boundaries';
import type { QuickAckContext } from './quick-ack';
type PreparedClip=SpeechClip&{audioRef?:string;streaming?:boolean};
interface PreparedSpeech {controller:AbortController;promise:Promise<PreparedClip>;complete?:boolean;readable?:boolean}

const runFile = promisify(execFile);
async function storeJson(path: string, value: unknown) {
  const temporary = path + '.partial-' + randomUUID();
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

const internal = ['runtime', 'master', 'directionController', 'input'] as const;
const roleNames: AgentRole[] = ['performer', 'director', 'editorial', 'production'];
interface Candidate {
  controlGuide?:string;
  component?: { path: string; id: string; version?: string; source?: unknown };
  id: string;
  taskId: string;
  taskVersion: number;
  epoch: number;
  intendedDirectionId?: string;
  hash: string;
  file: string;
  props: Record<string, unknown>;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
}
export class ProductionRuntime implements RoleRuntime {
  readonly kernel: EngineeringKernel;
  readonly clock = new ManualProgrammeClock();
  readonly gateway: BrowserGateway;
  private readonly log: FileEventLog;
  private readonly candidates = new Map<string, Candidate>();
  private readonly voice: ElevenLabsVoice;
  private readonly clips = new Map<string, PreparedClip & { audioRef: string; epoch: number }>();
  private readonly speechQueue: string[] = [];
  private speaking?: string;
  private synthController?: AbortController;
  private masterNotes: Array<{id:string;text:string;at:number}> = [];
  private readonly syntheses = new Map<string, PreparedSpeech>();
  private readonly interruptArms=new Map<string,string>();
  private readonly streamFailures=new Set<string>();
  private readonly acknowledgementReservations=new Map<string,symbol>();
  quickAcknowledgementContext(eventId:string):QuickAckContext|undefined{
    const state=this.kernel.view(),input=state.audience.find(i=>i.eventId===eventId);
    if(!input||input.directionEpoch!==this.kernel.epoch()||Object.values(state.speech).some(p=>p.responseTo===eventId&&((p.isAcknowledgement&&!['failed','aborted','cancelled','rejected'].includes(p.state))||['starting','playing','ended'].includes(p.state))))return;
    const speaking=this.speaking?state.speech[this.speaking]:undefined;
    return {epoch:this.kernel.epoch(),inputId:eventId,text:input.text,topic:state.directions[state.project.currentDirectionId]?.commitment??'',heard:speaking?[...speaking.text].slice(0,speaking.spokenChars).slice(-80).join(''):'',instructions:this.masterNotes.map(n=>n.text),recentHeard:this.recentHeard(),visualStatus:this.responseBrief().responses.find(r=>r.eventId===eventId)?.visualStatus??'unconfirmed'};
  }
  reserveAcknowledgement(eventId:string){const token=Symbol();this.acknowledgementReservations.set(eventId,token);return ()=>{if(this.acknowledgementReservations.get(eventId)===token){this.acknowledgementReservations.delete(eventId);const next=this.speechQueue.find(id=>this.kernel.view().speech[id]?.responseTo===eventId&&!this.kernel.view().speech[id]?.isAcknowledgement);if(next)this.prepareSpeech(next);void this.pumpSpeech().catch(e=>this.error(e));}};}
  async offerQuickAcknowledgement(eventId:string,text:string,epoch:number){const partId='quick-'+randomUUID(),result=await this.invoke('performer','acknowledgeInput',{directionEpoch:epoch,inputId:eventId,text,partId},'quick-ack') as {ok:boolean};if(result.ok)this.recordTiming('quick-ack-committed',{partId,responseTo:eventId});return result;}
  private synthesisActive=0;
  private readonly synthesisWaiting:Array<{run:()=>void}>=[];
  private speechSlot(signal:AbortSignal,priority:boolean):Promise<()=>void>{
    return new Promise((resolve,reject)=>{
      const abort=()=>{const at=this.synthesisWaiting.indexOf(waiter);if(at>=0)this.synthesisWaiting.splice(at,1);reject(Object.assign(Error('Speech synthesis cancelled'),{name:'AbortError'}));};
      const waiter={run:()=>{signal.removeEventListener('abort',abort);this.synthesisActive++;let released=false;resolve(()=>{if(released)return;released=true;this.synthesisActive--;this.synthesisWaiting.shift()?.run();});}};
      if(signal.aborted){abort();return;}
      if(this.synthesisActive<2)waiter.run();else{signal.addEventListener('abort',abort,{once:true});if(priority)this.synthesisWaiting.unshift(waiter);else this.synthesisWaiting.push(waiter);}
    });
  }
  private sdk: any;
  private sdkLoading?: Promise<any>;
  private sdkError?: string;
  private tickTimer?: ReturnType<typeof setInterval>;
  private isClosing = false;
  private readonly busy = new Set<string>();
  private readonly sceneErrors = new Map<string,{epoch:number;message:string}>();
  private readonly dispatched = new Set<number>();
  private lastVetoCheck = -10000;
  private tickBusy = false;
  private timingSequence = 0;
  private readonly timings: Array<{sequence:number;at:number;showTime:number;phase:string;fields:Record<string,string|number|boolean>}> = [];
  recordTiming(phase:string,fields:Record<string,string|number|boolean>){
    this.timings.push({sequence:++this.timingSequence,at:Date.now(),showTime:this.clock.now(),phase,fields});
    if(this.timings.length>2048)this.timings.splice(0,this.timings.length-2048);
  }
  timingsSince(after=0){return {oldest:this.timings[0]?.sequence??0,latest:this.timingSequence,events:this.timings.filter(e=>e.sequence>after)};}
  onWake?: (role: AgentRole, text: string, urgent?: boolean) => void;
  onError?: (message: string) => void;
  constructor(
    private readonly options: { repoRoot: string; dataDir: string; port: number; secret: SecretReader; presentation?:()=>unknown },
  ) {
    this.log = new FileEventLog(join(options.dataDir, 'events.jsonl'));
    const actors = Object.fromEntries(
      [...roleNames, ...internal].map((role) => [
        `live:${role}`,
        { actorId: `live:${role}`, role, trustedMaster: role === 'master' } satisfies ActorRecord,
      ]),
    );
    this.kernel = EngineeringKernel.hydrate(this.log, { clock: this.clock, actors });
    for (const event of this.log.snapshot().events) this.dispatched.add(event.sequence);
    this.voice = new ElevenLabsVoice({ dir: join(options.dataDir, 'voice'), secret: async name=>name==='ELEVENLABS_MODEL_ID'?(await options.secret('ELEVENLABS_LIVE_MODEL_ID'))||(await options.secret(name)):options.secret(name) });
    this.gateway = new BrowserGateway({
      port: options.port,
      browserDir: join(options.repoRoot, 'packages/scene-host/dist'),
      onReceipt: (event) => {
        void this.receipt(event).catch((e) => this.error(e));
      },
      onConnection: (online) => {
        if (online) void this.reconcileBrowser().catch((e) => this.error(e));
      },
    });
  }
  async start() {
    this.masterNotes = await readFile(join(this.options.dataDir,'master-notes.json'),'utf8').then(JSON.parse).catch(()=>[]);
    for (const file of await readdir(join(this.options.dataDir, 'candidates')).catch(() => [] as string[])) {
      if (!file.endsWith('.json')) continue;
      const c = JSON.parse(
        await readFile(join(this.options.dataDir, 'candidates', file), 'utf8'),
      ) as Candidate;
      this.candidates.set(c.id, c);
      this.gateway.publishBundle(c.hash, c.file);
    }
    for (const name of await readdir(join(this.options.dataDir, 'clips')).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue;
      const record = JSON.parse(await readFile(join(this.options.dataDir, 'clips', name), 'utf8'));
      if (['starting', 'playing'].includes(this.kernel.view().speech[record.partId]?.state))
        this.clips.set(record.partId, record.clip);
    }
    // Hydration never replays submitted audio/takes. Operators must inspect the restored state.
    const last = this.log.snapshot().events.at(-1)?.showTime ?? 0;
    this.clock.showTime = last;
    await this.gateway.start();
    this.tickTimer = setInterval(() => {
      void this.tick().catch((e) => this.error(e));
    }, 100);
    this.tickTimer.unref?.();
  }
  private loadSdk(): Promise<any> {
    if (this.sdk) return Promise.resolve(this.sdk);
    if (!this.sdkLoading)
      this.sdkLoading = (async () => {
        const module = await import(
          pathToFileURL(join(this.options.repoRoot, 'scripts/sdk-source.mjs')).href
        );
        this.sdk = await module.sdkTools({ cacheRoot: join(this.options.repoRoot, '.deps/sdk') });
        this.sdkError = undefined;
        return this.sdk;
      })().catch((error) => {
        this.sdkError = error instanceof Error ? error.message : String(error);
        this.sdkLoading = undefined;
        throw error;
      });
    return this.sdkLoading;
  }
  async recordMasterNote(text:string) {
    const next=[...this.masterNotes,{id:randomUUID(),text,at:Date.now()}];
    await storeJson(join(this.options.dataDir,'master-notes.json'),next);
    this.masterNotes=next;
  }
  private error(e: unknown) {
    this.onError?.(e instanceof Error ? e.message : String(e));
  }
  private queuedSpeechMs(except?:string){return this.speechQueue.filter(id=>id!==except).reduce((ms,id)=>ms+[...(this.kernel.view().speech[id]?.text??'')].length*160,0);}
  private recentHeard(){
    return Object.values({...this.kernel.view().speechArchive,...this.kernel.view().speech})
      .filter(p=>p.playback?.startedAtShowTime!==undefined&&p.directionEpoch===this.kernel.epoch())
      .sort((a,b)=>(a.playback?.startedAtShowTime??0)-(b.playback?.startedAtShowTime??0)).slice(-6)
      .map(p=>({partId:p.partId,responseTo:p.responseTo,state:p.state,text:[...p.text].slice(0,p.state==='ended'?[...p.text].length:p.spokenChars).slice(-100).join('')})).filter(p=>p.text);
  }
  private speechOutlook(){
    const state=this.kernel.view();
    const describe=(id:string,actual=false)=>{
      const p=state.speech[id];if(!p||(!actual&&p.directionEpoch!==this.kernel.epoch())||!['offered','accepted','queued','starting','playing'].includes(p.state))return null;
      const chars=[...p.text];
      return {partId:id,directionEpoch:p.directionEpoch,revision:p.revision,state:p.state,text:chars.slice(0,1000).join(''),textExcerpt:chars.length>1000,totalChars:chars.length,spokenChars:p.spokenChars,responseTo:p.responseTo,isAcknowledgement:p.isAcknowledgement===true,alignment:{mode:p.alignment.mode,starts:p.alignment.mode==='real'?p.alignment.starts?.slice(0,1000):undefined}};
    };
    const active=this.speaking?state.speech[this.speaking]:undefined,started=active&&['starting','playing'].includes(active.state);
    const pending=[...new Set([...(this.speaking&&!started?[this.speaking]:[]),...this.speechQueue])];
    return {epoch:this.kernel.epoch(),current:this.speaking&&started?describe(this.speaking,true):null,upcoming:pending.slice(0,5).flatMap(id=>{const p=describe(id);return p?[p]:[];}),note:'upcoming是可撤换的待讲内容，不是已听内容；按partId和Unicode字位置规划，真实发声进度控制执行，主播不等待画面审批。'};
  }
  private contentShelf(controls=false){
    const state=this.kernel.view(),current=this.kernel.epoch();
    return {
      editorial:Object.values(state.editorial).filter(p=>p.directionEpoch===current&&!editorialProposalProblem(p)).slice(-3).map(p=>({id:p.id,segmentIntent:p.segmentIntent.slice(0,400),viewingValue:p.viewingValue.slice(0,200),participation:p.participation.slice(0,200),handoff:p.handoff.slice(0,200),minimumMaterials:p.minimumMaterials.slice(0,4).map(m=>m.slice(0,400))})),
      ready:Object.values(state.tasks).filter(t=>t.directionEpoch===current&&t.liveEligible&&!t.cancelled&&t.status==='ready'&&typeof t.goal==='string').slice(-3).flatMap(t=>t.assetVersionIds.slice(-1).flatMap(id=>{const a=state.assets[id];if(!a)return [];const g=a.contentGuide;return [{...(controls&&a.controlGuide?{controlGuide:a.controlGuide}:{}),taskId:t.id,assetVersionId:id,codeVersion:a.codeVersion,goal:t.goal.slice(0,300),contentGuide:g?{title:g.title,summary:g.summary.slice(0,300),beats:g.beats.slice(0,3).map(x=>x.slice(0,200)),sources:g.sources.slice(0,2),visualNotes:g.visualNotes.slice(0,3).map(x=>x.slice(0,200))}:undefined,guideExcerpt:!!g&&(g.summary.length>300||g.beats.length>3||g.beats.some(x=>x.length>200)||g.sources.length>2||g.visualNotes.length>3||g.visualNotes.some(x=>x.length>200))}];})),
      note:'后台建议与可用素材，不是固定台词、事实认证或送播指令；主播结合互动自由讲述，导演独立选画面。完整指南用readLiveBrief({assetVersionId})。',
    };
  }
  private responseBrief(){
    const state=this.kernel.view(),byInput=new Map<string,typeof state.speech[string][]>();
    for(const part of Object.values(state.speech))if(part.responseTo){const parts=byInput.get(part.responseTo)??[];parts.push(part);byInput.set(part.responseTo,parts);}
    const responses=state.audience.filter(input=>input.directionEpoch===this.kernel.epoch()&&(input.priority==='urgent'||byInput.has(input.eventId))).map(input=>{
      const parts=byInput.get(input.eventId)??[],effective=parts.filter(part=>!['cancelled','rejected','aborted','failed'].includes(part.state));
      const acknowledged=effective.some(part=>part.state==='ended'),verbalComplete=effective.some(part=>part.responseStage==='finish'&&part.state==='ended'),completionInFlight=effective.some(part=>part.responseStage==='finish'&&part.state!=='ended');
      const proposals=Object.values(state.proposals).filter(p=>p.eventIds.includes(input.eventId));
      return {eventId:input.eventId,inputId:input.replyRef??input.eventId,summary:input.text.slice(0,160),acknowledged,verbalComplete,completionInFlight,needsAck:effective.length===0,
        nextStep:verbalComplete?'done':completionInFlight?'await-playback':effective.length===0?'ack':effective.every(part=>part.responseStage==='ack')?'answer':'continue',
        parts:parts.slice(-4).map(part=>({partId:part.partId,stage:part.responseStage,state:part.state,text:part.text.slice(0,160)})),
        proposalIds:proposals.slice(-4).map(p=>p.id),visualStatus:proposals.length?proposals.every(p=>p.status==='presented')?'presented':proposals.every(p=>p.status==='cancelled')?'cancelled':'pending':'not-requested'};
    });
    return {nextReply:responses.find(r=>!r.verbalComplete&&!r.needsAck&&!r.completionInFlight)??null,responses:responses.slice(-12),pendingReplies:[...responses.filter(r=>r.needsAck).slice(-4),...responses.filter(r=>!r.needsAck&&!r.verbalComplete).slice(0,4)]};
  }
  brief(role:'performer'):Extract<ReturnType<ProductionRuntime['makeBrief']>,{role:'performer'}>;
  brief(role:Exclude<AgentRole,'performer'>):Exclude<ReturnType<ProductionRuntime['makeBrief']>,{role:'performer'}>;
  brief(role:AgentRole):ReturnType<ProductionRuntime['makeBrief']>;
  brief(role:AgentRole){return this.makeBrief(role);}
  private makeBrief(role: AgentRole) {
    const state = this.kernel.view();
    const tail = <T>(items:T[],cap:number) => items.slice(-cap);
    const map = <T>(items:T[],key:(item:T)=>string) => Object.fromEntries(items.map(item=>[key(item),item]));
    const current = state.project.currentEpoch;
    const runnable=Object.values(state.tasks).filter(t=>typeof t.id==='string'&&typeof t.goal==='string'&&Array.isArray(t.dependsOn)&&t.status==='open'&&!t.cancelled&&t.directionEpoch===current&&(t.liveEligible||(t.intendedDirectionId&&state.directions[t.intendedDirectionId]?.status==='preparing'))&&!unmetProductionDependencies(t,state.tasks).length).sort((a,b)=>Number(b.liveEligible)-Number(a.liveEligible)||productionPriority(b.priority)-productionPriority(a.priority)||a.id.localeCompare(b.id));
    const view = { ...state,
      audience: tail(state.audience,12),
      directions: Object.fromEntries(Object.entries(state.directions).map(([id,d])=>[id,{...d,commitment:typeof d.commitment==='string'?d.commitment.slice(0,2000):'',coreQuestion:typeof d.coreQuestion==='string'?d.coreQuestion.slice(0,1000):'',outcomes:(d.outcomes??[]).filter(x=>typeof x==='string').slice(-8).map(x=>x.slice(0,400)),contentPool:(d.contentPool??[]).filter(x=>x&&typeof x.summary==='string').slice(-8).map(x=>({...x,summary:x.summary.slice(0,400)}))}])),
      speech: map(tail(Object.values(state.speech).filter(p=>p.directionEpoch===current).map(p=>({...p,text:p.text.slice(0,500)})),10),p=>p.partId),
      tasks: map(Object.values(state.tasks).filter(t=>!t.cancelled&&(t.directionEpoch===current||(t.intendedDirectionId&&state.directions[t.intendedDirectionId]?.status==='preparing'))).sort((a,b)=>Number(a.status==='ready')-Number(b.status==='ready')||b.priority-a.priority).slice(0,12),t=>t.id),
      scenes: map(tail(Object.values(state.scenes).filter(s=>s.directionEpoch===current&&!['disposed','retired','failed'].includes(s.lifecycle)),8),s=>s.instanceId),
      proposals: map(tail(Object.values(state.proposals).filter(p=>!['cancelled','presented'].includes(p.status)),12),p=>p.id),
      performerCues: tail(state.performerCues,6),
      timeline: {...state.timeline,segments:tail(state.timeline.segments,12)},
    };
    const briefs = projectRoleBriefs(view);
    if(role==='performer'){
      const speech=Object.fromEntries(Object.entries(state.speech).filter(([,part])=>['offered','accepted','queued','starting','playing'].includes(part.state)));
      const continuations=Object.values(state.continuations).filter(note=>note.directionEpoch===current&&['pending','resuming'].includes(note.status)).sort((a,b)=>a.sourceOfferedAt-b.sourceOfferedAt).slice(0,6).map(note=>({...note,topic:note.topic.slice(0,300),unreadText:note.unreadText.slice(0,1000),unreadExcerpt:note.unreadText.length>1000,priorNotes:(note.parentContinuationIds??[]).slice(-2).flatMap(id=>{const old=state.continuations[id];return old?[{id,lastHeardExcerpt:old.lastHeardExcerpt,unreadText:old.unreadText.slice(0,400),unreadExcerpt:old.unreadText.length>400}]:[];})}));
      return {epoch:current,role,playbackConnected:this.gateway.connected(),brief:briefs.performer,...this.responseBrief(),continuations,recentHeard:this.recentHeard(),contentShelf:this.contentShelf(),
        visualEvidence:{programSceneInstanceId:state.project.channel.programSceneInstanceId,presented:Object.values(state.proposals).filter(p=>p.status==='presented'&&p.fulfillment).slice(-6).map(p=>({proposalId:p.id,eventIds:p.eventIds,fulfillment:p.fulfillment}))},
        firstResponseTasks:[...this.acknowledgementReservations.keys()].map(id=>({inputId:state.audience.find(i=>i.eventId===id)?.replyRef??id,state:'generating'})),
        voiceQueue:{currentPartId:this.speaking,upcoming:[...this.speechQueue],estimatedUpcomingMs:this.queuedSpeechMs(),maxUpcomingParts:4,urgentReserve:1,estimateOnly:true},
        revisions:{speech},masterNotes:this.masterNotes.slice(-16).map(n=>({...n,text:n.text.slice(0,700),excerpt:n.text.length>700})),masterNoteCount:this.masterNotes.length,
        commandFormat:'先接住，再逐段回答。已入队不等于观众已听见；acknowledged与verbalComplete只由实际播放派生。画面兑现另看visualStatus。recentHeard是实际已说；普通节目或接回故事省略responseTo/responseStage，不能为新问题标finish。只有实际覆盖便签未完内容才带resumesContinuationIds。',
        toolContracts:{acknowledgeInput:'{directionEpoch,inputId,text,complete?}：先用短语接住；完整口头回答已能一句说完时才complete=true。',offerSpeech:'{directionEpoch,text,responseTo?,responseStage?:answer|finish,partId?,replacePending?,resumesContinuationIds?}；普通节目省略回答字段；回应观众时两者同时填写。恢复旧问题只绑定sourceResponseTo，恢复普通故事省略回答字段。便签ID仅用于本段实际覆盖的未完内容，不因过渡或提到原话题就消费，不能重播旧音频。',yieldSpeech:'{directionEpoch,partId,expectedRevision}',discardContinuation:'{directionEpoch,continuationId,expectedRevision,reason}：原内容过时则明确放弃，不硬接。',requestInteraction:'{directionEpoch,requestId,text}',requestProduction:'{directionEpoch,task:{id,goal,priority,inputs:[],dependsOn:[]},proposalId?}'}};
    }
    return {
      epoch: this.kernel.epoch(),
      ...(role==='director'?{contentShelf:this.contentShelf(true),speechOutlook:this.speechOutlook(),visualTimeline:{totalFutureCues:Object.values(state.cues).filter(c=>c.directionEpoch===current&&c.status==='future').length,cues:Object.values(state.cues).filter(c=>c.directionEpoch===current&&c.status==='future').slice(-24).map(({payload,...c})=>({...c,payloadPreview:JSON.stringify(payload).slice(0,1000),payloadExcerpt:JSON.stringify(payload).length>1000}))}}:{}),
      presentation: this.options.presentation?.(),
      role,
      continuations:role==='director'?Object.values(state.continuations).filter(n=>n.directionEpoch===current&&['pending','resuming'].includes(n.status)).slice(-6).map(({id,sourcePartId,sceneInstanceId,status})=>({id,sourcePartId,sceneInstanceId,status})):undefined,
      voiceQueue:{currentPartId:this.speaking,upcoming:[...this.speechQueue],estimatedUpcomingMs:this.queuedSpeechMs(),maxUpcomingMs:10000,maxUpcomingParts:4,estimateOnly:true},
      playbackConnected: this.gateway.connected(),
      sceneErrors: Object.fromEntries([...this.sceneErrors].filter(([,e])=>e.epoch===current).slice(-8)),
      sdk: {
        state: this.sdk ? 'ready' : this.sdkLoading ? 'loading' : this.sdkError ? 'blocked' : 'not-requested',
        ...(this.sdkError ? { reason: this.sdkError } : {}),
      },
      masterNotes: this.masterNotes.slice(-16).map(n=>({...n,text:n.text.slice(0,700),excerpt:n.text.length>700})),
      masterNoteCount: this.masterNotes.length,
      brief: role==='production' ? runnable.slice(0,1).map(t=>projectProductionBrief(state,t.id)).map(v=>({...v,task:v.task?{...v.task,goal:v.task.goal.slice(0,4000),goalExcerpt:v.task.goal.length>4000}:null})) : briefs[role],
      revisions: {
        show: {id:state.project.id,revision:state.project.revision,currentEpoch:current,currentDirectionId:state.project.currentDirectionId,channel:state.project.channel},
        directions: Object.fromEntries(Object.entries(view.directions).filter(([id,d])=>id===state.project.currentDirectionId||d.status==='preparing').slice(-4).map(([id,d])=>[id,{id,revision:d.revision,epoch:d.epoch,status:d.status,commitment:d.commitment,coreQuestion:d.coreQuestion}])),
        timeline: view.timeline,
        speech: Object.fromEntries(
          Object.entries(view.speech).filter(
            ([, p]) => !['ended', 'cancelled', 'aborted', 'failed'].includes(p.state),
          ),
        ),
        scenes: Object.fromEntries(Object.entries(view.scenes).map(([id,s])=>[id,{instanceId:id,revision:s.revision,directionEpoch:s.directionEpoch,assetVersionId:s.assetVersionId,codeVersion:s.codeVersion,inputsRevision:s.inputsRevision,lifecycle:s.lifecycle,readiness:Object.fromEntries(Object.entries(s.readiness).map(([key,gate])=>[key,{status:gate.status,hint:JSON.stringify(gate).slice(0,240)}]))}])),
        tasks: Object.fromEntries(Object.entries(view.tasks).map(([id,t])=>[id,{id,revision:t.revision,version:t.version,status:t.status,directionEpoch:t.directionEpoch,intendedDirectionId:t.intendedDirectionId,liveEligible:t.liveEligible,cancelled:t.cancelled,assetVersionIds:t.assetVersionIds.slice(-4)}])),
        proposals: Object.fromEntries(Object.entries(view.proposals).map(([id,p])=>[id,{id,revision:p.revision,status:p.status,intent:p.intent.slice(0,400)}])),
      },
      candidates: [...this.candidates.values()]
        .map((c) => this.candidateContext(c))
        .filter((c): c is NonNullable<typeof c> => !!c)
        .slice(-8).map(({file,props,...c})=>({...c,propsAvailable:!!props})),
      recentEvents: this.kernel
        .allEvents()
        .slice(-10)
        .map((e) => ({ eventId: e.eventId, type: e.type, showTime: e.showTime })),
      commandFormat:
        'Brief text fields are excerpts. Use readTask({taskId,offset}) or readProgramme({instanceId}) for targeted detail; masterOffset pages durable master instructions. Always directionEpoch. New records get target/revision/id from runtime; updates require expectedRevision from revisions.',
      toolContracts: Object.fromEntries(Object.entries({
        readTask:'{taskId?,offset?}；不指定taskId时只派可执行任务',
        readProgramme:'{partId?,instanceId?,assetVersionId?,layerIds?:string[],cueId?,offset?}；不指定目标时读最新简报',
        searchSdk:'{path?,offset?}；示例aivtb/remotion、aivtb/hyperframes、aivtb/d3、aivtb/three，源码通过workspaceBuildPreview提交，不猜本地目录',
        searchEffects:'{query,includeSource?}；返回真实可复用effectPath',
        reportProgress:'{directionEpoch,taskId,note,expectedRevision}',
        offerSpeech: '{directionEpoch,text,partId?,replacePending?:{partId,expectedRevision}}',
        requestProduction:
          '{directionEpoch,task:{id,goal,priority,inputs:[],dependsOn:[],intendedDirectionId?},proposalId?}',
        reviewAudienceProposal:'{directionEpoch,proposalId,expectedRevision,status:accepted|deferred|cancelled}；纯口头问题无画面需求可cancelled，真实视觉需求必须跟进，不得伪造presented',
        publishEditorialProposal:
          '{directionEpoch,proposal:{id,segmentIntent,viewingValue,participation,handoff,minimumMaterials:[],alternatives:[]}}',
        prepareDirection: '{directionEpoch,directionId,commitment,coreQuestion}',
        workspaceBuildPreview:
          '{directionEpoch,taskId,taskVersion,source? OR template:layered-stage|gsap|remotion OR effectPath?,props?,width?,height?,durationInFrames?}；2D物件/图文可先用layered-stage组件组合，searchSdk path=aivtb/layered-stage读能力，props.layers独立调节',
        publishCandidate: '{directionEpoch,taskId,assetVersionId,expectedRevision,contentGuide?:{title,summary,beats:string[],sources:string[],visualNotes:string[]}}；内容指南不是固定台词，候选发布不送播',
        prepareScene: '{directionEpoch,instanceId,assetVersionId,segmentId,label}',
        take: '{directionEpoch,instanceId,expectedRevision}',
        updateInputs: '{directionEpoch,instanceId,inputsRevision,inputs,expectedRevision,proposalIds?}',
        bindCue:
          '{directionEpoch,cue:{cueId,sceneInstanceId,anchor:{kind:speech,partId,charIndex}|{kind:showTime,at},payload:场景输入补丁对象}}；按controlGuide/currentInputs取结构，layered-stage用layers不套params',
        editCue: '{directionEpoch,cueId,payload,expectedRevision}；仅改未来参数',
        cancelCue: '{directionEpoch,cueId,expectedRevision}；仅撤回未来Cue，改锚点时撤回后用新ID重新bindCue，不撤场不撤话',
        holdScene: '{directionEpoch,instanceId,expectedRevision}',
        resumeScene: '{directionEpoch,instanceId,expectedRevision}',
        editFutureTimeline: '{directionEpoch,segmentId,label,sceneInstanceId?,expectedRevision}',
        sendPerformerCue: '{directionEpoch,cueId,text,expectedRevision}',
      }).filter(([name])=>(TOOL_PERMISSIONS[role] as readonly string[]).includes(name))),
    };
  }
  private submit(
    actor: string,
    target: CommandTarget,
    payload: ShowCommand,
    command?: Partial<CommandEnvelope>,
  ) {
    const commandId = command?.commandId ?? randomUUID();
    return this.kernel.submit({
      commandId,
      idempotencyKey: commandId,
      actorId: `live:${actor}`,
      directionEpoch: command?.directionEpoch ?? this.kernel.epoch(),
      expectedRevision: command?.expectedRevision ?? this.kernel.revision(target),
      target,
      payload,
    });
  }
  async invoke(role: AgentRole, tool: string, args: Record<string, any>,source?:'quick-ack'): Promise<unknown> {
    if (!(TOOL_PERMISSIONS[role] as readonly string[]).includes(tool)) throw Error('Role tool denied');
    if(tool==='reviewAudienceProposal')tool='setProposalStatus';
    if(tool==='acknowledgeInput'){
      tool='offerSpeech';args={...args,responseTo:args.inputId,responseStage:args.complete===true?'finish':'ack',isAcknowledgement:true};delete args.inputId;delete args.complete;
    }
    if(tool==='offerSpeech'&&args.resumesContinuationIds?.length&&!args.responseTo){const notes=args.resumesContinuationIds.map((id:string)=>this.kernel.view().continuations[id]),targets=[...new Set(notes.map((n:any)=>n?.sourceResponseTo))];if(targets.length===1&&targets[0])args={...args,responseTo:targets[0],responseStage:args.responseStage??'answer'};}
    if(tool==='offerSpeech'&&args.responseTo){const inputs=this.kernel.view().audience,input=inputs.find(i=>i.eventId===args.responseTo)??inputs.find(i=>i.replyRef===args.responseTo);if(input)args={...args,responseTo:input.eventId};}
    if(tool==='offerSpeech'&&(args.isAcknowledgement||args.responseStage==='ack')&&args.responseTo&&this.acknowledgementReservations.has(args.responseTo)&&source!=='quick-ack')return {ok:false,reject:'ACK_PENDING',message:'专用首响正在生成；后续answer/finish可先交入未播队列，不重复首响。'};
    if((tool==='readLiveBrief'||tool==='readProgramme')&&args.assetVersionId){const id=String(args.assetVersionId),s=this.kernel.view(),task=Object.values(s.tasks).find(t=>t.assetVersionIds.includes(id)&&t.directionEpoch===this.kernel.epoch()&&t.liveEligible&&!t.cancelled&&t.status==='ready');if(!task)return null;const c=this.candidates.get(id);let props=c?.props;
      const layers=props?.layers;if(role==='director'&&Array.isArray(args.layerIds)&&layers&&typeof layers==='object'&&!Array.isArray(layers))props={layers:Object.fromEntries(args.layerIds.filter((k:unknown):k is string=>typeof k==='string'&&Object.hasOwn(layers,k)).map((k:string)=>[k,(layers as Record<string,unknown>)[k]]))};
      const fits=!!props&&Buffer.byteLength(JSON.stringify(props),'utf8')<=24000;
      return{assetVersionId:id,codeVersion:s.assets[id]?.codeVersion,componentId:s.assets[id]?.componentId,contentGuide:s.assets[id]?.contentGuide,controlGuide:s.assets[id]?.controlGuide,...(role==='director'?{props:fits?structuredClone(props):undefined,propsSource:'compiled-initial',propsExcerpt:!fits||Array.isArray(args.layerIds),layerIds:layers&&typeof layers==='object'?Object.keys(layers).slice(0,40):[],hint:'同componentId的layered-stage候选可选新增层合并到当前inputs.layers，保留其余在播参数；大输入用layerIds筛选。其他Scene只作整场备场/take。'}:{})};}
    if(tool==='readProgramme'&&args.cueId){const c=this.kernel.view().cues[String(args.cueId)];return c?.directionEpoch===this.kernel.epoch()?c:null;}
    if(tool==='readProgramme'&&args.partId){const p=this.kernel.view().speech[String(args.partId)];if(!p||p.directionEpoch!==this.kernel.epoch())return null;const offset=Number.isSafeInteger(args.offset)&&args.offset>=0?args.offset:0,chars=[...p.text];return {partId:p.partId,revision:p.revision,state:p.state,spokenChars:p.spokenChars,offset,text:chars.slice(offset,offset+1000).join(''),nextOffset:offset+1000<chars.length?offset+1000:null};}
    if(tool==='readLiveBrief'&&args.continuationId){const note=this.kernel.view().continuations[String(args.continuationId)],offset=Math.max(0,Number(args.offset)||0);return note?{...note,unreadText:note.unreadText.slice(offset,offset+2000),nextOffset:offset+2000<note.unreadText.length?offset+2000:null}:null;}
    const hasResponse=!!args.responseTo&&Object.values(this.kernel.view().speech).some(part=>part.responseTo===args.responseTo&&!['failed','aborted','cancelled','rejected'].includes(part.state));
    const firstResponse=tool==='offerSpeech'&&!!args.responseTo&&(args.responseStage==='ack'||(args.responseStage==='finish'&&!hasResponse));
    if(firstResponse&&!args.replacePending){
      const state=this.kernel.view(),id=this.speechQueue.find(id=>!state.speech[id]?.responseTo&&state.speech[id]?.responseStage!=='ack'&&!state.speech[id]?.isAcknowledgement);
      if(id)args.replacePending={partId:id,expectedRevision:state.speech[id].revision};
    }
    if (tool.startsWith('read') && args.masterOffset!==undefined) {const offset=Math.max(0,Number(args.masterOffset)||0);return {epoch:this.kernel.epoch(),masterNotes:this.masterNotes.slice(offset,offset+4),nextOffset:offset+4<this.masterNotes.length?offset+4:null};}
    if(tool.startsWith('read')&&args.directionId){const d=this.kernel.view().directions[String(args.directionId)];const offset=Math.max(0,Number(args.offset)||0);return d?{id:d.id,revision:d.revision,epoch:d.epoch,commitment:d.commitment.slice(offset,offset+8000),coreQuestion:d.coreQuestion.slice(0,2000),nextOffset:offset+8000<d.commitment.length?offset+8000:null}:null;}
    if(tool==='readTask'&&args.taskId){const task=this.kernel.view().tasks[String(args.taskId)];const offset=Math.max(0,Number(args.offset)||0);return {epoch:this.kernel.epoch(),task:task?{...task,goal:task.goal.slice(offset,offset+8000)}:null,nextOffset:task&&offset+8000<task.goal.length?offset+8000:null};}
    if(tool==='readProgramme'&&args.instanceId){const scene=this.kernel.view().scenes[String(args.instanceId)];if(!scene)return null;const {playbackSamples,...detail}=scene;return {epoch:this.kernel.epoch(),scene:detail,currentInputs:scene.inputs,inputsAreCanonical:scene.inputsAreCanonical===true,controlGuide:this.kernel.view().assets[scene.assetVersionId]?.controlGuide,sampleCount:playbackSamples?.length??0};}
    if (tool.startsWith('read')) return this.brief(role);
    if (tool === 'inspectCandidate')
      return {
        ...this.brief(role),
        browser: this.gateway.connected()
          ? await this.gateway.execute('snapshot', this.kernel.epoch(), {})
          : null,
      };
    if (tool === 'searchSdk') {
      const sdk = await this.loadSdk();
      const examples:Record<string,string>={'aivtb/remotion':'remotion.tsx','aivtb/hyperframes':'hyperframes.ts','aivtb/d3':'d3.ts','aivtb/three':'three.ts','aivtb/layered-stage':'layered-stage.md'};
      const path=String(args.path??'INDEX.md');
      const guide=examples[path]?await readFile(join(this.options.repoRoot,'examples/scenes',examples[path]),'utf8'):await sdk.readGuide(path);const offset=Math.max(0,Number(args.offset)||0);const end=offset+16000;return {guide:guide.slice(offset,end),offset,nextOffset:end<guide.length?end:null,pin:sdk.provenance.commit,integrationExamples:Object.keys(examples)};
    }
    if (tool === 'searchEffects') return this.effects(String(args.query ?? ''),args.includeSource===true);
    const remainingQueue=this.speechQueue.filter(id=>id!==args.replacePending?.partId);
    if (tool === 'offerSpeech' && (remainingQueue.length>=(firstResponse?5:4)||(!firstResponse&&remainingQueue.length>0&&this.queuedSpeechMs(args.replacePending?.partId)+[...String(args.text??'')].length*160>10000)))
      return {
        ok: false,
        reject: 'SPEECH_QUEUE_FULL',
        message: '未播语音缓冲已满（最多约10秒/4句）；等待消费，或明确替换未开口旧句，不继续锁未来口播。',
      };
    if(tool==='requestProduction'&&args.task){const p=args.task.priority;args={...args,task:{...args.task,priority:typeof p==='string'&&['high','normal','low'].includes(p)?productionPriority(p):p}};}
    if (tool === 'workspaceBuildPreview') return this.build(args);
    if (!Number.isSafeInteger(args.directionEpoch))
      throw Error('Write requires directionEpoch from latest brief');
    const commandId = String(args._callId || args.commandId || randomUUID());
    if (tool === 'offerSpeech') {
      args.partId ??= `speech-${commandId}`;
      if (typeof args.text !== 'string' || !args.text.trim()) throw Error('Speech text required');
    }
    if(tool==='prepareScene'){const c=this.candidates.get(String(args.assetVersionId));args={...args,initialInputs:c?this.sceneProps(c):undefined};}
    const target = this.target(tool, args);
    const create = [
      'offerSpeech',
      'requestProduction',
      'publishEditorialProposal',
      'prepareDirection',
      'prepareScene',
      'bindCue',
    ].includes(tool);
    const expectedRevision =
      args.expectedRevision ??
      (create ? 0 : tool === 'publishCandidate' ? this.kernel.revision(target) : undefined);
    if (!Number.isSafeInteger(expectedRevision))
      throw Error('Updating an existing record requires its latest expectedRevision');
    const {
      directionEpoch,
      _callId,
      target: ignoredTarget,
      expectedRevision: ignoredRevision,
      commandId: ignoredId,
      ...fields
    } = args;
    let payload: ShowCommand = { ...fields, type: tool } as ShowCommand;
    if (tool === 'publishCandidate') {
      const stored = this.candidates.get(String(args.assetVersionId));
      const candidate = stored ? this.candidateContext(stored) : undefined;
      if (
        !candidate ||
        candidate.taskId !== args.taskId ||
        candidate.epoch !== directionEpoch ||
        candidate.taskVersion !== this.kernel.view().tasks[candidate.taskId]?.version
      )
        throw Error('No matching compiled candidate');
      payload = {
        type: 'publishCandidate',
        taskId: candidate.taskId,
        asset: {
          ...(args.contentGuide!==undefined?{contentGuide:args.contentGuide}:{}),
          ...(candidate.controlGuide?{controlGuide:candidate.controlGuide}:{}),
          ...(candidate.component?.id?{componentId:candidate.component.id}:{}),
          id: candidate.id,
          hash: candidate.hash,
          codeVersion: candidate.hash,
          dependencyVersions: {},
          schemaVersion: '1',
          verification: 'unverified',
          provenance: `reelmorph-agent@${this.sdk?.provenance?.commit ?? 'restored-build'}; local compiled scene, live capability not certified`,
          capabilities: {
            supportsInPlaceInputUpdate: false,
            requiresStandbyRebuild: true,
            deterministicReplay: false,
            holdLoop: true,
            audioOwnership: 'none',
            realtime: 'unverified',
          },
        },
      };
    }
    const result = this.submit(role, target, payload, { commandId, directionEpoch, expectedRevision });
    if (!result.ok) return result;
    if (this.dispatched.has(result.acceptSequence))
      return {ok:true,acceptSequence:result.acceptSequence,reused:true,epoch:this.kernel.epoch(),target,revision:this.kernel.revision(target)};
    this.dispatched.add(result.acceptSequence);
    // One command owner dispatches effects; fixture Desks are never part of this path.
    if (tool === 'offerSpeech') {
      this.recordTiming('speech-offered',{partId:args.partId,chars:[...args.text].length,...(args.responseTo?{responseTo:args.responseTo,stage:args.responseStage}:{})});
      if(args.replacePending){
        const oldId=String(args.replacePending.partId),index=this.speechQueue.indexOf(oldId);
        if(index>=0)this.speechQueue.splice(index,1);
        this.syntheses.get(oldId)?.controller.abort();this.syntheses.delete(oldId);
        this.cancelInterruptFor(oldId);
      }
      if(firstResponse){const at=this.speechQueue.findIndex(id=>this.kernel.view().speech[id]?.responseStage!=='ack'&&!this.kernel.view().speech[id]?.isAcknowledgement);this.speechQueue.splice(at<0?this.speechQueue.length:at,0,args.partId);}
      else if(args.replacePending)this.speechQueue.unshift(args.partId);else this.speechQueue.push(args.partId);
      if(!args.responseTo||!this.acknowledgementReservations.has(args.responseTo)||args.isAcknowledgement)this.prepareSpeech(args.partId,firstResponse||!!args.replacePending);
      void this.pumpSpeech().catch((e) => this.error(e));
      this.onWake?.('director',`主播待讲内容已更新：${args.partId}。按speechOutlook提前自主编排画面；不审批口播，不因每段新话清空旧画面。`);
    } else if (tool === 'yieldSpeech') {
      const index = this.speechQueue.indexOf(args.partId);
      if (index >= 0) this.speechQueue.splice(index, 1);
      this.syntheses.get(args.partId)?.controller.abort();
      this.syntheses.delete(args.partId);
      this.cancelInterruptFor(args.partId);
      this.onWake?.('director','主播撤回未播内容；检查受影响的未来画面，保留仍合适的在播内容。');
    } else if (tool === 'publishEditorialProposal') this.onWake?.('performer','后台有新的内容建议，contentShelf可读；结合互动自主组织表达，不等画面制作完成。');
    else if (tool === 'requestProduction')
      this.onWake?.('production', '有新的制作任务。读取任务与版本，后台制作不得阻塞现场。');
    else if (tool === 'publishCandidate'&&this.kernel.view().tasks[args.taskId]?.liveEligible){
      this.onWake?.('performer','后台内容和场景候选已发布，读取contentShelf自行选择讲法；不照读固定稿，不宣称画面已显示。');
      this.onWake?.('director', '新候选已编译。结合主播待讲内容检查、备场并自主选择何时使用；ready不是上播。');
    }
    else if (tool === 'sendPerformerCue') this.onWake?.('performer', `导播内部cue：${args.text}`);
    else if (['holdScene', 'resumeScene', 'retireScene', 'disposeScene'].includes(tool)) {
      const observation = await this.gateway.execute(
        tool === 'holdScene' ? 'hold' : tool === 'resumeScene' ? 'resume' : 'dispose',
        directionEpoch,
        { instanceId: args.instanceId },
      );
      this.submit('runtime', target, {
        type: 'receiptSceneLifecycle',
        frame: observation?.frame,
        observedAtShowTime: observation?.observedAtShowTime,
        instanceId: args.instanceId,
        lifecycle:
          tool === 'holdScene'
            ? 'holding'
            : tool === 'resumeScene'
              ? 'taken'
              : tool === 'retireScene'
                ? 'retired'
                : 'disposed',
      });
    } else if (tool === 'prepareScene') {
      void this.prepare(args.instanceId)
        .then(() => this.onWake?.('director', `备场 ${args.instanceId} 已就绪，读取状态后自主选择送播。`))
        .catch((error) => {
          this.error(error);
          const scene = this.kernel.view().scenes[args.instanceId];
          if (
            scene &&
            scene.directionEpoch === this.kernel.epoch() &&
            !['retired', 'disposed'].includes(scene.lifecycle)
          )
            this.submit(
              'runtime',
              { kind: 'sceneInstance', id: args.instanceId },
              {
                type: 'noteReadiness',
                instanceId: args.instanceId,
                gate: 'firstFramePaint',
                observation: {
                  status: 'failed',
                  detail: error instanceof Error ? error.message : String(error),
                },
              },
            );
          this.onWake?.('director', `备场 ${args.instanceId} 失败或已失效；在播保持，选择备选。`);
        });
    } else if (tool === 'take') {
      const observation = await this.gateway.execute('take', directionEpoch, { instanceId: args.instanceId });
      this.disposedRetiredScenes(observation?.observedAtShowTime);
    } else if (tool === 'updateInputs')
      await this.applyPatch(args.instanceId, commandId, args.inputsRevision, args.inputs);
    return {ok:true,acceptSequence:result.acceptSequence,epoch:this.kernel.epoch(),target,revision:this.kernel.revision(target)};
  }
  private target(tool: string, args: Record<string, any>): CommandTarget {
    if(tool==='setProposalStatus')return {kind:'audienceProposal',id:String(args.proposalId??'')};
    if(tool==='discardContinuation')return {kind:'continuation',id:String(args.continuationId??'')};
    if (['offerSpeech', 'yieldSpeech'].includes(tool))
      return { kind: 'speechPart', id: String(args.partId ?? '') };
    if (['requestProduction', 'publishCandidate', 'reportProgress'].includes(tool))
      return { kind: 'productionTask', id: String(args.task?.id ?? args.taskId ?? '') };
    if (tool === 'publishEditorialProposal')
      return { kind: 'editorialProposal', id: String(args.proposal?.id ?? '') };
    if (tool === 'bindCue') return { kind: 'cue', id: String(args.cue?.cueId ?? '') };
    if (tool === 'editCue'||tool==='cancelCue') return {kind:'cue',id:String(args.cueId??'')};
    if (tool === 'prepareDirection') return { kind: 'direction', id: String(args.directionId ?? '') };
    if (
      [
        'prepareScene',
        'take',
        'updateInputs',
        'holdScene',
        'resumeScene',
        'retireScene',
        'disposeScene',
      ].includes(tool)
    )
      return { kind: 'sceneInstance', id: String(args.instanceId ?? '') };
    if (tool === 'editFutureTimeline') return { kind: 'timeline', id: this.kernel.view().timeline.id };
    return { kind: 'show', id: this.kernel.view().project.id };
  }
  private async reconcileBrowser() {
    await this.gateway.execute('setEpoch', this.kernel.epoch(), { showTime: this.clock.now() });
    this.disposedRetiredScenes();
    const snapshot = await this.gateway.execute('snapshot', this.kernel.epoch(), {});
    const current = this.kernel.view();
    for (const scene of Object.values(current.scenes)) {
      if (scene.directionEpoch !== this.kernel.epoch() || scene.lifecycle === 'disposed') continue;
      const observed = snapshot.scenes?.find(
        (s: any) => s.instanceId === scene.instanceId && s.codeVersion === scene.codeVersion,
      );
      this.submit(
        'runtime',
        { kind: 'sceneInstance', id: scene.instanceId },
        {
          type: 'receiptSceneLifecycle',
          instanceId: scene.instanceId,
          lifecycle: observed
            ? observed.phase === 'preview'
              ? 'prepared'
              : observed.phase === 'held'
                ? 'holding'
                : 'taken'
            : 'disposed',
        },
      );
    }
    if (!snapshot.audio) {
      for (const part of Object.values(current.speech))
        if (['starting', 'playing'].includes(part.state)) {
          this.submit(
            'runtime',
            { kind: 'speechPart', id: part.partId },
            { type: 'receiptSpeech', partId: part.partId, kind: 'failed' },
          );
          this.clips.delete(part.partId);
          this.streamFailures.delete(part.partId);
          if (this.speaking === part.partId) this.speaking = undefined;
        }
    } else if (current.speech[snapshot.audio.partId] && this.clips.has(snapshot.audio.partId))
      this.speaking = snapshot.audio.partId;
    if (!this.synthController) void this.pumpSpeech().catch((e) => this.error(e));
  }
  private sceneProps(c:Candidate){return {...c.props,fps:c.fps,width:c.width,height:c.height,durationInFrames:c.durationInFrames,window:{start:0,seconds:c.durationInFrames/c.fps,frames:c.durationInFrames,fps:c.fps}};}
  private async prepare(id: string) {
    const scene = this.kernel.view().scenes[id];
    const candidate = this.candidates.get(scene.assetVersionId);
    if (!candidate) throw Error('Candidate package not available');
    const value = await this.gateway.execute('prepare', scene.directionEpoch, {
      ...candidate,
      instanceId: id,
      codeVersion: scene.codeVersion,
      directionEpoch: scene.directionEpoch,
      moduleUrl: this.gateway.publishBundle(candidate.hash, candidate.file),
      props:this.sceneProps(candidate),
    });
    if (
      this.kernel.epoch() !== scene.directionEpoch ||
      ['retired', 'disposed'].includes(this.kernel.view().scenes[id]?.lifecycle) ||
      value?.instanceId !== id ||
      value.codeVersion !== scene.codeVersion
    )
      throw Error('Stale prepare result');
    const target: CommandTarget = { kind: 'sceneInstance', id };
    this.submit('runtime', target, {
      type: 'noteLiveCapabilities',
      instanceId: id,
      supportsInPlaceInputUpdate: value.supportsInPlaceInputUpdate === true,
    });
    for (const gate of ['moduleLoad', 'schemaAssets', 'firstFramePaint', 'businessVersionMatch'] as const)
      this.submit('runtime', target, {
        type: 'noteReadiness',
        instanceId: id,
        gate,
        observation: {
          status: 'ok',
          observedAtShowTime: this.clock.now(),
          detail: 'Real browser preparation; certification of arbitrary media is not implied',
        },
      });
  }
  private async build(args: Record<string, any>) {
    const task = this.kernel.view().tasks[args.taskId];
    if (
      !task ||
      task.directionEpoch !== args.directionEpoch ||
      task.version !== args.taskVersion ||
      task.cancelled
    )
      throw Error('Stale task');
    const dependencies=unmetProductionDependencies(task,this.kernel.view().tasks);if(dependencies.length)throw Error('Production dependencies are not ready: '+dependencies.join(', '));
    if (
      !args.template && !args.effectPath &&
      (typeof args.source !== 'string' || !args.source.trim() || args.source.length > 100000)
    )
      throw Error('Provide Scene source (up to 100000 characters), template gsap/remotion, or effectPath from searchEffects');
    if (args.effectPath && (args.source || args.template))
      throw Error('Choose effectPath, source or template; do not mix component reuse with source overrides');
    if (args.template && !['gsap', 'remotion','layered-stage'].includes(args.template))
      throw Error('Unknown native SDK template');
    if(args.template==='layered-stage'){if(args.source)throw Error('Use layered-stage props or custom source, not both');const problem=layeredStageProblem(args.props??{});if(problem)throw Error(problem);}
    const width = args.width ?? 1920,
      height = args.height ?? 1080,
      frames = args.durationInFrames ?? (args.template==='layered-stage'?108000:1800);
    if (
      ![width, height, frames].every((n) => Number.isSafeInteger(n) && n > 0) ||
      width > 3840 ||
      height > 3840 ||
      width * height > 3840 * 2160 ||
      frames > 108000
    )
      throw Error('Scene exceeds the configured canvas/duration budget');
    if (this.busy.size >= 1) throw Error('Production slot busy; keep task pending');
    const id = randomUUID();
    this.busy.add(id);
    const folder = join(this.options.dataDir, 'production', id);
    try {
      const sdk = await this.loadSdk();
      const reused = args.effectPath ? await sdk.reuseEffect(args.effectPath) : undefined;
      await mkdir(folder, { recursive: true });
      if (reused) await writeFile(join(folder, 'index.tsx'), reused.source);
      if(args.template==='layered-stage')await writeFile(join(folder,'index.tsx'),await readFile(join(this.options.repoRoot,'examples/scenes/layered-stage.tsx'),'utf8'));
      else if (args.template) {
        const files = sdk.scaffold(`scene-${id}`, args.template);
        for (const [name, bytes] of files)
          await writeFile(join(folder, name === 'index.ts' ? 'index.tsx' : name), bytes);
      }
      if (args.source) await writeFile(join(folder, 'index.tsx'), args.source);
      await runFile(
        process.execPath,
        [
          join(this.options.repoRoot, 'scripts/sdk-build.mjs'),
          folder,
          join(this.options.repoRoot, '.deps/sdk'),
        ],
        {
          cwd: this.options.repoRoot,
          timeout: 60000,
          maxBuffer: 1024 * 1024,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, AIVTB_SDK_REPO: process.env.AIVTB_SDK_REPO },
        },
      );
      const completedTask = this.kernel.view().tasks[task.id];
      const adopted =
        task.intendedDirectionId &&
        completedTask?.intendedDirectionId === task.intendedDirectionId &&
        completedTask.directionEpoch === this.kernel.epoch() &&
        this.kernel.view().project.currentDirectionId === task.intendedDirectionId;
      if (
        this.isClosing ||
        (!adopted && this.kernel.epoch() !== task.directionEpoch) ||
        completedTask?.cancelled ||
        completedTask?.version !== task.version
      )
        throw Error('Production completed after task invalidation; not eligible for live');
      const code = await readFile(join(folder, 'bundle.js'));
      const hash = createHash('sha256').update(code).digest('hex');
      const c: Candidate = {
        ...(reused ? { component: reused.component } : {}),
        ...(args.template==='layered-stage'?{component:{id:'aivtb-layered-stage-v1',path:'examples/scenes/layered-stage.tsx',version:'1'},controlGuide:await readFile(join(this.options.repoRoot,'examples/scenes/layered-stage.md'),'utf8')}:{}),
        id,
        taskId: task.id,
        taskVersion: completedTask.version,
        epoch: completedTask.directionEpoch,
        intendedDirectionId: task.intendedDirectionId,
        hash,
        file: join(folder, 'bundle.js'),
        props: args.props ?? {},
        fps: 30,
        width: args.width ?? 1920,
        height: args.height ?? 1080,
        durationInFrames: frames,
      };
      await mkdir(join(this.options.dataDir, 'candidates'), { recursive: true });
      await storeJson(join(this.options.dataDir, 'candidates', `${id}.json`), c);
      this.candidates.set(id, c);
      const { file, ...manifest } = c;
      return {
        status: 'compiled',
        manifest,
        preview: 'Director must prepare in real browser before take; compilation is not visual certification',
      };
    } finally {
      this.busy.delete(id);
    }
  }
  private async effects(query: string, includeSource = false) {
    const sdk = await this.loadSdk();
    const root = join(sdk.root, 'library/sources');
    const entries: any[] = [];
    for (const source of await readdir(root))
      for (const name of await readdir(join(root, source))) {
        const folder = join(root, source, name);
        const entry = JSON.parse(await readFile(join(folder, 'component.json'), 'utf8').catch(() => 'null'));
        if (entry && JSON.stringify(entry).toLowerCase().includes(query.toLowerCase())) {
          const implementation = includeSource ? await readFile(join(folder, 'index.ts'), 'utf8').catch(()=>undefined) : undefined;
          entries.push({
            id:entry.id,name:entry.name,summary:entry.summary,params:entry.params,media:entry.media,version:entry.version,source:entry.source,
            path: `library/sources/${source}/${name}`,
            reuse: { tool: 'workspaceBuildPreview', effectPath: `library/sources/${source}/${name}` },
            ...(implementation && implementation.length<=24000 ? { implementation } : {}),
          });
        }
      }
    return {
      entries: entries.slice(0, includeSource?1:6),
      scaffoldGuide: 'Read searchSdk INDEX.md; use effectPath for direct reuse. includeSource=true returns one bounded source entry.',
      note: 'Read/copy source via authorized SDK workspace; no database is required for these local components',
    };
  }
  private cancelInterruptFor(replyPartId:string){
    const current=this.speaking?this.kernel.view().speech[this.speaking]:undefined,request=current?.interruption;
    if(!current||request?.replyPartId!==replyPartId)return;
    const result=this.submit('runtime',{kind:'speechPart',id:current.partId},{type:'cancelSpeechInterrupt',partId:current.partId,interruptId:request.id});
    if(result.ok){this.interruptArms.delete(current.partId);void this.gateway.execute('cancelSpeechInterrupt',this.kernel.epoch(),{partId:current.partId,interruptId:request.id}).catch(()=>{});}
  }
  private interruptForReadyReply(){
    if(this.isClosing||!this.gateway.connected())return;
    const nextId=this.speechQueue[0],next=this.kernel.view().speech[nextId],current=this.speaking?this.kernel.view().speech[this.speaking]:undefined;
    if(!next?.responseTo||next.state!=='offered'||!this.syntheses.get(nextId)?.readable||!current||current.state!=='playing'||next.responseTo===current.responseTo||(current.responseStage==='ack'||current.isAcknowledgement)||current.abortRequested||current.directionEpoch!==this.kernel.epoch())return;
    const alreadySpoken=Object.values(this.kernel.view().speech).some(p=>p.responseTo===next.responseTo&&p.playback?.startedAtShowTime!==undefined&&!['failed','aborted','cancelled','rejected'].includes(p.state));
    if(!next.isAcknowledgement&&next.responseStage!=='ack'&&alreadySpoken)return;
    if(!current.interruption){
      const result=this.submit('runtime',{kind:'speechPart',id:current.partId},{type:'requestSpeechInterrupt',partId:current.partId,interruptId:randomUUID(),responseTo:next.responseTo,replyPartId:nextId});
      if(!result.ok)return;
    }
    this.armSpeechInterrupt(current.partId);
  }
  private armSpeechInterrupt(partId:string){
    const part=this.kernel.view().speech[partId],clip=this.clips.get(partId);
    if(!part?.interruption||part.state!=='playing'||part.directionEpoch!==this.kernel.epoch()||!clip?.starts)return;
    const windows=speechPauseWindows(part.text,clip.starts).filter(w=>w.firstUnreadChar>=part.spokenChars).slice(0,8);
    if(!windows.length)return;
    const signature=JSON.stringify({id:part.interruption.id,windows});if(this.interruptArms.get(partId)===signature)return;
    this.interruptArms.set(partId,signature);
    void this.gateway.execute('interruptSpeech',this.kernel.epoch(),{partId,interruptId:part.interruption.id,audioRef:clip.audioRef,windows}).catch(()=>{if(this.interruptArms.get(partId)===signature)this.interruptArms.delete(partId);});
  }
  private prepareSpeech(partId: string,priority=false) {
    const prior = this.syntheses.get(partId);
    if (prior) return prior;
    const part = this.kernel.view().speech[partId];
    const controller = new AbortController();
    const source=new ProgressiveAudio();
    let ready=false,prepared:PreparedClip|undefined,resolveReady!:(clip:PreparedClip)=>void,rejectReady!:(error:unknown)=>void;
    const promise=new Promise<PreparedClip>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    const entry:PreparedSpeech={controller,promise,complete:false};
    this.syntheses.set(partId, entry);
    void promise.catch(()=>{});
    void Promise.resolve().then(async()=>{
      if(!part||part.state!=='offered'||part.directionEpoch!==this.kernel.epoch()||this.isClosing)throw Error('Speech is no longer eligible for synthesis');
      this.recordTiming('tts-queued',{partId});
      const release=await this.speechSlot(controller.signal,priority);
      try{
      this.recordTiming('tts-start',{partId});
      const clip=await this.voice.synthesizeStream(part.text,controller.signal,chunk=>{
        source.append(chunk.audio);
        if(!ready&&source.bytes>=2048){
          ready=true;entry.readable=true;this.recordTiming('tts-first-audio',{partId,bytes:source.bytes});
          prepared={file:chunk.file,url:'',ms:chunk.ms,starts:chunk.starts,streaming:true,audioRef:this.gateway.publishStream(partId,source)};resolveReady(prepared);
          queueMicrotask(()=>this.interruptForReadyReply());
        }
        if(prepared&&chunk.starts){prepared.starts=chunk.starts;prepared.ms=chunk.ms;}
        this.extendSpeechTiming(partId,chunk.starts,chunk.ms);
      });
      if(this.isClosing||controller.signal.aborted)throw Object.assign(Error('Speech stream cancelled'),{name:'AbortError'});
      entry.complete=true;
      if(prepared)Object.assign(prepared,clip);
      this.recordTiming('tts-ready',{partId,durationMs:clip.ms});
      const audioRef=this.gateway.publishMedia(partId,join(this.options.dataDir,'voice',clip.file));
      const retained=this.clips.get(partId);
      if(retained){Object.assign(retained,clip);this.extendSpeechTiming(partId,clip.starts,clip.ms);await storeJson(join(this.options.dataDir,'clips',createHash('sha256').update(partId).digest('hex')+'.json'),{partId,clip:retained});}
      source.finish();
      if(!ready){ready=true;entry.readable=true;this.recordTiming('tts-first-audio',{partId,bytes:source.bytes});resolveReady({...clip,audioRef,streaming:true});queueMicrotask(()=>this.interruptForReadyReply());}
      if(this.speaking===partId||['cancelled','aborted','ended','failed','rejected'].includes(this.kernel.view().speech[partId]?.state))this.syntheses.delete(partId);
      }finally{release();}
    }).catch(error=>{
      entry.complete=true;source.fail();this.gateway.revokeStream(partId);rejectReady(error);
      this.recordTiming(controller.signal.aborted?'tts-aborted':'tts-failed',{partId});
      // A requested cut waits for the actual browser stop receipt. Aborting
      // the producer is not itself evidence that the speaker has stopped.
      if(ready&&!this.kernel.view().speech[partId]?.abortRequested)void this.failStreamingSpeech(partId,error);
    });
    return entry;
  }
  private extendSpeechTiming(partId:string,starts:number[]|undefined,ms:number){
    const clip=this.clips.get(partId),part=this.kernel.view().speech[partId];
    if(!clip||!starts?.length)return;
    clip.starts=starts;clip.ms=ms;
    if(part&&['starting','playing'].includes(part.state)){
      if(part.audioRef===clip.audioRef)this.submit('runtime',{kind:'speechPart',id:partId},{type:'appendSpeechTiming',partId,audioRef:clip.audioRef,starts});
      void this.gateway.execute('speechTiming',this.kernel.epoch(),{partId,starts,ms}).catch(()=>{});
      this.armSpeechInterrupt(partId);
    }
  }
  private async failStreamingSpeech(partId:string,error:unknown){
    if(this.isClosing)return;
    const part=this.kernel.view().speech[partId];
    if(part&&['starting','playing'].includes(part.state)){
      this.streamFailures.add(partId);
      if(this.speaking===partId)await this.gateway.execute('abortSpeech',this.kernel.epoch(),{partId}).catch(()=>{});
      if(!(error instanceof Error&&error.name==='AbortError'))this.error(error);
      return;
    }else if(part?.state==='offered')this.submit('runtime',{kind:'speechPart',id:partId},{type:'rejectSpeech',partId,reason:'Streaming synthesis failed'});
    this.cancelInterruptFor(partId);
    const index=this.speechQueue.indexOf(partId);if(index>=0)this.speechQueue.splice(index,1);
    this.syntheses.delete(partId);
    if(!(error instanceof Error&&error.name==='AbortError'))this.error(error);
    void this.pumpSpeech().catch(e=>this.error(e));
  }
  private cancelSpeechPreparation(keepCurrent=false) {
    const preserve=(id:string|undefined)=>keepCurrent&&!!id&&['starting','playing'].includes(this.kernel.view().speech[id]?.state);
    if(!preserve(this.speaking))this.synthController?.abort();
    for (const [id,entry] of this.syntheses)if(!preserve(id)){entry.controller.abort();this.syntheses.delete(id);this.gateway.revokeStream(id);}
    for (let i = this.speechQueue.length - 1; i >= 0; i--) {
      const part = this.kernel.view().speech[this.speechQueue[i]];
      if (this.isClosing || !part || part.directionEpoch !== this.kernel.epoch() || part.state !== 'offered')
        this.speechQueue.splice(i, 1);
    }
  }
  private async pumpSpeech() {
    if (this.speaking || this.isClosing) return;
    const first=this.kernel.view().speech[this.speechQueue[0]];
    if(first?.responseTo&&this.acknowledgementReservations.has(first.responseTo)&&!first.isAcknowledgement&&first.responseStage!=='ack')return;
    const partId = this.speechQueue.shift();
    if (!partId) return;
    this.speaking = partId;
    try {
      const part = this.kernel.view().speech[partId];
      if (!part || part.directionEpoch !== this.kernel.epoch() || part.state !== 'offered') return;
      const target: CommandTarget = { kind: 'speechPart', id: partId };
      const { controller, promise } = this.prepareSpeech(partId);
      this.synthController = controller;
      const clip = await promise;
      if (this.synthController === controller) this.synthController = undefined;
      if (
        part.directionEpoch !== this.kernel.epoch() ||
        this.kernel.view().speech[partId]?.state !== 'offered'
      )
        return;
      const audioRef = clip.audioRef??this.gateway.publishMedia(partId, join(this.options.dataDir, 'voice', clip.file));
      const retained = { ...clip, audioRef, epoch: part.directionEpoch };
      const clipDir = join(this.options.dataDir, 'clips');
      await mkdir(clipDir, { recursive: true });
      const clipPath = join(clipDir, createHash('sha256').update(partId).digest('hex') + '.json');
      if(!clip.streaming||this.syntheses.get(partId)?.complete)await storeJson(clipPath, { partId, clip: retained });
      this.clips.set(partId, retained);
      for (const type of ['acceptSpeech', 'queueSpeech', 'startSpeech'] as const) {
        const r = this.submit('runtime', target, { type, partId });
        if (!r.ok) throw Error(r.message);
      }
      await this.gateway.execute('speech', part.directionEpoch, {
        partId,
        text: part.text,
        audioRef,
        ms: clip.ms,
        starts: clip.starts,
        realOnly:clip.streaming===true,
      });
      // The playing event, not this command acknowledgement, moves speech to playing.
      return;
    } catch (error) {
      if (this.isClosing) return;
      const part = this.kernel.view().speech[partId];
      if (part && ['starting', 'playing'].includes(part.state))
        this.submit(
          'runtime',
          { kind: 'speechPart', id: partId },
          { type: 'receiptSpeech', partId, kind: 'failed' },
        );
      if (part && ['offered', 'accepted', 'queued'].includes(part.state))
        this.submit(
          'runtime',
          { kind: 'speechPart', id: partId },
          {
            type: 'rejectSpeech',
            partId,
            reason: error instanceof Error ? error.message : 'Speech admission failed',
          },
        );
      this.clips.delete(partId);
      this.synthController = undefined;
      this.speaking = undefined;
      this.error(error);
    } finally {
      if(this.syntheses.get(partId)?.complete)this.syntheses.delete(partId);
      if (!['starting', 'playing'].includes(this.kernel.view().speech[partId]?.state ?? ''))
        this.speaking = undefined;
      if (!this.speaking && this.speechQueue.length && !this.isClosing)
        queueMicrotask(() => void this.pumpSpeech().catch(e => this.error(e)));
    }
  }
  private fulfill(evidenceId: string) {
    const state = this.kernel.view();
    const evidence = state.playback.find((e) => e.id === evidenceId);
    if (!evidence || evidence.kind !== 'painted' || evidence.orphan) return;
    const newlyPresented:string[]=[];
    for (const proposal of Object.values(state.proposals)) {
      if (proposal.status !== 'ready' || proposal.directionEpoch !== this.kernel.epoch()) continue;
      const linked = proposal.taskIds.some(
        (id) =>
          !!evidence.assetVersionId && state.tasks[id]?.assetVersionIds.includes(evidence.assetVersionId),
      );
      const patched =
        !!proposal.presentation &&
        proposal.presentation.sceneInstanceId === evidence.sceneInstanceId &&
        proposal.presentation?.inputsRevision === evidence.inputsRevision;
      if (linked || patched){
        const result=this.submit(
          'runtime',
          { kind: 'audienceProposal', id: proposal.id },
          {
            type: 'setProposalStatus',
            proposalId: proposal.id,
            status: 'presented',
            evidencePlaybackId: evidenceId,
          },
        );
        if(result.ok){newlyPresented.push(proposal.intent.slice(0,100));for(const eventId of proposal.eventIds)this.recordTiming('proposal-presented',{proposalId:proposal.id,responseTo:eventId,playbackEventId:evidenceId});}
      }
    }
    if(newlyPresented.length)this.onWake?.('performer','以下观众画面要求已取得关联的实际绘制回执：'+newlyPresented.slice(0,4).join('；')+'。可结合画面继续或停留，不必为了状态另说一遍完成通知。');
  }
  private async receipt(event: Record<string, any>) {
    if(event?.type==='error'&&typeof event.instanceId==='string'){this.sceneErrors.set(event.instanceId,{epoch:Number(event.epoch),message:String(event.error).slice(0,300)});if(this.sceneErrors.size>16)this.sceneErrors.delete(this.sceneErrors.keys().next().value!);this.onWake?.('director',`场景 ${event.instanceId} 实际运行报错；读取sceneErrors并选择替代或重做，不要把失败视作已播效果。`,true);return;}
    if (event.type === 'clock' && event.epoch === this.kernel.epoch() && Number.isFinite(event.showTime)) {
      this.clock.showTime = Math.max(this.clock.now(), event.showTime);
      return;
    }
    if (event.type === 'painted' && event.operation === 'take') {
      const scene = this.kernel.view().scenes[event.instanceId];
      if (
        !scene ||
        scene.codeVersion !== event.codeVersion ||
        scene.directionEpoch !== event.epoch ||
        event.epoch !== this.kernel.epoch()
      )
        return;
      const evidenceId = randomUUID();
      const recorded = this.submit(
        'runtime',
        { kind: 'sceneInstance', id: scene.instanceId },
        {
          type: 'recordPlayback',
          receipt: {
            id: evidenceId,
            kind: 'painted',
            operation: 'take',
            frame: event.frame,
            observedAtShowTime: event.showTime,
            sceneInstanceId: scene.instanceId,
            assetVersionId: scene.assetVersionId,
            inputsRevision: scene.inputsRevision,
          },
        },
      );
      if (recorded.ok) this.fulfill(evidenceId);
      this.onWake?.('performer', '导播选择的新画面已实际显示。可结合它继续表达，也可保持观察。');
    }
    if (event.type !== 'audio') return;
    const part = this.kernel.view().speech[event.partId];
    const clip = this.clips.get(event.partId);
    if (!part || !clip || event.audioRef !== clip.audioRef) return;
    if(['playing','ended','error','aborted','waiting'].includes(event.kind))this.recordTiming('audio-'+event.kind,{partId:part.partId,...(part.responseTo?{responseTo:part.responseTo,stage:part.responseStage??'answer'}:{})});
    const target: CommandTarget = { kind: 'speechPart', id: part.partId };
    if(event.kind==='interrupted'&&['starting','playing'].includes(part.state)){
      const known=part.interruption?.id===event.interruptId||part.cancelledInterruptions?.some(i=>i.id===event.interruptId);
      if(!known)return;
      const state=this.kernel.view();
      const leased=part.abortRequested||state.windDown?.speechPartIds.includes(part.partId)||state.switches.some(s=>s.fromEpoch===part.directionEpoch&&(s.retainedSpeechPartIds.includes(part.partId)||s.revokedSpeechPartIds.includes(part.partId)));
      const result=part.directionEpoch===this.kernel.epoch()?this.submit('runtime',target,{type:'receiptSpeechInterrupted',partId:part.partId,interruptId:event.interruptId,audioRef:clip.audioRef,mediaTimeMs:event.mediaTimeMs}):leased?this.submit('runtime',target,{type:'receiptSpeech',partId:part.partId,kind:'aborted',audioRef:clip.audioRef,mediaTimeMs:event.mediaTimeMs}):undefined;
      if(!result?.ok)return;
      this.recordTiming('audio-interrupted',{partId:part.partId});
    }else if (event.kind === 'playing' && part.state === 'starting'){
      this.submit('runtime', target, {
        type: 'receiptSpeech',
        partId: part.partId,
        kind: 'playing',
        audioRef: clip.audioRef,
        ...(clip.starts?{alignment:'real' as const}:!clip.streaming?{alignment:'estimated' as const}:{}),
        ...(clip.starts ? { starts: clip.starts } : {}),
        spokenChars: 0,
      });
      this.onWake?.('director',`主播 ${part.partId} 已实际开口；按真实进度执行画面，不按预计字速追赶。`);
      if(part.responseStage==='ack')this.onWake?.('performer','接住语句已实际开口。可趁此继续生成后续一小段或推进后台，不必等完整答案；不要把接住当作任务完成。');
      this.interruptForReadyReply();
    }else if (event.kind === 'timeupdate' && part.state === 'playing' && clip.starts){
      this.submit('runtime', target, {
        type: 'progressSpeech',
        partId: part.partId,
        mediaTimeMs: event.mediaTimeMs,
        audioRef: clip.audioRef,
      });
      this.armSpeechInterrupt(part.partId);
    }else if (event.kind === 'ended' && part.state === 'playing')
      this.submit('runtime', target, {
        type: 'receiptSpeech',
        partId: part.partId,
        kind: 'ended',
        audioRef: clip.audioRef,
        mediaTimeMs:event.mediaTimeMs,
        spokenChars: [...part.text].length,
      });
    else if (event.kind === 'aborted' && ['starting', 'playing'].includes(part.state))
      this.submit('runtime', target, {
        type: 'receiptSpeech',
        partId: part.partId,
        kind: this.streamFailures.has(part.partId)?'failed':'aborted',
        audioRef: clip.audioRef,
        mediaTimeMs:event.mediaTimeMs,
      });
    else if (event.kind === 'error' && ['starting', 'playing'].includes(part.state))
      this.submit('runtime', target, { type: 'receiptSpeech', partId: part.partId, kind: part.abortRequested?'aborted':'failed',audioRef:clip.audioRef,mediaTimeMs:event.mediaTimeMs });
    if (['ended', 'error', 'aborted','interrupted'].includes(event.kind)) {
      this.syntheses.get(part.partId)?.controller.abort();this.syntheses.delete(part.partId);this.gateway.revokeStream(part.partId);this.interruptArms.delete(part.partId);
      this.clips.delete(part.partId);
      this.streamFailures.delete(part.partId);
      if(this.speaking===part.partId)this.speaking = undefined;
      void this.pumpSpeech();
      this.onWake?.('director',`主播 ${part.partId} 播放${event.kind}。按最新speechOutlook调整未来画面；不要自动撤掉仍适用的在播场景。`);
      this.onWake?.('performer', event.kind==='interrupted'?'原话题已实际停止，进度和未读部分保存在continuations。先根据pendingReplies接住或展开互动；新音频失败要重试。合适时以新台词自然接回，不重播旧音频。':'上一段真实播放已结束；读取pendingReplies与continuations，自行判断继续回答、自然接回原话题或停留。');
    }
  }
  async switchDirection(commitment: string, hard = false) {
    const prepared = Object.values(this.kernel.view().directions).filter(
      (d) => d.status === 'preparing' && d.commitment === commitment,
    );
    const selected = prepared.length === 1 ? prepared[0] : undefined;
    const direction = this.kernel.view().project.currentDirectionId;
    const target: CommandTarget = { kind: 'direction', id: direction };
    const authorizationId = randomUUID();
    const r = this.submit('master', target, {
      type: 'issueSwitchAuthorization',
      authorizationId,
      kind: hard ? 'master-hard' : 'master-soft',
      reason: 'Authenticated local master command',
    });
    if (!r.ok) return r;
    const result = this.submit('directionController', target, {
      type: 'switchDirection',
      authorizationId,
      strategy: hard ? 'hard' : 'soft',
      next: commitment
        ? {
            ...(selected ? { directionId: selected.id } : {}),
            commitment,
            coreQuestion: selected?.coreQuestion ?? commitment,
          }
        : { transition: true },
    });
    if (result.ok) {
      this.cancelSpeechPreparation(!hard);
    }
    if (result.ok && this.gateway.connected()) {
      await this.gateway.execute('setEpoch', this.kernel.epoch(), { keepSpeech: !hard });
      this.disposedRetiredScenes();
    }
    for (const role of roleNames)
      this.onWake?.(role, `方向已获授权切换。读取当前epoch和简报；旧未执行内容不得追加。${commitment}`, true);
    return result;
  }
  private async tick() {
    if (this.isClosing || this.tickBusy) return;
    this.tickBusy = true;
    try {
      for (const { cueId, resolution } of this.kernel.tick().scanned) {
        if (resolution.status !== 'due') continue;
        const state = this.kernel.view(),
          cue = state.cues[cueId];
        const scene = cue.sceneInstanceId ? state.scenes[cue.sceneInstanceId] : undefined;
        if (!scene || scene.pendingInputs || ['retired', 'disposed'].includes(scene.lifecycle)) continue;
        const r = this.submit('runtime', { kind: 'cue', id: cueId }, { type: 'dispatchCue', cueId });
        if (!r.ok) continue;
        try {
          const operationId = randomUUID(),
            inputsRevision = scene.inputsRevision + 1;
          const reserved = this.submit(
            'runtime',
            { kind: 'sceneInstance', id: scene.instanceId },
            {
              type: 'updateInputs',
              instanceId: scene.instanceId,
              inputsRevision,
              inputs: cue.payload,
              cueId,
            },
            { commandId: operationId },
          );
          if (!reserved.ok) throw Error(reserved.message);
          await this.applyPatch(scene.instanceId, operationId, inputsRevision, cue.payload);
          this.submit(
            'runtime',
            { kind: 'sceneInstance', id: scene.instanceId },
            {
              type: 'recordPlayback',
              receipt: { id: randomUUID(), kind: 'applied', sceneInstanceId: scene.instanceId, cueId },
            },
          );
        } catch (error) {
          this.error(error);
        }
      }
      await this.pumpSpeech();
      await this.reviewVeto();
    } finally {
      this.tickBusy = false;
    }
  }
  private async reviewVeto() {
    const now = this.clock.now();
    if (now - this.lastVetoCheck < 1000) return;
    this.lastVetoCheck = now;
    const state = this.kernel.view();
    const distinct = new Set(
      state.audience
        .filter(
          (r) =>
            r.directionEpoch === this.kernel.epoch() && r.kind === 'opposition' && now - r.showTime <= 30000,
        )
        .map((r) => r.audienceId),
    );
    if (distinct.size < 5 || now < 10000) return;
    const authorizationId = randomUUID();
    const target: CommandTarget = { kind: 'direction', id: state.project.currentDirectionId };
    const issued = this.submit('directionController', target, {
      type: 'issueSwitchAuthorization',
      authorizationId,
      kind: 'group-veto',
      reason: 'Recorded distinct audience opposition passed configured policy',
      assessmentTimes: [now - 10000, now],
    });
    if (!issued.ok) return;
    const next = Object.values(state.directions).find((d) => d.status === 'preparing');
    const switched = this.submit('directionController', target, {
      type: 'switchDirection',
      authorizationId,
      strategy: 'soft',
      next: next
        ? { directionId: next.id, commitment: next.commitment, coreQuestion: next.coreQuestion }
        : { transition: true },
    });
    if (!switched.ok) return;
    this.cancelSpeechPreparation(true);

    if (this.gateway.connected()) {
      await this.gateway.execute('setEpoch', this.kernel.epoch(), { keepSpeech: true });
      this.disposedRetiredScenes();
    }
    for (const role of roleNames)
      this.onWake?.(
        role,
        '群体否决已由控制器复核并切换。读取新epoch；没有候选时进入中性过渡并询问观众，不继续旧方向。',
        true,
      );
  }
  private disposedRetiredScenes(observedAtShowTime?: number) {
    for (const scene of Object.values(this.kernel.view().scenes))
      if (
        scene.lifecycle !== 'disposed' &&
        (scene.lifecycle === 'retired' || scene.directionEpoch !== this.kernel.epoch())
      )
        this.submit(
          'runtime',
          { kind: 'sceneInstance', id: scene.instanceId },
          {
            type: 'receiptSceneLifecycle',
            instanceId: scene.instanceId,
            lifecycle: 'disposed',
            observedAtShowTime,
          },
        );
  }
  private candidateContext(c: Candidate) {
    const state = this.kernel.view(),
      task = state.tasks[c.taskId];
    if (!task || task.cancelled || task.directionEpoch !== state.project.currentEpoch) return undefined;
    const promoted =
      !!c.intendedDirectionId &&
      c.intendedDirectionId === task.intendedDirectionId &&
      task.intendedDirectionId === state.project.currentDirectionId &&
      task.liveEligible;
    if (c.epoch !== task.directionEpoch && !promoted) return undefined;
    return { ...c, authoredEpoch: c.epoch, epoch: task.directionEpoch, liveEligible: task.liveEligible };
  }
  private async applyPatch(
    instanceId: string,
    operationId: string,
    inputsRevision: number,
    inputs: Record<string, unknown>,
  ) {
    const scene = this.kernel.view().scenes[instanceId];
    try {
      const observation = await this.gateway.execute('patch', scene.directionEpoch, {
        instanceId,
        codeVersion: scene.codeVersion,
        inputsRevision,
        inputs,
      });
      const received = this.submit(
        'runtime',
        { kind: 'sceneInstance', id: instanceId },
        {
          type: 'receiptScenePatch',
          instanceId,
          operationId,
          codeVersion: scene.codeVersion,
          inputsRevision,
          inputs,
          ...(Number.isSafeInteger(observation?.frame)?{frame:observation.frame}:{}),
          ...(Number.isFinite(observation?.observedAtShowTime)?{observedAtShowTime:observation.observedAtShowTime}:{}),
        },
      );
      if (!received.ok) throw Error(received.message);
      this.fulfill(`pb-patch-${instanceId}-${inputsRevision}`);
    } catch (error) {
      this.submit(
        'runtime',
        { kind: 'sceneInstance', id: instanceId },
        {
          type: 'receiptScenePatchFailed',
          instanceId,
          operationId,
          reason: error instanceof Error ? error.message : 'Patch failed',
        },
      );
      throw error;
    }
  }
  async stop() {
    this.isClosing = true;
    this.cancelSpeechPreparation();
    if (this.tickTimer) clearInterval(this.tickTimer);
    await this.gateway.stop();
    this.log.close();
  }
}
