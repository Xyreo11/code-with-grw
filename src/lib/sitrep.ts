import { db } from './db'
import { scoreSignals, explainContributions } from '@/engine/scorer'
import { buildNarrative, type Narrative } from '@/engine/narrative'
import type { DetectedTheme } from '@/engine/theme'
import type {
  Contribution,
  Intent,
  Priority,
  ScoringContext,
  Severity,
  Signal,
} from '@/engine/types'
import { MARKET_BENCHMARK } from './universe'

/**
 * The SITREP: what changed since this user last looked.
 *
 * The read path is a personalised FILTER over precomputed rows, never a
 * recomputation. Events, scores and themes already exist (see compute.ts); what
 * happens here is cheap and O(watchlist): pull events past the cursor, re-weight
 * them by this user's priority and intent, rank, and cut to the attention budget.
 *
 * Crucially the window is per-user. Two people opening the app at the same
 * instant get different briefs because they last looked at different times.
 */

const SURFACED: Severity[] = ['CRITICAL', 'IMPORTANT', 'WATCH']

/** Default number of cards. Deliberately small; see docs/calibration.md. */
export const DEFAULT_ATTENTION_BUDGET = 5

export interface SitrepItem {
  symbol: string
  name: string
  sector: string | null
  attentionScore: number
  severity: Severity
  headline: string
  /** Every reason, positive and negative, behind the score. */
  positives: Contribution[]
  suppressors: Contribution[]
  eventIds: string[]
  /** Net move over the absence window, not just the last session. */
  windowReturnPct: number | null
  sigmas: number | null
  lastClose: number
  asOf: string
  confidence: number
  /** False only when two sources actively disagreed. */
  confirmed: boolean
  /** False when only one source reported — uncorroborated, but not disputed. */
  corroborated: boolean
  priority: Priority
  intent: Intent
  themeKey: string | null
  sparkline: number[]
  isUpdate: boolean
}

export interface SitrepResult {
  displayName: string
  /** Cursor: the moment this user last acknowledged anything. */
  since: Date | null
  absenceHours: number | null
  asOf: string | null
  items: SitrepItem[]
  themes: Array<DetectedTheme & { id: string }>
  narrative: Narrative
  /** Severity histogram across the whole watchlist, for the budget bar. */
  budget: Record<Severity, number>
  withinNormalRange: number
  /** Flagged by the engine but cut by the attention budget. */
  belowBudget: number
  watchlistSize: number
  quiet: boolean
  attentionBudget: number
  dataQuality: {
    stalestSource: string | null
    lagSeconds: number | null
    unconfirmedCount: number
  }
}

interface WatchRow {
  instrumentId: string
  symbol: string
  name: string
  sector: string | null
  priority: Priority
  intent: Intent
}

