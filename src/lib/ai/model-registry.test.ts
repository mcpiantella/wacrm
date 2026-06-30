import { describe, it, expect } from 'vitest'
import { MODEL_REGISTRY, resolveAllowedModels } from './model-registry'

describe('model-registry', () => {
  it('budget_default resolves to the mini default', () => {
    expect(resolveAllowedModels(['budget_default'])).toContain('gpt-5.4-mini')
  })
  it('resolves multiple keys, deduped', () => {
    const models = resolveAllowedModels(['budget_default', 'openai_4o_mini', 'budget_default'])
    expect(models).toEqual(expect.arrayContaining(['gpt-5.4-mini', 'gpt-4o-mini']))
    expect(new Set(models).size).toBe(models.length)
  })
  it('ignores unknown keys', () => {
    expect(resolveAllowedModels(['nope'])).toEqual([])
  })
  it('every registry entry has provider + model', () => {
    for (const v of Object.values(MODEL_REGISTRY)) {
      expect(v.provider).toMatch(/openai|anthropic/)
      expect(typeof v.model).toBe('string')
    }
  })
})
