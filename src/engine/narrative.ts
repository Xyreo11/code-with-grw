import type { DetectedTheme } from './theme'

/**
 * The market narrative — "THE STORY".
 *
 * Deterministic rules over structured facts. No language model is involved in
 * reaching a conclusion, and every number in the output is substituted from a
 * computed value rather than generated. That constraint is the point: a
 * plausible-sounding sentence about someone's money that no one can trace back
 * to a calculation is worse than no sentence at all.
 *
 * An optional LLM pass may later rephrase the text, but it may only ever see
 * facts already established here and may not introduce new ones.
 */

export interface NarrativeInput {
  themes: DetectedTheme[]
  /** Sectors of the top-ranked attention events, most important first. */
  topEventSectors: string[]
  /** Market benchmark move on the day, and how unusual it is. */
  marketReturn: number
  marketSigmas: number
  /** Share of the watchlist that moved more than 1 sigma, 0..1. */
  breadth: number
  watchlistSize: number
  /** Count of events at WATCH severity or above. */
  notableCount: number
}

export interface Narrative {
  /** Which rule fired. Stored so the output is auditable after the fact. */
  ruleId: string
  text: string
  inputs: Record<string, unknown>
}

const BROAD_MARKET_SIGMAS = 1.5
const CALM_MARKET_SIGMAS = 0.5
const BROAD_BREADTH = 0.6

/**
 * Rules are evaluated in order and the first match wins, so they are arranged
 * most-specific first. Each returns `null` when it does not apply.
 */
type Rule = (input: NarrativeInput) => Narrative | null

const quietRule: Rule = (i) => {
  if (i.notableCount > 0) return null
  return {
    ruleId: 'quiet',
    text: `Nothing in your watchlist needs attention. All ${i.watchlistSize} names moved within their normal range.`,
    inputs: { notableCount: i.notableCount, watchlistSize: i.watchlistSize },
  }
}

const rotationRule: Rule = (i) => {
  const up = i.themes.filter((t) => t.direction === 1)
  const down = i.themes.filter((t) => t.direction === -1)
  if (up.length === 0 || down.length === 0) return null

  const strongestUp = up[0]
  const strongestDown = down[0]

  return {
    ruleId: 'sector_rotation',
    text:
      `Your watchlist is splitting by sector. ${strongestDown.scopeKey} names are under pressure ` +
      `while ${strongestUp.scopeKey} names are holding up. That pattern usually reflects rotation ` +
      `between sectors rather than a change in overall market direction.`,
    inputs: {
      up: strongestUp.scopeKey,
      down: strongestDown.scopeKey,
      themeCount: i.themes.length,
    },
  }
}

const sectorSpecificRule: Rule = (i) => {
  const theme = i.themes[0]
  if (!theme) return null

  // The theme must dominate what we are actually showing the user...
  const top5 = i.topEventSectors.slice(0, 5)
  const shareOfTop = top5.filter((s) => s === theme.scopeKey).length
  if (shareOfTop < 3) return null

  // ...and the market must be calm, otherwise this is not sector-specific at all.
  if (Math.abs(i.marketSigmas) >= CALM_MARKET_SIGMAS) return null

  const word = theme.direction < 0 ? 'weakness' : 'strength'
  return {
    ruleId: 'sector_specific',
    text:
      `Your watchlist is experiencing concentrated ${theme.scopeKey} ${word}. ` +
      `${shareOfTop} of your top ${top5.length} attention events are ${theme.scopeKey} names, ` +
      `but the broader market is close to flat (${fmtPct(i.marketReturn)}). ` +
      `This looks like sector-specific pressure rather than a broad market move.`,
    inputs: {
      sector: theme.scopeKey,
      shareOfTop,
      marketReturn: i.marketReturn,
      marketSigmas: i.marketSigmas,
      themeConfidence: theme.confidence,
    },
  }
}

const broadMarketRule: Rule = (i) => {
  if (i.breadth < BROAD_BREADTH) return null
  if (Math.abs(i.marketSigmas) < BROAD_MARKET_SIGMAS) return null

  const dir = i.marketReturn < 0 ? 'lower' : 'higher'
  return {
    ruleId: 'broad_market',
    text:
      `This is a broad market move, not a story about any one of your names. ` +
      `The market is ${fmtPct(i.marketReturn)} (${Math.abs(i.marketSigmas).toFixed(1)}σ) and ` +
      `${Math.round(i.breadth * 100)}% of your watchlist moved with it. ` +
      `Individual moves are mostly explained by the market being ${dir}.`,
    inputs: {
      breadth: i.breadth,
      marketReturn: i.marketReturn,
      marketSigmas: i.marketSigmas,
    },
  }
}

const singleThemeRule: Rule = (i) => {
  const theme = i.themes[0]
  if (!theme) return null

  const word = theme.direction < 0 ? 'selling pressure' : 'strength'
  const marketNote =
    Math.abs(i.marketSigmas) < CALM_MARKET_SIGMAS
      ? ' The broader market is close to flat.'
      : ` The broader market is ${fmtPct(i.marketReturn)}.`

  return {
    ruleId: 'single_theme',
    text:
      `${theme.memberCount} of your ${theme.scopeKey} names are showing ${word} ` +
      `(${theme.confidence.toFixed(0)}% confidence).${marketNote}`,
    inputs: {
      sector: theme.scopeKey,
      memberCount: theme.memberCount,
      confidence: theme.confidence,
      marketSigmas: i.marketSigmas,
    },
  }
}

const scatteredRule: Rule = (i) => ({
  ruleId: 'scattered',
  text:
    `${i.notableCount} name${i.notableCount === 1 ? '' : 's'} in your watchlist ` +
    `need${i.notableCount === 1 ? 's' : ''} attention, but they do not share a common driver. ` +
    `These look like independent, company-specific moves.`,
  inputs: { notableCount: i.notableCount, themeCount: i.themes.length },
})

/** Most specific first; the first rule that applies wins. */
const RULES: Rule[] = [
  quietRule,
  rotationRule,
  sectorSpecificRule,
  broadMarketRule,
  singleThemeRule,
  scatteredRule,
]

export function buildNarrative(input: NarrativeInput): Narrative {
  for (const rule of RULES) {
    const result = rule(input)
    if (result) return result
  }
  // scatteredRule always matches, so this is unreachable in practice.
  return scatteredRule(input)!
}

function fmtPct(x: number): string {
  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`
}
