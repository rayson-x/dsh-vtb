import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {SOULS} from '../../dsh/runtime';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { AgentRole } from '../domain/codes';
import { TOOL_PERMISSIONS } from '../domain/permissions';
import { currentTeam } from './link';

export function applyRoleAgent(ctx: any, role: AgentRole) {
  if(role==='performer')ctx.effect(()=>ctx.systemPrompt.variable('soul',()=>readFileSync(join(SOULS,'whale-maid.md'),'utf8')),'v2 performer soul');
  for (const tool of TOOL_PERMISSIONS[role]) {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: tool,
      description: tool.startsWith('read') || tool === 'inspectCandidate' ? '读取本岗位最新的真实工程简报/候选；不推进制作，不改变演出。'
        : `${tool}：在本岗位权限内提交操作。payload填写JSON对象文本，类型固定为工具名；身份由运行时绑定。先读简报取得目标、revision和epoch。错误须据最新状态修正，不盲重试。`,
      parameters: { payload: { type: 'string', description: 'JSON对象。读可省略。写入必须directionEpoch。offerSpeech:{directionEpoch,text,partId可选}；requestProduction:{directionEpoch,task:{id,goal,priority,inputs:[],dependsOn:[]}}；workspaceBuildPreview:{directionEpoch,taskId,taskVersion,source,props,width,height,durationInFrames}；publishCandidate:{directionEpoch,taskId,assetVersionId,expectedRevision}；prepareScene:{directionEpoch,instanceId,assetVersionId,segmentId,label}；take:{directionEpoch,instanceId,expectedRevision}。其他工具先读简报内toolContracts。命令ID/新实体ID可由运行时分配。' } },
      output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
      isConcurrencySafe: () => true,
      execute: async (args: any, exec: any) => {
        const team = currentTeam(); if (!team) throw new Error('V2 runtime not active');
        let payload: Record<string, unknown> = {};
        if (args.payload) {
          const parsed = JSON.parse(String(args.payload));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('payload must be an object');
          payload = parsed;
        }
        payload._callId = String(exec?.callId ?? '');
        return JSON.stringify(await team.invoke(exec?.agent?.session?.id, role, tool, payload));
      },
    } as any)), `v2 ${role}/${tool}`);
  }
}
