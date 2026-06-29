import Link from 'next/link'
import { Check, Circle, ArrowRight } from 'lucide-react'
import type { OnboardingState } from '@/lib/dashboard/types'

interface Step {
  key: keyof OnboardingState
  label: string
  href: string
  cta: string
}

const STEPS: Step[] = [
  { key: 'hasChannel', label: 'Conectar um número de WhatsApp', href: '/settings?tab=channels', cta: 'Conectar' },
  { key: 'hasContacts', label: 'Adicionar contatos', href: '/contacts', cta: 'Adicionar' },
  { key: 'hasBroadcast', label: 'Criar sua primeira campanha', href: '/broadcasts/new', cta: 'Criar' },
  { key: 'hasSdr', label: 'Ativar o SDR com IA numa campanha', href: '/broadcasts', cta: 'Configurar' },
]

/**
 * First-run checklist. Renders the setup steps with a CTA for each pending one
 * and self-hides once every step is done — no dismissal state needed.
 */
export function OnboardingChecklist({ state }: { state: OnboardingState }) {
  const done = STEPS.filter((s) => state[s.key]).length
  if (done === STEPS.length) return null

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Primeiros passos</h2>
          <p className="text-xs text-muted-foreground">
            Configure o essencial para começar a disparar e qualificar leads.
          </p>
        </div>
        <span className="text-xs font-medium text-muted-foreground">
          {done}/{STEPS.length}
        </span>
      </div>

      <div className="mt-3 space-y-2">
        {STEPS.map((s) => {
          const ok = state[s.key]
          return (
            <div
              key={s.key}
              className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                {ok ? (
                  <Check className="size-4 shrink-0 text-primary" />
                ) : (
                  <Circle className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span
                  className={
                    ok
                      ? 'truncate text-sm text-muted-foreground line-through'
                      : 'truncate text-sm text-foreground'
                  }
                >
                  {s.label}
                </span>
              </div>
              {!ok && (
                <Link
                  href={s.href}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium"
                >
                  {s.cta}
                  <ArrowRight className="size-3" />
                </Link>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
