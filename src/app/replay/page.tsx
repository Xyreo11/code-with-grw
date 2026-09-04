import { redirect } from 'next/navigation'
import Link from 'next/link'
import { currentUser } from '@/lib/auth'
import { replayScenario, SCENARIOS } from '@/lib/scenarios'
import { ReplayPlayer } from '@/components/ReplayPlayer'

export const dynamic = 'force-dynamic'

export default async function ReplayPage({ searchParams }: PageProps<'/replay'>) {
  const user = await currentUser()
  if (!user) redirect('/login')

  const params = await searchParams
  const slug =
    typeof params.s === 'string' && SCENARIOS.some((x) => x.slug === params.s)
      ? params.s
      : SCENARIOS[0].slug

  const { scenario, steps } = await replayScenario(slug)

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-mono text-[11px] tracking-[0.2em] text-[color:var(--accent-ink)]">
          SITREP · REPLAY
        </span>
        <Link
          href="/"
          className="font-mono text-[11px] tracking-wide text-[color:var(--ink-3)] underline decoration-dotted underline-offset-4 hover:text-[color:var(--accent-ink)]"
        >
          back to brief
        </Link>
      </div>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight">
        Watch the engine work on history
      </h1>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-[color:var(--ink-3)]">
        Step a real historical window forward one trading day at a time. At each
        step the engine sees only what it would have seen on that date — no
        lookahead, even though the rest of the series is sitting in the database.
      </p>

      <nav className="mt-6 flex flex-wrap gap-2">
        {SCENARIOS.map((s) => (
          <Link
            key={s.slug}
            href={`/replay?s=${s.slug}`}
            className="rounded-md border px-3 py-1.5 font-mono text-xs"
            style={
              s.slug === slug
                ? { borderColor: 'var(--accent)', color: 'var(--accent-ink)' }
                : {
                    borderColor: 'var(--border-strong)',
                    color: 'var(--ink-3)',
                  }
            }
          >
            {s.name}
          </Link>
        ))}
      </nav>

      <ReplayPlayer scenario={scenario} steps={steps} />
    </main>
  )
}
