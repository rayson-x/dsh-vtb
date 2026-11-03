import type { StageState, Scene } from './protocol';
import { REGIONS, type Box } from './regions';
/** One target geometry shared by the compositor and the agents' presentation brief. */
export function programmeBox(state: StageState, layout: Scene = state.scene): Box {
 const content=REGIONS[layout].main,avatar=state.canvas.avatar;
 const available=layout==='chat'&&avatar.visible&&avatar.x>content.x+20?Math.min(content.w,avatar.x-content.x-20):content.w;
 const w=Math.min(available,content.h*16/9),h=w*9/16;
 return{x:content.x+(available-w)/2,y:content.y+(content.h-h)/2,w,h};
}