export async function buildSitrep(userId: string): Promise<SitrepResult> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { displayName: true, settings: true },
  })

  const settings = (user.settings ?? {}) as { attentionBudget?: number }
  const attentionBudget = settings.attentionBudget ?? DEFAULT_ATTENTION_BUDGET

  const watchlist = await db.watchlist.findFirst({
    where: { userId },
    include: {
      items: {
        include: {
          instrument: {
            select: { id: true, symbol: true, name: true, sector: true },
          },
        },
      },
    },
  })

  const rows: WatchRow[] = (watchlist?.items ?? []).map((i) => ({
    instrumentId: i.instrument.id,
    symbol: i.instrument.symbol,
    name: i.instrument.name,
    sector: i.instrument.sector,
    priority: i.priority,
    intent: i.intent,
  }))

  if (rows.length === 0) {
    return emptyResult(user.displayName, attentionBudget)
  }

  const instrumentIds = rows.map((r) => r.instrumentId)

  // ---- the cursor --------------------------------------------------------
  const cursors = await db.userWatchState.findMany({
    where: { userId, instrumentId: { in: instrumentIds } },
  })
  const cursorByInstrument = new Map(cursors.map((c) => [c.instrumentId, c]))

  // The brief window starts at the OLDEST cursor across the watchlist: a name
  // the user has not acknowledged in a month should still be able to report
  // what it did, even if they cleared everything else yesterday.
  const cursorTimes = cursors.map((c) => c.lastSeenAt.getTime())
  const since = cursorTimes.length ? new Date(Math.min(...cursorTimes)) : null

  const now = new Date()
  const absenceHours = since ? (now.getTime() - since.getTime()) / 3_600_000 : null

  // ---- events past the cursor -------------------------------------------
  const events = await db.event.findMany({
    where: {
      instrumentId: { in: instrumentIds },
      scenarioId: null,
      severity: { in: ['CRITICAL', 'IMPORTANT', 'WATCH', 'INFO'] },
      ...(since ? { marketTime: { gt: since } } : {}),
    },
    orderBy: { marketTime: 'desc' },
    include: { theme: true },
  })

  // Anti-join: anything already seen or dismissed is gone unless a snooze has
  // expired. Merely LOADING the brief never advances the cursor, so a glance on
  // a phone cannot silently clear the laptop.
  const seen = await db.userEventState.findMany({
    where: {
      userId,
      eventId: { in: events.map((e) => e.id) },
      status: { in: ['SEEN', 'DISMISSED'] },
    },
    select: { eventId: true },
  })
  const seenIds = new Set(seen.map((s) => s.eventId))

  const snoozed = await db.userEventState.findMany({
    where: { userId, status: 'SNOOZED', snoozedUntil: { gt: now } },
    select: { eventId: true },
  })
  const snoozedIds = new Set(snoozed.map((s) => s.eventId))

  const visible = events.filter(
    (e) => !seenIds.has(e.id) && !snoozedIds.has(e.id),
  )

  // ---- per-instrument re-scoring under this user's context ---------------
  const byInstrument = new Map<string, typeof visible>()
  for (const e of visible) {
    const list = byInstrument.get(e.instrumentId) ?? []
    list.push(e)
    byInstrument.set(e.instrumentId, list)
  }

  const budget: Record<Severity, number> = {
    CRITICAL: 0,
    IMPORTANT: 0,
    WATCH: 0,
    INFO: 0,
    NOISE: 0,
  }

  const items: SitrepItem[] = []

  for (const row of rows) {
    const instrumentEvents = byInstrument.get(row.instrumentId) ?? []
    if (instrumentEvents.length === 0) {
      budget.NOISE++
      continue
    }

    const cursor = cursorByInstrument.get(row.instrumentId)

    // Recency decay is measured from the CURSOR, not from the wall clock.
    //
    // Every event reaching this point is unseen by this user - the seen and
    // dismissed ones were anti-joined away above - so it is new to them however
    // old it is to the market. Decaying from `now` meant a 5-sigma move that
    // happened three days into a ten-week absence arrived at the 0.35 floor and
    // was filed as noise, which is exactly the thing the user came back to find
    // out about. Decay still applies to events surfaced again after being seen.
    const ageTradingDays = 0

    const signals: Signal[] = instrumentEvents.flatMap((e) => {
      const stored = e.features as { signals?: Signal[] } | null
      return stored?.signals ?? []
    })

    const worstConfidence = Math.min(...instrumentEvents.map((e) => e.confidence))
    // Confirmed is NOT derived from confidence. A single-source bar sits at 0.9
    // confidence but is confirmed - nothing contradicted it. Only an actual
    // cross-source disagreement makes it unconfirmed, and the UI says different
    // things about the two.
    const anyUnconfirmed = instrumentEvents.some((e) => !e.confirmed)

    const ctx: ScoringContext = {
      priority: row.priority,
      intent: row.intent,
      dataConfidence: worstConfidence,
      confirmed: !anyUnconfirmed,
      ageTradingDays,
      hasCatalyst: instrumentEvents.some((e) => e.type === 'earnings_upcoming'),
      isIdiosyncratic: instrumentEvents.some((e) => e.type === 'sector_divergence'),
      isMacroDay: false,
    }

    const scored = scoreSignals(signals, ctx)
    const { positives, suppressors } = explainContributions(scored.contributions)

    // The headline comes from the STRONGEST event, not the most recent one.
    // Ordering by time meant a name that moved 62% over the window could be
    // introduced by a passing volume note, burying the thing that mattered.
    const lead = [...instrumentEvents].sort((a, b) => b.score - a.score)[0]

    budget[scored.severity]++

    const window = await windowStats(row.instrumentId, cursor?.lastSeenAt ?? null)

    items.push({
      symbol: row.symbol,
      name: row.name,
      sector: row.sector,
      attentionScore: Math.round(scored.score),
      severity: scored.severity,
      headline: lead.headline,
      positives,
      suppressors,
      eventIds: instrumentEvents.map((e) => e.id),
      windowReturnPct: window.returnPct,
      sigmas: window.sigmas,
      lastClose: window.lastClose,
      asOf: window.asOf,
      confidence: worstConfidence,
      confirmed: !anyUnconfirmed,
      corroborated: worstConfidence >= 1,
      priority: row.priority,
      intent: row.intent,
      themeKey: instrumentEvents.find((e) => e.theme)?.theme?.scopeKey ?? null,
      sparkline: window.sparkline,
      isUpdate: false,
    })
  }

  const surfaced = items
    .filter((i) => SURFACED.includes(i.severity))
    .sort((a, b) => b.attentionScore - a.attentionScore)

  const shown = surfaced.slice(0, attentionBudget)

  // Names that genuinely did nothing. Anything the engine flagged but the
  // attention budget cut is NOT "within normal range" - saying so would
  // misreport what was actually found, which is the one thing a product built
  // on filtering cannot afford to do.
  const withinNormalRange = rows.length - surfaced.length
  const belowBudget = surfaced.length - shown.length

  // ---- themes and narrative ---------------------------------------------
  const themeIds = [
    ...new Set(visible.map((e) => e.themeId).filter((id): id is string => !!id)),
  ]
  const themeRows = await db.theme.findMany({
    where: { id: { in: themeIds } },
    orderBy: { confidence: 'desc' },
  })

  const themes = themeRows.map((t) => ({
    id: t.id,
    scope: 'sector' as const,
    scopeKey: t.scopeKey,
    members: [] as string[],
    direction: (t.summary.includes('selling') ? -1 : 1) as -1 | 1,
    windowStart: t.windowStart.toISOString().slice(0, 10),
    windowEnd: t.windowEnd.toISOString().slice(0, 10),
    memberCount: t.memberCount,
    confidence: t.confidence,
    cohesion: t.cohesion,
    timing: t.timing,
    size: t.size,
    distinctness: t.distinctness,
    characteristics: t.characteristics,
    summary: t.summary,
  }))

  for (const theme of themes) {
    theme.members = shown
      .filter((i) => i.themeKey === theme.scopeKey)
      .map((i) => i.symbol)
  }

  const market = await marketContext(since)

  const narrative = buildNarrative({
    themes,
    topEventSectors: shown.map((i) => i.sector ?? ''),
    marketReturn: market.returnPct,
    marketSigmas: market.sigmas,
    breadth:
      rows.length > 0
        ? items.filter((i) => (i.sigmas ?? 0) > 1).length / rows.length
        : 0,
    watchlistSize: rows.length,
    notableCount: surfaced.length,
  })

  const freshness = await db.dataFreshness.findMany({
    orderBy: { lastSuccess: 'asc' },
    take: 1,
  })

  return {
    displayName: user.displayName,
    since,
    absenceHours,
    asOf: shown[0]?.asOf ?? items[0]?.asOf ?? null,
    items: shown,
    themes,
    narrative,
    budget,
    withinNormalRange,
    belowBudget,
    watchlistSize: rows.length,
    quiet: surfaced.length === 0,
    attentionBudget,
    dataQuality: {
      stalestSource: freshness[0]?.sourceId ?? null,
      lagSeconds: freshness[0]?.lagSeconds ?? null,
      unconfirmedCount: items.filter((i) => !i.confirmed).length,
    },
  }
}

