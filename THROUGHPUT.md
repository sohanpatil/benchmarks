# Browser Step Throughput Benchmark

This document describes the **browser step throughput benchmark** — a measurement of how fast a browser provider can execute sequential agent-style actions inside a single running session. It is a complement to the existing browser lifecycle benchmark, which measures session provisioning latency.

## Why this benchmark exists

The existing browser benchmark (`src/browser/benchmark.ts`) measures the **lifecycle**:

```
session create → CDP connect → single page load → release
```

That answers one important question: *how fast can I get a fresh browser?* It is the right metric for short-lived sessions where each task spins up a new browser.

It does **not** answer the question that matters for long-running agent workloads:

> *Once a session is up, how fast does each individual action complete, and does performance hold up over the course of a session?*

A vision-based agent might run for thirty minutes to several hours and execute hundreds of browser actions inside a single session. For those workloads, provisioning speed is a negligible fraction of total runtime — the per-action throughput is the bottleneck. A provider that creates a session in 200ms but takes 800ms per screenshot will lose to a provider that takes 2s to create a session but only 100ms per screenshot, every single time.

This benchmark closes that gap.

## What gets measured

For each provider, the benchmark runs **N sessions** (default 10, configurable). Each session executes a fixed sequence of **50 sequential actions** end-to-end inside one running browser. We record, in order:

- Session creation time (`createMs`)
- CDP connection time (`connectMs`)
- Wall-clock duration of each individual action, tagged by action type
- Session release time (`releaseMs`)
- Total wall-clock time (`totalMs`)
- Sum of action durations (`taskMs`)
- Actions per second over the session (`actionsCompleted / (taskMs / 1000)`)

From that raw data we summarize across iterations:

- `actionsPerSecond` — median, p95, p99
- `taskMs` — median, p95, p99
- `totalMs` — median, p95, p99
- `createMs` — median, p95, p99
- `perActionType` — median, p95, p99 for each of the six action types

## The 50-action sequence

Each session repeats a 10-action loop five times against Wikipedia:

```
1.  goto('https://en.wikipedia.org/wiki/Special:Random')
2.  waitForSelector('#firstHeading')
3.  screenshot()
4.  textContent('#firstHeading')
5.  click('#mw-content-text a[href^="/wiki/"]:not([href*=":"])')
6.  waitForSelector('#firstHeading')
7.  screenshot()
8.  textContent('#firstHeading')
9.  page.goBack({ waitUntil: 'commit' })
10. waitForSelector('#firstHeading')
```

Five loops × ten actions = **50 actions per session**.

This pattern simulates what a vision-based agent actually does on each turn: navigate, wait for the DOM, capture a screenshot for an LLM to look at, extract some text, take an action, observe the result, and move on.

### Why Wikipedia

Wikipedia's `Special:Random` endpoint is intentionally chosen over real-world target sites. It gives us:

- **Global availability** — no geographic restrictions, no auth flows.
- **Consistent structure** — every article page has `#firstHeading` and a `#mw-content-text` body container, so the same selectors work everywhere.
- **A rich, deterministic link graph** — every random article exposes many `/wiki/...` outbound links to follow.
- **Stable, predictable load times** — Wikipedia's CDN serves pages quickly and consistently across regions.
- **No meaningful bot detection** for scripted, polite traffic.

That isolates the variable we care about: the provider's per-action overhead. Page-level variance is small enough that differences between providers are real, not noise from the target site.

### Why these six action types

Together they cover the surface area of nearly every agent action:

| Action type        | Represents                                                  |
| ------------------ | ----------------------------------------------------------- |
| `navigate`         | Full-page transitions (HTTP + page load + render)           |
| `waitForSelector`  | DOM polling — measures CDP round-trip + selector evaluation |
| `screenshot`       | Pixel capture — relevant for vision-based agents            |
| `textContent`      | DOM read — cheapest possible action, isolates raw CDP cost  |
| `click`            | Synthetic input event + waiting for the navigation it triggers |
| `goBack`           | History navigation, exercises bfcache behavior              |

Per-action breakdown matters: two providers can have identical end-to-end times but very different cost structures (one is screenshot-bound, the other is click-bound). The `perActionType` summary surfaces those differences.

### Stealth + real viewport

Every provider is configured with the settings agent workloads typically use:

```typescript
sessionCreateOptions: {
  stealth: true,
  headless: true,
  viewport: { width: 1920, height: 1080 },
}
```

This makes the comparison apples-to-apples and reflects realistic agent conditions (stealth mode often changes performance characteristics, and a 1920×1080 viewport produces meaningfully larger screenshots than the default).

## How the runner behaves

A few deliberate choices in `runThroughputIteration`:

