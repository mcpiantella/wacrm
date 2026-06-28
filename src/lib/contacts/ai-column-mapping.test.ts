import { describe, it, expect, vi, beforeEach } from 'vitest'

const { chatCompleteJson } = vi.hoisted(() => ({ chatCompleteJson: vi.fn() }))
vi.mock('@/lib/ai/chat', () => ({ chatCompleteJson }))

import { inferColumnMapping } from './ai-column-mapping'

describe('inferColumnMapping', () => {
  beforeEach(() => chatCompleteJson.mockReset())

  it('returns the model mapping, clamped to valid indices', async () => {
    chatCompleteJson.mockResolvedValue({
      phone: 0, name: 1, email: null, company: 2, tags: null, defaultCountry: 'BR',
    })
    const out = await inferColumnMapping(['Telefone', 'Nome', 'Empresa'], [['11999', 'Ana', 'Acme']])
    expect(out).toEqual({ phone: 0, name: 1, email: null, company: 2, tags: null, defaultCountry: 'BR' })
    expect(chatCompleteJson).toHaveBeenCalledOnce()
    const arg = chatCompleteJson.mock.calls[0][0]
    expect(arg.system.toLowerCase()).toContain('json')
  })

  it('clamps out-of-range / non-number indices to null and defaults country', async () => {
    chatCompleteJson.mockResolvedValue({
      phone: 9, name: -1, email: 'x', company: 1.5, tags: 0,
    })
    const out = await inferColumnMapping(['a', 'b'], [['1', '2']])
    expect(out.phone).toBeNull()   // 9 out of range (len 2)
    expect(out.name).toBeNull()    // -1 invalid
    expect(out.email).toBeNull()   // 'x' not a number
    expect(out.company).toBeNull() // 1.5 not an integer
    expect(out.tags).toBe(0)
    expect(out.defaultCountry).toBe('BR') // omitted → default
  })
})
