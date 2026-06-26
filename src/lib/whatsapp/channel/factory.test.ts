import { describe, it, expect, vi } from 'vitest'
import { encrypt } from '@/lib/whatsapp/encryption'
import { createChannel } from './factory'
import { CloudApiChannel } from './cloud-api-channel'
import type { ChannelRow } from './types'

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: vi.fn(),
  sendTemplateMessage: vi.fn(),
  sendMediaMessage: vi.fn(),
}))

function row(overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: 'chan-1',
    account_id: 'acc-1',
    provider: 'cloud',
    identifier: '123',
    display_name: null,
    phone_e164: null,
    status: 'connected',
    config: {},
    credentials: { access_token: encrypt('tok') },
    ...overrides,
  }
}

describe('createChannel', () => {
  it('builds a CloudApiChannel for provider="cloud"', () => {
    const ch = createChannel(row())
    expect(ch).toBeInstanceOf(CloudApiChannel)
    expect(ch.provider).toBe('cloud')
  })

  it('throws a clear "not implemented" error for provider="evolution"', () => {
    expect(() => createChannel(row({ provider: 'evolution' }))).toThrow(
      /Evolution channels are not implemented yet/,
    )
  })
})
