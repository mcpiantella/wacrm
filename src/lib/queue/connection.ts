import IORedis, { type Redis } from 'ioredis'

/**
 * Lazy, shared Redis connection for BullMQ.
 *
 * IMPORTANT: never connect at import time — a route that merely imports
 * the queue must not open a socket during the Next build/edge analysis
 * (blueprint risk R1). The connection is created on first use only.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ (its blocking
 * commands must not be capped by ioredis's per-request retry limit).
 */
let connection: Redis | null = null

export function getRedisConnection(): Redis {
  if (connection) return connection
  const url = process.env.REDIS_URL
  if (!url) {
    throw new Error('REDIS_URL is not set — required for the SDR queue/worker.')
  }
  connection = new IORedis(url, { maxRetriesPerRequest: null })
  return connection
}
