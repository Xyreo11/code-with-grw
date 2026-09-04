'use client'

import { useState, useTransition } from 'react'
import type { SitrepItem } from '@/lib/sitrep'
import { WhyPanel } from './WhyPanel'
import {
  AttentionScore,
  Change,
  Money,
  SeverityChip,
  Sparkline,
} from './primitives'

/**
 * One name in the brief.
 *
 * The card leads with what changed and why it matters, not with a price. The
 * price is present but subordinate — a returning user already knows roughly
 * what their names are worth; what they do not know is what happened while
 * they were gone.
 */
export function EventCard({
  item,
  onAcknowledged,
}: {
  item: SitrepItem
  onAcknowledged?: () => void
}) {
  const [pending, startTransition] = useTransition()
  const [dismissed, setDismissed] = useState(false)

  async function markSeen() {
    setDismissed(true)
    await fetch('/api/watch-state/mark-seen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbols: [item.symbol], eventIds: item.eventIds }),
    })
    startTransition(() => onAcknowledged?.())
  }

  if (dismissed && !pending) return null

  const accent =
    item.severity === 'CRITICAL'
      ? 'var(--sev-critical)'
      : item.severity === 'IMPORTANT'
        ? 'var(--sev-important)'
        : 'var(--sev-watch)'

  return (
    <article
      className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-4 transition-opacity"
      style={{ borderLeft: `2px solid ${accent}`, opacity: dismissed ? 0.4 : 1 }}
    >
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-base font-semibold tracking-wide">
              {item.symbol}
            </h3>
            <SeverityChip severity={item.severity} />
            {item.priority !== 'NORMAL' && (
              <span className="rounded-sm border border-[color:var(--border-strong)] px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-[color:var(--ink-3)]">
                {item.priority} PRIORITY
              </span>
            )}
            {!item.confirmed ? (
              <span
                className="rounded-sm border px-1.5 py-0.5 font-mono text-[10px] tracking-wider"
                style={{ color: 'var(--accent)', borderColor: 'var(--accent)' }}
                title="Two data sources disagree on this price beyond tolerance"
              >
                UNCONFIRMED
              </span>
            ) : !item.corroborated ? (
              <span
                className="rounded-sm border border-[color:var(--border-strong)] px-1.5 py-0.5 font-mono text-[10px] tracking-wider text-[color:var(--ink-3)]"
                title="Only one source reported this price. Uncorroborated, but nothing contradicts it."
              >
                SINGLE SOURCE
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-[color:var(--ink-3)]">
            {item.name}
            {item.sector ? ` · ${item.sector}` : ''}
          </p>
        </div>

        <AttentionScore score={item.attentionScore} />
      </header>

      <p className="mt-3 text-[15px] leading-snug text-[color:var(--ink)]">
        {item.headline}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <span className="flex items-center gap-2">
          <span className="font-mono text-[10px] tracking-wider text-[color:var(--ink-3)]">
            SINCE YOU LOOKED
          </span>
          <Change pct={item.windowReturnPct} />
        </span>
        <Money
          value={item.lastClose}
          asOf={item.asOf}
          confirmed={item.confirmed}
          confidence={item.confidence}
        />
        <span className="ml-auto">
          <Sparkline points={item.sparkline} />
        </span>
      </div>

      <WhyPanel
        score={item.attentionScore}
        positives={item.positives}
        suppressors={item.suppressors}
      />

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={markSeen}
          className="rounded-md border border-[color:var(--border-strong)] px-2.5 py-1 font-mono text-[11px] tracking-wide text-[color:var(--ink-2)] hover:border-[color:var(--accent)] hover:text-[color:var(--accent-ink)] focus-visible:outline-2 focus-visible:outline-[color:var(--accent)]"
        >
          Mark seen
        </button>
      </div>
    </article>
  )
}
