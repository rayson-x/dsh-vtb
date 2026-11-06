/** DSH adapter simulation: registry and agents are ports; no model requests or stage playback. */
import { afterEach, expect, it, vi } from 'vitest';
import{TOOL_PERMISSIONS}from'../src/live/domain/permissions';
import type{AgentRole}from'../src/live/domain/codes';
import { DshLiveTeam, type DshAgentPort,type RoleRuntime } from '../src/live/runtime/dsh-team';
class Agent implements DshAgentPort {
  status = 'idle';
  calls: string[] = [];
  messages: any[] = [];
  ctx:{tools:{schemas:()=>{name:string}[];restrict:(filter:{allow:string[]})=>()=>void}};
  constructor(readonly session:{id:string},role:AgentRole='performer'){let names:string[]=[...TOOL_PERMISSIONS[role],'working_directory'];this.ctx={tools:{schemas:()=>names.map(name=>({name})),restrict:filter=>{const prior=names;names=names.filter(n=>filter.allow.includes(n));return()=>{names=prior;};}}};}
  followup(message: unknown) {
    this.calls.push('followup');
    this.messages.push(message);
  }
  steer(message: unknown) {
    this.calls.push('steer');
    this.messages.push(message);
  }
  cancel() {
    this.calls.push('cancel');
  }
  async whenIdle() {}
}
const teams: DshLiveTeam[] = [];
afterEach(async () => {
  for (const team of teams.splice(0)) await team.stop();
  vi.useRealTimers();
});
function setup(select: (id: string) => Promise<void> = async () => {},selection={provider:'fixture',model:'fixture'},extras:{runtime?:Partial<RoleRuntime>;llm?:unknown}={}) {
  const agents = new Map<string, Agent>();
  const optionsByRole=new Map<string,any>();
  const services = {
    llm:extras.llm,
    agents: {
      async create(options: any) {
        optionsByRole.set(options.meta.agentPreset,options.agentOptions);
        const agent = new Agent({ id: options.sessionId },options.meta.agentPreset.replace('live-v2-','') as AgentRole);
        agents.set(options.meta.agentPreset, agent);
        return { agent };
      },
    },
    agentDefaultModel: { currentSelection: () => selection },
    agentPresets: { select: (_agent: unknown, id: string) => select(id) },
  };
  const team = new DshLiveTeam(
    { get: (name: string) => services[name as keyof typeof services] },
    { brief: () => ({}), invoke: async () => ({}),...extras.runtime },
    process.cwd(),
  );
  teams.push(team);
  return { team, agents,optionsByRole };
}
it('uses the DeepSeek non-thinking route for the live speaker while keeping background role reasoning',async()=>{
 const {team,optionsByRole}=setup(undefined,{provider:'deepseek',model:'deepseek-v4-flash'});await team.start();
 expect(optionsByRole.get('live-v2-performer').reasoningEffort).toBe('off');
 expect(optionsByRole.get('live-v2-production').reasoningEffort).toBe('low');
});
it('starts a one-shot acknowledgement while the main speaker is busy, without a tool round trip',async()=>{
 let release!:()=>void;const gate=new Promise<void>(done=>{release=done;}),offer=vi.fn(async()=>({ok:true})),requests:any[]=[];
 const {team,agents}=setup(undefined,{provider:'deepseek',model:'deepseek-flash'},{llm:{async*stream(options:any){requests.push(options);await gate;yield{type:'text-delta',text:'暖灯留窗边。'};yield{type:'finish',reason:{kind:'stop'}};}},runtime:{quickAcknowledgementContext:id=>({epoch:2,inputId:id,text:'窗边加暖灯？',topic:'书房',heard:'正读信',instructions:[]}),reserveAcknowledgement:()=>()=>{},offerQuickAcknowledgement:offer}});
 await team.start();const actor=agents.get('live-v2-performer')!;actor.calls=[];actor.status='running';team.observeStream(actor,{type:'start',attemptId:'busy'});
 expect(team.acknowledgeAudience('viewer')).toBe(true);await vi.waitFor(()=>expect(requests).toHaveLength(1));expect(actor.calls).toEqual([]);expect(requests[0].tools).toBeUndefined();
 release();await vi.waitFor(()=>expect(offer).toHaveBeenCalledWith('viewer','暖灯留窗边。',2));expect(actor.calls).toEqual([]);
});
it('lets the performer and director work while editorial preset setup is still waiting', async () => {
  let release!: () => void;
  const pending = new Promise<void>((done) => (release = done));
  const { team, agents } = setup((id) => (id === 'live-v2-editorial' ? pending : Promise.resolve()));
  const starting = team.start();
  try {
    await vi.waitFor(() => expect(agents.get('live-v2-performer')?.calls).toContain('followup'));
    expect(agents.get('live-v2-director')?.calls).toContain('followup');
  } finally {
    release();
    await starting;
  }
  expect(new Set(team.snapshot().map((r) => r.sessionId)).size).toBe(4);
});
it('ignores stale agent instances before deciding whether to abort an old generation', async () => {
  const { team, agents } = setup();
  await team.start();
  const performer = agents.get('live-v2-performer')!;
  performer.calls = [];
  performer.status = 'running';
  team.observeStream(performer, { type: 'start', attemptId: 'active' });
  team.observeStream(new Agent(performer.session), { type: 'end', attemptId: 'active' });
  team.wake('performer', 'urgent audience input', true);
  expect(performer.calls).toEqual(['cancel', 'steer']);
});
it('pauses editorial without cancelling the performer or production worker', async () => {
  const { team, agents } = setup();
  await team.start();
  for (const agent of agents.values()) agent.calls = [];
  await team.setOnline('editorial', false);
  team.wake('performer', 'respond or hold');
  expect(agents.get('live-v2-editorial')!.calls).toEqual(['cancel']);
  expect(agents.get('live-v2-performer')!.calls).toEqual(['followup']);
  expect(agents.get('live-v2-production')!.calls).toEqual([]);
});

