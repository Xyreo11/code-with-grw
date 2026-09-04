/**
 * The demo universe.
 *
 * Deliberately tech-heavy: the six semiconductor names against SOXX are what
 * make theme detection demonstrable. A theme needs several instruments that
 * genuinely co-move for the right reason, and semis are the cleanest such
 * cluster in US large-cap.
 *
 * Every equity maps to a sector ETF that actually contains it — the relative
 * performance detector regresses against that proxy, so a sloppy mapping would
 * produce sloppy "sector divergence" signals. XLF/XLE/XLV carry no constituents
 * here; they exist so the market-context strip can show breadth outside tech.
 */

export interface InstrumentSeed {
  symbol: string
  name: string
  sector: string | null
  /** Symbol of the sector proxy used for relative-performance regressions. */
  sectorEtf: string | null
  isEtf: boolean
}

/** Market-wide benchmark. Beta and residuals are computed against this. */
export const MARKET_BENCHMARK = 'SPY'

export const BENCHMARKS: InstrumentSeed[] = [
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF', sector: null, sectorEtf: null, isEtf: true },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust', sector: null, sectorEtf: null, isEtf: true },
]

export const SECTOR_ETFS: InstrumentSeed[] = [
  { symbol: 'SOXX', name: 'iShares Semiconductor ETF', sector: 'Semiconductors', sectorEtf: null, isEtf: true },
  { symbol: 'XLK', name: 'Technology Select Sector SPDR', sector: 'Information Technology', sectorEtf: null, isEtf: true },
  { symbol: 'XLC', name: 'Communication Services Select Sector SPDR', sector: 'Communication Services', sectorEtf: null, isEtf: true },
  { symbol: 'XLY', name: 'Consumer Discretionary Select Sector SPDR', sector: 'Consumer Discretionary', sectorEtf: null, isEtf: true },
  { symbol: 'XLF', name: 'Financial Select Sector SPDR', sector: 'Financials', sectorEtf: null, isEtf: true },
  { symbol: 'XLE', name: 'Energy Select Sector SPDR', sector: 'Energy', sectorEtf: null, isEtf: true },
  { symbol: 'XLV', name: 'Health Care Select Sector SPDR', sector: 'Health Care', sectorEtf: null, isEtf: true },
]

export const EQUITIES: InstrumentSeed[] = [
  // Semiconductors -> SOXX. The flagship theme cluster.
  { symbol: 'NVDA', name: 'NVIDIA Corporation', sector: 'Semiconductors', sectorEtf: 'SOXX', isEtf: false },
  { symbol: 'AMD', name: 'Advanced Micro Devices', sector: 'Semiconductors', sectorEtf: 'SOXX', isEtf: false },
  { symbol: 'AVGO', name: 'Broadcom Inc.', sector: 'Semiconductors', sectorEtf: 'SOXX', isEtf: false },
  { symbol: 'MU', name: 'Micron Technology', sector: 'Semiconductors', sectorEtf: 'SOXX', isEtf: false },
  { symbol: 'INTC', name: 'Intel Corporation', sector: 'Semiconductors', sectorEtf: 'SOXX', isEtf: false },
  { symbol: 'QCOM', name: 'QUALCOMM Incorporated', sector: 'Semiconductors', sectorEtf: 'SOXX', isEtf: false },

  // Information Technology -> XLK
  { symbol: 'AAPL', name: 'Apple Inc.', sector: 'Information Technology', sectorEtf: 'XLK', isEtf: false },
  { symbol: 'MSFT', name: 'Microsoft Corporation', sector: 'Information Technology', sectorEtf: 'XLK', isEtf: false },
  { symbol: 'ORCL', name: 'Oracle Corporation', sector: 'Information Technology', sectorEtf: 'XLK', isEtf: false },
  { symbol: 'CRM', name: 'Salesforce, Inc.', sector: 'Information Technology', sectorEtf: 'XLK', isEtf: false },
  { symbol: 'ADBE', name: 'Adobe Inc.', sector: 'Information Technology', sectorEtf: 'XLK', isEtf: false },
  { symbol: 'PLTR', name: 'Palantir Technologies', sector: 'Information Technology', sectorEtf: 'XLK', isEtf: false },

  // Communication Services -> XLC
  { symbol: 'GOOGL', name: 'Alphabet Inc. Class A', sector: 'Communication Services', sectorEtf: 'XLC', isEtf: false },
  { symbol: 'META', name: 'Meta Platforms, Inc.', sector: 'Communication Services', sectorEtf: 'XLC', isEtf: false },
  { symbol: 'NFLX', name: 'Netflix, Inc.', sector: 'Communication Services', sectorEtf: 'XLC', isEtf: false },

  // Consumer Discretionary -> XLY
  { symbol: 'AMZN', name: 'Amazon.com, Inc.', sector: 'Consumer Discretionary', sectorEtf: 'XLY', isEtf: false },
  { symbol: 'TSLA', name: 'Tesla, Inc.', sector: 'Consumer Discretionary', sectorEtf: 'XLY', isEtf: false },
]

/** Every instrument we ingest, benchmarks and proxies first. */
export const UNIVERSE: InstrumentSeed[] = [
  ...BENCHMARKS,
  ...SECTOR_ETFS,
  ...EQUITIES,
]

export const ALL_SYMBOLS = UNIVERSE.map((i) => i.symbol)

/** The names that go on the demo user's watchlist (benchmarks/proxies excluded). */
export const DEMO_WATCHLIST = EQUITIES.map((e) => e.symbol)

/** Stooq addresses US listings as `aapl.us`. */
export function toStooqSymbol(symbol: string): string {
  return `${symbol.toLowerCase()}.us`
}
