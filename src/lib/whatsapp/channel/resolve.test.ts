import { describe, it, expect } from 'vitest'
import {
  flattenCloudChannel,
  buildCloudChannelRow,
  type CloudChannelWrite,
} from './resolve'

describe('flattenCloudChannel', () => {
  it('maps channel columns + JSONB back to the legacy whatsapp_config shape', () => {
    const flat = flattenCloudChannel({
      id: 'chan-1',
      account_id: 'acc-1',
      user_id: 'user-1',
      identifier: '123456789',
      status: 'connected',
      connected_at: '2026-06-26T00:00:00Z',
      config: {
        waba_id: 'waba-1',
        verify_token: 'enc-verify',
        registered_at: '2026-06-25T00:00:00Z',
        subscribed_apps_at: '2026-06-25T01:00:00Z',
        last_registration_error: null,
      },
      credentials: { access_token: 'enc-token' },
    })

    expect(flat).toEqual({
      id: 'chan-1',
      account_id: 'acc-1',
      user_id: 'user-1',
      phone_number_id: '123456789', // identifier → phone_number_id
      access_token: 'enc-token', // credentials.access_token (ciphertext)
      waba_id: 'waba-1',
      verify_token: 'enc-verify',
      status: 'connected',
      registered_at: '2026-06-25T00:00:00Z',
      subscribed_apps_at: '2026-06-25T01:00:00Z',
      last_registration_error: null,
      connected_at: '2026-06-26T00:00:00Z',
    })
  })

  it('tolerates empty/missing JSONB without throwing', () => {
    const flat = flattenCloudChannel({
      id: 'c',
      account_id: 'a',
      user_id: null,
      identifier: '1',
      status: 'disconnected',
      connected_at: null,
      config: null,
      credentials: null,
    })
    expect(flat.access_token).toBe('')
    expect(flat.waba_id).toBeNull()
    expect(flat.verify_token).toBeNull()
    expect(flat.user_id).toBeNull()
  })
})

describe('buildCloudChannelRow', () => {
  const write: CloudChannelWrite = {
    phone_number_id: '123456789',
    waba_id: 'waba-1',
    encrypted_access_token: 'enc-token',
    encrypted_verify_token: 'enc-verify',
    status: 'connected',
    connected_at: '2026-06-26T00:00:00Z',
    registered_at: '2026-06-25T00:00:00Z',
    subscribed_apps_at: '2026-06-25T01:00:00Z',
    last_registration_error: null,
  }

  it('maps legacy write fields onto channels columns + JSONB', () => {
    const row = buildCloudChannelRow(write)
    expect(row.identifier).toBe('123456789')
    expect(row.status).toBe('connected')
    expect(row.connected_at).toBe('2026-06-26T00:00:00Z')
    expect(row.credentials).toEqual({ access_token: 'enc-token' })
    expect(row.config).toMatchObject({
      waba_id: 'waba-1',
      verify_token: 'enc-verify',
      registered_at: '2026-06-25T00:00:00Z',
    })
    expect(typeof row.updated_at).toBe('string')
  })

  it('round-trips through flattenCloudChannel (write → read parity)', () => {
    const built = buildCloudChannelRow(write)
    const flat = flattenCloudChannel({
      id: 'c',
      account_id: 'a',
      user_id: 'u',
      identifier: built.identifier,
      status: built.status,
      connected_at: built.connected_at,
      config: built.config,
      credentials: built.credentials,
    })
    expect(flat.phone_number_id).toBe(write.phone_number_id)
    expect(flat.access_token).toBe(write.encrypted_access_token)
    expect(flat.waba_id).toBe(write.waba_id)
    expect(flat.verify_token).toBe(write.encrypted_verify_token)
    expect(flat.registered_at).toBe(write.registered_at)
  })
})
