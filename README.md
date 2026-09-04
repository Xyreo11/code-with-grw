# SITREP

**Your market, since you last looked.**

A watchlist built around one question: *what meaningfully changed since I last checked, and what deserves my attention now?*

Not a dashboard. A briefing.

---

## Run it

No API keys needed. Real market data is committed as fixtures.

```bash
docker compose up -d          # postgres on 5433, redis on 6380
npm install
npx prisma migrate dev
npm run demo:reset            # seed, load fixtures, compute events, plant a cursor
npm run dev
```

Open http://localhost:3000 and sign in as `demo@sitrep.local` / `sitrep-demo`.

| Page | What it shows |
|---|---|
| `/` | The SITREP — what changed since your cursor |
| `/replay` | Step two real historical windows one trading day at a time |
| `/watchlist` | Manage names, priority, and intent |
| `/admin/pipeline` | Ingest runs, data quality, engine version |

```bash
npm test              # 133 unit tests, engine + ingestion
npm run test:e2e      # 4 Playwright journeys through a real browser
npm run calibrate     # replay history, rewrite docs/calibration.md
npx tsx scripts/verify-requirements.ts   # 30 checks against the brief's minimums
```

### Background ingestion (optional, needs API keys)

```bash
npm run worker                                    # consumes the queues
curl -X POST localhost:3000/api/cron/ingest      -H "authorization: Bearer $CRON_SECRET"      # enqueues all 26 symbols
```

The route only **enqueues** — it returns in milliseconds regardless of how slow
or rate-limited the upstream feeds are, and never does provider I/O on a
request thread. The worker paces itself against the free tiers (Twelve Data
8/min, Tiingo 50/hour), retries with a long backoff because the real failure is
an hourly quota rather than a transient blip, and when the batch drains it
enqueues **one** recompute — not one per symbol, because a name's features
depend on the benchmark and sector proxies and computing mid-batch would read a
half-updated universe.

---

## The problem with watchlists

A normal watchlist is **stateless**. Every visit looks the same whether you were away an hour or a month, so it cannot tell you what is new *to you*. It ranks by percent change, which conflates a 3% wobble on a volatile small-cap with a 3% post-earnings gap on a mega-cap. It shows every row, so you do the filtering. And when it does alert you, it cannot say why.

SITREP inverts each of those.

| Normal watchlist | SITREP |
|---|---|
| Same view every time | **Per-user cursor** into an event timeline |
| Ranks by % change | Ranks by **anomaly**, normalised to each instrument's own volatility |
| Shows everything | **Attention budget** — top few, the rest collapse |
| Alert with no rationale | **Why am I seeing this?** *and* **Why not higher?** |
| Stale data shown as live | Every price carries freshness; disputed prices are capped |

---

## How it decides what matters

```
bars → features → detectors → scoring → themes → narrative → SITREP
```

**Six detectors.** Move since you last looked (the only user-relative one), volume spike, sector divergence, range break, volatility regime shift, upcoming earnings. Together they cover every signal family the scorer weights; more detectors would add coverage, not structure.

**The score is a transparent linear model.** Every point traces to a named signal:

```
score = 100 × strength × coverage^0.25 × context multipliers
```

- **strength** — weighted mean of the families that reported, so a lone extreme move is not punished for the silence of others
- **coverage** — how much of the total weight reported at all, so *corroboration counts*. Volume confirming a price move is worth more than either alone.
- **multipliers** — data quality, confirmation, recency, your explicit priority, your stated intent. All emitted as named contributions, never applied invisibly.

That is what makes the Why panel possible. It is not a rationalisation generated after the fact — the bars *are* the arithmetic.

**Why not higher** is the half that matters. Any ranking system can list the evidence it accepted; showing what it rejected, and by how much, is far harder to fake:

```
NVDA — 93
✓ outperforming its sector by +7.6% (3.4σ)     +29
✓ +8.7% over session (3.1σ)                    +23
✓ Volume 2.7× the 20-day median                +22
✓ You marked this name High priority          ×1.30
WHY NOT HIGHER
✕ Only 3 of 5 signal families fired           ×0.88
```

---

## Calibration: the thresholds are measured, not guessed

`npm run calibrate` replays the entire chain over real history and measures what would actually have been surfaced. Full report in [`docs/calibration.md`](docs/calibration.md).

| Metric | Value |
|---|---|
| Surfaced instrument-days per name per month | **1.06** (target 1–2) |
| Items in a typical brief | **2.1** (attention budget 5) |
| CRITICAL share of active days | **1.2%** |
| Follow-through vs look-every-day baseline | **1.31×** |

The target is derived from brief size, not picked: for 17 names checked twice weekly, a rate of R puts `17R/8.7` items in a brief. 0.7 feels empty; 2.5 hits the budget every visit.

**The first run said the engine was badly tuned**, and fixing it took three corrections worth reading as a record of what calibration is *for*:

