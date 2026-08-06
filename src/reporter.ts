import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

import { renderReport } from './report/html.ts';
import {
  changedStoriesOf,
  classify,
  indexPlanByTitle,
  totalsFor,
  type CaptureArtifacts,
  type CaptureResult,
  type RunSummary,
} from './report/summary.ts';
import type { RunPlan } from './runner/generate.ts';

export interface DiopsisReporterOptions {
  /** Absolute path of the run plan written by the generator. */
  planPath: string;
  /** Absolute path of the directory the report and summary are written to. */
  outputDir: string;
  /** Configured snapshot directory, as written — for display. */
  snapshotDir: string;
  /** Absolute snapshot directory, for locating baselines. */
  snapshotDirAbs: string;
  mode: 'run' | 'update';
  platform: string;
  arch: string;
  /** Fixed timestamp, so a report is reproducible when the run is. */
  createdAt: string;
}

/**
 * Sort the comparator's three images.
 *
 * Classification is by file path, not attachment name: the `-expected`/`-actual`/`-diff`
 * suffix is part of the filename Playwright writes, and the attachment names do not
 * distinguish them — reading the name collapses all three onto one entry.
 */
export function artifactsOf(
  attachments: readonly { name: string; path?: string; contentType: string }[],
  outputDir: string,
): CaptureArtifacts {
  const artifacts: CaptureArtifacts = {};
  for (const attachment of attachments) {
    if (!attachment.path || attachment.contentType !== 'image/png') continue;
    const relative = path.relative(outputDir, attachment.path);
    const base = path.basename(attachment.path);
    if (base.endsWith('-expected.png')) artifacts.expected = relative;
    else if (base.endsWith('-diff.png')) artifacts.diff = relative;
    else artifacts.actual = relative;
  }
  return artifacts;
}

/** Playwright colours its error messages; a JSON file and an HTML report want neither. */
const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI, '');
}

function errorTextOf(result: TestResult): string {
  const parts = result.errors.map((error) => `${error.message ?? ''}\n${error.stack ?? ''}`);
  if (result.status === 'timedOut') parts.push('Test timed out.');
  return stripAnsi(parts.join('\n'));
}

/**
 * Playwright reporter that owns the review surface.
 *
 * A reporter is the smallest stable extension point that sees every result, which is what
 * lets Diopsis delegate the runner and still own the part that is differentiated
 * (DECISIONS.md §2).
 */
export default class DiopsisReporter implements Reporter {
  private readonly options: DiopsisReporterOptions;
  private readonly results = new Map<string, CaptureResult>();
  private plan: RunPlan | undefined;

  constructor(options: DiopsisReporterOptions) {
    this.options = options;
  }

  printsToStdio(): boolean {
    return true;
  }

  /**
   * The baseline is located from the snapshot path rather than read off an attachment.
   * Playwright's "expected" attachment points at the baseline file itself, whose name carries
   * no `-expected` suffix to sort it by — and the baseline is exactly what the report's
   * before-image should be anyway.
   */
  private artifactsFor(snapshotPath: string, result: TestResult): CaptureArtifacts {
    const artifacts = artifactsOf(result.attachments, this.options.outputDir);
    if (!artifacts.expected) {
      const baseline = path.join(this.options.snapshotDirAbs, snapshotPath);
      if (existsSync(baseline)) {
        artifacts.expected = path.relative(this.options.outputDir, baseline);
      }
    }
    return artifacts;
  }

  async onBegin(_config: FullConfig): Promise<void> {
    this.plan = JSON.parse(await readFile(this.options.planPath, 'utf8')) as RunPlan;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const planned = this.plan ? indexPlanByTitle(this.plan.captures).get(test.title) : undefined;
    if (!planned) return;

    const verdict = classify({
      passed: result.status === 'passed',
      errorText: errorTextOf(result),
      timedOut: result.status === 'timedOut',
    });

    const errorText = errorTextOf(result).trim();
    this.results.set(planned.title, {
      storyId: planned.storyId,
      storyTitle: planned.storyTitle,
      storyName: planned.storyName,
      width: planned.width,
      status: verdict.status,
      snapshotPath: planned.snapshotPath,
      ...(verdict.diffPixels === undefined ? {} : { diffPixels: verdict.diffPixels }),
      ...(verdict.diffRatio === undefined ? {} : { diffRatio: verdict.diffRatio }),
      ...(verdict.status === 'unchanged' || !errorText
        ? {}
        : { error: errorText.split('\n').slice(0, 4).join('\n') }),
      artifacts: this.artifactsFor(planned.snapshotPath, result),
    });
  }

  async onEnd(_result: FullResult): Promise<void> {
    // Report in plan order, so the list is stable between runs rather than finish-order.
    const ordered = (this.plan?.captures ?? [])
      .map((capture) => this.results.get(capture.title))
      .filter((capture): capture is CaptureResult => capture !== undefined);

    const summary: RunSummary = {
      diopsis: 1,
      createdAt: this.options.createdAt,
      platform: this.options.platform,
      arch: this.options.arch,
      mode: this.options.mode,
      snapshotDir: this.options.snapshotDir,
      totals: totalsFor(ordered),
      changedStories: changedStoriesOf(ordered),
      captures: ordered,
    };

    await mkdir(this.options.outputDir, { recursive: true });
    const summaryPath = path.join(this.options.outputDir, 'summary.json');
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

    const reportPath = path.join(this.options.outputDir, 'report.html');
    await writeFile(reportPath, await renderReport(summary, this.options.outputDir), 'utf8');

    const { totals } = summary;
    const lines = [
      '',
      `Diopsis · ${totals.captures} captures across ${totals.stories} stories · ${summary.platform}-${summary.arch}`,
      `  unchanged ${totals.unchanged}` +
        (totals.changed ? `   changed ${totals.changed}` : '') +
        (totals.new ? `   new ${totals.new}` : '') +
        (totals.renderFailed ? `   render failed ${totals.renderFailed}` : '') +
        (totals.failed ? `   failed ${totals.failed}` : ''),
      '',
      `  report  ${reportPath}`,
      `  summary ${summaryPath}`,
    ];

    if (summary.changedStories.length > 0 && summary.mode === 'run') {
      lines.push('', '  Accept this run as the new baseline:', '    npx diopsis accept');
    }
    lines.push('');
    process.stdout.write(lines.join('\n'));
  }
}