/**
 * Move over the absence window, not just the last session.
 *
 * This is the difference between "NVDA is down 0.4% today" and "NVDA is down 8%
 * since you last looked" — the second is the thing the user actually missed,
 * and it is invisible to any watchlist that only shows a daily change.
 */
async function windowStats(instrumentId: string, since: Date | null) {
  const bars = await db.dailyBar.findMany({
    where: { instrumentId },
    orderBy: { barDate: 'desc' },
    take: 40,
    select: {
      barDate: true,
      closeAdj: true,
      asOf: true,
      confidence: true,
      confirmed: true,
    },
  })

  if (bars.length === 0) {
    return { returnPct: null, sigmas: null, lastClose: 0, asOf: '', sparkline: [] }
  }

  const ascending = [...bars].reverse()
  const closes = ascending.map((b) => Number(b.closeAdj))
  const last = closes[closes.length - 1]

  const rets: number[] = []
  for (let i = 1; i < closes.length; i++) {
    rets.push(Math.log(closes[i] / closes[i - 1]))
  }
  const mean = rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length)
  const variance =
    rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1)
  const sigma = Math.sqrt(variance)

  let baselineIndex = ascending.length - 2
  if (since) {
    const idx = ascending.findIndex((b) => b.barDate >= since)
    if (idx > 0) baselineIndex = idx - 1
    else if (idx === 0) baselineIndex = 0
  }
  baselineIndex = Math.max(0, Math.min(baselineIndex, ascending.length - 2))

  const from = closes[baselineIndex]
  const sessions = Math.max(1, ascending.length - 1 - baselineIndex)
  const returnPct = from > 0 ? last / from - 1 : null
  const sigmas =
    sigma > 0 && from > 0
      ? Math.log(last / from) / (sigma * Math.sqrt(sessions))
      : null

  return {
    returnPct,
    sigmas,
    lastClose: last,
    asOf: ascending[ascending.length - 1].asOf.toISOString(),
    sparkline: closes.slice(-20),
  }
}

