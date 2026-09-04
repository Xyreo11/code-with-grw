# Calibration report

Generated 2026-09-04 · engine `v1` · scorer `v1`

Window: **2023-01-01 → present** · 17 equities · 2591 events across 1750 active instrument-days

## The number being tuned

**1.09 surfaced instrument-days per name per month** (target 1–2) — within budget

For the reference user (17 names, ~8.7 visits/month) that is **2.1 items in a typical brief**, against an attention budget of 5.

The unit is an instrument-DAY, not an event: a day on which three
detectors fire on one name is a single interruption, not three.
"Surfaced" means the day reached CRITICAL, IMPORTANT or WATCH. INFO and
NOISE days are stored but never shown, so they spend no attention.

The target is an attention budget rather than an accuracy figure. A
watchlist that interrupts someone twenty times a month is one they stop
opening, regardless of how correct each alert was.

## Severity distribution

| Severity | Instrument-days | Share |
|---|---:|---:|
| CRITICAL | 28 | 1.6% |
| IMPORTANT | 173 | 9.9% |
| WATCH | 614 | 35.1% |
| INFO | 389 | 22.2% |
| NOISE | 546 | 31.2% |

## By detector

| Detector | Fired | On a surfaced day | Share |
|---|---:|---:|---:|
| `range_break` | 888 | 285 | 32.1% |
| `sector_divergence` | 765 | 528 | 69.0% |
| `volume_spike` | 438 | 430 | 98.2% |
| `move_since_last_seen` | 370 | 343 | 92.7% |
| `vol_regime_shift` | 130 | 33 | 25.4% |

## Follow-through (precision proxy)

Share of surfaced events followed by a ≥1.5σ move within 3 sessions:

- **surfaced events: 19.9%** (162/814)
- every session, as a baseline: 15.3% (2385/15606)

Lift over "look every day": **1.30×**

This is a proxy, not ground truth — nobody labelled these events, and
"did the user care?" cannot be measured before the product has users.
What it does test is whether an alert carried information about the
near future rather than restating noise that had already passed. A lift
at or below 1.0 would mean the engine is no better than looking daily.

## Per symbol

| Symbol | Events | Active days | Surfaced days | Per month |
|---|---:|---:|---:|---:|
| AVGO | 167 | 108 | 64 | 1.45 |
| ORCL | 205 | 133 | 60 | 1.36 |
| AAPL | 162 | 108 | 59 | 1.34 |
| QCOM | 164 | 111 | 57 | 1.30 |
| INTC | 164 | 104 | 54 | 1.23 |
| ADBE | 168 | 110 | 54 | 1.23 |
| PLTR | 160 | 102 | 51 | 1.16 |
| NFLX | 137 | 88 | 50 | 1.14 |
| CRM | 165 | 108 | 49 | 1.11 |
| META | 149 | 104 | 45 | 1.02 |
| MU | 151 | 107 | 44 | 1.00 |
| AMD | 153 | 106 | 43 | 0.98 |
| GOOGL | 139 | 94 | 41 | 0.93 |
| MSFT | 138 | 99 | 40 | 0.91 |
| AMZN | 122 | 79 | 38 | 0.86 |
| NVDA | 120 | 93 | 33 | 0.75 |
| TSLA | 127 | 96 | 33 | 0.75 |

## Parameters in force

```
detector thresholds
  moveSigmas                       2.5
  rvol                             2.5
  sectorDivergenceZ                2
  sectorDivergenceMinVolFraction   0.5
  rangeBreakAtr                    0.5
  volRegimeRatio                   2
  earningsHours                    48

scorer family weights
  event                            0.28
  relative                         0.24
  price                            0.22
  volume                           0.14
  volatility                       0.12
```

## Known limitation

The `earnings_upcoming` detector is absent from these numbers. The free
Finnhub tier serves forward-looking earnings dates only — historical
windows return zero rows — so there is no historical calendar to
calibrate against. That detector is live-only, and its contribution to
the attention budget is therefore not measured here.
