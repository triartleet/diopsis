#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { acceptCommand } from './commands/accept.ts';
import { doctorCommand } from './commands/doctor.ts';
import { initCommand } from './commands/init.ts';
import { reportCommand } from './commands/report.ts';
import { runCommand } from './commands/run.ts';

const USAGE = `diopsis — visual regression for Storybook

Usage
  diopsis init                 scaffold a config, git settings and a CI recipe
  diopsis run                  verify against committed baselines   (default)
  diopsis update               regenerate baselines
  diopsis accept [story-id]    adopt the last run's output as the baseline
  diopsis report               open the last report
  diopsis doctor               audit the setup for what silently breaks a baseline set

Options
  --grep <text>    only stories whose id contains <text>
  --keep           keep the generated Playwright project
  --force          overwrite an existing config (init)
  --lfs            set the baselines up for Git LFS (init)
  --no-stage       accept without staging the result in git
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
      force: { type: 'boolean', default: false },
      lfs: { type: 'boolean', default: false },
      'no-stage': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
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
    case 'accept':
      return acceptCommand({
        root,
        ...(positionals[0] ? { storyId: positionals[0] } : {}),
        noStage: values['no-stage'],
      });
    case 'init':
      return initCommand({ root, force: values.force, lfs: values.lfs });
    case 'doctor':
      return doctorCommand({ root });
    case 'report':
      return reportCommand({ root });
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
