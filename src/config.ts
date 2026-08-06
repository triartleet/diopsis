import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Stabilization defaults. Every one of these is on by default: a guarantee that has to be
 * switched on is a guarantee most suites never get (DECISIONS.md §3).
 */
export interface StabilizeOptions {
  /** Fixed wall-clock time, ISO-8601. `false` leaves the clock alone. */
  freezeClock: string | false;
  /** Wait for the network to go idle before capturing. */
  waitForNetworkIdle: boolean;
  /** Zero out CSS animations, transitions and scroll behaviour. */
  disableAnimations: boolean;
  /** Wait for `document.fonts.ready`. */
  waitForFonts: boolean;
  /** Wait for every `<img>` to finish decoding. */
  waitForImages: boolean;
  /** Wait for common loading-state markers to disappear. */
  waitForLoadingStates: boolean;
  /** Ceiling, in ms, for the whole stabilization sequence. */
  settleTimeout: number;
}

export interface CompareOptions {
  /** Per-pixel colour distance tolerance, 0–1. */
  threshold: number;
  /** Share of differing pixels tolerated before a capture counts as changed. */
  maxDiffPixelRatio: number;
}

export interface DiopsisConfig {
  /** Directory holding the built static Storybook. */
  storybookDir: string;
  /** Directory the baselines are committed to. */
  snapshotDir: string;
  /**
   * Named sets of viewport widths. `default` applies to every story that carries no
   * `diopsis:` tag; other names are selected per story by a `diopsis:<name>` tag.
   */
  viewports: Record<string, number[]>;
  /** Viewport height. Captures are full-page, so this sets the fold, not the crop. */
  viewportHeight: number;
  /** Capture the whole scrollable page rather than the viewport. */
  fullPage: boolean;
  /** The one image name that both baseline generation and CI verification read. */
  image: string;
  stabilize: StabilizeOptions;
  /** Selectors painted over before comparison. */
  mask: string[];
  compare: CompareOptions;
  /** `'all'` in v1; `'auto'` (change-aware capture) lands in v2 — DECISIONS.md §4. */
  affected: 'all' | 'auto';
  /** Per-capture timeout in ms. */
  timeout: number;
  /** Parallel workers. Left to Playwright's default when unset. */
  workers?: number;
  /** Where the report and summary are written. */
  outputDir: string;
}

export type UserConfig = {
  [K in keyof DiopsisConfig]?: K extends 'stabilize'
    ? Partial<StabilizeOptions>
    : K extends 'compare'
      ? Partial<CompareOptions>
      : DiopsisConfig[K];
};

export const defaultConfig: DiopsisConfig = {
  storybookDir: 'storybook-static',
  snapshotDir: '__screenshots__',
  viewports: { default: [320, 1280] },
  viewportHeight: 900,
  fullPage: true,
  image: 'mcr.microsoft.com/playwright:v1.62.1-jammy',
  stabilize: {
    freezeClock: '2026-01-15T12:00:00Z',
    waitForNetworkIdle: true,
    disableAnimations: true,
    waitForFonts: true,
    waitForImages: true,
    waitForLoadingStates: true,
    settleTimeout: 15_000,
  },
  mask: ['[data-diopsis-ignore]'],
  compare: { threshold: 0.2, maxDiffPixelRatio: 0.001 },
  affected: 'all',
  timeout: 30_000,
  outputDir: '.diopsis',
};

/** Identity helper that gives a config file full type checking and completion. */
export function defineConfig(config: UserConfig): UserConfig {
  return config;
}

export function resolveConfig(user: UserConfig = {}): DiopsisConfig {
  return {
    ...defaultConfig,
    ...user,
    viewports: user.viewports ?? defaultConfig.viewports,
    stabilize: { ...defaultConfig.stabilize, ...user.stabilize },
    compare: { ...defaultConfig.compare, ...user.compare },
  };
}

/** Config file names, in discovery order. */
export const CONFIG_FILENAMES = [
  'diopsis.config.ts',
  'diopsis.config.mts',
  'diopsis.config.mjs',
  'diopsis.config.js',
] as const;

export function findConfigFile(root: string): string | undefined {
  for (const name of CONFIG_FILENAMES) {
    const candidate = path.join(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * TypeScript config files are loaded by Node's own type stripping, which is unflagged from
 * Node 22.18. There is no bundler and no transpile dependency, so on older runtimes the
 * `.ts` form genuinely cannot be read and `init` scaffolds `.mjs` instead.
 */
export function supportsTypeStripping(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split('.').map((n) => Number.parseInt(n, 10));
  if (major >= 23) return true;
  return major === 22 && minor >= 18;
}

export interface LoadedConfig {
  config: DiopsisConfig;
  /** Absolute path of the file the config came from, or undefined if defaults were used. */
  filepath?: string;
  root: string;
}

export async function loadConfig(root: string = process.cwd()): Promise<LoadedConfig> {
  const filepath = findConfigFile(root);
  if (!filepath) return { config: resolveConfig(), root };

  if (filepath.endsWith('.ts') || filepath.endsWith('.mts')) {
    if (!supportsTypeStripping()) {
      throw new Error(
        `Cannot read ${path.basename(filepath)} on Node ${process.versions.node}: ` +
          'a TypeScript config is loaded by Node\'s built-in type stripping, which needs ' +
          'Node 22.18 or newer. Either upgrade Node, or rename the config to ' +
          'diopsis.config.mjs (the same object, without the type annotations).',
      );
    }
  }

  const module = (await import(pathToFileURL(filepath).href)) as { default?: UserConfig };
  const user = module.default;
  if (!user || typeof user !== 'object') {
    throw new Error(`${path.basename(filepath)} must export a config object as its default export.`);
  }
  return { config: resolveConfig(user), filepath, root };
}
