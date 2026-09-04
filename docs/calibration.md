# Calibration report

Generated 2026-09-04 · engine `v1` · scorer `v1`

Window: **2023-01-01 → present** · 17 equities · 2602 events across 1758 active instrument-days

## The number being tuned

**1.06 surfaced instrument-days per name per month** (target 1–2) — within budget

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
| CRITICAL | 21 | 1.2% |
| IMPORTANT | 165 | 9.4% |
| WATCH | 607 | 34.5% |
| INFO | 418 | 23.8% |
| NOISE | 547 | 31.1% |

## By detector

| Detector | Fired | On a surfaced day | Share |
|---|---:|---:|---:|
| `range_break` | 888 | 281 | 31.6% |
| `sector_divergence` | 776 | 516 | 66.5% |
| `volume_spike` | 438 | 430 | 98.2% |
| `move_since_last_seen` | 370 | 334 | 90.3% |
| `vol_regime_shift` | 130 | 33 | 25.4% |

## Follow-through (precision proxy)

Share of surfaced events followed by a ≥1.5σ move within 3 sessions:

- **surfaced events: 19.9%** (158/792)
- every session, as a baseline: 15.3% (2385/15606)

Lift over "look every day": **1.31×**

This is a proxy, not ground truth — nobody labelled these events, and
"did the user care?" cannot be measured before the product has users.
What it does test is whether an alert carried information about the
near future rather than restating noise that had already passed. A lift
at or below 1.0 would mean the engine is no better than looking daily.

## Per symbol

| Symbol | Events | Active days | Surfaced days | Per month |
|---|---:|---:|---:|---:|
| AVGO | 168 | 108 | 65 | 1.48 |
| AAPL | 163 | 109 | 60 | 1.36 |
| ORCL | 205 | 133 | 60 | 1.36 |
| QCOM | 164 | 111 | 57 | 1.30 |
| INTC | 165 | 104 | 54 | 1.23 |
| ADBE | 168 | 110 | 54 | 1.23 |
| PLTR | 160 | 102 | 51 | 1.16 |
| CRM | 165 | 108 | 49 | 1.11 |
| NFLX | 137 | 88 | 48 | 1.09 |
| MU | 152 | 108 | 45 | 1.02 |
| AMD | 152 | 106 | 43 | 0.98 |
| MSFT | 138 | 99 | 40 | 0.91 |
| META | 149 | 104 | 40 | 0.91 |
| AMZN | 123 | 80 | 34 | 0.77 |
| NVDA | 120 | 93 | 33 | 0.75 |
| GOOGL | 142 | 97 | 32 | 0.73 |
| TSLA | 131 | 98 | 28 | 0.64 |

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
