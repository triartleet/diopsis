# Diopsis

> διόψις — _sight that discerns the difference between two._

**Diopsis** is a visual-regression tool for [Storybook](https://storybook.js.org/): it
screenshots the **already-built static Storybook** and diffs each story against committed
baselines, running identically on your machine and in CI. Baselines live in your repo, so
every visual change is reviewed in the pull request.

## Why

Taking the screenshot is the easy part. Diopsis focuses on **determinism and
reviewability** — the parts that decide whether a visual suite survives contact with a real
team:

- **Deterministic captures** — frozen clock, network-idle waits, animations off, and the
  platform baked into every snapshot path so a local run can never overwrite what CI reads.
- **A real diff report** — no git forge renders a visual diff (GitLab has 2-up/swipe/onion-skin
  but no pixel-diff highlight), so Diopsis ships a self-contained HTML report: changed
  stories first, with a diff-highlight overlay, swipe and onion-skin.
- **No SaaS** — baselines live in your repo; nothing is uploaded, nothing is metered.

> **Status:** v1 in progress — see [DECISIONS.md](./DECISIONS.md). Capture and comparison run
> end to end; the report, `init` and `doctor` are not built yet, and the API and CLI are not
> final. This README is a placeholder until the tool can show its own output.
