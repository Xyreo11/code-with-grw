import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth'
import { LoginForm } from '@/components/LoginForm'

export const dynamic = 'force-dynamic'

export default async function LoginPage() {
  if (await currentUser()) redirect('/')

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-5 py-16">
      <span className="font-mono text-[11px] tracking-[0.2em] text-[color:var(--accent-ink)]">
        SITREP
      </span>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">
        Your market, since you last looked.
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-[color:var(--ink-3)]">
        A watchlist that tells you what meaningfully changed while you were
        away, why it matters, and what it decided not to bother you with.
      </p>

      <LoginForm />
    </main>
  )
}
