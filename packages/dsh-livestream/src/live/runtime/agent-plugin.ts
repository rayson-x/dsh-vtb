import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOULS } from '../../dsh/runtime';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { AgentRole } from '../domain/codes';
import { TOOL_PERMISSIONS } from '../domain/permissions';
import { currentTeam } from './link';

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
                : `${tool}：在本岗位权限内提交操作。payload填写JSON对象文本，类型固定为工具名；身份由运行时绑定。从附带即时快照或最新简报取得目标、revision和epoch。错误须据最新状态修正，不盲重试。`,
            parameters: tool==='acknowledgeInput'?{
              directionEpoch:{type:'integer',required:true,description:'即时快照里的当前epoch'},
              inputId:{type:'string',required:true,description:'pendingReplies中的inputId短引用，例如q123；不必抄长eventId'},
              text:{type:'string',required:true,description:'先接住具体内容，通常6–14字；不必先点名、夸赞或复述整题。不是完整答案，不提前说制作已完成'},
              complete:{type:'boolean',description:'只有这个短语本身已足以完整回答时才true；不代表画面已兑现'},
            }:{
              payload: {
                type: 'string',
                description:
                  'JSON对象。读可省略。写入必须directionEpoch。offerSpeech:{directionEpoch,text,responseTo可选:观众eventId,responseStage可选:ack|answer|finish,resumesContinuationIds可选:恢复便签ID数组,partId可选,replacePending可选:{partId:未开口旧句ID,expectedRevision:旧句revision}}；requestProduction:{directionEpoch,task:{id,goal,priority,inputs:[],dependsOn:[]}}；workspaceBuildPreview:{directionEpoch,taskId,taskVersion,source或template或effectPath三选一,props,width,height,durationInFrames}，effectPath使用searchEffects返回的路径直接复用；publishCandidate:{directionEpoch,taskId,assetVersionId,expectedRevision}；prepareScene:{directionEpoch,instanceId,assetVersionId,segmentId,label}；take:{directionEpoch,instanceId,expectedRevision}。其他工具先读简报内toolContracts。命令ID/新实体ID可由运行时分配。',
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
              let payload: Record<string, unknown> = tool==='acknowledgeInput'?{directionEpoch:args.directionEpoch,inputId:args.inputId,text:args.text,complete:args.complete}:{};
              if (tool!=='acknowledgeInput'&&args.payload) {
                const parsed = JSON.parse(String(args.payload));
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                  throw new Error('payload must be an object');
                payload = parsed;
              }
              payload._callId = String(exec?.callId ?? '');
              return JSON.stringify(await team.invoke(exec?.agent?.session?.id, role, tool, payload));
            },
          } as any),
        ),
      `v2 ${role}/${tool}`,
    );
  }
}
