import { describe, it, expect, vi, beforeEach } from 'vitest'

const { chatCompleteJson } = vi.hoisted(() => ({ chatCompleteJson: vi.fn() }))
vi.mock('./chat', () => ({ chatCompleteJson }))

import { generateTemplate } from './generate-template'

describe('generateTemplate', () => {
  beforeEach(() => chatCompleteJson.mockReset())

  it('normalises a well-formed model response', async () => {
    chatCompleteJson.mockResolvedValue({
      name: 'Promoção Imóveis!! Zona Sul',
      category: 'Marketing',
      body_text: '  Olá {{1}}, temos novidades.  ',
    })
    const out = await generateTemplate('imobiliária SP')
    expect(out.name).toBe('promocao_imoveis_zona_sul')
    expect(out.category).toBe('Marketing')
    expect(out.body_text).toBe('Olá {{1}}, temos novidades.')
  })

  it('defaults category to Marketing and name when missing', async () => {
    chatCompleteJson.mockResolvedValue({ category: 'Nonsense', body_text: 123 })
    const out = await generateTemplate('algo')
    expect(out.category).toBe('Marketing')
    expect(out.name).toBe('template_ia')
    expect(out.body_text).toBe('')
  })

  it('keeps Utility when the model returns it, and asks for JSON', async () => {
    chatCompleteJson.mockResolvedValue({ name: 'lembrete', category: 'Utility', body_text: 'Oi' })
    const out = await generateTemplate('lembrete de agendamento')
    expect(out.category).toBe('Utility')
    const arg = chatCompleteJson.mock.calls[0][0]
    expect(arg.system.toLowerCase()).toContain('json')
  })
})
