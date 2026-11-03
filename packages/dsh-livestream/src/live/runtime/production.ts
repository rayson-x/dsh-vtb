import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rename, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EngineeringKernel } from '../kernel';
import { ManualProgrammeClock } from '../playback/manual-clock';
import { FileEventLog } from './file-log';
import { BrowserGateway } from './browser-gateway';
import { projectRoleBriefs } from '../agents/briefs';
import { TOOL_PERMISSIONS } from '../domain/permissions';
import type { AgentRole } from '../domain/codes';
import type { ActorRecord } from '../domain/entities';
import type { CommandEnvelope, CommandTarget, ShowCommand } from '../domain/commands';
import type { RoleRuntime } from './dsh-team';
import { ElevenLabsVoice, type SpeechClip, type SecretReader } from '../../host/voice';

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
  private readonly clips = new Map<string, SpeechClip & { audioRef: string; epoch: number }>();
  private readonly speechQueue: string[] = [];
  private speaking?: string;
  private synthController?: AbortController;
  private masterNotes: Array<{id:string;text:string;at:number}> = [];
  private readonly syntheses = new Map<string, { controller: AbortController; promise: Promise<SpeechClip> }>();
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
    this.voice = new ElevenLabsVoice({ dir: join(options.dataDir, 'voice'), secret: options.secret });
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
  brief(role: AgentRole) {
    const state = this.kernel.view();
    const tail = <T>(items:T[],cap:number) => items.slice(-cap);
    const map = <T>(items:T[],key:(item:T)=>string) => Object.fromEntries(items.map(item=>[key(item),item]));
    const current = state.project.currentEpoch;
    const view = { ...state,
      audience: tail(state.audience,12),
      directions: Object.fromEntries(Object.entries(state.directions).map(([id,d])=>[id,{...d,commitment:d.commitment.slice(0,2000),coreQuestion:d.coreQuestion.slice(0,1000),outcomes:d.outcomes.slice(-8).map(x=>x.slice(0,400)),contentPool:d.contentPool.slice(-8).map(x=>({...x,summary:x.summary.slice(0,400)}))}])),
      speech: map(tail(Object.values(state.speech).filter(p=>p.directionEpoch===current).map(p=>({...p,text:p.text.slice(0,500)})),10),p=>p.partId),
      tasks: map(Object.values(state.tasks).filter(t=>!t.cancelled&&(t.directionEpoch===current||(t.intendedDirectionId&&state.directions[t.intendedDirectionId]?.status==='preparing'))).sort((a,b)=>Number(a.status==='ready')-Number(b.status==='ready')||b.priority-a.priority).slice(0,12),t=>t.id),
      scenes: map(tail(Object.values(state.scenes).filter(s=>s.directionEpoch===current&&!['disposed','retired','failed'].includes(s.lifecycle)),8),s=>s.instanceId),
      proposals: map(tail(Object.values(state.proposals).filter(p=>!['cancelled','presented'].includes(p.status)),12),p=>p.id),
      performerCues: tail(state.performerCues,6),
      timeline: {...state.timeline,segments:tail(state.timeline.segments,12)},
    };
    const briefs = projectRoleBriefs(view);
    return {
      epoch: this.kernel.epoch(),
      presentation: this.options.presentation?.(),
      role,
      playbackConnected: this.gateway.connected(),
      sceneErrors: Object.fromEntries([...this.sceneErrors].filter(([,e])=>e.epoch===current).slice(-8)),
      sdk: {
        state: this.sdk ? 'ready' : this.sdkLoading ? 'loading' : this.sdkError ? 'blocked' : 'not-requested',
        ...(this.sdkError ? { reason: this.sdkError } : {}),
      },
      masterNotes: this.masterNotes.slice(-16).map(n=>({...n,text:n.text.slice(0,700),excerpt:n.text.length>700})),
      masterNoteCount: this.masterNotes.length,
      brief: role==='production' ? briefs.production.slice(0,1).map(v=>({...v,task:v.task?{...v.task,goal:v.task.goal.slice(0,4000),goalExcerpt:v.task.goal.length>4000}:null})) : briefs[role],
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
      toolContracts: {
        offerSpeech: '{directionEpoch,text,partId?}',
        requestProduction:
          '{directionEpoch,task:{id,goal,priority,inputs:[],dependsOn:[],intendedDirectionId?},proposalId?}',
        publishEditorialProposal:
          '{directionEpoch,proposal:{id,segmentIntent,viewingValue,participation,handoff,minimumMaterials:[],alternatives:[]}}',
        prepareDirection: '{directionEpoch,directionId,commitment,coreQuestion}',
        workspaceBuildPreview:
          '{directionEpoch,taskId,taskVersion,source? OR template? OR effectPath?,props?,width?,height?,durationInFrames?}',
        publishCandidate: '{directionEpoch,taskId,assetVersionId,expectedRevision}',
        prepareScene: '{directionEpoch,instanceId,assetVersionId,segmentId,label}',
        take: '{directionEpoch,instanceId,expectedRevision}',
        updateInputs: '{directionEpoch,instanceId,inputsRevision,inputs,expectedRevision,proposalIds?}',
        bindCue:
          '{directionEpoch,cue:{cueId,sceneInstanceId,anchor:{kind:speech,partId,charIndex}|{kind:showTime,at},payload:{params:{key:value}}}}',
        holdScene: '{directionEpoch,instanceId,expectedRevision}',
        resumeScene: '{directionEpoch,instanceId,expectedRevision}',
        editFutureTimeline: '{directionEpoch,segmentId,label,sceneInstanceId?,expectedRevision}',
        sendPerformerCue: '{directionEpoch,cueId,text,expectedRevision}',
      },
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
  async invoke(role: AgentRole, tool: string, args: Record<string, any>): Promise<unknown> {
    if (!(TOOL_PERMISSIONS[role] as readonly string[]).includes(tool)) throw Error('Role tool denied');
    if (tool.startsWith('read') && args.masterOffset!==undefined) {const offset=Math.max(0,Number(args.masterOffset)||0);return {epoch:this.kernel.epoch(),masterNotes:this.masterNotes.slice(offset,offset+4),nextOffset:offset+4<this.masterNotes.length?offset+4:null};}
    if(tool.startsWith('read')&&args.directionId){const d=this.kernel.view().directions[String(args.directionId)];const offset=Math.max(0,Number(args.offset)||0);return d?{id:d.id,revision:d.revision,epoch:d.epoch,commitment:d.commitment.slice(offset,offset+8000),coreQuestion:d.coreQuestion.slice(0,2000),nextOffset:offset+8000<d.commitment.length?offset+8000:null}:null;}
    if(tool==='readTask'&&args.taskId){const task=this.kernel.view().tasks[String(args.taskId)];const offset=Math.max(0,Number(args.offset)||0);return {epoch:this.kernel.epoch(),task:task?{...task,goal:task.goal.slice(offset,offset+8000)}:null,nextOffset:task&&offset+8000<task.goal.length?offset+8000:null};}
    if(tool==='readProgramme'&&args.instanceId){const scene=this.kernel.view().scenes[String(args.instanceId)];if(!scene)return null;const {playbackSamples,...detail}=scene;return {epoch:this.kernel.epoch(),scene:detail,sampleCount:playbackSamples?.length??0};}
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
      const examples:Record<string,string>={'aivtb/remotion':'remotion.tsx','aivtb/hyperframes':'hyperframes.ts','aivtb/d3':'d3.ts','aivtb/three':'three.ts'};
      const path=String(args.path??'INDEX.md');
      const guide=examples[path]?await readFile(join(this.options.repoRoot,'examples/scenes',examples[path]),'utf8'):await sdk.readGuide(path);const offset=Math.max(0,Number(args.offset)||0);const end=offset+16000;return {guide:guide.slice(offset,end),offset,nextOffset:end<guide.length?end:null,pin:sdk.provenance.commit,integrationExamples:Object.keys(examples)};
    }
    if (tool === 'searchEffects') return this.effects(String(args.query ?? ''),args.includeSource===true);
    if (tool === 'offerSpeech' && this.speechQueue.length >= 1)
      return {
        ok: false,
        reject: 'SPEECH_QUEUE_FULL',
        message: '下一段已在队列；先观察现场，不继续锁未来口播。',
      };
    if (tool === 'workspaceBuildPreview') return this.build(args);
    if (!Number.isSafeInteger(args.directionEpoch))
      throw Error('Write requires directionEpoch from latest brief');
    const commandId = String(args._callId || args.commandId || randomUUID());
    if (tool === 'offerSpeech') {
      args.partId ??= `speech-${commandId}`;
      if (typeof args.text !== 'string' || !args.text.trim()) throw Error('Speech text required');
    }
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
      this.speechQueue.push(args.partId);
      this.prepareSpeech(args.partId);
      void this.pumpSpeech().catch((e) => this.error(e));
    } else if (tool === 'yieldSpeech') {
      const index = this.speechQueue.indexOf(args.partId);
      if (index >= 0) this.speechQueue.splice(index, 1);
      this.syntheses.get(args.partId)?.controller.abort();
      this.syntheses.delete(args.partId);
    } else if (tool === 'requestProduction')
      this.onWake?.('production', '有新的制作任务。读取任务与版本，后台制作不得阻塞现场。');
    else if (tool === 'publishCandidate')
      this.onWake?.('director', '新候选已编译。先检查与备场，由你选择何时使用；ready不是上播。');
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
    if (['offerSpeech', 'yieldSpeech'].includes(tool))
      return { kind: 'speechPart', id: String(args.partId ?? '') };
    if (['requestProduction', 'publishCandidate', 'reportProgress'].includes(tool))
      return { kind: 'productionTask', id: String(args.task?.id ?? args.taskId ?? '') };
    if (tool === 'publishEditorialProposal')
      return { kind: 'editorialProposal', id: String(args.proposal?.id ?? '') };
    if (tool === 'bindCue') return { kind: 'cue', id: String(args.cue?.cueId ?? '') };
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
          if (this.speaking === part.partId) this.speaking = undefined;
        }
    } else if (current.speech[snapshot.audio.partId] && this.clips.has(snapshot.audio.partId))
      this.speaking = snapshot.audio.partId;
    if (!this.synthController) void this.pumpSpeech().catch((e) => this.error(e));
  }
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
      props: {
        ...candidate.props,
        fps: candidate.fps,
        width: candidate.width,
        height: candidate.height,
        durationInFrames: candidate.durationInFrames,
        window: { start: 0, seconds: candidate.durationInFrames / candidate.fps },
      },
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
    if (
      !args.template && !args.effectPath &&
      (typeof args.source !== 'string' || !args.source.trim() || args.source.length > 100000)
    )
      throw Error('Provide Scene source (up to 100000 characters), template gsap/remotion, or effectPath from searchEffects');
    if (args.effectPath && (args.source || args.template))
      throw Error('Choose effectPath, source or template; do not mix component reuse with source overrides');
    if (args.template && !['gsap', 'remotion'].includes(args.template))
      throw Error('Unknown native SDK template');
    const width = args.width ?? 1920,
      height = args.height ?? 1080,
      frames = args.durationInFrames ?? 1800;
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
      if (args.template) {
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
        durationInFrames: args.durationInFrames ?? 1800,
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
  private prepareSpeech(partId: string) {
    const prior = this.syntheses.get(partId);
    if (prior) return prior;
    const part = this.kernel.view().speech[partId];
    const controller = new AbortController();
    const promise = Promise.resolve().then(async () => {
      if (!part || part.state !== 'offered' || part.directionEpoch !== this.kernel.epoch() || this.isClosing)
        throw Error('Speech is no longer eligible for synthesis');
      return this.voice.synthesize(part.text, controller.signal);
    });
    // One current part plus the bounded future queue; preparation never sends media.
    void promise.catch(() => {});
    const entry = { controller, promise };
    this.syntheses.set(partId, entry);
    return entry;
  }
  private cancelSpeechPreparation() {
    this.synthController?.abort();
    for (const entry of this.syntheses.values()) entry.controller.abort();
    this.syntheses.clear();
    for (let i = this.speechQueue.length - 1; i >= 0; i--) {
      const part = this.kernel.view().speech[this.speechQueue[i]];
      if (this.isClosing || !part || part.directionEpoch !== this.kernel.epoch() || part.state !== 'offered')
        this.speechQueue.splice(i, 1);
    }
  }
  private async pumpSpeech() {
    if (this.speaking || this.isClosing) return;
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
      const audioRef = this.gateway.publishMedia(partId, join(this.options.dataDir, 'voice', clip.file));
      const retained = { ...clip, audioRef, epoch: part.directionEpoch };
      const clipDir = join(this.options.dataDir, 'clips');
      await mkdir(clipDir, { recursive: true });
      const clipPath = join(clipDir, createHash('sha256').update(partId).digest('hex') + '.json');
      await storeJson(clipPath, { partId, clip: retained });
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
      this.syntheses.delete(partId);
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
      if (linked || patched)
        this.submit(
          'runtime',
          { kind: 'audienceProposal', id: proposal.id },
          {
            type: 'setProposalStatus',
            proposalId: proposal.id,
            status: 'presented',
            evidencePlaybackId: evidenceId,
          },
        );
    }
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
    const target: CommandTarget = { kind: 'speechPart', id: part.partId };
    if (event.kind === 'playing' && part.state === 'starting')
      this.submit('runtime', target, {
        type: 'receiptSpeech',
        partId: part.partId,
        kind: 'playing',
        audioRef: clip.audioRef,
        alignment: clip.starts ? 'real' : 'estimated',
        ...(clip.starts ? { starts: clip.starts } : {}),
        spokenChars: 0,
      });
    else if (event.kind === 'timeupdate' && part.state === 'playing' && clip.starts)
      this.submit('runtime', target, {
        type: 'progressSpeech',
        partId: part.partId,
        mediaTimeMs: event.mediaTimeMs,
        audioRef: clip.audioRef,
      });
    else if (event.kind === 'ended' && part.state === 'playing')
      this.submit('runtime', target, {
        type: 'receiptSpeech',
        partId: part.partId,
        kind: 'ended',
        audioRef: clip.audioRef,
        spokenChars: [...part.text].length,
      });
    else if (event.kind === 'aborted' && ['starting', 'playing'].includes(part.state))
      this.submit('runtime', target, {
        type: 'receiptSpeech',
        partId: part.partId,
        kind: 'aborted',
        audioRef: clip.audioRef,
      });
    else if (event.kind === 'error' && ['starting', 'playing'].includes(part.state))
      this.submit('runtime', target, { type: 'receiptSpeech', partId: part.partId, kind: 'failed' });
    if (['ended', 'error', 'aborted'].includes(event.kind)) {
      this.clips.delete(part.partId);
      this.speaking = undefined;
      void this.pumpSpeech();
      this.onWake?.('performer', '上一段真实播放已结束；观察现场，自行判断接话或停留。');
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
      this.cancelSpeechPreparation();
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
    this.cancelSpeechPreparation();

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
