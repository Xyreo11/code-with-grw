import { confidenceBand } from '@/engine/theme'

interface ThemeView {
  id: string
  scopeKey: string
  memberCount: number
  confidence: number
  cohesion: number
  timing: number
  size: number
  distinctness: number
  characteristics: string[]
  summary: string
  members: string[]
  direction: -1 | 1
}

/**
 * A theme: several names moving for what looks like one reason.
 *
 * The four confidence components are shown rather than just the headline
 * percentage. A bare "91% confident" is unearned precision; showing that it is
 * 91% because the members historically co-move, moved at the same time, and are
 * NOT explained by the broader market is a claim a reader can actually check.
 */
export function ThemeCard({ theme }: { theme: ThemeView }) {
  const band = confidenceBand(theme.confidence)
  const components: Array<[string, number, string]> = [
    ['Move together historically', theme.cohesion, 'cohesion'],
    ['Happened at the same time', theme.timing, 'timing'],
    ['Enough names to be a pattern', theme.size, 'size'],
    ['Not explained by the market', theme.distinctness, 'distinctness'],
  ]

  return (
    <article
      className="rounded-lg border bg-[color:var(--surface)] p-4"
      style={{ borderColor: 'var(--accent)' }}
    >
      <header className="flex items-start justify-between gap-4">
        <h3 className="font-mono text-sm font-semibold tracking-wider text-[color:var(--accent-ink)]">
          {theme.scopeKey.toUpperCase()}{' '}
          {theme.direction < 0 ? 'SELLING PRESSURE' : 'STRENGTH'}
        </h3>
        <span className="tabular shrink-0 font-mono text-xs text-[color:var(--ink-2)]">
          {band} · {theme.confidence.toFixed(0)}%
        </span>
      </header>

      <p className="mt-2 text-sm leading-relaxed text-[color:var(--ink-2)]">
        {theme.summary}
      </p>

      {theme.members.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {theme.members.map((m) => (
            <span
              key={m}
              className="rounded-sm border border-[color:var(--border-strong)] px-1.5 py-0.5 font-mono text-[11px] text-[color:var(--ink-2)]"
            >
              {m}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-1.5">
        {components.map(([label, value, key]) => (
          <div key={key} className="flex items-center gap-3">
            <span className="w-52 shrink-0 text-xs text-[color:var(--ink-3)]">
              {label}
            </span>
            <span className="h-1 flex-1 overflow-hidden rounded-full bg-[color:var(--surface-2)]">
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${Math.round(value * 100)}%`,
                  background: 'var(--accent)',
                }}
              />
            </span>
            <span className="tabular w-8 shrink-0 text-right font-mono text-[11px] text-[color:var(--ink-3)]">
              {Math.round(value * 100)}
            </span>
          </div>
        ))}
      </div>

      {theme.characteristics.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[color:var(--ink-3)]">
          {theme.characteristics.map((c) => (
            <li key={c}>• {c}</li>
          ))}
        </ul>
      )}
    </article>
  )
}