1. The squash curve mapped a 2σ move — 5% of sessions — to 58 points. **26% of all events rated CRITICAL.**
2. Full weight renormalisation meant any detected event automatically cleared WATCH. `volume_spike` and `move_since_last_seen` surfaced **99.5%** of everything they detected, with no gradation at all. The score measured only the strongest evidence and ignored how *much* there was — silently discarding the product's own thesis.
3. The metric itself was wrong. Coverage is only meaningful at the instrument-**day** level, which is also what the brief ranks. And the original 2–4/month target was unreachable: detectors only fire on 2.35 days/name/month, so it implied showing everything.

Follow-through lift went from 1.03× to 1.31×.

---

## Themes: knowing when *not* to group

Ten alerts saying "semiconductor stock down" is ten times the noise and none of the insight. A theme says what a person would say: *your semis are selling off together, and the market is not.*

Confidence is four stored components, not one opaque number:

```
confidence = 0.35·cohesion + 0.20·timing + 0.20·size + 0.25·distinctness
```

**`distinctness` is a gate, not a vote.** On a day when everything falls, every sector looks like a theme — cohesion, timing and size alone score ~72, clearing any reasonable confidence floor. A move the market explains is not a *weak* sector story; it is *not a sector story at all*. So being specific to the group gets a veto.

The two replay scenarios exist to prove exactly this:

| Scenario | Result |
|---|---|
| **Semis selloff**, 2025-01-27 | Theme fires — 78% distinctness. Narrative: semis *led* a broader decline. |
| **COVID crash**, 27 days of 2020 | **Zero themes.** Narrative: broad market decline. |

Membership also requires a **magnitude** test, not just direction. QCOM closed −0.5% on 2025-01-27 while its sector fell double digits; the sign matched, but the name did not participate, and listing it contradicted its own card, which correctly said it *outperformed*.

---

## Data quality is a first-class feature

Two independent providers, reconciled on every bar.

- Agree within tolerance (0.3% price) → take the higher-trust value, fully confirmed
- Disagree beyond it → keep both, mark **unconfirmed**, degrade confidence with the size of the gap, cap severity so a disputed price can never produce a CRITICAL
- Only one source reported → use it at 0.9 confidence, **confirmed but uncorroborated**

Those last two are different things and the UI says so differently. Collapsing them told users "sources disagree" when only one source had reported — which was simply false.

Volume disagreement is recorded but never marks a bar unconfirmed: vendors legitimately differ on consolidated vs primary-listing volume, and flagging every bar would train people to ignore the badge.

Across the committed dataset that leaves **8 genuine conflicts in 33,616 bars** (0.02%), and 3 bars where the two providers disagree enough to be marked unconfirmed.

**Reconciliation initially reported 68,733 conflicts across 49,714 bars.** It was not finding data problems — it was comparing different units. Twelve Data's close is split-adjusted; Tiingo's is raw; Tiingo's `adjClose` is split *and* dividend adjusted. Every name that had ever split showed ~90% "disagreement" across its pre-split history. Reconstructing Tiingo onto Twelve Data's exact basis using its per-row `splitFactor` brought it to **20 conflicts**.

> A reconciliation system that does not first establish a common unit will confidently report unit mismatches as data quality problems — which is worse than not reconciling at all.

---

## The cursor

`UserWatchState(user, instrument)` holds `lastSeenAt`. Everything "since you last checked" is a range query from there.

- **Loading the brief never advances it.** Otherwise glancing on a phone would silently wipe the brief waiting on a laptop.
- **Recency decay runs from the cursor, not the clock.** Every event past the cursor is unseen *by definition*. Decaying from `now` meant a 5σ move three days into a ten-week absence hit the floor and was filed as noise — precisely what the user came back to learn.
- **Window moves, not daily moves.** "NVDA is down 0.4% today" hides what actually happened: down 8% since you last looked.

**Two ways to clear a card, and they are not the same operation.** *Mark seen* means "I have absorbed this" and moves the cursor, so the next brief measures from now. *Snooze* means "not now" and moves nothing — the window keeps growing and the event returns, with its original timestamp, when the snooze lapses. Conflating them would quietly destroy the thing the product is built around.

The brief therefore reports **three** distinct populations, never folded together:

| | means |
|---|---|
| below your attention budget | the engine flagged it; the budget cut it |
| within normal range | the engine looked and found nothing |
| snoozed | *you* silenced it; still pending, not cleared |

Calling any of these "quiet" would misreport what the engine found, which a product built on filtering cannot afford. Snoozing the last live item shows *"Nothing new"*, not *"your market is quiet"* — the second is a claim about the market that the engine never made.

---

## Architecture

```
   cron ──▶ POST /api/cron/ingest ──▶ [ BullMQ: ingest ] ──▶ worker
                                                              │
                    ┌──────────────┐   ┌──────────────┐       │
   Twelve Data ────▶│   validate   │──▶│  reconcile   │──┐◀───┘
   Tiingo      ────▶│              │   │              │  │
   Finnhub (cal)    └──────────────┘   └──────────────┘  │
                                                          ▼
   ┌───────────────────────────────────────────────┐   Postgres
   │  COMPUTE — once per instrument, for everybody │◀──  bars
   │  [ BullMQ: compute ] — one job per drain      │
   │  features → detectors → scorer → themes       │──▶  events
   └───────────────────────────────────────────────┘     themes
                                                          │
   ┌───────────────────────────────────────────────┐      │
   │  SITREP — per user, at read time              │◀─────┘
   │  cursor → filter → re-weight → rank → budget  │
   └───────────────────────────────────────────────┘
                          │
                     Next.js SSR
```

