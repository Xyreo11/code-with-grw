import { redirect } from 'next/navigation'
import Link from 'next/link'
import { currentUser } from '@/lib/auth'
import { buildSitrep } from '@/lib/sitrep'
import { EventCard } from '@/components/EventCard'
import { StoryBlock } from '@/components/StoryBlock'
import { ThemeCard } from '@/components/ThemeCard'
import { AttentionBudget } from '@/components/AttentionBudget'
import { MarkAllSeen } from '@/components/MarkAllSeen'

export const dynamic = 'force-dynamic'

/**
 * THE SITREP.
 *
 * Server-rendered on purpose: the whole product is about the moment you come
 * back, so the answer should already be on the page when it paints rather than
 * arriving after a spinner.
 */
export default async function Page() {
  const user = await currentUser()
  if (!user) redirect('/login')

  const sitrep = await buildSitrep(user.id)

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10">
      <Header sitrep={sitrep} />

      {sitrep.watchlistSize === 0 ? (
        <EmptyWatchlist />
      ) : sitrep.quiet ? (
        <QuietState
          watchlistSize={sitrep.watchlistSize}
          snoozedCount={sitrep.snoozedCount}
        />
      ) : (
        <>
          <section className="mt-6 flex flex-col gap-3">
            {sitrep.items.map((item) => (
              <EventCard key={item.symbol} item={item} />
            ))}
          </section>

          <CollapseLine
            belowBudget={sitrep.belowBudget}
            withinNormalRange={sitrep.withinNormalRange}
            snoozedCount={sitrep.snoozedCount}
          />
        </>
      )}

      <div className="mt-8 flex flex-col gap-4">
        <StoryBlock narrative={sitrep.narrative} />

        {sitrep.themes.map((theme) => (
          <ThemeCard key={theme.id} theme={theme} />
        ))}

        {/* An all-zero budget bar makes an argument about filtering to someone
            who has nothing to filter. */}
        {sitrep.watchlistSize > 0 && (
          <AttentionBudget
            budget={sitrep.budget}
            watchlistSize={sitrep.watchlistSize}
            snoozedCount={sitrep.snoozedCount}
          />
        )}
      </div>

      {sitrep.watchlistSize > 0 && <Footer sitrep={sitrep} />}
    </main>
  )
}

function Header({
  sitrep,
}: {
  sitrep: Awaited<ReturnType<typeof buildSitrep>>
}) {
  const hours = sitrep.absenceHours
  const away =
    hours === null
      ? null
      : hours < 36
        ? `${Math.round(hours)} hours ago`
        : `${Math.round(hours / 24)} days ago`

  return (
    <header>
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-mono text-[11px] tracking-[0.2em] text-[color:var(--accent-ink)]">
          SITREP
        </span>
        <span className="flex items-center gap-4 font-mono text-[10px] tracking-wide text-[color:var(--ink-3)]">
          <span>
            {sitrep.asOf
              ? `data as of ${new Date(sitrep.asOf).toISOString().slice(0, 10)}`
              : 'no data yet'}
          </span>
          <Link
            href="/watchlist"
            className="underline decoration-dotted underline-offset-4 hover:text-[color:var(--accent-ink)]"
          >
            manage watchlist
          </Link>
        </span>
      </div>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight">
        Good morning, {sitrep.displayName}.
      </h1>

      {/* Nobody with an empty watchlist has "last checked" anything, and
          telling them nothing needs their attention is not the point. */}
      {sitrep.watchlistSize > 0 && (
        <>
          <p className="mt-4 font-mono text-[11px] tracking-wider text-[color:var(--ink-3)]">
            {away
              ? `HERE'S WHAT CHANGED SINCE YOU LAST CHECKED — ${away.toUpperCase()}`
              : "HERE'S WHAT CHANGED SINCE YOU LAST CHECKED"}
          </p>

          <div className="mt-2 flex items-center justify-between gap-4">
            <p className="text-lg text-[color:var(--ink-2)]">
              {sitrep.items.length === 0
                ? 'Nothing needs your attention.'
                : `${sitrep.items.length} thing${sitrep.items.length === 1 ? '' : 's'} need${sitrep.items.length === 1 ? 's' : ''} your attention.`}
            </p>
            {sitrep.items.length > 0 && <MarkAllSeen />}
          </div>
        </>
      )}
    </header>
  )
}

