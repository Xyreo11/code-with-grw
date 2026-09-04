import { clamp, correlation, mean } from './math'

/**
 * Theme detection: turning a list of independent events into one story.
 *
 * Ten separate alerts saying "semiconductor stock down" is ten times the noise
 * and none of the insight. A theme says the thing a person would actually say:
 * "your semis are selling off together, and the market is not."
 *
 * The hard part is not grouping — it is knowing when NOT to. On a day when
 * everything falls, every sector looks like a theme, and a system that labels
 * that "semiconductor selling pressure" is actively misleading. `distinctness`
 * exists for exactly that case and is what the COVID-scenario test asserts.
 */

export interface ThemeMember {
  symbol: string
  sector: string
  direction: -1 | 0 | 1
  /** `YYYY-MM-DD` of the member's triggering event. */
  marketTime: string
  score: number
  /**
   * Residual return series vs the market factor, most recent last.
   * Cohesion is the mean pairwise correlation across these.
   */
  residualSeries: number[]
  /** The member's total return on the event day. */
  ret: number
  /**
   * That return in units of the member's own daily volatility.
   *
   * Membership needs a magnitude test, not just a direction test. On
   * 2025-01-27 QCOM closed -0.5% while its sector fell double digits: the sign
   * is negative, but the name plainly did not participate in the selling, and
   * listing it as a member of a "selling pressure" theme contradicts its own
   * card, which correctly reported that it OUTPERFORMED its sector.
   */
  moveSigmas: number
  /** The part of that return the market factor explains (beta x market return). */
  marketExplained: number
}

export interface ThemeConfidence {
  /** 0-100 overall. */
  confidence: number
  /** Do the members actually move together, historically? */
  cohesion: number
  /** Did their events happen at the same time, or straggle across the window? */
  timing: number
  /** Are there enough of them to be a pattern rather than a coincidence? */
  size: number
  /** Is this specific to the group, or is the whole market doing it? */
  distinctness: number
}

export interface DetectedTheme extends ThemeConfidence {
  scope: 'sector'
  scopeKey: string
  members: string[]
  direction: -1 | 1
  windowStart: string
  windowEnd: string
  memberCount: number
  characteristics: string[]
  summary: string
}

/** Weights for the four confidence components. Sum to 1. */
export const CONFIDENCE_WEIGHTS = {
  cohesion: 0.35,
  timing: 0.2,
  size: 0.2,
  distinctness: 0.25,
} as const

/** Below this many co-moving names it is a coincidence, not a theme. */
export const MIN_THEME_MEMBERS = 3

/**
 * How far a name must actually move to count as taking part in a theme.
 *
 * Without this, any name closing fractionally in the theme's direction is
 * swept in, which both overstates the theme's size and produces cards that
 * contradict each other.
 */
export const MIN_MEMBER_MOVE_SIGMAS = 1.0

/** Themes below this confidence are not shown. */
export const MIN_THEME_CONFIDENCE = 45

/**
 * Distinctness is a GATE, not merely a weighted term.
 *
 * In a weighted sum, a tight simultaneous cluster scores ~70 on cohesion,
 * timing and size alone — so a market-wide crash, where every sector moves
 * together perfectly, would be reported as a high-confidence sector theme with
 * distinctness contributing almost nothing to stop it.
 *
 * That is backwards. A move the market explains does not make a weak sector
 * story; it makes it *not a sector story at all*. Being specific to the group
 * is part of the definition of a sector theme, so it gets a veto rather than a
 * vote.
 */
export const MIN_THEME_DISTINCTNESS = 0.35

/** `size` saturates here: five names is as much corroboration as we need. */
const SIZE_SATURATION = 5

export function confidenceBand(confidence: number): 'High' | 'Medium' | 'Low' {
  if (confidence >= 75) return 'High'
  if (confidence >= 50) return 'Medium'
  return 'Low'
}

/**
 * Score a candidate group of co-moving names.
 *
 * Every component is computed from data we already have, and all four are
 * stored on the theme so the UI can explain a theme the same way it explains an
 * event. A single opaque "91%" would be exactly the kind of unearned precision
 * this product is supposed to avoid.
 */
