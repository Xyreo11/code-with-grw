import type { Severity } from '@/engine/types'

/**
 * Small shared pieces. Kept together because each is a few lines and they are
 * always used in combination on a card.
 */

const SEVERITY_STYLE: Record<Severity, { label: string; color: string }> = {
  CRITICAL: { label: 'CRITICAL', color: 'var(--sev-critical)' },
  IMPORTANT: { label: 'IMPORTANT', color: 'var(--sev-important)' },
  WATCH: { label: 'WATCH', color: 'var(--sev-watch)' },
  INFO: { label: 'INFO', color: 'var(--sev-info)' },
  NOISE: { label: 'QUIET', color: 'var(--sev-noise)' },
}

export function SeverityChip({ severity }: { severity: Severity }) {
  const s = SEVERITY_STYLE[severity]
  return (
    <span
      className="rounded-sm border px-1.5 py-0.5 font-mono text-[10px] tracking-wider"
      style={{ color: s.color, borderColor: s.color }}
    >
      {s.label}
    </span>
  )
}

/**
 * Freshness is a required prop, not an optional decoration.
 *
 * There is deliberately no way to render a price in this app without also
 * saying how old it is and whether two sources agreed on it. Showing a stale or
 * disputed number as though it were live is the failure mode that matters most
 * here, so the type system makes it awkward to do.
 */
export function FreshnessDot({
  asOf,
  confirmed,
  confidence,
}: {
  asOf: string
  confirmed: boolean
  confidence: number
}) {
  const ageHours = asOf
    ? (Date.now() - new Date(asOf).getTime()) / 3_600_000
    : Infinity

  let color = 'var(--up)'
  let title = 'Fresh, confirmed by two sources'

  if (!confirmed) {
    color = 'var(--accent)'
    title = 'Two sources disagree on this price — treat as provisional'
  } else if (confidence < 1) {
    color = 'var(--sev-info)'
    title = `Only one source reported this price — uncorroborated, but not disputed (confidence ${Math.round(confidence * 100)}%)`
  } else if (ageHours > 96) {
    color = 'var(--sev-noise)'
    title = `Stale — last updated ${Math.round(ageHours / 24)} days ago`
  } else if (ageHours > 24) {
    color = 'var(--sev-info)'
    title = `Delayed — last updated ${Math.round(ageHours)}h ago`
  }

  return (
    <span
      className="inline-block size-1.5 shrink-0 rounded-full align-middle"
      style={{ background: color }}
      title={title}
      aria-label={title}
    />
  )
}

export function Money({
  value,
  asOf,
  confirmed,
  confidence,
}: {
  value: number
  asOf: string
  confirmed: boolean
  confidence: number
}) {
  return (
    <span className="tabular inline-flex items-center gap-1.5">
      <FreshnessDot asOf={asOf} confirmed={confirmed} confidence={confidence} />
      ${value.toFixed(2)}
    </span>
  )
}

export function Change({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-[color:var(--ink-3)]">—</span>
  const up = pct >= 0
  return (
    <span
      className="tabular font-medium"
      style={{ color: up ? 'var(--up)' : 'var(--down)' }}
    >
      {up ? '+' : ''}
      {(pct * 100).toFixed(1)}%
    </span>
  )
}

/**
 * Inline SVG sparkline. No charting library: this is twenty points and a path,
 * and a dependency for it would cost more than it saves.
 */
export function Sparkline({
  points,
  width = 96,
  height = 28,
}: {
  points: number[]
  width?: number
  height?: number
}) {
  if (points.length < 2) return <svg width={width} height={height} />

  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1
  const step = width / (points.length - 1)

  const d = points
    .map((p, i) => {
      const x = i * step
      const y = height - ((p - min) / range) * (height - 4) - 2
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  const rising = points[points.length - 1] >= points[0]
  const stroke = rising ? 'var(--up)' : 'var(--down)'
  const lastX = width
  const lastY =
    height - ((points[points.length - 1] - min) / range) * (height - 4) - 2

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      className="overflow-visible"
    >
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.5" />
      {/* The endpoint is the value that matters, so it gets a mark. */}
      <circle cx={lastX} cy={lastY} r="2" fill={stroke} />
    </svg>
  )
}

export function AttentionScore({ score }: { score: number }) {
  return (
    <div className="flex flex-col items-end leading-none">
      <span className="tabular text-2xl font-semibold">{score}</span>
      <span className="font-mono text-[9px] tracking-wider text-[color:var(--ink-3)]">
        ATTENTION
      </span>
    </div>
  )
}
