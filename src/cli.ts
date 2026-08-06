#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { runCommand } from './commands/run.ts';

const USAGE = `diopsis — visual regression for Storybook

Usage
  diopsis run [options]        verify against committed baselines   (default)
  diopsis update [options]     regenerate baselines

Options
  --grep <text>    only stories whose id contains <text>
  --keep           keep the generated Playwright project
  --help           show this message
`;

export async function main(argv: string[]): Promise<number> {
  const first = argv[0];
  const command = first && !first.startsWith('-') ? first : 'run';
  const rest = first && !first.startsWith('-') ? argv.slice(1) : argv;

  const { values, positionals } = parseArgs({
    args: rest,
    options: {
      grep: { type: 'string' },
      keep: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    // Anything after `--` is Playwright's.
    strict: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const root = process.cwd();

  switch (command) {
    case 'run':
    case 'update':
      return runCommand({
        root,
        update: command === 'update',
        ...(values.grep ? { grep: values.grep } : {}),
        keep: values.keep,
        passthrough: positionals,
      });
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

const entry = process.argv[1];
if (entry && pathToFileURL(realpathSync(entry)).href === import.meta.url) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
