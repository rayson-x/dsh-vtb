/**
 * 迁移清单。计划 §11：先复用角色资源和已有素材引用，不从头搬别的项目。
 * 这里只保存引用 ID。切换控制路径不会删除、改写或发布这些资产。
 * 本骨架不做破坏性数据迁移，也不自动发布旧未提交草稿。
 */

/** 与 page/live2d/logic.ts 的 LIVE2D_CHARACTER 相同。清单不搬模型文件。 */
export const FIXTURE_CHARACTER_ID = 'deepseek-live2d';

export interface CharacterResourceRef {
  characterId: string;
  resourceRef: string;
}

export interface MigrationInventory {
  stageId: string;
  characters: CharacterResourceRef[];
  /** 素材引用 ID。切换只核对这份列表还在，不读取文件内容。 */
  assetRefIds: string[];
}

export function fixtureInventory(stageId: string): MigrationInventory {
  return {
    stageId,
    characters: [
      {
        characterId: FIXTURE_CHARACTER_ID,
        resourceRef: `/characters/${FIXTURE_CHARACTER_ID}/character.json`,
      },
    ],
    assetRefIds: ['mat-opening-card', 'mat-blackboard-board', 'mat-voice-bed'],
  };
}

export function cloneInventory(inventory: MigrationInventory): MigrationInventory {
  return {
    stageId: inventory.stageId,
    characters: inventory.characters.map((item) => ({
      characterId: item.characterId,
      resourceRef: item.resourceRef,
    })),
    assetRefIds: [...inventory.assetRefIds],
  };
}

/** 稳定指纹。角色和素材的顺序也算，避免悄悄重排后还声称没变。 */
export function inventoryFingerprint(inventory: MigrationInventory): string {
  const characters = inventory.characters.map((item) => `${item.characterId}@${item.resourceRef}`).join('|');
  return `${inventory.stageId}#${characters}#${inventory.assetRefIds.join('|')}`;
}

export function assertInventoryShape(inventory: MigrationInventory): void {
  if (!inventory.stageId.trim()) throw new Error('舞台编号是空的');
  const characters = new Set<string>();
  for (const item of inventory.characters) {
    if (!item.characterId.trim() || !item.resourceRef.trim()) throw new Error('角色资源引用不完整');
    if (characters.has(item.characterId)) throw new Error(`角色 ${item.characterId} 重复`);
    characters.add(item.characterId);
  }
  const assets = new Set<string>();
  for (const id of inventory.assetRefIds) {
    if (!id.trim()) throw new Error('素材引用 ID 是空的');
    if (assets.has(id)) throw new Error(`素材引用 ${id} 重复`);
    assets.add(id);
  }
}

/**
 * 破坏性迁移入口。本 PR 拒绝它。
 * removed 固定为空：调用方不能靠这个函数删掉角色或素材。
 */
export function refuseDestructiveMigration(): {
  ok: false;
  code: 'destructive-migration-refused';
  removedCharacterIds: string[];
  removedAssetRefIds: string[];
} {
  return {
    ok: false,
    code: 'destructive-migration-refused',
    removedCharacterIds: [],
    removedAssetRefIds: [],
  };
}
