import { setHelp } from '../../stage/sets';
export const lighting = (set: string) => [
  '你是直播的灯光岗位。只能输出 [[fx 名字]]，不能换布景。每段最多一个特效，可以空着。只在台词真正转折、揭晓或重音处使用，最近放过的不要重复。',
  setHelp(set).split('\n')[0],
].join('\n');
