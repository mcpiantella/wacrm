import { describe, it, expect, vi, beforeEach } from 'vitest'
import { encrypt } from '@/lib/whatsapp/encryption'
import { CloudApiChannel } from './cloud-api-channel'
import type { ChannelRow } from './types'

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTextMessage: vi.fn(async () => ({ messageId: 'wamid.TEXT' })),
  sendTemplateMessage: vi.fn(async () => ({ messageId: 'wamid.TEMPLATE' })),
  sendMediaMessage: vi.fn(async () => ({ messageId: 'wamid.MEDIA' })),
}))

import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
} from '@/lib/whatsapp/meta-api'

const PLAINTEXT_TOKEN = 'EAAG-super-secret-access-token'

function cloudRow(overrides: Partial<ChannelRow> = {}): ChannelRow {
  return {
    id: 'chan-1',
    account_id: 'acc-1',
    provider: 'cloud',
    identifier: '123456789', // = phone_number_id
    display_name: 'Vendas',
    phone_e164: '+5511999999999',
    status: 'connected',
    config: { waba_id: 'waba-1' },
    credentials: { access_token: encrypt(PLAINTEXT_TOKEN) },
    ...overrides,
  }
}

describe('CloudApiChannel', () => {
  beforeEach(() => vi.clearAllMocks())

  it('exposes provider/identifier and declares template support', () => {
    const ch = new CloudApiChannel(cloudRow())
    expect(ch.provider).toBe('cloud')
    expect(ch.identifier).toBe('123456789')
    expect(ch.supportsTemplates).toBe(true)
    expect(ch.id).toBe('chan-1')
  })

  it('sendText decrypts the token and forwards phone_number_id to Meta', async () => {
    const ch = new CloudApiChannel(cloudRow())
    const result = await ch.sendText({ to: '+5511888888888', text: 'oi' })

    expect(result).toEqual({ messageId: 'wamid.TEXT' })
    expect(sendTextMessage).toHaveBeenCalledWith({
      phoneNumberId: '123456789',
      accessToken: PLAINTEXT_TOKEN, // decrypted, not ciphertext
      to: '+5511888888888',
      text: 'oi',
      contextMessageId: undefined,
    })
  })

  it('sendText passes contextMessageId through for quoted replies', async () => {
    const ch = new CloudApiChannel(cloudRow())
    await ch.sendText({ to: '+551', text: 'hi', contextMessageId: 'wamid.PARENT' })
    expect(sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ contextMessageId: 'wamid.PARENT' }),
    )
  })

  it('sendTemplate injects credentials and returns the messageId', async () => {
    const ch = new CloudApiChannel(cloudRow())
    const result = await ch.sendTemplate({
      to: '+551',
      templateName: 'welcome',
      language: 'pt_BR',
    })
    expect(result).toEqual({ messageId: 'wamid.TEMPLATE' })
    expect(sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: '123456789',
        accessToken: PLAINTEXT_TOKEN,
        templateName: 'welcome',
        language: 'pt_BR',
      }),
    )
  })

  it('sendMedia injects credentials and returns the messageId', async () => {
    const ch = new CloudApiChannel(cloudRow())
    const result = await ch.sendMedia({
      to: '+551',
      kind: 'image',
      link: 'https://x/y.png',
    })
    expect(result).toEqual({ messageId: 'wamid.MEDIA' })
    expect(sendMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: '123456789',
        accessToken: PLAINTEXT_TOKEN,
        kind: 'image',
        link: 'https://x/y.png',
      }),
    )
  })

  it('rejects a non-cloud row', () => {
    expect(() => new CloudApiChannel(cloudRow({ provider: 'evolution' }))).toThrow(
      /expected 'cloud'/,
    )
  })

  it('rejects a row with no access_token', () => {
    expect(() => new CloudApiChannel(cloudRow({ credentials: {} }))).toThrow(
      /missing credentials.access_token/,
    )
  })

  it('rejects a row with no identifier', () => {
    expect(() => new CloudApiChannel(cloudRow({ identifier: '' }))).toThrow(
      /missing identifier/,
    )
  })
})
