'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

export function LoginForm() {
  const router = useRouter()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(formData: FormData) {
    setBusy(true)
    setError(null)

    const body = {
      email: String(formData.get('email') ?? ''),
      password: String(formData.get('password') ?? ''),
      ...(mode === 'register'
        ? { displayName: String(formData.get('displayName') ?? '') }
        : {}),
    }

    const res = await fetch(`/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const problem = await res.json().catch(() => null)
      setError(problem?.detail ?? 'Something went wrong.')
      setBusy(false)
      return
    }

    router.push('/')
    router.refresh()
  }

  return (
    <form action={submit} className="mt-8 flex flex-col gap-3">
      {mode === 'register' && (
        <Field name="displayName" label="Name" type="text" autoComplete="name" />
      )}
      <Field name="email" label="Email" type="email" autoComplete="email" />
      <Field
        name="password"
        label="Password"
        type="password"
        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
      />

      {error && (
        <p className="text-sm text-[color:var(--down)]" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="mt-2 rounded-md bg-[color:var(--accent)] px-3 py-2 text-sm font-medium text-[#1a1206] hover:brightness-110 disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent)]"
      >
        {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
      </button>

      <button
        type="button"
        onClick={() => {
          setMode((m) => (m === 'login' ? 'register' : 'login'))
          setError(null)
        }}
        className="text-xs text-[color:var(--ink-3)] underline decoration-dotted underline-offset-4 hover:text-[color:var(--ink-2)]"
      >
        {mode === 'login'
          ? 'Need an account? Create one'
          : 'Already have an account? Sign in'}
      </button>

      <p className="mt-4 rounded-md border border-[color:var(--border)] bg-[color:var(--surface)] p-3 font-mono text-[11px] leading-relaxed text-[color:var(--ink-3)]">
        demo account
        <br />
        demo@sitrep.local / sitrep-demo
      </p>
    </form>
  )
}

function Field({
  name,
  label,
  type,
  autoComplete,
}: {
  name: string
  label: string
  type: string
  autoComplete?: string
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] tracking-wider text-[color:var(--ink-3)]">
        {label.toUpperCase()}
      </span>
      <input
        name={name}
        type={type}
        required
        autoComplete={autoComplete}
        className="rounded-md border border-[color:var(--border-strong)] bg-[color:var(--surface)] px-3 py-2 text-sm text-[color:var(--ink)] focus-visible:outline-2 focus-visible:outline-[color:var(--accent)]"
      />
    </label>
  )
}
