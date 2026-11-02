import type { DshLiveTeam } from './dsh-team';
let team: DshLiveTeam | undefined;
export function currentTeam() { return team; }
export function bindTeam(value: DshLiveTeam | undefined) { team = value; }
