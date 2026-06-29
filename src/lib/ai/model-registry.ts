// Maps a plan's capability keys to concrete provider models. Plans store
// keys (not raw model strings) so provider/model churn never needs a data
// migration. Premium keys are only ever attached to custom/enterprise plans.
export const MODEL_REGISTRY = {
  budget_default:    { provider: 'openai',    model: 'gpt-5.4-mini' },
  openai_4o_mini:    { provider: 'openai',    model: 'gpt-4o-mini' },
  anthropic_haiku:   { provider: 'anthropic', model: 'claude-haiku-4-5' },
  premium_anthropic: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
} as const

export type ModelKey = keyof typeof MODEL_REGISTRY

/** Concrete model strings the given capability keys resolve to (deduped). */
export function resolveAllowedModels(keys: string[]): string[] {
  const out = new Set<string>()
  for (const k of keys) {
    const entry = (MODEL_REGISTRY as Record<string, { model: string }>)[k]
    if (entry) out.add(entry.model)
  }
  return [...out]
}