- **Each action is timed individually** with `performance.now()` immediately before and after the Playwright call. The session timing is the *sum of action durations*, not measured separately — that way action-level numbers always add up to the session number.
- **A failing action does not abort the session.** If `click` times out on action 5, the loop records the failure and proceeds with action 6. This lets us measure partial completion rates and observe how providers degrade under stress, instead of throwing away an entire session because one action got unlucky.
- **The action index is recorded.** With 50 ordered actions per session, downstream analysis can detect if late-session actions are systematically slower than early-session ones — a useful signal for memory leaks or resource exhaustion in long-running sessions.
- **Action timeout is 30 seconds**, applied per-action via `withTimeout`. A single slow action can't hang an entire run, and the timeout lands well above any reasonable real action duration.
- **`page.goBack` uses `waitUntil: 'commit'`** rather than the Playwright default of `'load'`, because browsers restoring a page from the back-forward cache fire `pageshow` instead of `load` — `'load'` would hang for the full timeout on every bfcache restore. The next `waitForSelector` confirms arrival on the previous page.

## Scoring

The composite score is a single number (0–100, higher is better) for at-a-glance comparison. The weighting was chosen to reflect what actually matters for agent workloads:

```
score = (
    0.40 × score(actionsPerSecond.median)   // throughput is the primary signal
  + 0.25 × score(taskMs.median)             // total time per session
  + 0.20 × score(taskMs.p95)                // tail consistency (worst sessions)
  + 0.15 × score(screenshot.median)         // vision-agent proxy
) × successRate
```

Where the sub-scores are linear:

- `score(actionsPerSecond)` — 0/sec → 0, 10/sec → 100 (linear).
- `score(latencyMs)` — 0ms → 100, 30,000ms → 0 (linear, clamped to 0).
- `successRate` — fraction of sessions that completed all 50 actions without error. A session that completes only 49/50 does not count toward `successRate`. This deliberately punishes flakiness — an agent that fails 1 action in 50 fails 1 in every 50, period.

### Why these weights

- **40% on throughput**, because actions/sec is the headline metric for agent workloads. Doubling APS halves the wall-clock cost of any agent task.
- **25% on median task time**, to reward the typical case.
- **20% on p95 task time**, to reward consistency. A provider with a great median but a long tail is dangerous for agents that run for hours — the tail is what you actually pay.
- **15% on screenshot median**, because vision agents bottleneck on screenshot capture. It's separated out so this specific cost can't hide inside the aggregate.
- **× successRate**, because partial successes aren't useful. A provider that wins on speed but fails 10% of sessions is worse than a slower one that finishes.

### Why not just use APS

A single-axis score would hide important detail. A provider can have great throughput but terrible p95 (one in twenty sessions falls off a cliff) — which is unusable for production agents. The composite score forces all four axes to be acceptable to score well.

The full per-action distribution is preserved in the JSON output, so anyone who cares about a different weighting can compute their own score from the raw data.

## Running it

```bash
# Single provider, single session — useful for development
npm run bench:browser-throughput:browserbase -- --iterations 1

# All four providers, default 10 sessions each
npm run bench:browser-throughput

# Specific provider with custom iteration count
npm run bench -- --mode browser-throughput --provider hyperbrowser --iterations 25
```

Required environment variables (set in `.env` or your shell):

- `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`
- `HYPERBROWSER_API_KEY`
- `KERNEL_API_KEY`
- `STEEL_API_KEY`

Missing credentials cause that provider to be reported as `SKIPPED` rather than failing the run.

## Output

Results are written to `results/browser-throughput/YYYY-MM-DD.json` and copied to `results/browser-throughput/latest.json`. Each iteration's JSON includes the full ordered action list with per-action durations, success flags, and errors — enough to reconstruct any per-action analysis without re-running.

The SVG generator produces `browser-throughput.svg` with a ranked comparison table:

```bash
npm run generate-browser-throughput-svg
```

## Scheduling

The GitHub Actions workflow `browser-throughput-benchmarks.yml` runs daily at 03:00 UTC (offset from the lifecycle browser benchmark at 00:00) with 10 iterations per provider. Pull requests touching browser code run a faster 3-iteration version and post a comparison table as a PR comment.

## Limitations

- Wikipedia's CDN is fast and globally distributed — providers in regions closer to Wikipedia's edge nodes will benefit. This is acceptable for a relative comparison but it is not representative of every real-world target site.
- A 50-action session is short relative to real agent workloads. It catches per-action overhead and basic session drift, but multi-hour memory leaks or long-tail GC pauses will not show up here.
- The benchmark does not currently model concurrent sessions per account. Some providers may have very different per-action latency under high concurrency.
- Wikipedia's HTML occasionally changes. If `#firstHeading` or `#mw-content-text` get renamed or restructured, the selectors in the runner will need updating.
