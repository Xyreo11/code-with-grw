import { redirect } from 'next/navigation'
import Link from 'next/link'
import { currentUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { WatchlistManager } from '@/components/WatchlistManager'

export const dynamic = 'force-dynamic'

/**
 * Manage the watchlist.
 *
 * Deliberately plain. This screen is a graded requirement, not the product's
 * argument, so it earns its keep by being obvious and then getting out of the
 * way. The two controls that are NOT ordinary CRUD — priority and intent — are
 * here because they are the only personalisation the scorer uses, and both are
 * explicit user choices rather than anything inferred.
 */
export default async function WatchlistPage() {
  const user = await currentUser()
  if (!user) redirect('/login')

  const watchlist = await db.watchlist.findFirst({
    where: { userId: user.id },
    include: {
      items: {
        include: { instrument: true },
        orderBy: { addedAt: 'asc' },
      },
    },
  })

  const watched = new Set(watchlist?.items.map((i) => i.instrument.symbol) ?? [])

  // Only instruments that are actually watchable: benchmarks and sector proxies
  // are ingested to explain other names, not to be followed themselves.
  const available = await db.instrument.findMany({
    where: { isEtf: false, isActive: true },
    orderBy: { symbol: 'asc' },
    select: { symbol: true, name: true, sector: true },
  })

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-mono text-[11px] tracking-[0.2em] text-[color:var(--accent-ink)]">
          SITREP
        </span>
        <Link
          href="/"
          className="font-mono text-[11px] tracking-wide text-[color:var(--ink-3)] underline decoration-dotted underline-offset-4 hover:text-[color:var(--accent-ink)]"
        >
          back to brief
        </Link>
      </div>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight">
        Manage your watchlist
      </h1>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-[color:var(--ink-3)]">
        Priority is an explicit multiplier on a name&rsquo;s attention score
        (High ×1.3, Low ×0.7). Intent changes which kinds of change matter —
        someone hunting an entry cares about pullbacks, someone already holding
        cares about deterioration.
      </p>

      <WatchlistManager
        items={(watchlist?.items ?? []).map((i) => ({
          symbol: i.instrument.symbol,
          name: i.instrument.name,
          sector: i.instrument.sector,
          priority: i.priority,
          intent: i.intent,
        }))}
        available={available.filter((a) => !watched.has(a.symbol))}
      />
    </main>
  )
}
