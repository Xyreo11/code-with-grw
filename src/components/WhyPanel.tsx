'use client'

import { useState } from 'react'
import type { Contribution } from '@/engine/types'

/**
 * "Why am I seeing this?" and, more importantly, "Why not higher?".
 *
 * The second half is the differentiating one. Any ranking system can list the
 * evidence it accepted; showing what it REJECTED, and by how much, is a much
 * harder thing to fake and a much better test of whether the score means
 * anything. It is also what makes the ranking arguable rather than oracular —
 * a user who disagrees can see exactly which term to blame.
 *
 * Every number here is the actual arithmetic behind the score, not a
 * post-hoc rationalisation: additive terms sum to the subtotal, multipliers
 * scale it, and the product is the number on the card.
 */
export function WhyPanel({
  score,
  positives,
  suppressors,
}: {
  score: number
  positives: Contribution[]
  suppressors: Contribution[]
}) {
  const [open, setOpen] = useState(false)

  const maxAdditive = Math.max(
    1,
    ...positives.filter((c) => c.kind === 'additive').map((c) => c.amount),
  )

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="font-mono text-[11px] tracking-wide text-[color:var(--ink-3)] underline decoration-dotted underline-offset-4 hover:text-[color:var(--accent-ink)] focus-visible:outline-2 focus-visible:outline-[color:var(--accent)]"
        aria-expanded={open}
      >
        {open ? 'Hide reasoning' : 'Why am I seeing this?'}
      </button>

      {open && (
        <div className="mt-3 rounded-md border border-[color:var(--border)] bg-[color:var(--surface-2)] p-3 text-sm">
          <p className="mb-2 font-mono text-[10px] tracking-wider text-[color:var(--ink-3)]">
            RANKED {score} BECAUSE
          </p>

          <ul className="flex flex-col gap-1.5">
            {positives.map((c) => (
              <li key={c.key} className="flex items-center gap-2">
                <span className="text-[color:var(--up)]">✓</span>
                <span className="flex-1 text-[color:var(--ink-2)]">{c.label}</span>
                <ContributionBar
                  contribution={c}
                  max={maxAdditive}
                  positive
                />
              </li>
            ))}
          </ul>

          {suppressors.length > 0 && (
            <>
              <p className="mt-4 mb-2 font-mono text-[10px] tracking-wider text-[color:var(--ink-3)]">
                WHY NOT HIGHER
              </p>
              <ul className="flex flex-col gap-1.5">
                {suppressors.map((c) => (
                  <li key={c.key} className="flex items-center gap-2">
                    <span className="text-[color:var(--down)]">✕</span>
                    <span className="flex-1 text-[color:var(--ink-2)]">
                      {c.label}
                    </span>
                    <ContributionBar
                      contribution={c}
                      max={maxAdditive}
                      positive={false}
                    />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function ContributionBar({
  contribution,
  max,
  positive,
}: {
  contribution: Contribution
  max: number
  positive: boolean
}) {
  const colour = positive ? 'var(--up)' : 'var(--down)'

  if (contribution.kind === 'multiplier') {
    return (
      <span
        className="tabular w-14 shrink-0 text-right font-mono text-[11px]"
        style={{ color: colour }}
      >
        ×{contribution.amount.toFixed(2)}
      </span>
    )
  }

  const width = Math.min(100, (Math.abs(contribution.amount) / max) * 100)

  return (
    <span className="flex w-24 shrink-0 items-center justify-end gap-1.5">
      <span className="h-1 w-14 overflow-hidden rounded-full bg-[color:var(--border)]">
        <span
          className="block h-full rounded-full"
          style={{ width: `${width}%`, background: colour }}
        />
      </span>
      <span
        className="tabular w-8 text-right font-mono text-[11px]"
        style={{ color: colour }}
      >
        {contribution.amount > 0 ? '+' : ''}
        {Math.round(contribution.amount)}
      </span>
    </span>
  )
}
