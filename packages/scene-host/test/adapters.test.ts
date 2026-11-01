import { describe, expect, it } from 'vitest';
import { HYPERFRAMES_PLAYER_ADAPTER } from '../src/adapters/hyperframes-player';
import { REMOTION_PLAYER_ADAPTER } from '../src/adapters/remotion-player';

async function packageMissing(specifier: string): Promise<boolean> {
  try {
    // 非常量说明符，避免打包器在测试收集阶段就把缺失的包当成解析错误。
    await import(specifier);
    return false;
  } catch {
    return true;
  }
}

describe('真实 adapter 仍阻塞', () => {
  it('Remotion 与 HyperFrames 只有阻塞说明，没有工厂', () => {
    expect(REMOTION_PLAYER_ADAPTER).toMatchObject({
      status: 'blocked',
      packageName: '@remotion/player',
      requiredVersion: '4.0.535',
    });
    expect(HYPERFRAMES_PLAYER_ADAPTER).toMatchObject({
      status: 'blocked',
      requiredVersion: '0.8.212',
    });
    expect('create' in REMOTION_PLAYER_ADAPTER).toBe(false);
    expect('create' in HYPERFRAMES_PLAYER_ADAPTER).toBe(false);
  });

  it('本环境没有私有 SDK，也没有两家 Player 包', async () => {
    expect(await packageMissing('@remotion/player')).toBe(true);
    expect(await packageMissing('@hyperframes/player')).toBe(true);
    expect(await packageMissing('@reelmorph/scene')).toBe(true);
  });

  it.skip('TODO(P2): @remotion/player 4.0.535 连续 100 次 inputProps 更新不重载 iframe、不归零、不重播入场。阻塞：未安装该包，也没有可授权的场景组件。', () => {});

  it.skip('TODO(P2): HyperFrames Player 真实播放与 runtimeData，HTML/GSAP 连续 100 次不重载。阻塞：计划 1.1 写明 Player 未安装。静态变量注入和 seek shim 不算实现。', () => {});

  it.skip('TODO(P2): Chromium 里测首帧可见、离屏备场节流，并冻结就绪超时与漂移容限。阻塞：无浏览器运行，禁止在脚手架里编造这些数字。', () => {});
});
