import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { needsReview, type CaptureResult, type RunSummary } from './summary.ts';

/** Total embedded-image budget. Past this the report links to files instead of inlining. */
const EMBED_BUDGET_BYTES = 40 * 1024 * 1024;

async function dataUri(file: string): Promise<string | undefined> {
  try {
    const bytes = await readFile(file);
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    return undefined;
  }
}

interface EmbeddedCapture extends CaptureResult {
  images: { expected?: string; actual?: string; diff?: string };
}

/**
 * Inline the images a reviewer needs.
 *
 * Only captures that need review carry images: an unchanged capture has nothing to look at,
 * and embedding the whole matrix would make the report too heavy to open from a CI artifact —
 * which is the one place it has to work.
 */
async function embed(
  summary: RunSummary,
  outputDir: string,
): Promise<{ captures: EmbeddedCapture[]; truncated: number }> {
  let spent = 0;
  let truncated = 0;
  const captures: EmbeddedCapture[] = [];

  for (const capture of summary.captures) {
    if (!needsReview(capture.status)) {
      captures.push({ ...capture, images: {} });
      continue;
    }

    const images: EmbeddedCapture['images'] = {};
    for (const kind of ['expected', 'actual', 'diff'] as const) {
      const relative = capture.artifacts[kind];
      if (!relative) continue;
      if (spent >= EMBED_BUDGET_BYTES) {
        truncated += 1;
        continue;
      }
      const uri = await dataUri(path.resolve(outputDir, relative));
      if (!uri) continue;
      spent += uri.length;
      images[kind] = uri;
    }
    captures.push({ ...capture, images });
  }

  return { captures, truncated };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Safe to sit inside a `<script>` element: `</script>` and U+2028/9 cannot terminate it. */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export async function renderReport(summary: RunSummary, outputDir: string): Promise<string> {
  const { captures, truncated } = await embed(summary, outputDir);
  const payload = { ...summary, captures, truncated };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Diopsis — ${escapeHtml(String(summary.totals.captures))} captures</title>
<style>
:root {
  --bg: #0d1117; --panel: #151b23; --line: #2a323d; --ink: #e6edf3; --muted: #9198a1;
  --accent: #f0a132; --changed: #f0a132; --new: #58a6ff; --failed: #f85149; --ok: #3fb950;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding: 28px 32px 20px; border-bottom: 1px solid var(--line); }
h1 { margin: 0 0 6px; font-size: 20px; letter-spacing: -0.01em; }
h1 span { color: var(--accent); }
.meta { color: var(--muted); font-size: 13px; }
.totals { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.chip { border: 1px solid var(--line); background: var(--panel); color: var(--ink);
  border-radius: 999px; padding: 5px 13px; font-size: 13px; cursor: pointer; }
.chip[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.chip .n { color: var(--muted); margin-left: 6px; }
.chip[aria-pressed="true"] .n { color: inherit; }
main { padding: 24px 32px 64px; }
.story { border: 1px solid var(--line); border-radius: 10px; margin-bottom: 18px;
  background: var(--panel); overflow: hidden; }
.story > summary { cursor: pointer; padding: 14px 18px; display: flex; gap: 12px;
  align-items: center; list-style: none; }
.story > summary::-webkit-details-marker { display: none; }
.story > summary::before { content: "▸"; color: var(--muted); }
.story[open] > summary::before { content: "▾"; }
.title { font-weight: 600; }
.sub { color: var(--muted); font-size: 13px; }
.badge { margin-left: auto; font-size: 12px; padding: 3px 9px; border-radius: 999px;
  border: 1px solid currentColor; }
.s-changed { color: var(--changed); } .s-new { color: var(--new); }
.s-failed, .s-render-failed { color: var(--failed); } .s-unchanged { color: var(--ok); }
.capture { border-top: 1px solid var(--line); padding: 16px 18px; }
.bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
.bar .w { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 13px; }
.modes { display: flex; gap: 4px; margin-left: auto; }
.modes button { background: transparent; border: 1px solid var(--line); color: var(--muted);
  border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.modes button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
/* The stage shrink-wraps its image: a narrow capture must not sit in a full-width void,
   and a full-page capture must scale down to something a reviewer can take in at once. */
.stage { background: #000; border: 1px solid var(--line); border-radius: 8px;
  width: fit-content; max-width: 100%; margin: 0 auto; overflow: hidden; }
.stage img { display: block; max-width: 100%; max-height: 70vh; width: auto; height: auto; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: start; }
.pair figure { margin: 0; min-width: 0; }
.pair figcaption { color: var(--muted); font-size: 12px; padding: 4px 2px; }
.overlaywrap, .swipe { position: relative; line-height: 0; }
.overlaywrap img.top, .swipe img.top {
  position: absolute; inset: 0; width: 100%; height: 100%; max-height: none; }
.swipe img.top { clip-path: inset(0 50% 0 0); }
input[type=range] { width: 100%; margin-top: 10px; accent-color: var(--accent); }
.err { white-space: pre-wrap; font: 12px/1.5 ui-monospace, monospace; color: var(--failed);
  background: #1b1113; border: 1px solid #442; border-radius: 6px; padding: 10px; margin-top: 10px; }
.accept { display: flex; gap: 8px; align-items: center; margin-top: 12px; }
code { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: #0b0f14;
  border: 1px solid var(--line); border-radius: 6px; padding: 5px 9px; color: var(--ink); }
button.copy { background: transparent; border: 1px solid var(--line); color: var(--muted);
  border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
.empty { color: var(--muted); padding: 40px 0; text-align: center; }
.note { color: var(--muted); font-size: 12px; margin-top: 10px; }
</style>
</head>
<body>
<header>
  <h1><span>Diopsis</span> — visual regression</h1>
  <div class="meta" id="meta"></div>
  <div class="totals" id="filters"></div>
</header>
<main id="out"></main>
<script type="application/json" id="data">${embedJson(payload)}</script>
<script>
${CLIENT_SCRIPT}
</script>
</body>
</html>
`;
}

/** Client behaviour. Kept as one string so the report stays a single file with no assets. */
const CLIENT_SCRIPT = String.raw`
const data = JSON.parse(document.getElementById('data').textContent);
const REVIEW = new Set(['changed', 'new', 'render-failed', 'failed']);
const LABEL = { changed: 'Changed', new: 'New', 'render-failed': 'Render failed',
  failed: 'Failed', unchanged: 'Unchanged' };

document.getElementById('meta').textContent =
  data.totals.captures + ' captures across ' + data.totals.stories + ' stories · ' +
  data.platform + '-' + data.arch + ' · ' + data.mode + ' · ' + data.createdAt;

const counts = {};
for (const c of data.captures) counts[c.status] = (counts[c.status] || 0) + 1;

// Anything needing review leads; unchanged is available but never the default view.
const order = ['changed', 'new', 'render-failed', 'failed', 'unchanged'];
let active = order.find(s => REVIEW.has(s) && counts[s]) ? 'review' : 'all';

const filters = document.getElementById('filters');
function chip(key, label, n) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.innerHTML = label + '<span class="n">' + n + '</span>';
  b.onclick = () => { active = key; render(); };
  b.dataset.key = key;
  return b;
}
filters.appendChild(chip('review', 'Needs review',
  data.captures.filter(c => REVIEW.has(c.status)).length));
for (const s of order) if (counts[s]) filters.appendChild(chip(s, LABEL[s], counts[s]));
filters.appendChild(chip('all', 'All', data.captures.length));

function copyButton(text) {
  const wrap = document.createElement('div');
  wrap.className = 'accept';
  const code = document.createElement('code');
  code.textContent = text;
  const btn = document.createElement('button');
  btn.className = 'copy';
  btn.textContent = 'Copy';
  btn.onclick = async () => {
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
    catch { btn.textContent = 'Select it manually'; }
    setTimeout(() => (btn.textContent = 'Copy'), 1600);
  };
  wrap.append(code, btn);
  return wrap;
}

function stage(capture) {
  const el = document.createElement('div');
  const img = capture.images || {};
  // The highlight overlay is the default: it answers "what changed?" without any interaction.
  const modes = [];
  if (img.diff) modes.push('Overlay');
  if (img.expected && img.actual) modes.push('Side by side', 'Swipe', 'Onion-skin');
  if (!modes.length && img.actual) modes.push('Actual');
  if (!modes.length) { el.className = 'note'; el.textContent = 'No image artifacts for this capture.'; return { el, modes: null }; }

  const body = document.createElement('div');
  let current = modes[0];

  function draw() {
    body.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'stage';
    if (current === 'Overlay' || current === 'Actual') {
      const i = document.createElement('img');
      i.src = current === 'Overlay' ? img.diff : img.actual;
      box.appendChild(i);
      body.appendChild(box);
    } else if (current === 'Side by side') {
      box.classList.remove('stage');
      box.className = 'pair';
      for (const [src, cap] of [[img.expected, 'Baseline'], [img.actual, 'This run']]) {
        const f = document.createElement('figure');
        const c = document.createElement('figcaption'); c.textContent = cap;
        const i = document.createElement('img'); i.src = src;
        const s = document.createElement('div'); s.className = 'stage'; s.appendChild(i);
        f.append(c, s); box.appendChild(f);
      }
      body.appendChild(box);
    } else {
      const wrap = document.createElement('div');
      wrap.className = current === 'Swipe' ? 'swipe' : 'overlaywrap';
      const base = document.createElement('img'); base.src = img.expected;
      const top = document.createElement('img'); top.src = img.actual; top.className = 'top';
      wrap.append(base, top);
      box.appendChild(wrap);
      const slider = document.createElement('input');
      slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.value = '50';
      slider.oninput = () => {
        if (current === 'Swipe') top.style.clipPath = 'inset(0 ' + (100 - slider.value) + '% 0 0)';
        else top.style.opacity = String(slider.value / 100);
      };
      body.append(box, slider);
      slider.oninput();
    }
  }

  const bar = document.createElement('div');
  bar.className = 'modes';
  for (const m of modes) {
    const b = document.createElement('button');
    b.textContent = m;
    b.setAttribute('aria-pressed', String(m === current));
    b.onclick = () => {
      current = m;
      for (const other of bar.children) other.setAttribute('aria-pressed', String(other === b));
      draw();
    };
    bar.appendChild(b);
  }
  draw();
  el.appendChild(body);
  return { el, modes: bar };
}

function render() {
  for (const b of filters.children) b.setAttribute('aria-pressed', String(b.dataset.key === active));

  const visible = data.captures.filter(c =>
    active === 'all' ? true : active === 'review' ? REVIEW.has(c.status) : c.status === active);

  const out = document.getElementById('out');
  out.innerHTML = '';

  if (!visible.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'Nothing here. Every capture matched its baseline.';
    out.appendChild(p);
    return;
  }

  const byStory = new Map();
  for (const c of visible) {
    if (!byStory.has(c.storyId)) byStory.set(c.storyId, []);
    byStory.get(c.storyId).push(c);
  }

  for (const [storyId, captures] of byStory) {
    const worst = order.find(s => captures.some(c => c.status === s)) || 'unchanged';
    const det = document.createElement('details');
    det.className = 'story';
    det.open = REVIEW.has(worst);

    const sum = document.createElement('summary');
    const t = document.createElement('span');
    t.className = 'title';
    t.textContent = captures[0].storyTitle + ' › ' + captures[0].storyName;
    const s = document.createElement('span');
    s.className = 'sub';
    s.textContent = storyId + ' · ' + captures.length + (captures.length === 1 ? ' capture' : ' captures');
    const badge = document.createElement('span');
    badge.className = 'badge s-' + worst;
    badge.textContent = LABEL[worst];
    sum.append(t, s, badge);
    det.appendChild(sum);

    for (const c of captures) {
      const box = document.createElement('div');
      box.className = 'capture';
      const bar = document.createElement('div');
      bar.className = 'bar';
      const w = document.createElement('span');
      w.className = 'w';
      w.textContent = c.width + 'px' +
        (c.diffPixels != null ? ' · ' + c.diffPixels.toLocaleString() + ' px differ (' +
          (c.diffRatio * 100).toFixed(2) + '%)' : '');
      const st = document.createElement('span');
      st.className = 'badge s-' + c.status;
      st.textContent = LABEL[c.status];
      bar.append(w, st);
      box.appendChild(bar);

      const built = stage(c);
      if (built.modes) bar.appendChild(built.modes);
      box.appendChild(built.el);

      if (c.error) {
        const e = document.createElement('pre');
        e.className = 'err';
        e.textContent = c.error;
        box.appendChild(e);
      }
      det.appendChild(box);
    }

    if (captures.some(c => REVIEW.has(c.status))) {
      const foot = document.createElement('div');
      foot.className = 'capture';
      foot.appendChild(copyButton('npx diopsis accept ' + storyId));
      det.appendChild(foot);
    }
    out.appendChild(det);
  }

  if (data.changedStories.length) {
    const all = document.createElement('div');
    all.style.marginTop = '20px';
    all.appendChild(copyButton('npx diopsis accept'));
    out.appendChild(all);
  }
  if (data.truncated) {
    const n = document.createElement('p');
    n.className = 'note';
    n.textContent = data.truncated + ' capture(s) had images omitted to keep this file openable.';
    out.appendChild(n);
  }
}

render();
`;
