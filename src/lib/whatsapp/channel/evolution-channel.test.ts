import { describe, it, expect, vi, beforeEach } from 'vitest'
import { encrypt } from '@/lib/whatsapp/encryption'
import { EvolutionChannel } from './evolution-channel'
import type { ChannelRow } from './types'

vi.mock('@/lib/whatsapp/evolution-api', () => ({
  sendEvolutionText: vi.fn(async () => ({ messageId: 'BAE5-EVO' })),
}))

import { sendEvolutionText } from '@/lib/whatsapp/evolution-api'

const API_KEY = 'evo-instance-key'

function evoRow(overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: 'chan-evo',
    account_id: 'acc-1',
    provider: 'evolution',
    identifier: 'imobquest', // instance name
    display_name: 'Imob',
    phone_e164: '+5516997426401',
    status: 'connected',
    config: { base_url: 'https://evo.example.com' },
    credentials: { api_key: encrypt(API_KEY) },
    ...overrides,
  }
}

describe('EvolutionChannel', () => {
  beforeEach(() => vi.clearAllMocks())

  it('exposes provider/identifier and does not support templates', () => {
    const ch = new EvolutionChannel(evoRow())
    expect(ch.provider).toBe('evolution')
    expect(ch.identifier).toBe('imobquest')
    expect(ch.supportsTemplates).toBe(false)
    expect(ch.id).toBe('chan-evo')
  })

  it('sendText decrypts the api_key and forwards baseUrl + instance', async () => {
    const ch = new EvolutionChannel(evoRow())
    const result = await ch.sendText({ to: '+5511888888888', text: 'oi' })

    expect(result).toEqual({ messageId: 'BAE5-EVO' })
    expect(sendEvolutionText).toHaveBeenCalledWith({
      baseUrl: 'https://evo.example.com',
      apiKey: API_KEY, // decrypted
      instance: 'imobquest',
      to: '+5511888888888',
      text: 'oi',
    })
  })

  it('rejects a non-evolution row', () => {
    expect(() => new EvolutionChannel(evoRow({ provider: 'cloud' }))).toThrow(
      /expected 'evolution'/,
    )
  })

  it('rejects a row with no base_url', () => {
    expect(() => new EvolutionChannel(evoRow({ config: {} }))).toThrow(
      /missing config.base_url/,
    )
  })

  it('rejects a row with no api_key', () => {
    expect(() => new EvolutionChannel(evoRow({ credentials: {} }))).toThrow(
      /missing credentials.api_key/,
    )
  })

  it('rejects a row with no identifier', () => {
    expect(() => new EvolutionChannel(evoRow({ identifier: '' }))).toThrow(
      /missing identifier/,
    )
  })
})
