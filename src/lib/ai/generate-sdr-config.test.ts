import { describe, it, expect, vi, beforeEach } from 'vitest'

const { chatCompleteJson } = vi.hoisted(() => ({
  chatCompleteJson: vi.fn(),
}))

vi.mock('./chat', () => ({ chatCompleteJson }))

import { generateSdrConfig } from './generate-sdr-config'

describe('generateSdrConfig', () => {
  beforeEach(() => chatCompleteJson.mockReset())

  it('normalises a well-formed model response', async () => {
    chatCompleteJson.mockResolvedValue({
      system_prompt: '  Você é um SDR de imobiliária...  ',
      qualification_criteria: ['Orçamento', '  Prazo  ', '', 42],
      handoff_keywords: ['falar com humano', 'atendente'],
    })

    const out = await generateSdrConfig('Imobiliária em SP, qualificar leads')

    expect(out.system_prompt).toBe('Você é um SDR de imobiliária...')
    // trims, drops empties and non-strings
    expect(out.qualification_criteria).toEqual(['Orçamento', 'Prazo'])
    expect(out.handoff_keywords).toEqual(['falar com humano', 'atendente'])
  })

  it('tolerates missing/!array fields', async () => {
    chatCompleteJson.mockResolvedValue({ system_prompt: 123 })
    const out = await generateSdrConfig('algum briefing aqui')
    expect(out).toEqual({
      system_prompt: '',
      qualification_criteria: [],
      handoff_keywords: [],
    })
  })

  it('asks the model for JSON', async () => {
    chatCompleteJson.mockResolvedValue({})
    await generateSdrConfig('briefing de teste')
    const arg = chatCompleteJson.mock.calls[0][0]
    expect(arg.json).toBe(true)
    expect(arg.system.toLowerCase()).toContain('json')
    expect(arg.messages[0]).toEqual({ role: 'user', content: 'briefing de teste' })
  })
})
