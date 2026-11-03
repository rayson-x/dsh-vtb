/**
 * 把编导席和制作席接到同一份 P5 harness 上。
 * 不开播放器，也不跑模型。
 */

import { EditorialDesk } from './editorial/desk';
import { editorialMandate, productionMandate } from './gate';
import { MemoryAgentHarness } from './harness';
import { ProductionDesk } from './production/desk';
import { CandidateShelf } from './production/shelf';

export function openP6(harness = new MemoryAgentHarness()) {
  const epoch = harness.kernel.epoch();
  const shelf = new CandidateShelf();
  const editorial = new EditorialDesk(harness, editorialMandate(epoch), shelf);
  const production = new ProductionDesk(harness, productionMandate(epoch), shelf);
  return { harness, shelf, editorial, production };
}
