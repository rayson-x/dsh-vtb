/**
 * 把导入好的特效目录读进内存。文件在 assets/graphics/catalog.json，不进仓库。
 * 还没跑导入脚本时当作空目录，16 个短名字照旧能用。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installEffects, type EffectItem } from '../stage/effects';

export async function loadEffects(dir: string): Promise<number> {
  try {
    const text = await readFile(join(dir, 'catalog.json'), 'utf8');
    const json = JSON.parse(text) as { items?: EffectItem[] };
    const next = Array.isArray(json.items) ? json.items : [];
    installEffects(next);
    return next.length;
  } catch {
    installEffects([]);
    return 0;
  }
}
