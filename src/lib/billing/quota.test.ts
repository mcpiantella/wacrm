import { describe, it, expect, vi } from 'vitest'
import { consumeAiMessageOrThrow } from './quota'
import { BillingError } from './errors'

function db(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as unknown as Parameters<typeof consumeAiMessageOrThrow>[0]
}

describe('consumeAiMessageOrThrow', () => {
  it('returns the remaining quota on success', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 49, error: null })
    await expect(consumeAiMessageOrThrow(db(rpc), 'acc-1')).resolves.toBe(49)
    expect(rpc).toHaveBeenCalledWith('consume_ai_message', { p_account: 'acc-1' })
  })
  it('throws a typed BillingError when the function raises a known code', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'ai_quota_exceeded' } })
    await expect(consumeAiMessageOrThrow(db(rpc), 'acc-1')).rejects.toMatchObject({
      name: 'BillingError', code: 'ai_quota_exceeded',
    })
  })
  it('rethrows an unrelated error untouched', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'connection reset' } })
    await expect(consumeAiMessageOrThrow(db(rpc), 'acc-1')).rejects.not.toBeInstanceOf(BillingError)
  })
})
