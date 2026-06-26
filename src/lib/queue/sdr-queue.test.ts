import { describe, it, expect, vi } from 'vitest'
import { enqueueSdr, sdrJobId, SDR_QUEUE_NAME } from './sdr-queue'

function fakeQueue() {
  return {
    getJob: vi.fn(),
    add: vi.fn(),
  }
}

describe('enqueueSdr', () => {
  it('adds a delayed job keyed by conversation when none exists', async () => {
    const q = fakeQueue()
    q.getJob.mockResolvedValue(null)

    await enqueueSdr('conv-1', 'acc-1', 12, q)

    expect(q.add).toHaveBeenCalledWith(
      'qualify',
      { conversationId: 'conv-1', accountId: 'acc-1' },
      expect.objectContaining({ jobId: 'sdr-conv-1', delay: 12_000, removeOnComplete: true }),
    )
  })

  it('resets the debounce by removing the pending job before re-adding', async () => {
    const q = fakeQueue()
    const remove = vi.fn().mockResolvedValue(undefined)
    q.getJob.mockResolvedValue({ remove })

    await enqueueSdr('conv-1', 'acc-1', 15, q)

    expect(remove).toHaveBeenCalledTimes(1)
    expect(q.add).toHaveBeenCalledWith(
      'qualify',
      expect.any(Object),
      expect.objectContaining({ jobId: 'sdr-conv-1', delay: 15_000 }),
    )
  })

  it('swallows a remove race and still enqueues', async () => {
    const q = fakeQueue()
    q.getJob.mockResolvedValue({ remove: vi.fn().mockRejectedValue(new Error('locked')) })

    await expect(enqueueSdr('conv-2', 'acc-1', 10, q)).resolves.toBeUndefined()
    expect(q.add).toHaveBeenCalledTimes(1)
  })

  it('clamps a negative debounce to 0 delay', async () => {
    const q = fakeQueue()
    q.getJob.mockResolvedValue(null)
    await enqueueSdr('conv-3', 'acc-1', -5, q)
    expect(q.add).toHaveBeenCalledWith(
      'qualify',
      expect.any(Object),
      expect.objectContaining({ delay: 0 }),
    )
  })
})

describe('sdrJobId / constants', () => {
  it('derives a stable per-conversation id', () => {
    expect(sdrJobId('abc')).toBe('sdr-abc')
  })
  it('exposes the queue name', () => {
    expect(SDR_QUEUE_NAME).toBe('sdr')
  })
})
