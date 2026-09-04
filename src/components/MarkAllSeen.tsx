'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

/**
 * Advance the cursor for everything currently in the brief.
 *
 * Deliberately an explicit action. Merely LOADING the SITREP never moves the
 * cursor - otherwise glancing at it on a phone would silently wipe the brief
 * waiting on a laptop, which is exactly the cross-device behaviour the cursor
 * exists to get right.
 */
export function MarkAllSeen() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  async function acknowledge() {
    await fetch('/api/watch-state/mark-seen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    })
    startTransition(() => router.refresh())
  }

  return (
    <button
      type="button"
      onClick={acknowledge}
      disabled={pending}
      className="shrink-0 rounded-md border border-[color:var(--border-strong)] px-2.5 py-1 font-mono text-[11px] tracking-wide text-[color:var(--ink-2)] hover:border-[color:var(--accent)] hover:text-[color:var(--accent-ink)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-[color:var(--accent)]"
    >
      {pending ? 'Marking…' : 'Mark all seen'}
    </button>
  )
}
