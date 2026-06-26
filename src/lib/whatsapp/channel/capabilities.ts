import type { Provider } from './types'

/**
 * What a channel can do, by provider. Drives the capability badges in
 * the channels UI and the server-side guards (e.g. only Cloud can send
 * approved templates / message outside the 24h window).
 */
export interface ChannelCapabilities {
  /** Meta-approved templates (first-touch / outside the 24h window). */
  templates: boolean
  /** Freeform text messages. */
  freeform: boolean
}

export function channelCapabilities(provider: Provider): ChannelCapabilities {
  return {
    templates: provider === 'cloud',
    freeform: true,
  }
}
