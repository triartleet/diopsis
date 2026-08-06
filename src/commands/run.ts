import { existsSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../config.ts';
import { platformToken, resolveMatrix } from '../matrix.ts';
import { generateProject } from '../runner/generate.ts';
import { runPlaywright } from '../runner/execute.ts';
import { serveStatic } from '../server.ts';
import { readStoryIndex } from '../story-index.ts';

export interface RunOptions {
  root: string;
  /** Regenerate baselines instead of verifying against them. */
  update?: boolean;
  /** Substring filter on story ids. */
  grep?: string;
  /** Keep the generated Playwright project for inspection. */
  keep?: boolean;
  /** Playwright pass-through arguments. */
  passthrough?: string[];
}

export async function runCommand(options: RunOptions): Promise<number> {
  const { config, filepath } = await loadConfig(options.root);
  const storybookDir = path.resolve(options.root, config.storybookDir);

  if (!existsSync(storybookDir)) {
    process.stderr.write(
      `No Storybook build at ${config.storybookDir}. Build it first, or point ` +
        `storybookDir at the build output.\n`,
    );
    return 1;
  }

  const stories = await readStoryIndex(storybookDir);
  const matrix = resolveMatrix(stories, config);

  const captures = options.grep
    ? matrix.captures.filter((capture) => capture.storyId.includes(options.grep!))
    : matrix.captures;

  for (const warning of matrix.warnings) process.stderr.write(`warning: ${warning}\n`);

  if (captures.length === 0) {
    process.stderr.write('Nothing to capture.\n');
    return 1;
  }

  // Captures, not stories: a viewport matrix multiplies, and every cost that matters —
  // runtime, repository weight, review effort — scales with captures (DECISIONS.md §3).
  process.stdout.write(
    `Diopsis · ${stories.length} stories → ${captures.length} captures · ${platformToken()}\n` +
      `  config    ${filepath ? path.relative(options.root, filepath) : 'defaults (no config file)'}\n` +
      `  storybook ${config.storybookDir}\n` +
      `  baselines ${config.snapshotDir}\n` +
      (matrix.skipped.length ? `  skipped   ${matrix.skipped.length} stories (diopsis:skip)\n` : '') +
      '\n',
  );

  const server = await serveStatic(storybookDir);
  let project;
  try {
    project = await generateProject({
      root: options.root,
      config,
      captures,
      baseUrl: server.url,
    });

    const args = [...(options.passthrough ?? [])];
    if (options.update) args.push('--update-snapshots=all');

    return await runPlaywright({ root: options.root, configPath: project.configPath, args });
  } finally {
    await server.close();
    if (project && !options.keep) await project.cleanup();
  }
}
