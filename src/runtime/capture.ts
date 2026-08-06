import type { Page } from '@playwright/test';
import type { StabilizeOptions } from '../config.ts';

/** Storybook 7+ renders into `#storybook-root`; v6 used `#root`. */
export const RENDER_ROOTS = ['#storybook-root', '#root'] as const;

/** Markers that mean "this page is still loading" — waited out before capture. */
export const LOADING_SELECTORS = [
  '[aria-busy="true"]',
  '[data-diopsis-loading]',
  '[role="progressbar"]',
] as const;

/** `{base}/iframe.html?viewMode=story&id={storyId}` — the preview, without the manager UI. */
export function storyUrlFor(baseUrl: string, storyId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/iframe.html?viewMode=story&id=${encodeURIComponent(storyId)}`;
}

export class StoryRenderError extends Error {
  detail: string;

  constructor(message: string, detail: string) {
    super(message);
    this.name = 'StoryRenderError';
    this.detail = detail;
  }
}

/**
 * Everything that must be in place *before* the story navigates.
 *
 * The clock is fixed rather than masked: a mask hides content from review and still fails the
 * diff when its bounding box moves, so time is made deterministic instead (DECISIONS.md §3).
 * `page.clock` is a property, not a method.
 */
export async function preparePage(page: Page, options: StabilizeOptions): Promise<void> {
  if (options.freezeClock) {
    await page.clock.setFixedTime(new Date(options.freezeClock));
  }
  if (options.disableAnimations) {
    // Playwright's own `animations: 'disabled'` covers the capture itself; this additionally
    // keeps scroll anchoring and caret blink from moving between the wait and the shutter.
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          transition-delay: 0s !important;
          transition-duration: 0s !important;
          animation-delay: -0.0001s !important;
          animation-duration: 0s !important;
          animation-iteration-count: 1 !important;
          caret-color: transparent !important;
          scroll-behavior: auto !important;
        }
      `,
    }).catch(() => {
      // No document yet on a blank page; the same style is re-applied after navigation.
    });
  }
}

function deadline(timeout: number): { left(): number } {
  const start = Date.now();
  return { left: () => Math.max(0, timeout - (Date.now() - start)) };
}

/**
 * Wait until the story is actually painted.
 *
 * "The root exists" is not enough — the root exists while the skeleton is on screen, and a
 * capture taken there is a false baseline that only fails once the mock resolves faster.
 */
export async function stabilize(page: Page, options: StabilizeOptions): Promise<void> {
  const budget = deadline(options.settleTimeout);

  const error = page.locator('#error-message');
  if (await error.isVisible().catch(() => false)) {
    throw new StoryRenderError('Story failed to render', (await error.innerText()).trim());
  }

  // The render root must have a laid-out child, not merely be present.
  await page.waitForFunction(
    (roots: readonly string[]) => {
      for (const selector of roots) {
        const root = document.querySelector(selector);
        if (!root) continue;
        for (const child of Array.from(root.children)) {
          const rect = child.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) return true;
        }
      }
      return false;
    },
    RENDER_ROOTS,
    { timeout: budget.left() || 1 },
  );

  if (options.waitForNetworkIdle) {
    await page.waitForLoadState('networkidle', { timeout: budget.left() || 1 }).catch(() => {
      // A story holding a long-poll open should slow a run, not fail it.
    });
  }

  if (options.waitForLoadingStates) {
    const selector = LOADING_SELECTORS.join(', ');
    await page
      .waitForFunction(
        (sel: string) =>
          Array.from(document.querySelectorAll(sel)).every((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width === 0 && rect.height === 0;
          }),
        selector,
        { timeout: budget.left() || 1 },
      )
      .catch(() => {
        // A permanently-busy widget is a story-authoring matter, not a run failure.
      });
  }

  if (options.waitForFonts) {
    await page.evaluate(() => document.fonts.ready.then(() => undefined)).catch(() => undefined);
  }

  if (options.waitForImages) {
    await page
      .waitForFunction(
        () =>
          Array.from(document.images).every((img) => img.complete && img.naturalWidth > 0),
        undefined,
        { timeout: budget.left() || 1 },
      )
      .catch(() => undefined);
  }

  // One more frame, so anything scheduled by the waits above has painted.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

/** Navigate to a story and leave the page ready to be photographed. */
export async function openStory(
  page: Page,
  url: string,
  options: StabilizeOptions,
): Promise<void> {
  await preparePage(page, options);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Re-apply, because the pre-navigation style tag does not survive the document swap.
  await preparePage(page, options);
  await stabilize(page, options);
}
