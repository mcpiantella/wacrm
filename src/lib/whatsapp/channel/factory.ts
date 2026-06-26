import type { ChannelRow, WhatsAppChannel } from './types'
import { CloudApiChannel } from './cloud-api-channel'

/**
 * Build the right `WhatsAppChannel` for a `channels` row.
 *
 * This is the single place that maps `provider` → implementation, so
 * callers never branch on provider themselves. Evolution lands in S6;
 * until then it throws a clear, actionable error rather than silently
 * returning a half-channel.
 */
export function createChannel(row: ChannelRow): WhatsAppChannel {
  switch (row.provider) {
    case 'cloud':
      return new CloudApiChannel(row)
    case 'evolution':
      throw new Error(
        `Evolution channels are not implemented yet (S6). Channel ${row.id}.`,
      )
    default: {
      // Exhaustiveness guard — a new provider in the DB enum without a
      // matching case lands here loudly instead of being ignored.
      const exhaustive: never = row.provider
      throw new Error(`Unknown channel provider: ${String(exhaustive)}`)
    }
  }
}
