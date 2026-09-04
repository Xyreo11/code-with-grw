'use client'

import { useMemo, useState } from 'react'
import type { ReplayStep, ScenarioDefinition } from '@/lib/scenarios'
import { SeverityChip, Sparkline } from './primitives'
import { WhyPanel } from './WhyPanel'

/**
 * The replay player.
 *
 * Stepping is client-side over a precomputed array: the window is a few weeks,
 * and recomputing on every click would be perceptible for no benefit. The
 * point-in-time guarantee lives in the engine, not here — this component only
 * chooses which already-computed day to display.
 */
export function ReplayPlayer({
  scenario,
  steps,
}: {
  scenario: ScenarioDefinition
  steps: ReplayStep[]
}) {
  const [index, setIndex] = useState(0)
  const step = steps[index]

  // Days where something actually happened, so "skip ahead" can pass over the
  // quiet stretches without pretending they were not there.
  const interesting = useMemo(
    () =>
      steps
        .map((s, i) => (s.items.length > 0 || s.themes.length > 0 ? i : -1))
        .filter((i) => i >= 0),
    [steps],
  )

  const nextInteresting = interesting.find((i) => i > index)

  if (!step) {
    return (
      <p className="mt-8 text-sm text-[color:var(--ink-3)]">
        No data for this window.
      </p>
    )
  }

  return (
    <div className="mt-6">
      <p className="rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] p-3 text-xs leading-relaxed text-[color:var(--ink-3)]">
        <span className="text-[color:var(--ink-2)]">What to watch for: </span>
        {scenario.teaches}
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
          disabled={index === 0}
          className="rounded-md border border-[color:var(--border-strong)] px-3 py-1.5 font-mono text-xs text-[color:var(--ink-2)] hover:border-[color:var(--accent)] disabled:opacity-40"
        >
          &larr; prev
        </button>
        <button
          type="button"
          onClick={() => setIndex((i) => Math.min(steps.length - 1, i + 1))}
          disabled={index >= steps.length - 1}
          className="rounded-md border border-[color:var(--border-strong)] px-3 py-1.5 font-mono text-xs text-[color:var(--ink-2)] hover:border-[color:var(--accent)] disabled:opacity-40"
        >
          next &rarr;
        </button>
        {nextInteresting !== undefined && (
          <button
            type="button"
            onClick={() => setIndex(nextInteresting)}
            className="rounded-md border px-3 py-1.5 font-mono text-xs"
            style={{ borderColor: 'var(--accent)', color: 'var(--accent-ink)' }}
          >
            skip to next event &raquo;
          </button>
        )}
        <span className="tabular ml-auto font-mono text-xs text-[color:var(--ink-3)]">
          {index + 1} / {steps.length}
        </span>
      </div>

      <input
        type="range"
        min={0}
        max={steps.length - 1}
        value={index}
        onChange={(e) => setIndex(Number(e.target.value))}
        aria-label="Replay position"
        className="mt-3 w-full accent-[color:var(--accent)]"
      />

      <div className="mt-5 flex items-baseline justify-between gap-4">
        <h2 className="tabular font-mono text-lg tracking-wide">{step.date}</h2>
        <span className="tabular font-mono text-xs text-[color:var(--ink-3)]">
          market{' '}
          <span
            style={{
              color: step.marketReturnPct >= 0 ? 'var(--up)' : 'var(--down)',
            }}
          >
            {step.marketReturnPct >= 0 ? '+' : ''}
            {(step.marketReturnPct * 100).toFixed(1)}%
          </span>
        </span>
      </div>

      <section className="mt-4 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-4">
        <h3 className="mb-2 font-mono text-[10px] tracking-wider text-[color:var(--accent-ink)]">
          THE STORY
        </h3>
        <p className="text-sm leading-relaxed">{step.narrative.text}</p>
        <p className="mt-2 font-mono text-[10px] text-[color:var(--ink-3)]">
          rule: {step.narrative.ruleId}
        </p>
      </section>

      {step.themes.map((t) => (
        <section
          key={t.scopeKey}
          className="mt-3 rounded-lg border p-4"
          style={{ borderColor: 'var(--accent)' }}
        >
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="font-mono text-sm tracking-wider text-[color:var(--accent-ink)]">
              {t.scopeKey.toUpperCase()} THEME DETECTED
            </h3>
            <span className="tabular font-mono text-xs">
              {t.confidence.toFixed(0)}%
            </span>
          </div>
          <p className="mt-2 text-sm text-[color:var(--ink-2)]">{t.summary}</p>
          <p className="mt-2 font-mono text-[11px] text-[color:var(--ink-3)]">
            cohesion {t.cohesion.toFixed(2)} · timing {t.timing.toFixed(2)} ·
            size {t.size.toFixed(2)} · distinctness {t.distinctness.toFixed(2)}
          </p>
        </section>
      ))}

      {step.items.length === 0 ? (
        <p className="mt-4 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-6 text-center text-sm text-[color:var(--ink-3)]">
          No meaningful changes on this date.
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {step.items.map((item) => (
            <article
              key={item.symbol}
              className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-4"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-semibold">
                      {item.symbol}
                    </span>
                    <SeverityChip severity={item.severity} />
                  </div>
                  <p className="mt-1 text-sm">{item.headline}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="tabular text-xl font-semibold">
                    {item.attentionScore}
                  </span>
                  <span
                    className="tabular font-mono text-xs"
                    style={{
                      color: item.returnPct >= 0 ? 'var(--up)' : 'var(--down)',
                    }}
                  >
                    {item.returnPct >= 0 ? '+' : ''}
                    {(item.returnPct * 100).toFixed(1)}%
                  </span>
                </div>
              </div>
              <div className="mt-2 flex justify-end">
                <Sparkline points={item.sparkline} />
              </div>
              <WhyPanel
                score={item.attentionScore}
                positives={item.positives}
                suppressors={item.suppressors}
              />
            </article>
          ))}
        </div>
      )}

      <p className="mt-4 text-xs text-[color:var(--ink-3)]">
        {step.quietCount} of {scenario.symbols.length} names in this scenario
        were quiet on {step.date}.
      </p>
    </div>
  )
}
