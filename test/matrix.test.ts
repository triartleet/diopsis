import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { platformToken, resolveMatrix, snapshotPathFor, widthsForStory } from '../src/matrix.ts';
import type { StoryEntry } from '../src/story-index.ts';

const viewports = { default: [320, 1280], mobile: [320, 480] };

function story(id: string, tags: string[] = []): StoryEntry {
  return { id, name: id, title: 'T', tags };
}

describe('platformToken', () => {
  it('joins platform and architecture', () => {
    assert.equal(platformToken('linux', 'x64'), 'linux-x64');
    assert.equal(platformToken('darwin', 'arm64'), 'darwin-arm64');
  });

  it('is what keeps a local run from overwriting the set CI reads', () => {
    assert.notEqual(
      snapshotPathFor('a--one', 320, platformToken('darwin', 'arm64')),
      snapshotPathFor('a--one', 320, platformToken('linux', 'x64')),
    );
  });
});

describe('snapshotPathFor', () => {
  it('puts the width and the platform in the filename', () => {
    assert.equal(snapshotPathFor('a--one', 320, 'linux-x64'), 'a--one/320w-linux-x64.png');
  });

  it('cannot be talked out of its directory', () => {
    assert.equal(
      snapshotPathFor('../../etc/passwd', 320, 'linux-x64'),
      '.._.._etc_passwd/320w-linux-x64.png',
    );
  });
});

describe('widthsForStory', () => {
  it('uses the default set when the story carries no directive', () => {
    assert.deepEqual(widthsForStory(story('a--one'), viewports).widths, [320, 1280]);
  });

  it('accepts a literal width', () => {
    assert.deepEqual(widthsForStory(story('a--one', ['diopsis:1280']), viewports).widths, [1280]);
  });

  it('accepts the name of a viewport set', () => {
    assert.deepEqual(widthsForStory(story('a--one', ['diopsis:mobile']), viewports).widths, [320, 480]);
  });

  it('unions several directives and sorts them', () => {
    const result = widthsForStory(story('a--one', ['diopsis:1280', 'diopsis:mobile']), viewports);
    assert.deepEqual(result.widths, [320, 480, 1280]);
  });

  it('honours diopsis:skip', () => {
    const result = widthsForStory(story('a--one', ['diopsis:skip']), viewports);
    assert.equal(result.skip, true);
    assert.deepEqual(result.widths, []);
  });

  it('warns about a directive that names nothing, and still captures', () => {
    const result = widthsForStory(story('a--one', ['diopsis:tablet']), viewports);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? '', /diopsis:tablet/);
    // Falling back to the default set is the safe answer: skipping would hide a story silently.
    assert.deepEqual(result.widths, [320, 1280]);
  });

  it('ignores tags that are not directives', () => {
    assert.deepEqual(widthsForStory(story('a--one', ['dev', 'test']), viewports).widths, [320, 1280]);
  });
});

describe('resolveMatrix', () => {
  const stories = [
    story('a--one'),
    story('b--wide', ['diopsis:1280']),
    story('c--gone', ['diopsis:skip']),
  ];
  const matrix = resolveMatrix(stories, { viewports, viewportHeight: 900 }, 'linux-x64');

  it('counts captures, not stories', () => {
    assert.equal(stories.length, 3);
    assert.equal(matrix.captures.length, 3); // 2 + 1 + 0
  });

  it('reports what it skipped rather than dropping it quietly', () => {
    assert.deepEqual(matrix.skipped, ['c--gone']);
  });

  it('returns the full set as plain data, so a v2 filter is all that is needed', () => {
    assert.deepEqual(
      matrix.captures.map((c) => c.snapshotPath),
      ['a--one/320w-linux-x64.png', 'a--one/1280w-linux-x64.png', 'b--wide/1280w-linux-x64.png'],
    );
  });

  it('carries the story metadata a report and a v2 resolver both need', () => {
    const first = matrix.captures[0];
    assert.equal(first?.storyId, 'a--one');
    assert.equal(first?.height, 900);
  });
});
