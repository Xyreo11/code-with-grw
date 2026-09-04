'use client'

import { useRouter } from 'next/navigation'
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
export function EventCard({ item }: { item: SitrepItem }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [dismissed, setDismissed] = useState(false)

  /**
   * Acknowledge, then re-render from the server.
   *
   * The card hides optimistically so the interaction feels immediate, but the
   * refresh is what makes the screen agree with the cursor. Without it the UI
   * and the server drifted: the card vanished locally while the next reload
   * brought it straight back, because nothing had re-read the brief.
   */
  async function act(url: string, body: unknown) {
    setDismissed(true)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(String(res.status))
      startTransition(() => router.refresh())
    } catch {
      // Put the card back rather than pretending the write landed.
      setDismissed(false)
    }
  }

  /** Acknowledge: moves the cursor, so the next brief measures from now. */
  const markSeen = () =>
    act('/api/watch-state/mark-seen', {
      symbols: [item.symbol],
      eventIds: item.eventIds,
    })

  /**
   * Defer: moves nothing. The cursor stays where it is, so this event comes
   * back tomorrow with its original timestamp rather than being quietly lost.
   */
  const snooze = () =>
    act('/api/watch-state/snooze', { eventIds: item.eventIds, hours: 24 })

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
        {/*
          A bare `title` becomes the accessible name in some assistive tooling,
          which announces the tooltip instead of the control. Naming the button
          explicitly keeps the spoken label and the visible label identical.
        */}
        <button
          type="button"
          onClick={snooze}
          aria-label="Snooze 24h"
          title="Hide for 24 hours without moving your cursor"
          className="rounded-md border border-[color:var(--border-strong)] px-2.5 py-1 font-mono text-[11px] tracking-wide text-[color:var(--ink-2)] hover:border-[color:var(--accent)] hover:text-[color:var(--accent-ink)] focus-visible:outline-2 focus-visible:outline-[color:var(--accent)]"
        >
          Snooze 24h
        </button>
      </div>
    </article>
  )
}
