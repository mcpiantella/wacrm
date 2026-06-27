import { Queue } from 'bullmq'
import { getRedisConnection } from './connection'

export const SDR_QUEUE_NAME = 'sdr'

export interface SdrJobData {
  conversationId: string
  accountId: string
  /** Job kind; absent means the original debounce-qualify job. */
  kind?: 'qualify' | 'followup'
  /** 1-based reminder number, for followup jobs. */
  attempt?: number
}

let queue: Queue<SdrJobData> | null = null

/** Lazily create the shared SDR queue (no Redis socket until first use). */
export function getSdrQueue(): Queue<SdrJobData> {
  if (!queue) {
    queue = new Queue<SdrJobData>(SDR_QUEUE_NAME, {
      connection: getRedisConnection(),
    })
  }
  return queue
}

/**
 * Stable per-conversation job id — the basis of the debounce.
 *
 * Uses `-` (not `:`) as the separator: BullMQ reserves `:` for its internal
 * Redis key structure and rejects custom job ids that contain one
 * ("Custom Id cannot contain :"). Conversation ids are UUIDs (no colons),
 * so `sdr-<uuid>` is always valid.
 */
export function sdrJobId(conversationId: string): string {
  return `sdr-${conversationId}`
}

/**
 * Enqueue — or refresh — a debounced SDR job for a conversation.
 *
 * Rapid-fire inbound messages must NOT each trigger a reply. We key the
 * job by conversation (`sdr-<id>`) and, on every new message, remove any
 * pending delayed job and re-add with `delay = debounceSeconds`. The
 * timer resets, so the SDR fires once after the lead goes quiet and
 * reads the whole batch from history.
 *
 * Edge: if the previous job is already *active* (being processed), the
 * remove is a no-op and the new add is deduped by jobId — the just-
 * arrived message is then picked up on the next run, since the worker
 * always re-reads the full conversation. Acceptable; documented.
 *
 * `queueOverride` exists for tests (inject a fake queue, no Redis).
 */
export async function enqueueSdr(
  conversationId: string,
  accountId: string,
  debounceSeconds: number,
  queueOverride?: Pick<Queue<SdrJobData>, 'getJob' | 'add'>,
): Promise<void> {
  const q = queueOverride ?? getSdrQueue()
  const jobId = sdrJobId(conversationId)

  const existing = await q.getJob(jobId)
  if (existing) {
    // Reset the debounce window — drop the pending job, ignore races.
    await existing.remove().catch(() => undefined)
  }

  await q.add(
    'qualify',
    { conversationId, accountId },
    {
      jobId,
      delay: Math.max(0, debounceSeconds) * 1000,
      removeOnComplete: true,
      removeOnFail: 100,
    },
  )
}

/** Stable per-conversation follow-up job id (hyphen, not ':' — BullMQ bans ':'). */
export function followUpJobId(conversationId: string): string {
  return `sdrfu-${conversationId}`
}

/**
 * Remove any pending follow-up for a conversation. Called when the lead
 * comes back (a customer message arrives) so a stale reminder can't fire;
 * the ensuing SDR reply re-arms reminder #1 from scratch.
 */
export async function cancelFollowUp(
  conversationId: string,
  queueOverride?: Pick<Queue<SdrJobData>, 'getJob'>,
): Promise<void> {
  const q = queueOverride ?? getSdrQueue()
  const existing = await q.getJob(followUpJobId(conversationId))
  if (existing) await existing.remove().catch(() => undefined)
}

/**
 * Schedule (or reschedule) a follow-up reminder for a conversation.
 * One pending follow-up per conversation: a stable jobId means re-adding
 * replaces the previous one. `delayMinutes` is the gap from now.
 */
export async function enqueueFollowUp(
  conversationId: string,
  accountId: string,
  attempt: number,
  delayMinutes: number,
  queueOverride?: Pick<Queue<SdrJobData>, 'getJob' | 'add'>,
): Promise<void> {
  const q = queueOverride ?? getSdrQueue()
  const jobId = followUpJobId(conversationId)

  const existing = await q.getJob(jobId)
  if (existing) await existing.remove().catch(() => undefined)

  await q.add(
    'followup',
    { kind: 'followup', conversationId, accountId, attempt },
    {
      jobId,
      delay: Math.max(0, delayMinutes) * 60_000,
      removeOnComplete: true,
      removeOnFail: 100,
    },
  )
}