export function computeThemeConfidence(
  members: ThemeMember[],
  windowStart: string,
  windowEnd: string,
): ThemeConfidence {
  // --- cohesion: do these names genuinely travel together? ------------------
  // Correlation of RESIDUALS, not raw returns. Two mega-caps both tracking the
  // market are trivially correlated; that tells us nothing about a shared
  // sector story. What matters is whether the parts the market cannot explain
  // move together.
  const series = members.map((m) => m.residualSeries).filter((s) => s.length >= 20)
  let cohesion = 0
  if (series.length >= 2) {
    const n = Math.min(...series.map((s) => s.length))
    const trimmed = series.map((s) => s.slice(s.length - n))
    let total = 0
    let pairs = 0
    for (let i = 0; i < trimmed.length; i++) {
      for (let j = i + 1; j < trimmed.length; j++) {
        const c = correlation(trimmed[i], trimmed[j])
        if (c !== null) {
          total += c
          pairs++
        }
      }
    }
    // Negative correlation is not evidence of a shared theme, so the floor is 0.
    cohesion = pairs > 0 ? clamp(total / pairs, 0, 1) : 0
  }

  // --- timing: did this happen at once, or dribble out? ---------------------
  const times = members.map((m) => Date.parse(`${m.marketTime}T00:00:00Z`))
  const windowMs =
    Date.parse(`${windowEnd}T00:00:00Z`) - Date.parse(`${windowStart}T00:00:00Z`)
  const spread = Math.max(...times) - Math.min(...times)
  const timing =
    windowMs > 0 ? clamp(1 - spread / windowMs, 0, 1) : 1

  // --- size: enough names to be a pattern? ---------------------------------
  const size = clamp(members.length / SIZE_SATURATION, 0, 1)

  // --- distinctness: is this the group, or the whole market? ---------------
  // The component that stops a market-wide crash being reported as a sector
  // story. When the market factor explains most of the move, this collapses
  // and drags the confidence below the display threshold.
  const meanRet = mean(members.map((m) => Math.abs(m.ret))) ?? 0
  const meanExplained = mean(members.map((m) => Math.abs(m.marketExplained))) ?? 0
  const explainedShare = meanRet > 1e-9 ? meanExplained / meanRet : 1
  const distinctness = clamp(1 - explainedShare, 0, 1)

  const confidence =
    100 *
    (CONFIDENCE_WEIGHTS.cohesion * cohesion +
      CONFIDENCE_WEIGHTS.timing * timing +
      CONFIDENCE_WEIGHTS.size * size +
      CONFIDENCE_WEIGHTS.distinctness * distinctness)

  return {
    confidence: round1(confidence),
    cohesion: round3(cohesion),
    timing: round3(timing),
    size: round3(size),
    distinctness: round3(distinctness),
  }
}

/**
 * Group same-direction events by sector and keep the groups that clear both the
 * member floor and the confidence floor.
 */
export function detectThemes(
  members: ThemeMember[],
  windowStart: string,
  windowEnd: string,
): DetectedTheme[] {
  const groups = new Map<string, ThemeMember[]>()

  for (const m of members) {
    if (m.direction === 0) continue
    if (!m.sector) continue
    // Direction alone is not participation.
    if (Math.abs(m.moveSigmas) < MIN_MEMBER_MOVE_SIGMAS) continue
    const key = `${m.sector}|${m.direction}`
    const list = groups.get(key) ?? []
    list.push(m)
    groups.set(key, list)
  }

  const themes: DetectedTheme[] = []

  for (const [key, group] of groups) {
    if (group.length < MIN_THEME_MEMBERS) continue

    const [sector, dirStr] = key.split('|')
    const direction = Number(dirStr) as -1 | 1
    const conf = computeThemeConfidence(group, windowStart, windowEnd)

    // The veto comes first: if the market explains the move, this is weather,
    // not a sector story, however tight and simultaneous it looks.
    if (conf.distinctness < MIN_THEME_DISTINCTNESS) continue
    if (conf.confidence < MIN_THEME_CONFIDENCE) continue

    const ranked = [...group].sort((a, b) => b.score - a.score)

    themes.push({
      ...conf,
      scope: 'sector',
      scopeKey: sector,
      direction,
      members: ranked.map((m) => m.symbol),
      memberCount: group.length,
      windowStart,
      windowEnd,
      characteristics: describeCharacteristics(group, conf),
      summary: summarise(sector, direction, ranked, conf),
    })
  }

  return themes.sort((a, b) => b.confidence - a.confidence)
}

function describeCharacteristics(
  members: ThemeMember[],
  conf: ThemeConfidence,
): string[] {
  const out: string[] = []

  if (conf.timing >= 0.8) out.push('Similar timing')
  else out.push('Developed over several sessions')

  if (conf.cohesion >= 0.5) out.push('These names historically move together')

  if (conf.distinctness >= 0.6) {
    out.push('Not explained by the broader market')
  } else if (conf.distinctness <= 0.35) {
    out.push('Largely tracks a broader market move')
  }

  const avgMove =
    (mean(members.map((m) => Math.abs(m.ret))) ?? 0) * 100
  if (avgMove > 0) out.push(`Average move ${avgMove.toFixed(1)}%`)

  return out
}

function summarise(
  sector: string,
  direction: -1 | 1,
  ranked: ThemeMember[],
  conf: ThemeConfidence,
): string {
  const word = direction < 0 ? 'selling pressure' : 'strength'
  const lead = ranked[0]?.symbol
  const qualifier =
    conf.distinctness >= 0.6
      ? ' It is specific to these names rather than the broader market.'
      : ''
  return `${ranked.length} of your ${sector} names moved together, led by ${lead}.${qualifier}`.replace(
    'moved together',
    `showed ${word}`,
  )
}

function round1(x: number): number {
  return Math.round(x * 10) / 10
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}
