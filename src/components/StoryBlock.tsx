import type { Narrative } from '@/engine/narrative'

/**
 * THE STORY — the connective tissue between individual events.
 *
 * Produced by a deterministic rule table over computed facts. No language model
 * reaches a conclusion here, and every figure in the sentence is substituted
 * from a number the engine calculated. A fluent paragraph about someone's money
 * that nobody can trace back to a computation is worse than no paragraph.
 *
 * The rule id is shown deliberately: the reasoning should be inspectable, not
 * merely confident.
 */
export function StoryBlock({ narrative }: { narrative: Narrative }) {
  return (
    <section className="rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] p-5">
      <h2 className="mb-2 font-mono text-[10px] tracking-wider text-[color:var(--accent-ink)]">
        THE STORY
      </h2>
      <p className="text-[15px] leading-relaxed text-[color:var(--ink)]">
        {narrative.text}
      </p>
      <p className="mt-3 font-mono text-[10px] tracking-wide text-[color:var(--ink-3)]">
        rule: {narrative.ruleId}
      </p>
    </section>
  )
}
