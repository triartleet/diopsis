# Roadmap

What's next for Diopsis, in order of intent. This list is pruned, reordered and rewritten
freely — the *decisions* behind deferrals, and everything ruled out, live in
[DECISIONS.md](DECISIONS.md).

## Next

- **Change-aware capture** (v2, committed — D-006): shoot only the stories a change could
  have affected. On a typical pull request this turns a full matrix into a handful of
  captures. v1 already returns the full capture set as data and records it in
  `summary.json`, so this lands as a filter, not a redesign.

## Later

- **Interaction states** — capturing a story after a `play` function or a hover/focus step,
  keyed by story id, when a real need appears (deferred in §9 of the design).
- **Cross-browser matrix** — WebKit/Firefox beside Chromium, only once the single-browser
  path has proven solid in real projects.

## Not planned

- A hosted service, dashboard, or any state outside the consuming repository — a design
  goal, not a gap (D-001).
- An accept/reject review state machine; accepting a change is committing a file.