it('delivers an urgent performer wake with current engineering facts so a reply needs no extra read round', async () => {
  const {team,agents}=setup();await team.start();
  vi.spyOn(team.runtime,'brief').mockReturnValue({epoch:7,brief:{recentInteractions:[{eventId:'viewer-new',summary:'窗边加暖灯'}]},revisions:{speech:{next:{revision:3,state:'offered'}}},masterNotes:[{text:'保留书房方向'}]});
  team.wake('performer','观众简报：窗边加暖灯',true);
  const message=agents.get('live-v2-performer')!.messages.at(-1);
  const text=message.content.map((p:any)=>p.text??'').join('');
  expect(text).toContain('"epoch":7');expect(text).toContain('viewer-new');expect(text).toContain('"revision":3');expect(text).toContain('保留书房方向');
});

it('does not stop live seats when editorial setup fails, and can retry only that seat', async () => {
  let fail = true;
  const { team, agents } = setup(async (id) => {
    if (id === 'live-v2-editorial' && fail) throw Error('editorial fixture unavailable');
  });
  await team.start();
  expect(team.errors()).toMatchObject({ editorial: 'editorial fixture unavailable' });
  const performer = agents.get('live-v2-performer')!;
  expect(performer.calls).toEqual(['followup']);
  expect(team.snapshot().some((r) => r.role === 'production')).toBe(true);
  fail = false;
  await team.setOnline('editorial', true);
  expect(team.errors()).toEqual({});
  expect(performer.calls).toEqual(['followup']);
  expect(team.snapshot().filter((r) => r.role === 'editorial')).toHaveLength(1);
});

it('collects messages during preset setup without polling or invoking an unready seat', async () => {
  vi.useFakeTimers();
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>((done) => (release = done)),
    reached = new Promise<void>((done) => (entered = done));
  const { team, agents } = setup((id) => {
    if (id === 'live-v2-editorial') {
      entered();
      return pending;
    }
    return Promise.resolve();
  });
  const starting = team.start();
  await reached;
  const editorial = agents.get('live-v2-editorial')!;
  team.wake('editorial', 'queued audience interest', true);
  team.poll();
  await vi.advanceTimersByTimeAsync(30000);
  expect(editorial.calls).toEqual([]);
  await expect(team.invoke(editorial.session.id, 'editorial', 'readShow', {})).rejects.toThrow(
    'Unbound role',
  );
  release();
  await starting;
  expect(editorial.calls).toContain('followup');
  expect(team.snapshot().find((r) => r.role === 'editorial')?.ready).toBe(true);
});
it('exposes request failures and backs off until the operator resumes only that role',async()=>{
 vi.useFakeTimers();const {team,agents}=setup();await team.start();const actor=agents.get('live-v2-performer')!;actor.calls=[];
 team.observeEvent(actor.session,{type:'turn/end',data:{reason:{kind:'error',error:{code:'CONTEXT_WINDOW_EXCEEDED'}}}});
 expect(team.snapshot().find(r=>r.role==='performer')?.error).toBe('CONTEXT_WINDOW_EXCEEDED');
 team.poll();await vi.advanceTimersByTimeAsync(1000);expect(actor.calls).toEqual([]);
 await team.setOnline('performer',true);expect(actor.calls).toContain('followup');expect(team.errors()).not.toHaveProperty('performer');
});

it('coalesces ordinary visual updates while the director works and delivers the latest speech outlook on idle',async()=>{
 const {team,agents}=setup();await team.start();const director=agents.get('live-v2-director')!;director.calls=[];director.status='running';team.observeStream(director,{type:'start',attemptId:'visual-busy'});
 const brief=vi.spyOn(team.runtime,'brief');brief.mockReturnValue({epoch:2,speechOutlook:{upcoming:[{partId:'old'}]}});
 for(let i=0;i<8;i++)team.wake('director','主播待讲内容更新');
 expect(director.calls).toEqual([]);
 brief.mockReturnValue({epoch:2,speechOutlook:{upcoming:[{partId:'new'}]}});director.status='idle';team.observeStream(director,{type:'end',attemptId:'visual-busy'});team.poll();
 expect(director.calls).toEqual(['followup']);expect(JSON.stringify(director.messages.at(-1))).toContain('new');expect(JSON.stringify(director.messages.at(-1))).not.toContain('old');
});
it('does not report a live team ready when the performer has no callable role tools',async()=>{
 const {team,agents}=setup(async id=>{if(id==='live-v2-performer')vi.spyOn(agents.get(id)!.ctx.tools,'schemas').mockReturnValue([]);});
 await expect(team.start()).rejects.toThrow(/performer/);expect(team.snapshot()).toEqual([]);
});
