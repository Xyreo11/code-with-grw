import type { Severity } from '@/engine/types'

/**
 * The attention budget, made visible.
 *
 * This bar exists to make an argument, not to display a statistic: it shows
 * how much of the watchlist SITREP deliberately declined to show you. A
 * watchlist that surfaces everything has no opinion; the quiet bar being the
 * longest one is the product working.
 */

const ORDER: Severity[] = ['CRITICAL', 'IMPORTANT', 'WATCH', 'INFO', 'NOISE']

const LABEL: Record<Severity, string> = {
  CRITICAL: 'Critical',
  IMPORTANT: 'Important',
  WATCH: 'Watch',
  INFO: 'Background',
  NOISE: 'Quiet',
}

const COLOR: Record<Severity, string> = {
  CRITICAL: 'var(--sev-critical)',
  IMPORTANT: 'var(--sev-important)',
  WATCH: 'var(--sev-watch)',
  INFO: 'var(--sev-info)',
  NOISE: 'var(--sev-noise)',
}

export function AttentionBudget({
  budget,
  watchlistSize,
  snoozedCount = 0,
}: {
  budget: Record<Severity, number>
  watchlistSize: number
  /** Muted names get their own row; folding them into Quiet would overstate calm. */
  snoozedCount?: number
}) {
  const total = Math.max(1, watchlistSize)

  return (
    <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-4">
      <h2 className="mb-3 font-mono text-[10px] tracking-wider text-[color:var(--ink-3)]">
        YOUR ATTENTION TODAY
      </h2>

      <div className="flex flex-col gap-1.5">
        {ORDER.map((severity) => {
          const count = budget[severity] ?? 0
          const width = (count / total) * 100
          return (
            <div key={severity} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-[color:var(--ink-2)]">
                {LABEL[severity]}
              </span>
              <span className="h-2 flex-1 overflow-hidden rounded-sm bg-[color:var(--surface-2)]">
                <span
                  className="block h-full rounded-sm transition-[width] duration-500"
                  style={{ width: `${width}%`, background: COLOR[severity] }}
                />
              </span>
              <span className="tabular w-6 shrink-0 text-right font-mono text-xs text-[color:var(--ink-3)]">
                {count}
              </span>
            </div>
          )
        })}
        {snoozedCount > 0 && (
          <div className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-xs text-[color:var(--ink-2)]">
              Snoozed
            </span>
            <span className="h-2 flex-1 overflow-hidden rounded-sm bg-[color:var(--surface-2)]">
              <span
                className="block h-full rounded-sm opacity-60 transition-[width] duration-500"
                style={{
                  width: `${(snoozedCount / total) * 100}%`,
                  background: 'var(--sev-watch)',
                }}
              />
            </span>
            <span className="tabular w-6 shrink-0 text-right font-mono text-xs text-[color:var(--ink-3)]">
              {snoozedCount}
            </span>
          </div>
        )}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-[color:var(--ink-3)]">
        SITREP shows the top few and holds the rest back on purpose. A watchlist
        that surfaces everything has no opinion.
      </p>
    </section>
  )
}
