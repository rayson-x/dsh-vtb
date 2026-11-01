/**
 * 角色读权限与工具边界。计划 §3.4–§3.5。
 * 工具名是待实现的端口，不是现有 DSH 或 SDK 的原生 API。
 */

import type { AgentRole, Role } from './codes';
import type { ShowCommand } from './commands';

export const TOOL_PERMISSIONS = {
  editorial: [
    'readShow',
    'readAudienceSummary',
    'publishEditorialProposal',
    'requestProduction',
    'prepareDirection',
  ],
  director: [
    'readProgramme',
    'inspectCandidate',
    'prepareScene',
    'editFutureTimeline',
    'updateInputs',
    'take',
    'sendPerformerCue',
  ],
  performer: [
    'readLiveBrief',
    'offerSpeech',
    'yieldSpeech',
    'requestInteraction',
    'requestProduction',
  ],
  production: [
    'readTask',
    'searchSdk',
    'searchEffects',
    'workspaceBuildPreview',
    'publishCandidate',
    'reportProgress',
  ],
} as const satisfies Record<AgentRole, readonly string[]>;

export type AgentToolName = (typeof TOOL_PERMISSIONS)[AgentRole][number];

/**
 * 计划 §3.5 权限边界，写成可检查的拒绝项。
 * prepareDirection 只能建候选；编导没有 take、切换授权签发、播放中止。
 * 制作池没有在播控制。主播不直接改视觉轨。
 */
export const TOOL_BOUNDARIES = {
  editorial: {
    prepareDirectionCreatesCandidateOnly: true,
    deny: ['take', 'issueSwitchAuthorization', 'abortPlayback'],
  },
  director: {
    writesGoThroughRuntime: true,
    canConsumeValidSwitchAuthorization: true,
    deny: ['issueSwitchAuthorization'],
  },
  performer: {
    ordinarySpeechNeedsDirectorApproval: false,
    deny: ['loadSceneCode', 'overwriteVisualTrack', 'take'],
  },
  production: {
    publishCandidateIsNotTake: true,
    deny: ['take', 'abortPlayback', 'updateInputs'],
  },
} as const;

/** 域命令使用的工具槽。Agent 工具族之外的是 Runtime / 方向控制器内部端口。 */
export type DomainTool =
  | AgentToolName
  | 'reviewAudienceProposal'
  | 'issueSwitchAuthorization'
  | 'consumeSwitchAuthorization'
  | 'abortPlayback'
  | 'ingestAudience'
  | 'scheduleSpeech'
  | 'recordPlayback'
  | 'measureReadiness'
  | 'manageSceneLifecycle'
  | 'setEditorialPresence'
  | 'reconnect'
  | 'cancelGeneration'
  | 'noteProductionTimeout'
  | 'attemptPreviewAudio'
  | 'attemptVoiceDriftCompensation';

const AGENT_TOOL_SET: Record<AgentRole, ReadonlySet<string>> = {
  editorial: new Set(TOOL_PERMISSIONS.editorial),
  director: new Set(TOOL_PERMISSIONS.director),
  performer: new Set(TOOL_PERMISSIONS.performer),
  production: new Set(TOOL_PERMISSIONS.production),
};

export function roleAllows(role: Role, tool: DomainTool): boolean {
  if (role === 'editorial' || role === 'director' || role === 'performer' || role === 'production') {
    if (AGENT_TOOL_SET[role].has(tool)) return true;
  }
  switch (tool) {
    case 'reviewAudienceProposal':
      return role === 'editorial' || role === 'runtime';
    case 'issueSwitchAuthorization':
      return role === 'master' || role === 'directionController';
    case 'consumeSwitchAuthorization':
      return role === 'master' || role === 'directionController' || role === 'director';
    case 'abortPlayback':
      return role === 'master' || role === 'directionController' || role === 'runtime';
    case 'ingestAudience':
      return role === 'input' || role === 'runtime';
    case 'scheduleSpeech':
    case 'recordPlayback':
    case 'measureReadiness':
    case 'reconnect':
      return role === 'runtime';
    case 'manageSceneLifecycle':
      return role === 'director' || role === 'runtime';
    case 'setEditorialPresence':
    case 'cancelGeneration':
      return role === 'runtime';
    case 'noteProductionTimeout':
      return role === 'editorial' || role === 'production' || role === 'runtime';
    case 'attemptPreviewAudio':
    case 'attemptVoiceDriftCompensation':
      return role === 'runtime' || role === 'director';
    default:
      return false;
  }
}

export function boundaryDenied(role: AgentRole, action: string): boolean {
  return (TOOL_BOUNDARIES[role].deny as readonly string[]).includes(action);
}

/** 命令落到哪个工具槽。读模型走 read()，不在这里。 */
export function toolFor(command: ShowCommand): DomainTool {
  switch (command.type) {
    case 'ingestAudience':
      return 'ingestAudience';
    case 'setProposalStatus':
      return 'reviewAudienceProposal';
    case 'publishEditorialProposal':
      return 'publishEditorialProposal';
    case 'requestProduction':
      return 'requestProduction';
    case 'cancelTask':
      return 'requestProduction';
    case 'publishCandidate':
      return 'publishCandidate';
    case 'reportProgress':
      return 'reportProgress';
    case 'noteProductionTimeout':
      return 'noteProductionTimeout';
    case 'prepareDirection':
      return 'prepareDirection';
    case 'issueSwitchAuthorization':
      return 'issueSwitchAuthorization';
    case 'switchDirection':
      return 'consumeSwitchAuthorization';
    case 'requestInteraction':
      return 'requestInteraction';
    case 'offerSpeech':
      return 'offerSpeech';
    case 'editSpeech':
    case 'yieldSpeech':
      return 'yieldSpeech';
    case 'acceptSpeech':
    case 'queueSpeech':
    case 'startSpeech':
      return 'scheduleSpeech';
    case 'receiptSpeech':
    case 'recordPlayback':
      return 'recordPlayback';
    case 'abortSpeech':
      return 'abortPlayback';
    case 'editFutureTimeline':
    case 'bindCue':
    case 'editCue':
      return 'editFutureTimeline';
    case 'dispatchCue':
      return 'scheduleSpeech';
    case 'prepareScene':
      return 'prepareScene';
    case 'noteReadiness':
    case 'noteSdkSignal':
    case 'notePromiseResolved':
      return 'measureReadiness';
    case 'take':
      return 'take';
    case 'updateInputs':
      return 'updateInputs';
    case 'holdScene':
    case 'resumeScene':
    case 'retireScene':
    case 'disposeScene':
      return 'manageSceneLifecycle';
    case 'sendPerformerCue':
      return 'sendPerformerCue';
    case 'previewAudio':
      return 'attemptPreviewAudio';
    case 'compensateVoiceForDrift':
      return 'attemptVoiceDriftCompensation';
    case 'cancelGeneration':
      return 'cancelGeneration';
    case 'setEditorialPresence':
      return 'setEditorialPresence';
    case 'reconnect':
      return 'reconnect';
    default: {
      const neverCommand: never = command;
      return neverCommand;
    }
  }
}
