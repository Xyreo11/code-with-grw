'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import type { Intent, Priority } from '@/engine/types'

interface Item {
  symbol: string
  name: string
  sector: string | null
  priority: Priority
  intent: Intent
}

interface Available {
  symbol: string
  name: string
  sector: string | null
}

const PRIORITIES: Priority[] = ['HIGH', 'NORMAL', 'LOW']

const INTENT_LABEL: Record<Intent, string> = {
  NONE: 'No stated intent',
  CONSIDERING_BUY: 'Considering buying',
  HOLDING: 'Holding',
  THEMATIC: 'Thematic interest',
  HEDGE: 'Hedge',
}

export function WatchlistManager({
  items,
  available,
}: {
  items: Item[]
  available: Available[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState<string | null>(null)

  async function call(
    method: 'POST' | 'PATCH' | 'DELETE',
    body: Record<string, unknown>,
    key: string,
  ) {
    setBusy(key)
    const url =
      method === 'DELETE'
        ? `/api/watchlist/items?symbol=${encodeURIComponent(String(body.symbol))}`
        : '/api/watchlist/items'

    await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
    })

    setBusy(null)
    startTransition(() => router.refresh())
  }

  return (
    <div className="mt-8 flex flex-col gap-8">
      <section>
        <h2 className="mb-3 font-mono text-[10px] tracking-wider text-[color:var(--ink-3)]">
          WATCHING · {items.length}
        </h2>

        {items.length === 0 ? (
          <p className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-6 text-sm text-[color:var(--ink-3)]">
            Nothing watched yet. Add a name below and your first brief will
            appear after the next close.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li
                key={item.symbol}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <span className="font-mono text-sm font-semibold">
                    {item.symbol}
                  </span>
                  <p className="truncate text-xs text-[color:var(--ink-3)]">
                    {item.name}
                    {item.sector ? ` · ${item.sector}` : ''}
                  </p>
                </div>

                <label className="flex items-center gap-1.5">
                  <span className="font-mono text-[9px] tracking-wider text-[color:var(--ink-3)]">
                    PRIORITY
                  </span>
                  <select
                    value={item.priority}
                    disabled={busy === item.symbol || pending}
                    onChange={(e) =>
                      call(
                        'PATCH',
                        { symbol: item.symbol, priority: e.target.value },
                        item.symbol,
                      )
                    }
                    className="rounded-md border border-[color:var(--border-strong)] bg-[color:var(--surface-2)] px-2 py-1 text-xs text-[color:var(--ink)]"
                  >
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-1.5">
                  <span className="font-mono text-[9px] tracking-wider text-[color:var(--ink-3)]">
                    INTENT
                  </span>
                  <select
                    value={item.intent}
                    disabled={busy === item.symbol || pending}
                    onChange={(e) =>
                      call(
                        'PATCH',
                        { symbol: item.symbol, intent: e.target.value },
                        item.symbol,
                      )
                    }
                    className="rounded-md border border-[color:var(--border-strong)] bg-[color:var(--surface-2)] px-2 py-1 text-xs text-[color:var(--ink)]"
                  >
                    {(Object.keys(INTENT_LABEL) as Intent[]).map((i) => (
                      <option key={i} value={i}>
                        {INTENT_LABEL[i]}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  onClick={() => call('DELETE', { symbol: item.symbol }, item.symbol)}
                  disabled={busy === item.symbol || pending}
                  className="rounded-md border border-[color:var(--border-strong)] px-2 py-1 font-mono text-[10px] tracking-wide text-[color:var(--ink-3)] hover:border-[color:var(--down)] hover:text-[color:var(--down)] disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {available.length > 0 && (
        <section>
          <h2 className="mb-3 font-mono text-[10px] tracking-wider text-[color:var(--ink-3)]">
            AVAILABLE TO ADD
          </h2>
          <p className="mb-3 text-xs text-[color:var(--ink-3)]">
            A newly added name starts its cursor now, so it reports what happens
            from here rather than replaying history you never missed.
          </p>
          <div className="flex flex-wrap gap-2">
            {available.map((a) => (
              <button
                key={a.symbol}
                type="button"
                onClick={() => call('POST', { symbol: a.symbol }, a.symbol)}
                disabled={busy === a.symbol || pending}
                title={a.name}
                className="rounded-md border border-[color:var(--border-strong)] px-2.5 py-1 font-mono text-xs text-[color:var(--ink-2)] hover:border-[color:var(--accent)] hover:text-[color:var(--accent-ink)] disabled:opacity-50"
              >
                + {a.symbol}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
