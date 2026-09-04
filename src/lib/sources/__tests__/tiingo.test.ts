import { describe, expect, it } from 'vitest'
import { parseTiingo, toSplitAdjusted } from '../tiingo'
import { parseTwelveData } from '../twelvedata'

/**
 * These tests exist because of a real defect: reconciliation initially reported
 * 68,733 conflicts across 49,714 bars — 28% of the dataset "unconfirmed" —
 * purely because the two providers were on different adjustment bases. Every
 * name that had ever split showed a ~90% disagreement on its pre-split history,
 * while names that had not split showed none.
 *
 * The lesson worth encoding: a reconciliation system that does not first
 * establish a common unit will confidently report unit mismatches as data
 * quality problems, which is worse than not reconciling at all.
 */

describe('toSplitAdjusted', () => {
  it('divides pre-split prices by the cumulative factor', () => {
    // A 10:1 split effective 2024-06-10. The split-day row is already
    // post-split; only older rows are restated.
    const rows = [
      { date: '2024-06-07', open: 500, high: 505, low: 495, close: 500, volume: 1_000_000, splitFactor: 1 },
      { date: '2024-06-10', open: 50, high: 51, low: 49, close: 50, volume: 10_000_000, splitFactor: 10 },
      { date: '2024-06-11', open: 51, high: 52, low: 50, close: 51, volume: 9_000_000, splitFactor: 1 },
    ]

    const bars = toSplitAdjusted(rows)

    expect(bars[0].close).toBeCloseTo(50, 6)
    expect(bars[1].close).toBeCloseTo(50, 6)
    expect(bars[2].close).toBeCloseTo(51, 6)
  })

  it('scales volume inversely, since share counts move opposite to price', () => {
    const rows = [
      { date: '2024-06-07', open: 500, high: 505, low: 495, close: 500, volume: 1_000_000, splitFactor: 1 },
      { date: '2024-06-10', open: 50, high: 51, low: 49, close: 50, volume: 10_000_000, splitFactor: 10 },
    ]
    const bars = toSplitAdjusted(rows)
    expect(bars[0].volume).toBeCloseTo(10_000_000, 0)
  })

  it('compounds multiple splits', () => {
    const rows = [
      { date: '2020-01-02', open: 400, high: 400, low: 400, close: 400, volume: 100, splitFactor: 1 },
      { date: '2021-01-04', open: 200, high: 200, low: 200, close: 200, volume: 200, splitFactor: 2 },
      { date: '2022-01-03', open: 100, high: 100, low: 100, close: 100, volume: 400, splitFactor: 2 },
    ]
    const bars = toSplitAdjusted(rows)
    // 400 restated through two 2:1 splits -> 100.
    expect(bars[0].close).toBeCloseTo(100, 6)
    expect(bars[1].close).toBeCloseTo(100, 6)
    expect(bars[2].close).toBeCloseTo(100, 6)
  })

  it('leaves an unsplit series untouched', () => {
    const rows = [
      { date: '2024-06-07', open: 100, high: 101, low: 99, close: 100, volume: 500, splitFactor: 1 },
      { date: '2024-06-10', open: 101, high: 102, low: 100, close: 101, volume: 600, splitFactor: 1 },
    ]
    const bars = toSplitAdjusted(rows)
    expect(bars[0].close).toBe(100)
    expect(bars[1].close).toBe(101)
    expect(bars[0].volume).toBe(500)
  })
})

describe('provider bases agree after reconstruction', () => {
  it('reproduces Twelve Data’s split-adjusted close from Tiingo raw + splitFactor', () => {
    // Real captured values for NVDA 2024-01-02, pre the 10:1 split of
    // 2024-06-10. Twelve Data reports 48.168; Tiingo reports a raw close of
    // 481.68 with adjClose 48.0839 (which also removes dividends, so it does
    // NOT match Twelve Data).
    const tiingoRows = [
      {
        date: '2024-01-02T00:00:00.000Z',
        open: 492.44,
        high: 492.95,
        low: 475.95,
        close: 481.68,
        volume: 41_125_422,
        adjClose: 48.0839765887,
        splitFactor: 1,
      },
      {
        date: '2024-06-10T00:00:00.000Z',
        open: 120,
        high: 122,
        low: 118,
        close: 121,
        volume: 300_000_000,
        splitFactor: 10,
      },
    ]

    const tiingoBars = parseTiingo(tiingoRows, 'NVDA')

    const twelveDataBars = parseTwelveData(
      {
        values: [
          {
            datetime: '2024-01-02',
            open: '49.24400',
            high: '49.29500',
            low: '47.59500',
            close: '48.16800',
            volume: '411254000',
          },
        ],
      },
      'NVDA',
    )

    const tg = tiingoBars.find((b) => b.date === '2024-01-02')!
    const td = twelveDataBars.find((b) => b.date === '2024-01-02')!

    // The whole point: these now agree to well inside the 0.3% price tolerance.
    const delta = Math.abs(tg.close / td.close - 1)
    expect(delta).toBeLessThan(0.003)

    // And the naive comparisons that caused the original 28% failure rate do not.
    expect(Math.abs(481.68 / td.close - 1)).toBeGreaterThan(0.5)
    expect(Math.abs(48.0839765887 / td.close - 1)).toBeGreaterThan(0.0015)
  })
})

describe('parseTwelveData', () => {
  it('surfaces an error body even though it arrives with HTTP 200', () => {
    // Twelve Data signals rate limits and unknown symbols in the JSON body with
    // a 200 status, so trusting the status code alone silently yields zero bars.
    expect(() =>
      parseTwelveData(
        { status: 'error', code: 429, message: 'API credits exceeded' },
        'AAPL',
      ),
    ).toThrow(/API credits exceeded/)
  })

  it('rejects an empty value set rather than returning nothing', () => {
    expect(() => parseTwelveData({ values: [] }, 'AAPL')).toThrow(/no values/)
  })

  it('returns bars in ascending date order', () => {
    const bars = parseTwelveData(
      {
        values: [
          { datetime: '2024-01-03', open: '2', high: '2', low: '2', close: '2', volume: '1' },
          { datetime: '2024-01-02', open: '1', high: '1', low: '1', close: '1', volume: '1' },
        ],
      },
      'AAPL',
    )
    expect(bars.map((b) => b.date)).toEqual(['2024-01-02', '2024-01-03'])
  })
})