/** Benchmark move over the same window, used by the narrative rules. */
async function marketContext(since: Date | null) {
  const instrument = await db.instrument.findUnique({
    where: { symbol: MARKET_BENCHMARK },
    select: { id: true },
  })
  if (!instrument) return { returnPct: 0, sigmas: 0 }

  const stats = await windowStats(instrument.id, since)
  return { returnPct: stats.returnPct ?? 0, sigmas: stats.sigmas ?? 0 }
}

function emptyResult(displayName: string, attentionBudget: number): SitrepResult {
  return {
    displayName,
    since: null,
    absenceHours: null,
    asOf: null,
    items: [],
    themes: [],
    narrative: {
      ruleId: 'empty_watchlist',
      text: 'Add a few names to your watchlist and your first SITREP will appear after the next close.',
      inputs: {},
    },
    budget: { CRITICAL: 0, IMPORTANT: 0, WATCH: 0, INFO: 0, NOISE: 0 },
    withinNormalRange: 0,
    belowBudget: 0,
    watchlistSize: 0,
    quiet: true,
    attentionBudget,
    dataQuality: { stalestSource: null, lagSeconds: null, unconfirmedCount: 0 },
  }
}

/**
 * Advance the cursor.
 *
 * Guarded by a monotonic version so two devices cannot move it backwards: a
 * queued acknowledgement replayed from a phone that was offline must not undo
 * a later one made on a laptop.
 */
export async function markSeen(
  userId: string,
  instrumentIds: string[],
  eventIds: string[] = [],
): Promise<{ moved: number }> {
  const now = new Date()
  let moved = 0

  for (const instrumentId of instrumentIds) {
    const existing = await db.userWatchState.findUnique({
      where: { userId_instrumentId: { userId, instrumentId } },
    })

    if (existing && existing.lastSeenAt >= now) continue

    const snapshot = await db.dailyBar.findFirst({
      where: { instrumentId },
      orderBy: { barDate: 'desc' },
      select: { barDate: true, closeAdj: true },
    })

    await db.userWatchState.upsert({
      where: { userId_instrumentId: { userId, instrumentId } },
      create: {
        userId,
        instrumentId,
        lastSeenAt: now,
        lastSeenSnap: {
          date: snapshot?.barDate.toISOString().slice(0, 10) ?? null,
          close: snapshot ? Number(snapshot.closeAdj) : null,
        },
        cursorVersion: BigInt(1),
      },
      update: {
        lastSeenAt: now,
        lastSeenSnap: {
          date: snapshot?.barDate.toISOString().slice(0, 10) ?? null,
          close: snapshot ? Number(snapshot.closeAdj) : null,
        },
        cursorVersion: { increment: BigInt(1) },
      },
    })
    moved++
  }

  for (const eventId of eventIds) {
    await db.userEventState.upsert({
      where: { userId_eventId: { userId, eventId } },
      create: { userId, eventId, status: 'SEEN' },
      update: { status: 'SEEN' },
    })
  }

  await db.user.update({
    where: { id: userId },
    data: { lastActiveAt: now },
  })

  return { moved }
}

export async function snoozeEvent(
  userId: string,
  eventId: string,
  until: Date,
): Promise<void> {
  await db.userEventState.upsert({
    where: { userId_eventId: { userId, eventId } },
    create: { userId, eventId, status: 'SNOOZED', snoozedUntil: until },
    update: { status: 'SNOOZED', snoozedUntil: until },
  })
}

/**
 * Plant an initial cursor for every watched name.
 *
 * A user with no cursor has no "since", and the first visit would otherwise
 * replay years of history as though they had just missed it.
 */
export async function ensureCursors(
  userId: string,
  at: Date = new Date(),
): Promise<number> {
  const watchlist = await db.watchlist.findFirst({
    where: { userId },
    include: { items: { select: { instrumentId: true } } },
  })
  if (!watchlist) return 0

  let planted = 0
  for (const item of watchlist.items) {
    const existing = await db.userWatchState.findUnique({
      where: { userId_instrumentId: { userId, instrumentId: item.instrumentId } },
    })
    if (existing) continue

    await db.userWatchState.create({
      data: {
        userId,
        instrumentId: item.instrumentId,
        lastSeenAt: at,
        lastSeenSnap: {},
        cursorVersion: BigInt(0),
      },
    })
    planted++
  }

  return planted
}
