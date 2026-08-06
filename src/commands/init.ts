import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { defaultConfig, findConfigFile, supportsTypeStripping } from '../config.ts';
import { resolveMatrix } from '../matrix.ts';
import { readStoryIndex } from '../story-index.ts';

export interface InitOptions {
  root: string;
  /** Overwrite an existing config. */
  force?: boolean;
  /** Set the baselines up for Git LFS instead of plain binary tracking. */
  lfs?: boolean;
}

/**
 * Bytes per full-page capture, used only before any baseline exists.
 *
 * Stated as an assumption rather than a measurement: the real figure depends entirely on the
 * stories, and `doctor` reports it once there is something to weigh.
 */
const ESTIMATED_BYTES_PER_CAPTURE = 80 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The TypeScript form types itself through an `import type`, which Node's type stripping
 * erases along with the annotation. Nothing is imported at runtime, so the config still loads
 * when the package cannot be resolved from here — under `npx`, or before `npm install` has run.
 */
function configSource(typescript: boolean): string {
  const header = typescript
    ? "import type { UserConfig } from 'diopsis';\n\nexport default {"
    : "/** @type {import('diopsis').UserConfig} */\nexport default {";
  const footer = typescript ? '} satisfies UserConfig;' : '};';

  return `${header}
  storybookDir: '${defaultConfig.storybookDir}',
  snapshotDir: '${defaultConfig.snapshotDir}',

  // Every width multiplies the whole story set. Two widths cost half of what four do,
  // in runtime, repository weight and flake surface alike.
  viewports: { default: [320, 1280] },

  // One image name, read by both baseline generation and the CI job.
  image: '${defaultConfig.image}',

  stabilize: {
    freezeClock: '${defaultConfig.stabilize.freezeClock as string}',
    waitForNetworkIdle: true,
    disableAnimations: true,
  },

  // Regions excluded from comparison. Prefer deleting the annotation over masking:
  // the clock is frozen, so anything that only hid a date no longer needs to.
  mask: ['[data-diopsis-ignore]'],

  compare: { threshold: ${defaultConfig.compare.threshold}, maxDiffPixelRatio: ${defaultConfig.compare.maxDiffPixelRatio} },
${footer}
`;
}

export function gitattributesLines(snapshotDir: string, lfs: boolean): string[] {
  const pattern = `${snapshotDir}/**/*.png`;
  return lfs
    ? [`${pattern} filter=lfs diff=lfs merge=lfs -text`]
    : // Unmergeable on purpose: a rebase must conflict loudly rather than quietly
      // produce a PNG that is half of one baseline and half of another.
      [`${pattern} binary -merge -diff`];
}

async function appendLines(file: string, lines: string[], heading: string): Promise<boolean> {
  const existing = existsSync(file) ? await readFile(file, 'utf8') : '';
  const missing = lines.filter((line) => !existing.includes(line));
  if (missing.length === 0) return false;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  await writeFile(file, `${existing}${prefix}\n# ${heading}\n${missing.join('\n')}\n`, 'utf8');
  return true;
}

export function ciRecipe(image: string, snapshotDir: string): string {
  return `# Verify visual regressions in the same image the baselines were generated in.
# The image below must stay identical to \`image\` in diopsis.config — \`diopsis doctor\`
# fails when they drift apart.
jobs:
  visual:
    image: ${image}
    script:
      - npm ci
      - npm run build-storybook
      - npx diopsis run
    artifacts:
      when: always
      paths:
        - .diopsis/report.html
        - .diopsis/summary.json
        - .diopsis/test-results
# Baselines live in ${snapshotDir}/ and are reviewed in the merge request.
`;
}

export async function initCommand(options: InitOptions): Promise<number> {
  const existing = findConfigFile(options.root);
  if (existing && !options.force) {
    process.stderr.write(
      `${path.basename(existing)} already exists. Re-run with --force to overwrite it.\n`,
    );
    return 1;
  }

  const typescript = supportsTypeStripping();
  const configName = typescript ? 'diopsis.config.ts' : 'diopsis.config.mjs';
  await writeFile(path.join(options.root, configName), configSource(typescript), 'utf8');

  const wroteAttributes = await appendLines(
    path.join(options.root, '.gitattributes'),
    gitattributesLines(defaultConfig.snapshotDir, options.lfs ?? false),
    'Diopsis baselines: binary, and never auto-merged.',
  );
  const wroteIgnore = await appendLines(
    path.join(options.root, '.gitignore'),
    [`${defaultConfig.outputDir}/`],
    'Diopsis run output (the report and its artifacts) is not committed.',
  );

  const lines: string[] = [
    '',
    `Wrote ${configName}`,
    ...(wroteAttributes ? ['Wrote .gitattributes entries for the baselines'] : []),
    ...(wroteIgnore ? [`Wrote .gitignore entry for ${defaultConfig.outputDir}/`] : []),
    '',
  ];

  if (!typescript) {
    lines.push(
      `Node ${process.versions.node} cannot read a TypeScript config, so the JavaScript form`,
      'was written instead. On Node 22.18 or newer, diopsis.config.ts works with no extra setup.',
      '',
    );
  }

  // The cost of the matrix, before it is inherited rather than chosen.
  const storybookDir = path.resolve(options.root, defaultConfig.storybookDir);
  if (existsSync(storybookDir)) {
    try {
      const stories = await readStoryIndex(storybookDir);
      lines.push('Cost of the matrix, for this Storybook:', '');
      lines.push('  widths                     captures    estimated weight');
      for (const widths of [[1280], [320, 1280], [320, 768, 1024, 1280]]) {
        const matrix = resolveMatrix(stories, {
          viewports: { default: widths },
          viewportHeight: defaultConfig.viewportHeight,
        });
        const label = widths.join(', ').padEnd(25);
        const count = String(matrix.captures.length).padStart(8);
        const weight = formatBytes(matrix.captures.length * ESTIMATED_BYTES_PER_CAPTURE);
        lines.push(
          `  ${label}${count}    ${weight}${widths.length === 2 ? '   (configured)' : ''}`,
        );
      }
      lines.push(
        '',
        `  ${stories.length} stories. Weight assumes ${formatBytes(ESTIMATED_BYTES_PER_CAPTURE)} per capture;`,
        '  `diopsis doctor` reports the real figure once baselines exist. Every intentional',
        '  change adds another full set to history, permanently.',
        '',
      );
    } catch {
      lines.push(`Could not read the story index in ${defaultConfig.storybookDir}.`, '');
    }
  } else {
    lines.push(
      `No build at ${defaultConfig.storybookDir} yet, so the capture count could not be`,
      'estimated. Build the Storybook and run `diopsis doctor` to see it.',
      '',
    );
  }

  lines.push(
    'CI recipe:',
    '',
    ...ciRecipe(defaultConfig.image, defaultConfig.snapshotDir)
      .trimEnd()
      .split('\n')
      .map((line) => `  ${line}`),
    '',
    'Next: build your Storybook, then `diopsis update` to generate baselines.',
    '',
  );

  process.stdout.write(lines.join('\n'));
  return 0;
}
