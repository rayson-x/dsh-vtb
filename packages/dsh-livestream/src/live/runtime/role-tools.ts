import type{AgentRole}from'../domain/codes';
import{TOOL_PERMISSIONS}from'../domain/permissions';
export interface RoleToolScope {
  schemas(scope:object):Array<{name:string}>;
  restrict(filter:{allow:string[]}):()=>void;
}
/** Preset tools are ancestors of the Agent scope; restrict only after preset assembly. */
export function restrictRoleTools(agent:{ctx:{tools:RoleToolScope}},role:AgentRole){
  const tools=agent.ctx?.tools;
  if(!tools)throw Error('Live agent tool registry unavailable');
  const required=[...TOOL_PERMISSIONS[role]],allowed=new Set<string>(required);
  if(role==='editorial'||role==='production'){allowed.add('web_search');allowed.add('web_fetch');}
  const before=tools.schemas(agent).map(t=>t.name);
  if(required.some(name=>!before.includes(name)))throw Error('Live role tools missing after preset assembly');
  const dispose=tools.restrict({allow:before.filter(name=>allowed.has(name))});
  const names=tools.schemas(agent).map(t=>t.name);
  if(required.some(name=>!names.includes(name))||names.some(name=>!allowed.has(name))){dispose();throw Error('Live role tool isolation failed');}
  return{names,dispose};
}
