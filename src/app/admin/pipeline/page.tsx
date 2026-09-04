import { redirect } from 'next/navigation'
import Link from 'next/link'
import { currentUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { ENGINE_VERSION, SCORER_VERSION } from '@/engine/types'
import { queueDepths } from '@/lib/queue'

export const dynamic = 'force-dynamic'

/**
 * Pipeline health.
 *
 * Deliberately one plain page rather than a dashboard product. Its job is to
 * answer the questions you actually ask when something looks wrong — is the
 * data fresh, did the last ingest succeed, did any source disagree, what is
 * the engine currently emitting — and nothing else.
 */
export default async function PipelinePage() {
  const user = await currentUser()
  if (!user) redirect('/login')

  const [runs, freshness, sources, conflicts, deadLetters, severity, themes, bars] =
    await Promise.all([
      db.ingestRun.findMany({ orderBy: { startedAt: 'desc' }, take: 8 }),
      db.dataFreshness.findMany({ orderBy: { sourceId: 'asc' } }),
      db.dataSource.findMany({ orderBy: { trustRank: 'asc' } }),
      db.barConflict.count(),
      db.deadLetter.count(),
      db.event.groupBy({ by: ['severity'], _count: true }),
      db.theme.count(),
      db.dailyBar.count(),
    ])

  const queues = await queueDepths()
  const unconfirmedBars = await db.dailyBar.count({ where: { confirmed: false } })
  const singleSource = await db.dailyBar.count({ where: { confidence: { lt: 1 } } })

  const severityOrder = ['CRITICAL', 'IMPORTANT', 'WATCH', 'INFO', 'NOISE']
  const counts = new Map(severity.map((s) => [s.severity as string, s._count]))

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-mono text-[11px] tracking-[0.2em] text-[color:var(--accent-ink)]">
          SITREP · PIPELINE
        </span>
        <Link
          href="/"
          className="font-mono text-[11px] tracking-wide text-[color:var(--ink-3)] underline decoration-dotted underline-offset-4 hover:text-[color:var(--accent-ink)]"
        >
          back to brief
        </Link>
      </div>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight">
        Pipeline health
      </h1>

      <Section title="ENGINE">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          <Stat label="engine" value={ENGINE_VERSION} />
          <Stat label="scorer" value={SCORER_VERSION} />
          <Stat label="bars" value={bars.toLocaleString()} />
          <Stat label="themes" value={String(themes)} />
        </dl>
      </Section>

      <Section title="EVENTS BY SEVERITY">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-5">
          {severityOrder.map((s) => (
            <Stat key={s} label={s.toLowerCase()} value={String(counts.get(s) ?? 0)} />
          ))}
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-[color:var(--ink-3)]">
          Per detector firing, before personalisation. A brief can show a name
          as CRITICAL when no single event here is: the read path merges every
          signal for that instrument and re-scores it under the user&rsquo;s own
          priority and intent. These are different units, not a disagreement.
        </p>
      </Section>

      <Section title="DATA QUALITY">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <Stat
            label="cross-source conflicts"
            value={conflicts.toLocaleString()}
          />
          <Stat
            label="unconfirmed bars"
            value={unconfirmedBars.toLocaleString()}
          />
          <Stat
            label="single-source bars"
            value={singleSource.toLocaleString()}
          />
          <Stat label="rejected rows" value={deadLetters.toLocaleString()} />
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-[color:var(--ink-3)]">
          A conflict is two sources disagreeing on a price beyond 0.3%. A
          single-source bar is uncorroborated but not disputed — the two are
          reported separately because they mean different things.
        </p>
      </Section>

      <Section title="SOURCES">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="font-mono text-[10px] tracking-wider text-[color:var(--ink-3)]">
                <th className="pb-2 pr-4">SOURCE</th>
                <th className="pb-2 pr-4">KIND</th>
                <th className="pb-2 pr-4">TRUST</th>
                <th className="pb-2 pr-4">BREAKER</th>
                <th className="pb-2">LAST SUCCESS</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => {
                const f = freshness.find(
                  (x) => x.sourceId === s.id && x.kind === s.kind,
                )
                return (
                  <tr
                    key={`${s.id}-${s.kind}`}
                    className="border-t border-[color:var(--border)]"
                  >
                    <td className="py-2 pr-4 font-mono">{s.id}</td>
                    <td className="py-2 pr-4 text-[color:var(--ink-2)]">
                      {s.kind}
                    </td>
                    <td className="tabular py-2 pr-4">{s.trustRank}</td>
                    <td className="py-2 pr-4">
                      <span
                        style={{
                          color:
                            f?.breakerState === 'CLOSED'
                              ? 'var(--up)'
                              : 'var(--down)',
                        }}
                      >
                        {f?.breakerState ?? 'unknown'}
                      </span>
                    </td>
                    <td className="tabular py-2 font-mono text-xs text-[color:var(--ink-3)]">
                      {f?.lastSuccess
                        ? f.lastSuccess.toISOString().slice(0, 16).replace('T', ' ')
                        : 'never'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="QUEUES">
        {!queues.reachable ? (
          <p className="text-sm text-[color:var(--ink-3)]">
            Redis is not reachable. The queue accelerates ingestion but is not on
            the read path, so the brief still renders — run{' '}
            <code className="font-mono text-xs">docker compose up -d redis</code>{' '}
            and <code className="font-mono text-xs">npm run worker</code> to
            enable background ingestion.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="font-mono text-[10px] tracking-wider text-[color:var(--ink-3)]">
                  <th className="pb-2 pr-4">QUEUE</th>
                  <th className="pb-2 pr-4">WAITING</th>
                  <th className="pb-2 pr-4">ACTIVE</th>
                  <th className="pb-2 pr-4">DONE</th>
                  <th className="pb-2 pr-4">FAILED</th>
                  <th className="pb-2">DELAYED</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['ingest', queues.ingest],
                    ['compute', queues.compute],
                  ] as const
                ).map(([name, counts]) => (
                  <tr key={name} className="border-t border-[color:var(--border)]">
                    <td className="py-2 pr-4 font-mono">{name}</td>
                    <td className="tabular py-2 pr-4">{counts?.waiting ?? 0}</td>
                    <td className="tabular py-2 pr-4">{counts?.active ?? 0}</td>
                    <td className="tabular py-2 pr-4">{counts?.completed ?? 0}</td>
                    <td
                      className="tabular py-2 pr-4"
                      style={{
                        color: (counts?.failed ?? 0) > 0 ? 'var(--down)' : undefined,
                      }}
                    >
                      {counts?.failed ?? 0}
                    </td>
                    <td className="tabular py-2">{counts?.delayed ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="RECENT INGEST RUNS">
        {runs.length === 0 ? (
          <p className="text-sm text-[color:var(--ink-3)]">
            No ingest runs recorded.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="font-mono text-[10px] tracking-wider text-[color:var(--ink-3)]">
                  <th className="pb-2 pr-4">STARTED</th>
                  <th className="pb-2 pr-4">SOURCE</th>
                  <th className="pb-2 pr-4">STATUS</th>
                  <th className="pb-2 pr-4">ROWS</th>
                  <th className="pb-2">REJECTED</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr
                    key={r.id}
                    className="border-t border-[color:var(--border)]"
                  >
                    <td className="tabular py-2 pr-4 font-mono text-xs">
                      {r.startedAt.toISOString().slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="py-2 pr-4 font-mono">{r.sourceId}</td>
                    <td className="py-2 pr-4">
                      <span
                        style={{
                          color:
                            r.status === 'ok'
                              ? 'var(--up)'
                              : r.status === 'failed'
                                ? 'var(--down)'
                                : 'var(--accent)',
                        }}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="tabular py-2 pr-4">
                      {r.rowsIn.toLocaleString()}
                    </td>
                    <td className="tabular py-2">{r.rowsRejected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </main>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-4">
      <h2 className="mb-3 font-mono text-[10px] tracking-wider text-[color:var(--ink-3)]">
        {title}
      </h2>
      {children}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="font-mono text-[10px] tracking-wider text-[color:var(--ink-3)]">
        {label}
      </dt>
      <dd className="tabular text-lg">{value}</dd>
    </div>
  )
}
