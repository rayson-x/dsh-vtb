import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOULS } from '../../dsh/runtime';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { AgentRole } from '../domain/codes';
import { TOOL_PERMISSIONS } from '../domain/permissions';
import { currentTeam } from './link';

const structured=new Set(['acknowledgeInput','offerSpeech','yieldSpeech','discardContinuation','reviewAudienceProposal','publishEditorialProposal','requestProduction','prepareDirection']);
export function applyRoleAgent(ctx: any, role: AgentRole) {
  if (role === 'performer')
    ctx.effect(
      () => ctx.systemPrompt.variable('soul', () => readFileSync(join(SOULS, 'whale-maid.md'), 'utf8')),
      'v2 performer soul',
    );
  for (const tool of TOOL_PERMISSIONS[role]) {
    ctx.effect(
      () =>
        ctx.tools.register(
          defineTool({
            name: tool,
            description:
              tool==='acknowledgeInput'?'先接住一条优先互动：用一个简短、具体的意群回应观众，不等待完整答案、调研或画面制作。入队不代表已听见；之后仍可分段展开。此工具可让未开口的普通内容让位，保留其他待播接住语句。':tool.startsWith('read') || tool === 'inspectCandidate'
                ? '读取本岗位最新的真实工程简报/候选；不推进制作，不改变演出。'
                : tool==='yieldSpeech'?'仅撤回指定partId的未开口语句，必须给revision；结束本轮不需要调用工具。':tool==='discardContinuation'?'仅明确放弃指定过时便签，必须给revision及原因。':tool==='reviewAudienceProposal'?'编导分类提议：真实画面需求accepted并关联制作/导播；纯口头问答可cancelled，不用伪造场景。不能标presented。':['publishEditorialProposal','requestProduction','prepareDirection'].includes(tool)?'直接按结构化参数填写，不写payload；必填字段缺失会拒绝，不会写入工程。':tool==='offerSpeech'?'用结构化参数提交一段自然台词，不写payload字符串。已有首响则直接给具体回答，答清后finish；回故事省略回答字段。':`${tool}：在本岗位权限内提交操作。payload直接填写JSON对象，类型固定为工具名；身份由运行时绑定。从附带即时快照或最新简报取得目标、revision和epoch。错误须据最新状态修正，不盲重试。`,
            parameters: tool==='acknowledgeInput'?{
              directionEpoch:{type:'integer',required:true,description:'即时快照里的当前epoch'},
              inputId:{type:'string',required:true,description:'pendingReplies中的inputId短引用，例如q123；不必抄长eventId'},
              text:{type:'string',required:true,description:'先接住具体内容，通常6–14字；不必先点名、夸赞或复述整题。不是完整答案，不提前说制作已完成'},
              complete:{type:'boolean',description:'只有这个短语本身已足以完整回答时才true；不代表画面已兑现'},
            }:tool==='publishEditorialProposal'?{
              directionEpoch:{type:'integer',required:true},
              proposal:{type:'object',additionalProperties:false,required:true,properties:{
                id:{type:'string',required:true},segmentIntent:{type:'string',required:true,description:'本段可讲的具体内容'},viewingValue:{type:'string',required:true},participation:{type:'string',required:true},handoff:{type:'string',required:true},minimumMaterials:{type:'array',items:{type:'string'},required:true},alternatives:{type:'array',items:{type:'string'},required:true},
              }},
            }:tool==='requestProduction'?{
              directionEpoch:{type:'integer',required:true},proposalId:{type:'string'},
              task:{type:'object',additionalProperties:false,required:true,properties:{id:{type:'string',required:true},goal:{type:'string',required:true},priority:{type:'number',required:true,description:'high=80 normal=50 low=20'},inputs:{type:'array',items:{type:'string'},required:true},dependsOn:{type:'array',items:{type:'string'},required:true},intendedDirectionId:{type:'string'},deadlineShowTime:{type:'integer'}}},
            }:tool==='prepareDirection'?{
              directionEpoch:{type:'integer',required:true},directionId:{type:'string',required:true},commitment:{type:'string',required:true},coreQuestion:{type:'string',required:true},
            }:tool==='yieldSpeech'?{
              directionEpoch:{type:'integer',required:true},partId:{type:'string',required:true,description:'只撤回这一条尚未开口的语句，不代表结束本轮'},expectedRevision:{type:'integer',required:true},
            }:tool==='discardContinuation'?{
              directionEpoch:{type:'integer',required:true},continuationId:{type:'string',required:true},expectedRevision:{type:'integer',required:true},reason:{type:'string',required:true,description:'确实过时才丢弃，不能为省事清掉未回答问题'},
            }:tool==='reviewAudienceProposal'?{
              directionEpoch:{type:'integer',required:true},proposalId:{type:'string',required:true},expectedRevision:{type:'integer',required:true},status:{type:'string',enum:['accepted','deferred','cancelled'],required:true},
            }:tool==='offerSpeech'?{
              directionEpoch:{type:'integer',required:true,description:'当前epoch'},
              text:{type:'string',required:true,description:'本段自然台词。后续回答通常20–60字，表达一个完整新信息，不为缩短而拆成悬空半句；不重复首响。'},
              responseTo:{type:'string',description:'实际回答的inputId短引用；普通故事台词省略'},
              responseStage:{type:'string',enum:['answer','finish'],description:'通常一个完整短答就用finish；确有后续信息未说才answer。物件/参数请求说清具体方案即口头答清，不等画面完成；普通节目省略'},
              resumesContinuationIds:{type:'array',items:{type:'string'},description:'只列本段实际接续的未完内容便签'},
              partId:{type:'string',description:'可省略，由运行时分配'},
              plannedBeatRef:{type:'string'},
              replacePending:{type:'object',additionalProperties:false,properties:{partId:{type:'string',required:true},expectedRevision:{type:'integer',required:true}},description:'明确替换尚未开口的旧段时填写'},
            }:{
              payload: {
                type: 'json',
                description:
                  '本工具的JSON参数对象，兼容旧JSON字符串；只按最新简报中当前工具的toolContracts填写。读取可省略；写入必须directionEpoch，修改须expectedRevision。不填type或actorId，不调用其他岗位工具。acknowledgeInput、offerSpeech、yieldSpeech等结构化工具不使用payload。',
              },
            },
            output: {
              schema: { type: 'string' },
              render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
            },
            isConcurrencySafe: () => true,
            execute: async (args: any, exec: any) => {
              const team = currentTeam();
              if (!team) throw new Error('V2 runtime not active');
              let payload: Record<string, unknown> = tool==='acknowledgeInput'?{directionEpoch:args.directionEpoch,inputId:args.inputId,text:args.text,complete:args.complete}:structured.has(tool)?Object.fromEntries(Object.entries(args).filter(([,v])=>v!==undefined)):{};
              if (!structured.has(tool)) {
                if(Object.hasOwn(args,'payload')){
                  if(Object.keys(args).some(k=>k!=='payload'))throw Error('Do not mix payload with top-level arguments');
                  const parsed=typeof args.payload==='string'?JSON.parse(args.payload):args.payload;
                  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('payload must be an object');
                  payload={...parsed};
                }else payload={...args};
              }
              payload._callId = String(exec?.callId ?? '');
              const result = await team.invoke(exec?.agent?.session?.id, role, tool, payload);
              // Playback completion or a new viewer wakes the speaker again.
              // Close the accepted speech turn without asking the model to wait.
              if (role === 'performer' && ['offerSpeech','acknowledgeInput'].includes(tool)
                && result && typeof result === 'object' && 'ok' in result && result.ok === true)
                exec.concludeTurn();
              return JSON.stringify(result);
            },
          } as any),
        ),
      `v2 ${role}/${tool}`,
    );
  }
}