**The invariant:** features, events and themes are computed **once per instrument** and shared. A user's SITREP is an `O(watchlist)` filter over rows that already exist. Adding users adds fan-out and reads — never analytical work.

The engine (`src/engine/`) is **pure**: no database, no network, no clock. That is what makes it unit-testable against synthetic fixtures, replayable over history, and safe to version-stamp. Calibration, live compute and scenario replay all run the *same* code path — if calibration used a different one, its tuned thresholds would describe a system that was never shipped.

**Stack:** Next.js 16 (App Router, SSR) · TypeScript · Postgres 16 + Prisma 7 · BullMQ on Redis · Tailwind 4 · Vitest · Docker Compose.

The web process only enqueues; the worker does all provider I/O and compute. Redis is **not** on the read path — if it is down the brief still renders and the ops page says so, because a queue that can take the product offline is worse than no queue.

---

## Point-in-time correctness

Replay is only honest if the engine at date *T* sees exactly what it would have seen on *T*. The whole series is in the database, so nothing stops a careless query handing the engine tomorrow's bar and producing a beautifully prescient alert that could never have fired.

`computeFeatures` can only read the array it is given, and proxy series are truncated on date inside it. `src/engine/__tests__/pointInTime.test.ts` asserts output at *T* is identical with and without future bars — including when a large move is deliberately planted after the cut — plus a guard that the output *does* change when the as-of date genuinely advances, so the other assertions cannot pass vacuously.

---

## Testing

133 unit tests, 5 browser journeys, and 30 scored checks against the brief's three minimums.

Every detector has a **firing fixture and a must-not-fire fixture** — a detector that only ever fires is indistinguishable from a broken one, and on a product whose promise is filtering noise, false positives are the expensive failure.

Market data cannot produce "a 3.2σ gap on otherwise calm tape" on demand, so `src/engine/testing/synthetic.ts` generates seeded series with injectable events. Real history is used for calibration; synthetic series prove the detectors respond to the thing they claim to detect.

Several tests exist specifically to pin down bugs that were written and then caught:

- range extremes included the current bar, making a break arithmetically impossible
- sector divergence fired on 0.16% moves (tight residual distributions inflate z-scores)
- the session-move validator rejected 9,008 valid rows across a gap in the series
- a 2:1 split deliberately passes the validator — documented as a limitation rather than faked

The browser suite is deliberately thin: four journeys covering the three
minimums plus replay. Broad UI coverage of a product whose logic already has 133
unit tests would be slow to run, slower to maintain, and would mostly re-test
React. It did earn its place immediately though — it caught the acknowledge
button hiding a card optimistically without ever re-reading the brief, so the
cursor and the screen disagreed until the next navigation.

---

## Deliberately not built

Named because they were decisions, not oversights.

**Streaming / real-time.** The product is about *returning later*, not watching ticks. SSE would make the demo busier and the thesis weaker.

**LLM anywhere in the conclusion path.** The narrative is a deterministic rule table over computed facts, and every figure is substituted from a number the engine calculated. A fluent paragraph about someone's money that nobody can trace back to a computation is worse than no paragraph.

**Learned ranking.** Personalisation is two explicit user choices — priority and intent. No cold start, no feedback loop to debug, and the user can always see why their own setting changed the number.

**Earnings in calibration.** Finnhub's free tier serves forward-looking earnings only; historical windows return zero rows. The detector is live-only and its contribution to the attention budget is honestly unmeasured.

---

## Known limitations

- **Backfilling is rate-limited.** Tiingo's free tier allows 50 requests/hour, so a cold backfill of 26 symbols needs two passes an hour apart. `npm run backfill -- --reuse-primary --reuse-secondary` replays whatever is already captured and only fetches what is missing, so re-running costs nothing. During the first pass five symbols were single-source and correctly displayed a `SINGLE SOURCE` badge — degrading visibly rather than silently is the intended behaviour, and the committed fixtures now have full two-source coverage.
- **Daily bars only.** No intraday, so "since you last checked" resolves to trading days.
- **Split adjustment is trusted to the provider.** The validator is a gross-corruption backstop, not a corporate-actions engine.
- **Universe is fixed at 26 symbols.** Adding arbitrary tickers means backfilling them first.

---

## Where the interesting problems were

1. **Two providers, two adjustment bases** — 68,733 phantom conflicts until the units were reconciled.
2. **Calibrating an attention budget** rather than an accuracy score, and discovering the first metric measured the wrong unit entirely.
3. **Making corroboration count** without punishing a lone extreme signal — the coverage exponent.
4. **Knowing when not to detect a theme**, which needed a veto rather than a weight.
5. **Recency decay from a cursor rather than a clock**, which is the difference between a returning user's brief being useful and being empty.
