import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { P4_ACCEPTANCE } from '../src/status';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

async function typescriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await typescriptFiles(full)));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

describe('不把脚手架说成 P4 通过', () => {
  it('验收标记保持失败，两条路径和代表认证都不勾', async () => {
    expect(P4_ACCEPTANCE.passed).toBe(false);
    expect(P4_ACCEPTANCE.checklist.reusePathAvailable).toBe(false);
    expect(P4_ACCEPTANCE.checklist.authorPathAvailable).toBe(false);
    expect(P4_ACCEPTANCE.checklist.representativeComponentsCertified).toBe(false);
    const readme = await readFile(join(packageRoot, 'README.md'), 'utf8');
    expect(readme).toContain(`# ${P4_ACCEPTANCE.headline}`);
    expect(readme).toContain(P4_ACCEPTANCE.statement);
    expect(readme).toContain('候选 ready 不是认证，也不是 take');
    for (const blocker of P4_ACCEPTANCE.blockers) expect(readme).toContain(blocker);


  });

  it('源码不导入私有 SDK、播放器或 scene-host', async () => {
    const files = await typescriptFiles(join(packageRoot, 'src'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      expect(text, file).not.toMatch(/from\s+['"]@reelmorph/);
      expect(text, file).not.toMatch(/from\s+['"]@remotion/);
      expect(text, file).not.toMatch(/from\s+['"]@hyperframes/);
      expect(text, file).not.toMatch(/from\s+['"][^'"]*scene-host/);
      expect(text, file).not.toMatch(/require\(/);
      expect(text, file).not.toMatch(/passed:\s*true/);
    }
    const pkg = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(declared.react).toBeUndefined();
    expect(declared['react-dom']).toBeUndefined();
    expect(declared['@remotion/player']).toBeUndefined();
    expect(declared['@hyperframes/player']).toBeUndefined();
    for (const name of Object.keys(declared)) expect(name.startsWith('@reelmorph/')).toBe(false);
  });
});
