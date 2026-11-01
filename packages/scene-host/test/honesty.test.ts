import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { P2_ACCEPTANCE } from '../src/status';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

async function typescriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await typescriptFiles(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

describe('不把脚手架说成 P2 通过', () => {
  it('验收标记保持失败，README 写明阻塞', async () => {
    expect(P2_ACCEPTANCE.passed).toBe(false);
    const readme = await readFile(join(packageRoot, 'README.md'), 'utf8');
    expect(readme.startsWith(`# ${P2_ACCEPTANCE.headline}`)).toBe(true);
    expect(readme).toContain(P2_ACCEPTANCE.statement);
    for (const blocker of P2_ACCEPTANCE.blockers) expect(readme).toContain(blocker);

    const rootReadme = await readFile(join(repoRoot, 'README.md'), 'utf8');
    expect(rootReadme).toContain('不是 P2 验收');
    expect(rootReadme).toContain(P2_ACCEPTANCE.statement);
  });

  it('源码不导入私有 SDK 或播放器包，测量文件不写阈值', async () => {
    const files = await typescriptFiles(join(packageRoot, 'src'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      expect(text, file).not.toMatch(/@reelmorph/);
      expect(text, file).not.toMatch(/from\s+['"]@remotion/);
      expect(text, file).not.toMatch(/from\s+['"]@hyperframes/);
      expect(text, file).not.toMatch(/p2Accepted:\s*true/);
    }
    const measure = await readFile(join(packageRoot, 'src/measure.ts'), 'utf8');
    expect(measure).not.toMatch(/timeoutMs/);
    expect(measure).not.toMatch(/toleranceMs/);
    expect(measure).not.toMatch(/tolerance:\s*\d+/);

    const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(declared.react).toBeUndefined();
    expect(declared['react-dom']).toBeUndefined();
    expect(declared['@remotion/player']).toBeUndefined();
    expect(declared['@hyperframes/player']).toBeUndefined();
  });
});