function CollapseLine({
  belowBudget,
  withinNormalRange,
  snoozedCount,
}: {
  belowBudget: number
  withinNormalRange: number
  snoozedCount: number
}) {
  return (
    <p className="mt-4 text-sm text-[color:var(--ink-3)]">
      {belowBudget > 0 && (
        <>
          <span className="text-[color:var(--ink-2)]">{belowBudget} more</span>{' '}
          {belowBudget === 1 ? 'was' : 'were'} flagged but fell below your
          attention budget.{' '}
        </>
      )}
      {withinNormalRange} instrument{withinNormalRange === 1 ? '' : 's'} moved
      within {withinNormalRange === 1 ? 'its' : 'their'} normal range.
      {snoozedCount > 0 && (
        <>
          {' '}
          <span className="text-[color:var(--ink-2)]">
            {snoozedCount} snoozed
          </span>{' '}
          — still pending, not cleared.
        </>
      )}
    </p>
  )
}

/**
 * The very first screen a new account sees.
 *
 * Distinct from the quiet state on purpose: "0 names moved within their normal
 * range" is technically true and completely useless. A user with nothing on
 * their watchlist needs the next action, not a report.
 */
function EmptyWatchlist() {
  return (
    <section className="mt-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-8 text-center">
      <p className="font-mono text-[11px] tracking-wider text-[color:var(--ink-3)]">
        NOTHING WATCHED YET
      </p>
      <p className="mt-3 text-lg text-[color:var(--ink-2)]">
        Pick a few names and SITREP starts keeping watch.
      </p>
      <p className="mt-2 text-sm text-[color:var(--ink-3)]">
        Your first brief covers everything that happens between now and the next
        time you open it.
      </p>
      <Link
        href="/watchlist"
        className="mt-5 inline-block rounded-md border border-[color:var(--border-strong)] px-3 py-1.5 font-mono text-[11px] tracking-wide text-[color:var(--ink-2)] hover:border-[color:var(--accent)] hover:text-[color:var(--accent-ink)]"
      >
        Build your watchlist →
      </Link>
    </section>
  )
}

function QuietState({
  watchlistSize,
  snoozedCount,
}: {
  watchlistSize: number
  snoozedCount: number
}) {
  // An empty brief has two very different causes, and saying the wrong one is
  // worse than saying nothing: the market was calm, or the user muted it.
  const calm = watchlistSize - snoozedCount

  return (
    <section className="mt-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-8 text-center">
      <p className="font-mono text-[11px] tracking-wider text-[color:var(--ink-3)]">
        {snoozedCount > 0 ? 'NOTHING NEW' : 'YOUR MARKET IS QUIET'}
      </p>
      <p className="mt-3 text-lg text-[color:var(--ink-2)]">
        Nothing requires your attention.
      </p>
      <p className="mt-2 text-sm text-[color:var(--ink-3)]">
        {calm} name{calm === 1 ? '' : 's'} moved within{' '}
        {calm === 1 ? 'its' : 'their'} normal range.
        {snoozedCount > 0 ? (
          <>
            {' '}
            <span className="text-[color:var(--ink-2)]">
              {snoozedCount} snoozed
            </span>{' '}
            — still pending, not cleared.
          </>
        ) : (
          ' This is a real answer, not an empty screen.'
        )}
      </p>
    </section>
  )
}

function Footer({
  sitrep,
}: {
  sitrep: Awaited<ReturnType<typeof buildSitrep>>
}) {
  return (
    <footer className="mt-10 border-t border-[color:var(--border)] pt-4">
      <p className="font-mono text-[10px] leading-relaxed tracking-wide text-[color:var(--ink-3)]">
        {sitrep.watchlistSize} instrument
        {sitrep.watchlistSize === 1 ? '' : 's'} watched ·{' '}
        {sitrep.dataQuality.unconfirmedCount} unconfirmed · prices reconciled
        across two independent sources
      </p>
    </footer>
  )
}
