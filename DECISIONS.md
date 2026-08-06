# Diopsis — design proposal v1

<!-- ## D-NNN — YYYY-MM-DD — title · Decision/Why/Scope/Supersedes · append-only, corrections supersede -->
<!-- decisions-format: 1 -->

Status: **v1 design, approved.** Decisions are recorded at the bottom of this file
([§11](#11-decisions)) — this document is both the design and the decision record.

---

## 1. What Diopsis is for

Rendering a story and taking a screenshot is the easy part — every testing guide covers it.
The hard parts are the ones that make visual regression testing *survivable*:

- **Determinism.** The same story must produce the same pixels on every machine, or the
  suite becomes noise and gets ignored. Fonts, animations, clocks, in-flight network and
  host OS all conspire against this, and each needs an answer that is on by default rather
  than documented as advice (§3).
- **Reviewability.** A failing visual test is only useful if a human can see *what* changed.
  Git forges do not render pixel-level image diffs — GitLab offers 2-up, swipe and
  onion-skin but no diff highlight
  ([gitlab#503214](https://gitlab.com/gitlab-org/gitlab/-/issues/503214)); GitHub is
  similar — so the tool has to bring its own review surface (§5).
- **Cost of scale.** A viewport matrix multiplies stories into captures fast, and every
  capture costs runtime on each run and repository weight forever. Both must be visible and
  controllable, not discovered later (§4, §7).

**Scope choice:** Diopsis runs against the **built static Storybook**, not a dev server or
a bundler plugin. That keeps it independent of which builder produced the output and of the
Storybook version beyond the index format, and it means CI can reuse a Storybook build it
already produces.

**In one line:** _deterministic visual regression for Storybook, with a real diff review,
entirely inside your own repository and CI._

---

## 2. Architecture — thin engine, own the UX

Delegate the runner; own the parts that are actually differentiated.

```
diopsis.config.ts
        │
        ├── resolve stories        index.json from the built Storybook (type === 'story')
        ├── resolve matrix         viewports, per-story overrides via tags
        ├── resolve affected       changed files → story ids   (change-aware capture)
        │
        └── generate a Playwright project in a temp dir
                 └── playwright test  ← inherits sharding, retries, parallelism, workers
                          │
                          └── DiopsisReporter (custom PW reporter)
                                   ├── report.html   self-contained gallery + diff viewer
                                   └── summary.json  machine-readable, for CI bots
```

**Why delegate to the Playwright runner** rather than drive `playwright-core` directly:
parallelism, `--shard=i/n`, retries, timeouts, and the pixel comparator are all solved and
maintained upstream. That is the smallest footprint that still serves the performance
target, and it keeps the maintenance tail (the thing that killed the incumbents) short. We
add a **custom reporter** — a small, stable PW extension point — to own the review UX.

Serving the static build: a tiny built-in static server (no `http-server` dependency).

---

## 3. Determinism core

These are the things a hand-rolled setup gets wrong, promoted to structural guarantees.

| Guarantee | Mechanism |
|---|---|
| **Platform can never be confused** | `{platform}-{arch}` in the snapshot path **by default**. A native macOS run writes `…-darwin-arm64.png` and can never overwrite the Linux set CI reads — the clearest thing a tool fixes that a hand-rolled setup does not. |
| **Generate and verify use the same image** | One pinned image name in `diopsis.config.ts`, consumed by *both* the update path and the CI recipe. Parity by construction, not by documentation. `diopsis doctor` fails if CI's image differs. |
| **No mid-skeleton captures** | Default stabilization waits for network-idle **and** absence of loading states, not just first-child-visible — mocked network responses are a common source of genuine flake. |
| **Time is frozen, not masked** | Clock is fixed by default, so dates/years/relative times are deterministic. Masking is reserved for genuinely nondeterministic pixels — map tiles, video, canvas. A mask whose *bounding box* moves still fails the diff and hides content from review. |
| **One stray AA pixel can't block a pipeline** | A small non-zero `maxDiffPixelRatio` ships as a default alongside the per-pixel threshold. |
| **Honest units** | Every run prints **captures**, not stories — a 4-viewport matrix over 90 stories is 360 captures, and every estimate that matters (runtime, repo weight, review effort) scales with captures. |

**Cross-arch caveat, stated honestly:** `arm64` vs `amd64` renders differ slightly
([playwright#13873](https://github.com/microsoft/playwright/issues/13873)). Docker-on-Apple-
Silicon is therefore *near*-parity, not guaranteed parity. Diopsis records the
platform+arch that produced a baseline set in a manifest and **warns on mismatch** instead
of claiming an equivalence that does not hold.

---

## 4. Change-aware capture — the performance lever (v2)

Planned for v2; v1 is designed so as not to foreclose it. The win is **not shooting stories
that cannot have changed** — on a typical pull request this turns a full matrix into a
handful of captures, which matters far more than how fast any single capture is.

**What v1 ships to keep the door open:** the story resolver already returns the full
capture list as data, so v2 only has to *filter* it. v1 therefore includes the
`affected: 'auto' | 'all'` config key (accepting only `'all'` for now) and records the
run's full capture set in `summary.json`, so v2's resolver has a baseline to diff against.
No architectural change required later.

The v2 shape — a pluggable **affected-resolver** chain, each tier falling back safely:

1. **Story files changed** — changed path matches a story's `importPath` → affected. Cheap,
   exact, always available.
2. **Module graph** — if the build emitted stats (Webpack stats / Vite manifest), map
   changed source files → importers → story ids. Broader and still precise.
3. **Global-input change** — a changed `preview.*`, config, token/theme file, or the
   Diopsis config itself invalidates **everything**.
4. **Unknown → run everything.** The default is always the safe one; skipping is only ever
   an optimization we can *prove*.

Policy: affected-only on branches/MRs; **full run on the default branch and on schedule**,
so nothing rots undetected. Every run states what it skipped and why — a silent cap reads
as "all green" when it isn't.

---

## 5. Review experience

Since no git forge renders a visual diff, the report *is* the review surface. A
**single self-contained HTML file** (no server, no assets, opens from a CI artifact):

- **Gallery of changed stories first** — unchanged ones collapsed. Reviewers see only what
  moved, with the change count per story.
- **Four diff modes per capture**: side-by-side, **diff-highlight overlay**, swipe, and
  onion-skin. The overlay is the default because it answers "what changed?" instantly.
- **Filter by status**: changed · new · missing baseline · failed to render.
- **Copy-paste accept command** per story and for the whole run.
- **`summary.json`** beside it — changed story ids, counts, artifact paths — so an existing
  CI bot can post a pull-request comment without any additional service.

**Accept flow** — one command to adopt a run's output as the new baseline:

```
diopsis accept            # unpack the CI "update" artifact into the snapshot dir, stage it
diopsis accept <story-id> # accept a single story
```

---

## 6. Setup & footprint — the CLI

```
diopsis init      scaffold diopsis.config.ts + CI recipe + .gitignore/.gitattributes entries
diopsis run       verify against committed baselines            (default command)
diopsis update    regenerate baselines in the pinned Linux image (Docker)
diopsis accept    accept baselines from a CI run
diopsis report    open the last report
diopsis doctor    audit the setup: image parity, platform suffix, gitignore, LFS,
                  capture count, baseline weight, stale/orphan baselines
```

`diopsis doctor` is where these guarantees become **guardrails instead of documentation** —
misconfigurations that silently invalidate a baseline set are caught before they cost a run.

**Dependencies:** `@playwright/test` as a **peer** dependency (no duplicate browser
downloads), plus a CLI arg parser and a PNG codec. Nothing else. Zero runtime dependencies
on Storybook itself — Diopsis reads the *built output*, so it does not care about the
Storybook version beyond the index format.

**OS compatibility vs easy setup** — these conflict — they genuinely conflict, so the resolution is
explicit rather than blended:

- **Authoritative baselines require Docker.** That is the only honest cross-OS answer.
- **Trying Diopsis does not.** `diopsis run` works natively on macOS/Windows/Linux against
  platform-suffixed local baselines, so a first run costs nothing. You only need Docker when
  you want baselines CI will agree with.

---

## 7. Repo weight — the cost of keeping baselines in git

Baselines living in the repository is what makes Diopsis self-contained and reviewable —
and it has a real price that should be stated plainly rather than discovered later.
Hundreds of PNGs enter git, and every intentional UI change adds another full set that
stays in history permanently.

- `diopsis init` **estimates and prints** the weight, and offers an **LFS-aware** setup —
  the decision is only cheap *before* the first commit.
- Baselines are marked **binary/unmergeable** in `.gitattributes`, so a rebase conflicts
  loudly instead of silently producing a corrupt PNG.
- `diopsis doctor` reports orphaned baselines (stories that no longer exist) so the set does
  not accumulate dead weight.
- The **viewport matrix is a decision with a visible cost**, not an inheritance: `init`
  shows what each viewport adds in captures/MB. Dropping 4 widths to 2 nearly halves
  runtime, weight, and flake surface at once.

---

## 8. Configuration sketch

```ts
// diopsis.config.ts
export default {
  storybookDir: 'storybook-static',
  snapshotDir: '__screenshots__',
  viewports: { default: [320, 1280] },        // explicit, cost shown at init
  image: 'mcr.microsoft.com/playwright:v1.62.1-jammy',  // single source of truth
  stabilize: {
    freezeClock: '2026-01-15T12:00:00Z',
    waitForNetworkIdle: true,
    disableAnimations: true,
  },
  mask: ['[data-diopsis-ignore]'],             // our own attribute; see §11 D-008
  compare: { threshold: 0.2, maxDiffPixelRatio: 0.001 },
  affected: 'all',                             // 'all' in v1; 'auto' lands in v2 (§4)
}
```

Per-story overrides come from **story tags** in the index (`tags: ['diopsis:1280']`) rather
than a hand-maintained map: the story index serializes `tags` but not `parameters`, so any
map of "which story renders at which widths" has to be kept in sync by hand and drifts.

**Adopting from another tool:** Diopsis reads only `data-diopsis-ignore` (§11 D-008), so
existing ignore annotations are renamed — a one-line search-and-replace. `diopsis doctor`
reports any that were missed, and because the clock is frozen by default (§3), annotations
that only existed to hide dates or a changing year can usually be **deleted rather than
renamed**.

---

## 9. Scope boundaries

**v1 ships:** the determinism core (§3), the rich self-contained report (§5), the CLI
including `doctor` (§6), tag-driven viewports, and the repo-weight tooling (§7).

**v1 does *not* include:**

- Change-aware capture — **v2, committed** (§4). v1 keeps the door open by design.
- No cloud, dashboard, or hosted state — running entirely inside the consuming repo and its
  CI is a design goal, not a limitation to be lifted later.
- No accept/reject *state machine*; accept = commit the baseline.
- No cross-browser matrix (Chromium only) until the single-browser path is solid.
- No a11y audit in v1 — optional, non-blocking, later.
- No interaction/`play` support in v1; add keyed by story id when a real need appears.

---

## 10. Build order

1. Story/matrix resolver + static server + generated Playwright project (the spine).
2. Determinism core (§3) — platform-suffixed paths, stabilization, frozen clock, defaults.
3. `diopsis run` / `update` / `accept` + `summary.json`.
4. The report (§5) — gallery, four diff modes, overlay default.
5. `diopsis init` + `doctor` (§6/§7) — the guardrails.
6. Validate against a real Storybook project; then publish (§11 D-007).
7. **v2:** change-aware capture (§4).

---

## 11. Decisions

Append-only. Design sections above may be rewritten freely; entries below are the record and
are not edited in place — corrections supersede. Each entry states its **Decision**, the
**Why** behind it, any **Consequences** or **Revisit** date, and its **Scope**; the
`decisions-format` marker at the top of this file makes that shape enforceable rather than
customary.

## D-001 — 2026-08-05 — What Diopsis is

**Decision:** A standalone Storybook visual-regression tool: it screenshots the
**already-built static Storybook** and diffs each story against committed baselines,
running identically locally and in CI. No hosted service; baselines live in the consuming
repo.

**Why:** the parts that decide whether a visual suite survives are determinism and
reviewability, not the screenshot itself — and both are lost when the baselines and the
review surface live outside the repository under test.

**Scope:** repo.

## D-002 — 2026-08-05 — Name

**Decision:** The tool is **Diopsis** (διόψις — _sight that discerns the difference between
two_). Package and repository name: `diopsis`.

**Why:** it names what the tool does — seeing the difference between two renders — and the
name was free on the registry.

**Scope:** repo.

## D-003 — 2026-08-05 — Repository and licence

**Decision:** GitHub `triartleet/diopsis`, MIT licensed.

**Why:** MIT imposes the least friction on adoption for a developer tool, and matches the
licence of the author's other published tools.

**Scope:** repo.

## D-004 — 2026-08-05 — Baselines are a Linux artifact

**Decision:** Baselines are generated in Linux — in a container locally, or in the CI image
— so they match the runner that verifies them. Diff defaults stay strict, with
`maxDiffPixelRatio` as the first lever if real parity problems appear.

**Why:** screenshots are OS-specific; a baseline generated on a developer's machine will not
match a Linux CI runner, and the mismatch presents as a suite that fails on arrival.

**Consequences:** `arm64` and `amd64` renders also differ slightly
([playwright#13873](https://github.com/microsoft/playwright/issues/13873)), so a container
on an ARM host gives near-parity, not guaranteed parity. Diopsis records platform and
architecture per baseline set and warns on mismatch rather than claiming an equivalence that
does not hold.

**Scope:** repo.

## D-005 — 2026-08-05 — Ship the rich report in v1

**Decision:** The self-contained HTML report — changed-stories gallery, four diff modes with
the highlight overlay as default — is v1 scope, not deferred.

**Why:** no git forge renders a pixel-level image diff. GitLab offers 2-up, swipe and
onion-skin but no diff highlight
([gitlab#503214](https://gitlab.com/gitlab-org/gitlab/-/issues/503214)); GitHub is
comparable. Without its own report the tool gives a reviewer no way to see *what* changed,
which is the whole point of a failing visual test.

**Scope:** repo.

## D-006 — 2026-08-05 — Change-aware capture lands in v2

**Decision:** Capturing only the stories a change could have affected is deferred to v2. v1
must not foreclose it: the resolver returns the full capture set as data and `summary.json`
records it, so v2 adds a filter rather than a redesign (§4).

**Why:** it is the performance story and worth doing properly, but it is also the most
complex piece in the design — shipping v1 without it keeps the first release small, and
costs nothing later because the seam is already there.

**Scope:** repo.

## D-007 — 2026-08-05 — Open source

**Decision:** Public repository and public npm package, MIT licensed, from the first
release.

**Why:** the problem is common to every Storybook project, and a tool whose value is
determinism benefits from being inspectable by the people trusting it.

**Scope:** repo.

## D-008 — 2026-08-05 — One ignore attribute: `data-diopsis-ignore`

**Decision:** Regions excluded from comparison are marked with `data-diopsis-ignore`. This
is the only recognized attribute; the API carries no vendor-specific aliases.

**Why:** an API that recognizes another tool's vocabulary inherits that tool's conventions
permanently, and every alias is a second thing to document and keep working.

**Consequences:** a project adopting Diopsis renames its existing annotations — a one-line
search-and-replace. `diopsis doctor` reports elements still carrying another tool's ignore
attribute so the migration can be finished cleanly, and because the clock is frozen by
default (§3), annotations that existed only to hide dates can usually be deleted rather than
renamed.

**Scope:** repo.

## D-009 — 2026-08-05 — One document: design and decisions together

**Decision:** The design and the decision record live in one file, `DECISIONS.md`, rather
than two.

**Why:** the decisions largely restated the design sections, leaving too little unique
content to justify a second document.

**Revisit:** if the design and the decisions start changing at different rates, split them.

**Scope:** repo.

## D-010 — 2026-08-06 — Validate end to end before building the rest

**Decision:** The first code written was a thin end-to-end slice — resolve stories, serve the
build, generate a Playwright project, capture, compare — run against a real Storybook build
before any of §10's later steps were fleshed out. Subsequent steps are built against a loop
that already runs.

**Why:** nothing in this design had ever executed. §10 sequenced first contact with a real
Storybook last, which concentrates every unverified assumption — index shape, render root,
settling behaviour — at the point where five steps of work already depend on them.

**Consequences:** it paid immediately. Storybook 10 emits `subtype` and `exportName` and omits
`componentPath`, so the index parser tolerates unknown fields rather than asserting a shape;
and a stabilization guard that looked correct was passing only because network-idle happened
to outlast the timer it was meant to catch, which a fixture-only test would not have exposed.

**Scope:** repo.

## D-011 — 2026-08-06 — TypeScript config, no transpiler

**Decision:** `diopsis.config.ts` is loaded by Node's own type stripping. `.mjs` and `.js`
configs are accepted on any supported Node, and the runtime dependency count stays at zero.

**Why:** §8 specifies a TypeScript config and §6 caps dependencies. A bundler or a transpile
dependency satisfies the first at the cost of the second; type stripping satisfies both.

**Consequences:** the `.ts` form needs Node 22.18 or newer, where type stripping is unflagged;
below that the loader says so and names the `.mjs` alternative rather than failing obscurely.
Type stripping erases types but generates no code, so enums, namespaces and parameter
properties are unusable — in a user's config *and* in this codebase. `erasableSyntaxOnly` in
`tsconfig.json` turns that from a runtime surprise into a compile error.

**Scope:** repo.

## D-012 — 2026-08-06 — The generated project lives under the tested project

**Decision:** The generated Playwright project is written to `node_modules/.diopsis/project`
inside the project under test, rather than the operating system's temporary directory as §2
sketched.

**Why:** `@playwright/test` is a peer dependency, so the generated config and spec must be able
to resolve it. Node's module resolution skips ancestors already named `node_modules`, which
puts the project's own `node_modules` on the search path from that location — a temporary
directory elsewhere on disk has no path back to it.

**Consequences:** the directory is rewritten on every run and removed afterwards, so it holds
no state between runs. Two concurrent runs in one project would contend for it.

**Scope:** repo.

## D-013 — 2026-08-06 — Two fixtures, only one of them committed

**Decision:** Tests run against a committed Storybook-shaped fixture — a story index and a
preview document, no Storybook involved. End-to-end validation runs against a real Storybook
build that is reproduced locally from instructions and never committed.

**Why:** these are different jobs. The committed fixture has to be fast, deterministic and
installable-free so the suite runs anywhere; validation has to be real enough to disagree with
the design, which only a genuine build does. Committing the real one would put a framework's
full dependency tree in a repository that has none.

**Consequences:** the committed fixture cannot catch what only a real build reveals, so it is
never the sole evidence that something works.

**Scope:** repo.

## D-014 — 2026-08-06 — `diopsis:skip` excludes a story

**Decision:** A story tagged `diopsis:skip` is not captured. A `diopsis:` tag that names
neither a width nor a configured viewport set produces a warning and falls back to the default
set.

**Why:** §8 established tags as the override channel, and some stories cannot be usefully
photographed. The fallback direction matters more than the tag: silently capturing nothing
because a tag was misspelled reads as "all green" when a story is simply unwatched.

**Scope:** repo.
