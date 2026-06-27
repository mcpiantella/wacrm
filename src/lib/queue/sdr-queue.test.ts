import { describe, it, expect, vi } from 'vitest'
import { enqueueSdr, sdrJobId, SDR_QUEUE_NAME } from './sdr-queue'
import { enqueueFollowUp, followUpJobId, cancelFollowUp } from './sdr-queue'

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

describe('enqueueFollowUp', () => {
  it('adds a delayed followup job keyed by conversation', async () => {
    const q = fakeQueue()
    q.getJob.mockResolvedValue(null)

    await enqueueFollowUp('conv-1', 'acc-1', 2, 21 * 60, q)

    expect(q.add).toHaveBeenCalledWith(
      'followup',
      { kind: 'followup', conversationId: 'conv-1', accountId: 'acc-1', attempt: 2 },
      expect.objectContaining({ jobId: 'sdrfu-conv-1', delay: 21 * 60 * 60_000 }),
    )
  })

  it('removes a pending followup before re-adding (reschedule)', async () => {
    const q = fakeQueue()
    const remove = vi.fn().mockResolvedValue(undefined)
    q.getJob.mockResolvedValue({ remove })
    await enqueueFollowUp('conv-1', 'acc-1', 1, 180, q)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('derives a hyphen-separated job id (no colon)', () => {
    expect(followUpJobId('abc')).toBe('sdrfu-abc')
  })
})

describe('cancelFollowUp', () => {
  it('removes a pending follow-up job when one exists', async () => {
    const q = fakeQueue()
    const remove = vi.fn().mockResolvedValue(undefined)
    q.getJob.mockResolvedValue({ remove })
    await cancelFollowUp('conv-1', q)
    expect(q.getJob).toHaveBeenCalledWith('sdrfu-conv-1')
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when no follow-up is pending', async () => {
    const q = fakeQueue()
    q.getJob.mockResolvedValue(null)
    await expect(cancelFollowUp('conv-1', q)).resolves.toBeUndefined()
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
