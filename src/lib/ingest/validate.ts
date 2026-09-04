import type { RawBar } from '../sources/types'

/**
 * Bar validation.
 *
 * Runs before reconciliation, because a bar that is internally impossible should
 * never get as far as being compared against another source. Every rejection
 * carries a reason and is written to the dead-letter table — silently dropping
 * rows would make a data outage look like a quiet market, which is the single
 * most dangerous failure mode this product has.
 */

export interface ValidationReject {
  bar: RawBar
  reason: string
}

export interface ValidationResult {
  valid: RawBar[]
  rejected: ValidationReject[]
}

/**
 * Largest single-session move treated as plausible.
 *
 * This is a backstop against gross data corruption, NOT a split detector, and
 * the distinction matters. A 2:1 split — the most common ratio — produces
 * exactly a 50% drop, which is indistinguishable by magnitude from a real
 * collapse; small biotechs genuinely fall that far on a failed trial. No
 * threshold separates the two cleanly.
 *
 * Split adjustment is therefore the provider's responsibility: both Twelve Data
 * and Tiingo return split-adjusted daily series, and `closeAdj` carries it.
 * What this catches is the unambiguous case — a price that moved further in one
 * session than any real security plausibly does, which means the row is
 * corrupt rather than merely dramatic.
 */
const MAX_DAILY_MOVE = 0.6

export function validateBars(bars: RawBar[]): ValidationResult {
  const valid: RawBar[] = []
  const rejected: ValidationReject[] = []

  const seenDates = new Set<string>()
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date))

  let previousClose: number | null = null

  for (const bar of sorted) {
    const reason = firstProblem(bar, seenDates)
    if (reason) {
      rejected.push({ bar, reason })
      continue
    }

    if (previousClose !== null) {
      const move = Math.abs(bar.close / previousClose - 1)
      if (move > MAX_DAILY_MOVE) {
        rejected.push({
          bar,
          reason: `implausible ${(move * 100).toFixed(0)}% session move — treating the row as corrupt`,
        })
        continue
      }
    }

    seenDates.add(bar.date)
    valid.push(bar)
    previousClose = bar.close
  }

  return { valid, rejected }
}

function firstProblem(bar: RawBar, seenDates: Set<string>): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.date)) {
    return `malformed date "${bar.date}"`
  }
  if (seenDates.has(bar.date)) {
    return `duplicate bar for ${bar.date}`
  }

  const numbers: Array<[string, number]> = [
    ['open', bar.open],
    ['high', bar.high],
    ['low', bar.low],
    ['close', bar.close],
    ['closeAdj', bar.closeAdj],
  ]

  for (const [name, value] of numbers) {
    if (!Number.isFinite(value)) return `${name} is not a finite number`
    if (value <= 0) return `${name} must be positive, got ${value}`
  }

  if (!Number.isFinite(bar.volume) || bar.volume < 0) {
    return `volume must be zero or positive, got ${bar.volume}`
  }

  // Internal consistency: the day's range must actually contain its own prices.
  if (bar.high < bar.low) return 'high is below low'
  if (bar.high < bar.open || bar.high < bar.close) return 'high is below open or close'
  if (bar.low > bar.open || bar.low > bar.close) return 'low is above open or close'

  const future = new Date()
  future.setUTCDate(future.getUTCDate() + 1)
  if (bar.date > future.toISOString().slice(0, 10)) {
    return `bar is dated in the future (${bar.date})`
  }

  return null
}
