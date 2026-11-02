import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
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
const internal = ['runtime', 'master', 'directionController', 'input'] as const;
const roleNames: AgentRole[] = ['performer', 'director', 'editorial', 'production'];
interface Candidate { id: string; taskId: string; taskVersion: number; epoch: number; hash: string; file: string; props: Record<string, unknown>; fps: number; width: number; height: number; durationInFrames: number }
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
  private sdk: any;
  private tickTimer?: ReturnType<typeof setInterval>;
  private isClosing = false;
  private readonly busy = new Set<string>();
  private lastVetoCheck = -10000;
  private tickBusy = false;
  onWake?: (role: AgentRole, text: string, urgent?: boolean) => void;
  onError?: (message: string) => void;
  constructor(private readonly options: { repoRoot: string; dataDir: string; port: number; secret: SecretReader }) {
    this.log = new FileEventLog(join(options.dataDir, 'events.jsonl'));
    const actors = Object.fromEntries([...roleNames, ...internal].map(role => [`live:${role}`, { actorId: `live:${role}`, role, trustedMaster: role === 'master' } satisfies ActorRecord]));
    this.kernel = EngineeringKernel.hydrate(this.log, { clock: this.clock, actors });
    this.voice = new ElevenLabsVoice({ dir: join(options.dataDir, 'voice'), secret: options.secret });
    this.gateway = new BrowserGateway({ port: options.port, browserDir: join(options.repoRoot, 'packages/scene-host/dist'),
      onReceipt: event => { void this.receipt(event).catch(e => this.error(e)); },
      onConnection: online => { if (online) void this.reconcileBrowser().catch(e => this.error(e)); },
    });
  }
  async start() {
    const module = await import(pathToFileURL(join(this.options.repoRoot, 'scripts/sdk-source.mjs')).href);
    this.sdk = await module.sdkTools({ cacheRoot: join(this.options.repoRoot, '.deps/sdk') });
    for (const file of await readdir(join(this.options.dataDir, 'candidates')).catch(() => [] as string[])) {
      if (!file.endsWith('.json')) continue;
      const c = JSON.parse(await readFile(join(this.options.dataDir, 'candidates', file), 'utf8')) as Candidate;
      this.candidates.set(c.id, c); this.gateway.publishBundle(c.hash, c.file);
    }
    // Hydration never replays submitted audio/takes. Operators must inspect the restored state.
    const last = this.log.snapshot().events.at(-1)?.showTime ?? 0;
    this.clock.showTime = last;
    await this.gateway.start();
    this.tickTimer = setInterval(() => { void this.tick().catch(e => this.error(e)); }, 100); this.tickTimer.unref?.();
  }
  private error(e: unknown) { this.onError?.(e instanceof Error ? e.message : String(e)); }
  brief(role: AgentRole) {
    const state = this.kernel.view(); const briefs = projectRoleBriefs(state);
    return { epoch: this.kernel.epoch(), role, playbackConnected: this.gateway.connected(), brief: briefs[role],
      revisions: { show: state.project, directions: state.directions, timeline: state.timeline, speech: Object.fromEntries(Object.entries(state.speech).filter(([, p]) => !['ended','cancelled','aborted','failed'].includes(p.state))), scenes: state.scenes, tasks: state.tasks, proposals:state.proposals },
      candidates: [...this.candidates.values()].filter(c => c.epoch === this.kernel.epoch()).map(({ file, ...c }) => c),
      recentEvents:this.kernel.allEvents().slice(-10).map(e=>({eventId:e.eventId,type:e.type,showTime:e.showTime})),
      commandFormat: 'Always directionEpoch. New records get target/revision/id from runtime; updates require expectedRevision from revisions.',
      toolContracts: {
        offerSpeech: '{directionEpoch,text,partId?}',
        requestProduction: '{directionEpoch,task:{id,goal,priority,inputs:[],dependsOn:[]},proposalId?}',
        publishEditorialProposal: '{directionEpoch,proposal:{id,segmentIntent,viewingValue,participation,handoff,minimumMaterials:[],alternatives:[]}}',
        prepareDirection: '{directionEpoch,directionId,commitment,coreQuestion}',
        workspaceBuildPreview: '{directionEpoch,taskId,taskVersion,source,props?,width?,height?,durationInFrames?}',
        publishCandidate: '{directionEpoch,taskId,assetVersionId,expectedRevision}',
        prepareScene: '{directionEpoch,instanceId,assetVersionId,segmentId,label}',
        take: '{directionEpoch,instanceId,expectedRevision}',
        updateInputs: '{directionEpoch,instanceId,inputsRevision,inputs,expectedRevision}',
        bindCue:'{directionEpoch,cue:{cueId,sceneInstanceId,anchor:{kind:speech,partId,charIndex}|{kind:showTime,at},payload:{inputs}}}',
        holdScene:'{directionEpoch,instanceId,expectedRevision}',
        resumeScene:'{directionEpoch,instanceId,expectedRevision}',
        editFutureTimeline: '{directionEpoch,segmentId,label,sceneInstanceId?,expectedRevision}',
        sendPerformerCue: '{directionEpoch,cueId,text,expectedRevision}',
      },
    };
  }
  private submit(actor: string, target: CommandTarget, payload: ShowCommand, command?: Partial<CommandEnvelope>) {
    const commandId = command?.commandId ?? randomUUID();
    return this.kernel.submit({ commandId, idempotencyKey: commandId, actorId: `live:${actor}`, directionEpoch: command?.directionEpoch ?? this.kernel.epoch(), expectedRevision: command?.expectedRevision ?? this.kernel.revision(target), target, payload });
  }
  async invoke(role: AgentRole, tool: string, args: Record<string, any>): Promise<unknown> {
    if (!(TOOL_PERMISSIONS[role] as readonly string[]).includes(tool)) throw Error('Role tool denied');
    if (tool.startsWith('read')) return this.brief(role);
    if (tool === 'inspectCandidate') return { ...this.brief(role), browser: this.gateway.connected() ? await this.gateway.execute('snapshot',this.kernel.epoch(),{}) : null };
    if (tool === 'searchSdk') return { guide: await this.sdk.readGuide(args.path ?? 'INDEX.md'), pin: this.sdk.provenance.commit };
    if (tool === 'searchEffects') return this.effects(String(args.query ?? ''));
    if (tool === 'offerSpeech' && this.speechQueue.length >= 1) return { ok:false, reject:'SPEECH_QUEUE_FULL', message:'下一段已在队列；先观察现场，不继续锁未来口播。' };
    if (tool === 'workspaceBuildPreview') return this.build(args);
    if (!Number.isSafeInteger(args.directionEpoch)) throw Error('Write requires directionEpoch from latest brief');
    const commandId = String(args._callId || args.commandId || randomUUID());
    if (tool === 'offerSpeech') { args.partId ??= `speech-${commandId}`; if (typeof args.text !== 'string' || !args.text.trim()) throw Error('Speech text required'); }
    const target = this.target(tool, args);
    const create = ['offerSpeech','requestProduction','publishEditorialProposal','prepareDirection','prepareScene','bindCue'].includes(tool);
    const expectedRevision = args.expectedRevision ?? (create ? 0 : tool === 'publishCandidate' ? this.kernel.revision(target) : undefined);
    if (!Number.isSafeInteger(expectedRevision)) throw Error('Updating an existing record requires its latest expectedRevision');
    const { directionEpoch, _callId, target: ignoredTarget, expectedRevision: ignoredRevision, commandId: ignoredId, ...fields } = args;
    let payload: ShowCommand = { ...fields, type: tool } as ShowCommand;
    if (tool === 'publishCandidate') {
      const candidate = this.candidates.get(String(args.assetVersionId));
      if (!candidate || candidate.taskId !== args.taskId || candidate.epoch !== directionEpoch || candidate.taskVersion !== this.kernel.view().tasks[candidate.taskId]?.version) throw Error('No matching compiled candidate');
      payload = { type: 'publishCandidate', taskId: candidate.taskId, asset: { id: candidate.id, hash: candidate.hash, codeVersion: candidate.hash, dependencyVersions: {}, schemaVersion: '1', verification: 'unverified',
        provenance: `reelmorph-agent@${this.sdk.provenance.commit}; local compiled scene, live capability not certified`, capabilities: { supportsInPlaceInputUpdate: false, requiresStandbyRebuild: true, deterministicReplay: false, holdLoop: true, audioOwnership: 'none', realtime: 'unverified' } } };
    }
    const result = this.submit(role, target, payload, { commandId, directionEpoch, expectedRevision });
    if (!result.ok) return result;
    // One command owner dispatches effects; fixture Desks are never part of this path.
    if (tool === 'offerSpeech') {
      this.speechQueue.push(args.partId); void this.pumpSpeech().catch(e => this.error(e));
    } else if (tool === 'requestProduction') this.onWake?.('production', '有新的制作任务。读取任务与版本，后台制作不得阻塞现场。');
    else if (tool === 'publishCandidate') this.onWake?.('director', '新候选已编译。先检查与备场，由你选择何时使用；ready不是上播。');
    else if (tool === 'sendPerformerCue') this.onWake?.('performer', `导播内部cue：${args.text}`);
    else if (['holdScene','resumeScene','retireScene','disposeScene'].includes(tool)) {
      await this.gateway.execute(tool==='holdScene'?'hold':tool==='resumeScene'?'resume':'dispose',directionEpoch,{instanceId:args.instanceId});
      this.submit('runtime',target,{type:'receiptSceneLifecycle',instanceId:args.instanceId,lifecycle:tool==='holdScene'?'holding':tool==='resumeScene'?'taken':tool==='retireScene'?'retired':'disposed'});
    }
    else if (tool === 'prepareScene') await this.prepare(args.instanceId);
    else if (tool === 'take') await this.gateway.execute('take', directionEpoch, { instanceId: args.instanceId });
    else if (tool === 'updateInputs') {
      const scene = this.kernel.view().scenes[args.instanceId];
      await this.gateway.execute('patch', directionEpoch, { ...fields, codeVersion: scene.codeVersion });
      this.submit('runtime', target, { type: 'receiptScenePatch', instanceId: args.instanceId, codeVersion: scene.codeVersion, inputsRevision: args.inputsRevision, inputs: args.inputs });
    }
    return { ...result, latest: this.brief(role) };
  }
  private target(tool: string, args: Record<string, any>): CommandTarget {
    if (['offerSpeech','yieldSpeech'].includes(tool)) return {kind:'speechPart',id:String(args.partId ?? '')};
    if (['requestProduction','publishCandidate','reportProgress'].includes(tool)) return {kind:'productionTask',id:String(args.task?.id ?? args.taskId ?? '')};
    if (tool === 'publishEditorialProposal') return {kind:'editorialProposal',id:String(args.proposal?.id ?? '')};
    if (tool === 'bindCue') return {kind:'cue',id:String(args.cue?.cueId??'')};
    if (tool === 'prepareDirection') return {kind:'direction',id:String(args.directionId ?? '')};
    if (['prepareScene','take','updateInputs','holdScene','resumeScene','retireScene','disposeScene'].includes(tool)) return {kind:'sceneInstance',id:String(args.instanceId ?? '')};
    if (tool === 'editFutureTimeline') return {kind:'timeline',id:this.kernel.view().timeline.id};
    return {kind:'show',id:this.kernel.view().project.id};
  }
  private async reconcileBrowser() {
    await this.gateway.execute('setEpoch',this.kernel.epoch(),{});
    const snapshot=await this.gateway.execute('snapshot',this.kernel.epoch(),{});
    const current=this.kernel.view();
    for(const scene of Object.values(current.scenes)) {
      if(scene.directionEpoch!==this.kernel.epoch()||scene.lifecycle==='disposed')continue;
      const observed=snapshot.scenes?.find((s:any)=>s.instanceId===scene.instanceId&&s.codeVersion===scene.codeVersion);
      this.submit('runtime',{kind:'sceneInstance',id:scene.instanceId},{type:'receiptSceneLifecycle',instanceId:scene.instanceId,lifecycle:observed?(observed.phase==='held'?'holding':'taken'):'disposed'});
    }
    if(!snapshot.audio)for(const part of Object.values(current.speech))if(['starting','playing'].includes(part.state))this.submit('runtime',{kind:'speechPart',id:part.partId},{type:'receiptSpeech',partId:part.partId,kind:'failed'});
  }
  private async prepare(id: string) {
    const scene = this.kernel.view().scenes[id]; const candidate = this.candidates.get(scene.assetVersionId);
    if (!candidate) throw Error('Candidate package not available');
    const value = await this.gateway.execute('prepare', scene.directionEpoch, { ...candidate, instanceId: id, codeVersion: scene.codeVersion, directionEpoch: scene.directionEpoch, moduleUrl: this.gateway.publishBundle(candidate.hash, candidate.file), props: { ...candidate.props, fps: candidate.fps, width: candidate.width, height: candidate.height, durationInFrames: candidate.durationInFrames, window: { start: 0, seconds: candidate.durationInFrames / candidate.fps } } });
    if (this.kernel.epoch() !== scene.directionEpoch || value?.instanceId !== id || value.codeVersion !== scene.codeVersion) throw Error('Stale prepare result');
    const target: CommandTarget = { kind: 'sceneInstance', id };
    this.submit('runtime', target, { type: 'noteLiveCapabilities', instanceId: id, supportsInPlaceInputUpdate: value.supportsInPlaceInputUpdate === true });
    for (const gate of ['moduleLoad', 'schemaAssets', 'firstFramePaint', 'businessVersionMatch'] as const) this.submit('runtime', target, { type: 'noteReadiness', instanceId: id, gate, observation: { status: 'ok', observedAtShowTime: this.clock.now(), detail: 'Real browser preparation; certification of arbitrary media is not implied' } });
  }
  private async build(args: Record<string, any>) {
    const task = this.kernel.view().tasks[args.taskId];
    if (!task || task.directionEpoch !== args.directionEpoch || task.version !== args.taskVersion || task.cancelled) throw Error('Stale task');
    if (!args.template && (typeof args.source !== 'string' || !args.source.trim() || args.source.length > 100000)) throw Error('Provide Scene source (up to 100000 characters), or template gsap/remotion');
    if (args.template && !['gsap','remotion'].includes(args.template)) throw Error('Unknown native SDK template');
    if (this.busy.size >= 1) throw Error('Production slot busy; keep task pending');
    const id = randomUUID(); this.busy.add(id);
    const folder = join(this.options.dataDir, 'production', id);
    try {
      await mkdir(folder, { recursive: true });
      if (args.template) {
        const files = this.sdk.scaffold(`scene-${id}`, args.template);
        for (const [name, bytes] of files) await writeFile(join(folder, name === 'index.ts' ? 'index.tsx' : name), bytes);
      }
      if (args.source) await writeFile(join(folder, 'index.tsx'), args.source);
      await runFile(process.execPath, [join(this.options.repoRoot, 'scripts/sdk-build.mjs'), folder, join(this.options.repoRoot, '.deps/sdk')], { cwd: this.options.repoRoot, timeout: 60000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME, AIVTB_SDK_REPO: process.env.AIVTB_SDK_REPO } });
      if (this.isClosing || this.kernel.epoch() !== task.directionEpoch || this.kernel.view().tasks[task.id]?.cancelled) throw Error('Production completed after task invalidation; not eligible for live');
      const code = await readFile(join(folder, 'bundle.js')); const hash = createHash('sha256').update(code).digest('hex');
      const c: Candidate = { id, taskId: task.id, taskVersion: task.version, epoch: task.directionEpoch, hash, file: join(folder, 'bundle.js'), props: args.props ?? {}, fps: 30, width: args.width ?? 1920, height: args.height ?? 1080, durationInFrames: args.durationInFrames ?? 1800 };
      this.candidates.set(id, c); await mkdir(join(this.options.dataDir, 'candidates'), { recursive: true }); await writeFile(join(this.options.dataDir, 'candidates', `${id}.json`), JSON.stringify(c));
      const { file, ...manifest } = c;
      return { status: 'compiled', manifest, preview: 'Director must prepare in real browser before take; compilation is not visual certification' };
    } finally { this.busy.delete(id); }
  }
  private async effects(query: string) {
    const root = join(this.sdk.root, 'library/sources'); const entries: any[] = [];
    for (const source of await readdir(root)) for (const name of await readdir(join(root, source))) {
      const folder = join(root, source, name);
      const entry = JSON.parse(await readFile(join(folder, 'component.json'), 'utf8').catch(() => 'null'));
      if (entry && JSON.stringify(entry).toLowerCase().includes(query.toLowerCase())) {
        const implementation = await readFile(join(folder, 'index.ts'), 'utf8').catch(() => undefined);
        entries.push({ ...entry, path: `library/sources/${source}/${name}`, ...(implementation ? { implementation } : {}) });
      }
    }
    return { entries: entries.slice(0, 12), scaffoldGuide: await this.sdk.readGuide('INDEX.md'), note: 'Read/copy source via authorized SDK workspace; no database is required for these local components' };
  }
  private async pumpSpeech() {
    if (this.speaking || this.isClosing) return;
    const partId = this.speechQueue.shift(); if (!partId) return;
    this.speaking = partId;
    try {
      const part = this.kernel.view().speech[partId];
      if (!part || part.directionEpoch !== this.kernel.epoch() || part.state !== 'offered') return;
      const target: CommandTarget = { kind: 'speechPart', id: partId };
      const controller=new AbortController();this.synthController=controller;
      const clip = await this.voice.synthesize(part.text, controller.signal);
      if(this.synthController===controller)this.synthController=undefined;
      if (part.directionEpoch !== this.kernel.epoch() || this.kernel.view().speech[partId]?.state !== 'offered') return;
      const audioRef = this.gateway.publishMedia(partId, join(this.options.dataDir, 'voice', clip.file));
      this.clips.set(partId, { ...clip, audioRef, epoch: part.directionEpoch });
      for (const type of ['acceptSpeech', 'queueSpeech', 'startSpeech'] as const) { const r = this.submit('runtime', target, { type, partId }); if (!r.ok) throw Error(r.message); }
      await this.gateway.execute('speech', part.directionEpoch, { partId, text: part.text, audioRef, ms:clip.ms, starts:clip.starts });
      // The playing event, not this command acknowledgement, moves speech to playing.
      return;
    } catch (error) {
      const part = this.kernel.view().speech[partId];
      if (part && ['starting','playing'].includes(part.state)) this.submit('runtime', { kind: 'speechPart', id: partId }, { type: 'receiptSpeech', partId, kind: 'failed' });
      this.speaking = undefined; this.error(error);
    } finally {
      if (!['starting','playing'].includes(this.kernel.view().speech[partId]?.state ?? '')) this.speaking = undefined;
    }
  }
  private async receipt(event: Record<string, any>) {
    if (event.type === 'clock' && Number.isFinite(event.showTime)) { this.clock.showTime = Math.max(this.clock.now(), event.showTime); return; }
    if (event.type === 'painted' && event.operation === 'take') {
      const scene = this.kernel.view().scenes[event.instanceId];
      if (!scene || scene.codeVersion !== event.codeVersion || scene.directionEpoch !== event.epoch || event.epoch !== this.kernel.epoch()) return;
      const evidenceId=randomUUID();
      const recorded=this.submit('runtime', { kind: 'sceneInstance', id: scene.instanceId }, { type: 'recordPlayback', receipt: { id: evidenceId, kind: 'painted', sceneInstanceId: scene.instanceId, assetVersionId: scene.assetVersionId } });
      if(recorded.ok)for(const proposal of Object.values(this.kernel.view().proposals))if(proposal.status==='ready'&&proposal.directionEpoch===this.kernel.epoch()&&proposal.taskIds.some(id=>this.kernel.view().tasks[id]?.assetVersionIds.includes(scene.assetVersionId)))this.submit('runtime',{kind:'audienceProposal',id:proposal.id},{type:'setProposalStatus',proposalId:proposal.id,status:'presented',evidencePlaybackId:evidenceId});
      this.onWake?.('performer', '导播选择的新画面已实际显示。可结合它继续表达，也可保持观察。');
    }
    if (event.type !== 'audio') return;
    const part = this.kernel.view().speech[event.partId]; const clip = this.clips.get(event.partId);
    if (!part || !clip || event.audioRef !== clip.audioRef) return;
    const target: CommandTarget = { kind: 'speechPart', id: part.partId };
    if (event.kind === 'playing' && part.state === 'starting') this.submit('runtime', target, { type: 'receiptSpeech', partId: part.partId, kind: 'playing', audioRef: clip.audioRef, alignment: clip.starts ? 'real' : 'estimated', ...(clip.starts ? { starts: clip.starts } : {}), spokenChars: 0 });
    else if (event.kind === 'timeupdate' && part.state === 'playing' && clip.starts) this.submit('runtime', target, { type: 'progressSpeech', partId: part.partId, mediaTimeMs: event.mediaTimeMs, audioRef: clip.audioRef });
    else if (event.kind === 'ended' && part.state === 'playing') this.submit('runtime', target, { type: 'receiptSpeech', partId: part.partId, kind: 'ended', audioRef: clip.audioRef, spokenChars: [...part.text].length });
    else if (event.kind === 'aborted' && ['starting','playing'].includes(part.state)) this.submit('runtime', target, { type: 'receiptSpeech', partId: part.partId, kind: 'aborted', audioRef: clip.audioRef });
    else if (event.kind === 'error' && ['starting','playing'].includes(part.state)) this.submit('runtime', target, { type: 'receiptSpeech', partId: part.partId, kind: 'failed' });
    if (['ended','error','aborted'].includes(event.kind)) { this.clips.delete(part.partId); this.speaking = undefined; void this.pumpSpeech(); this.onWake?.('performer', '上一段真实播放已结束；观察现场，自行判断接话或停留。'); }
  }
  async switchDirection(commitment: string, hard = false) {
    const direction = this.kernel.view().project.currentDirectionId; const target: CommandTarget = { kind: 'direction', id: direction }; const authorizationId = randomUUID();
    const r = this.submit('master', target, { type: 'issueSwitchAuthorization', authorizationId, kind: hard ? 'master-hard' : 'master-soft', reason: 'Authenticated local master command' });
    if (!r.ok) return r;
    const result = this.submit('directionController', target, { type: 'switchDirection', authorizationId, strategy: hard ? 'hard' : 'soft', next: commitment ? { commitment, coreQuestion: commitment } : { transition: true } });
    if(result.ok)this.synthController?.abort();
    if (result.ok && this.gateway.connected()) await this.gateway.execute('setEpoch', this.kernel.epoch(), { keepSpeech: !hard });
    for (const role of roleNames) this.onWake?.(role, `方向已获授权切换。读取当前epoch和简报；旧未执行内容不得追加。${commitment}`, true);
    return result;
  }
  private async tick() {
    if (this.isClosing || this.tickBusy) return;
    this.tickBusy = true;
    try {
    for (const { cueId, resolution } of this.kernel.tick().scanned) {
      if (resolution.status !== 'due') continue;
      const cue = this.kernel.view().cues[cueId];
      const r = this.submit('runtime', { kind: 'cue', id: cueId }, { type: 'dispatchCue', cueId });
      if (!r.ok || !cue.sceneInstanceId) continue;
      try {
        const scene = this.kernel.view().scenes[cue.sceneInstanceId];
        await this.gateway.execute('patch', scene.directionEpoch, { instanceId: scene.instanceId, codeVersion: scene.codeVersion, inputsRevision: scene.inputsRevision + 1, inputs: cue.payload });
        this.submit('runtime', {kind:'sceneInstance',id:scene.instanceId},{type:'receiptScenePatch',instanceId:scene.instanceId,codeVersion:scene.codeVersion,inputsRevision:scene.inputsRevision+1,inputs:cue.payload});
        this.submit('runtime', { kind: 'sceneInstance', id: scene.instanceId }, { type: 'recordPlayback', receipt: { id: randomUUID(), kind: 'applied', sceneInstanceId: scene.instanceId, cueId } });
      } catch (error) { this.error(error); }
    }
    await this.pumpSpeech();
    await this.reviewVeto();
    } finally { this.tickBusy = false; }
  }
  private async reviewVeto() {
    const now = this.clock.now(); if (now - this.lastVetoCheck < 1000) return; this.lastVetoCheck = now;
    const state = this.kernel.view();
    const distinct = new Set(state.audience.filter(r => r.directionEpoch === this.kernel.epoch() && r.kind === 'opposition' && now-r.showTime <= 30000).map(r => r.audienceId));
    if (distinct.size < 5 || now < 10000) return;
    const authorizationId = randomUUID(); const target: CommandTarget = {kind:'direction',id:state.project.currentDirectionId};
    const issued = this.submit('directionController', target, {type:'issueSwitchAuthorization',authorizationId,kind:'group-veto',reason:'Recorded distinct audience opposition passed configured policy',assessmentTimes:[now-10000,now]});
    if (!issued.ok) return;
    const next = Object.values(state.directions).find(d => d.status === 'preparing');
    const switched = this.submit('directionController',target,{type:'switchDirection',authorizationId,strategy:'soft',next:next?{commitment:next.commitment,coreQuestion:next.coreQuestion}:{transition:true}});
    if (!switched.ok) return;
    this.synthController?.abort();
    if (this.gateway.connected()) await this.gateway.execute('setEpoch',this.kernel.epoch(),{keepSpeech:true});
    for (const role of roleNames) this.onWake?.(role,'群体否决已由控制器复核并切换。读取新epoch；没有候选时进入中性过渡并询问观众，不继续旧方向。',true);
  }
  async stop() { this.isClosing = true; this.synthController?.abort(); if (this.tickTimer) clearInterval(this.tickTimer); await this.gateway.stop(); this.log.close(); }
}
