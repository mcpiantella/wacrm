import { describe, it, expect } from 'vitest'
import { assertModelAllowed } from './allowed-models'

// supabase stub: from() called twice — first the subscriptions row (plan_id),
// then the plans row (allowed_model_keys).
function db(keys: string[] | null) {
  let call = 0
  const chain = (data: unknown) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }) }) }) })
  return { from: () => { call++; return call === 1 ? chain({ plan_id: 'p' }) : chain(keys ? { allowed_model_keys: keys } : null) } } as never
}

describe('assertModelAllowed', () => {
  it('passes when model is null (worker default)', async () => {
    await expect(assertModelAllowed(db(['budget_default']), 'acc', null)).resolves.toBeUndefined()
  })
  it('passes when model is in the plan resolved set', async () => {
    await expect(assertModelAllowed(db(['budget_default']), 'acc', 'gpt-5.4-mini')).resolves.toBeUndefined()
  })
  it('throws model_not_allowed for a model outside the plan', async () => {
    await expect(assertModelAllowed(db(['budget_default']), 'acc', 'claude-sonnet-4-6'))
      .rejects.toMatchObject({ code: 'model_not_allowed' })
  })
  it('passes premium model on a plan whose keys include it', async () => {
    await expect(assertModelAllowed(db(['budget_default', 'premium_anthropic']), 'acc', 'claude-sonnet-4-6'))
      .resolves.toBeUndefined()
  })
})
