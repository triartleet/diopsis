import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { serveStatic, storyUrlFor, type StaticServer } from '../src/server.ts';

const root = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'storybook-static',
);

describe('serveStatic', () => {
  let server: StaticServer;

  before(async () => {
    server = await serveStatic(root);
  });
  after(async () => {
    await server.close();
  });

  it('serves the preview with an HTML content type', async () => {
    const response = await fetch(`${server.url}/iframe.html`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await response.text(), /storybook-root/);
  });

  it('serves the story index as JSON', async () => {
    const response = await fetch(`${server.url}/index.json`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const body = (await response.json()) as { v: number };
    assert.equal(body.v, 5);
  });

  it('never serves a cached response, so a rebuilt Storybook is the one captured', async () => {
    const response = await fetch(`${server.url}/index.json`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('404s on a path that is not there', async () => {
    assert.equal((await fetch(`${server.url}/nope.html`)).status, 404);
  });

  it('refuses to serve outside the build directory', async () => {
    const response = await fetch(`${server.url}/../../../package.json`);
    assert.ok(response.status === 403 || response.status === 404, `got ${response.status}`);
  });

  it('refuses an encoded traversal too', async () => {
    const response = await fetch(`${server.url}/%2e%2e%2f%2e%2e%2fpackage.json`);
    assert.ok(response.status === 403 || response.status === 404, `got ${response.status}`);
  });

  it('picks a free port when asked for any', () => {
    assert.ok(server.port > 0);
  });
});

describe('storyUrlFor', () => {
  it('addresses the preview directly, without the manager UI', () => {
    assert.equal(
      storyUrlFor('http://127.0.0.1:1234', 'button--primary'),
      'http://127.0.0.1:1234/iframe.html?viewMode=story&id=button--primary',
    );
  });

  it('tolerates a trailing slash on the base', () => {
    assert.equal(
      storyUrlFor('http://127.0.0.1:1234/', 'a--b'),
      'http://127.0.0.1:1234/iframe.html?viewMode=story&id=a--b',
    );
  });

  it('encodes the story id', () => {
    assert.match(storyUrlFor('http://x', 'a b&c'), /id=a%20b%26c$/);
  });
});
