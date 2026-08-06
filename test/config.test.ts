import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  defaultConfig,
  findConfigFile,
  loadConfig,
  resolveConfig,
  supportsTypeStripping,
} from '../src/config.ts';

const temporaries: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'diopsis-test-'));
  temporaries.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('resolveConfig', () => {
  it('merges stabilize and compare per key rather than wholesale', () => {
    const config = resolveConfig({ stabilize: { freezeClock: false } });
    assert.equal(config.stabilize.freezeClock, false);
    assert.equal(config.stabilize.waitForNetworkIdle, true);
    assert.equal(config.compare.maxDiffPixelRatio, defaultConfig.compare.maxDiffPixelRatio);
  });

  it('replaces viewports wholesale, since a merged matrix is never what was meant', () => {
    const config = resolveConfig({ viewports: { default: [768] } });
    assert.deepEqual(config.viewports, { default: [768] });
  });

  it('defaults every determinism guarantee on', () => {
    const { stabilize } = resolveConfig();
    assert.equal(stabilize.disableAnimations, true);
    assert.equal(stabilize.waitForFonts, true);
    assert.equal(stabilize.waitForImages, true);
    assert.equal(stabilize.waitForLoadingStates, true);
    assert.equal(typeof stabilize.freezeClock, 'string');
  });

  it('ships a non-zero pixel-ratio tolerance so one stray pixel cannot block a pipeline', () => {
    assert.ok(defaultConfig.compare.maxDiffPixelRatio > 0);
  });

  it('recognises only its own ignore attribute', () => {
    assert.deepEqual(defaultConfig.mask, ['[data-diopsis-ignore]']);
  });
});

describe('supportsTypeStripping', () => {
  it('is true from Node 22.18 and on every later major', () => {
    assert.equal(supportsTypeStripping('22.18.0'), true);
    assert.equal(supportsTypeStripping('22.22.3'), true);
    assert.equal(supportsTypeStripping('24.0.0'), true);
  });

  it('is false on runtimes that cannot read a TypeScript config', () => {
    assert.equal(supportsTypeStripping('22.17.9'), false);
    assert.equal(supportsTypeStripping('20.11.0'), false);
    assert.equal(supportsTypeStripping('18.0.0'), false);
  });
});

describe('findConfigFile', () => {
  it('prefers the TypeScript config when several exist', async () => {
    const dir = await scratch();
    await writeFile(path.join(dir, 'diopsis.config.mjs'), 'export default {}');
    await writeFile(path.join(dir, 'diopsis.config.ts'), 'export default {}');
    assert.equal(findConfigFile(dir), path.join(dir, 'diopsis.config.ts'));
  });

  it('returns nothing when there is no config at all', async () => {
    assert.equal(findConfigFile(await scratch()), undefined);
  });
});

describe('loadConfig', () => {
  it('falls back to defaults with no config file present', async () => {
    const loaded = await loadConfig(await scratch());
    assert.equal(loaded.filepath, undefined);
    assert.equal(loaded.config.storybookDir, defaultConfig.storybookDir);
  });

  it('loads a JavaScript config', async () => {
    const dir = await scratch();
    await writeFile(
      path.join(dir, 'diopsis.config.mjs'),
      'export default { storybookDir: "out", viewports: { default: [640] } };',
    );
    const loaded = await loadConfig(dir);
    assert.equal(loaded.config.storybookDir, 'out');
    assert.deepEqual(loaded.config.viewports, { default: [640] });
  });

  it('loads a TypeScript config through Node type stripping', async (t) => {
    if (!supportsTypeStripping()) t.skip('runtime cannot strip types');
    const dir = await scratch();
    await writeFile(
      path.join(dir, 'diopsis.config.ts'),
      'const width: number = 640;\nexport default { viewports: { default: [width] } };\n',
    );
    const loaded = await loadConfig(dir);
    assert.deepEqual(loaded.config.viewports, { default: [640] });
  });

  it('rejects a config that exports no object', async () => {
    const dir = await scratch();
    await writeFile(path.join(dir, 'diopsis.config.mjs'), 'export default 42;');
    await assert.rejects(() => loadConfig(dir), /default export/);
  });
});
