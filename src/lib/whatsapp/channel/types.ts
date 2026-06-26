/**
 * WhatsApp channel abstraction (S5 of the wacrm↔Zenith merge).
 *
 * A "channel" is one WhatsApp number an account can send from. Two
 * providers exist side by side (see migration 028_channels):
 *   - 'cloud'      → WhatsApp Cloud API (Meta, official). Supports
 *                    approved templates + media; free-form text only
 *                    inside the 24h customer-service window.
 *   - 'evolution'  → Evolution API (unofficial). Free-form text only;
 *                    no Meta templates.
 *
 * `sendText` is the cross-provider primitive every channel implements.
 * Capabilities that only some providers have (templates, media) live on
 * the concrete class and are gated by `supportsTemplates`, so callers
 * stay honest about what a given channel can actually do.
 */

export type Provider = 'cloud' | 'evolution'

export type ChannelStatus = 'connected' | 'disconnected' | 'error'

/**
 * One row of the `channels` table. `config` holds non-secret provider
 * metadata; `credentials` holds CIPHERTEXT secrets (decrypted lazily by
 * the concrete channel using ENCRYPTION_KEY).
 */
export interface ChannelRow {
  id: string
  account_id: string
  provider: Provider
  identifier: string
  display_name: string | null
  phone_e164: string | null
  status: ChannelStatus
  config: Record<string, unknown>
  credentials: Record<string, unknown>
}

export interface SendTextInput {
  to: string
  text: string
  /** Meta message_id being replied to (Cloud renders a quoted reply). */
  contextMessageId?: string
}

export interface SendResult {
  messageId: string
}

/**
 * The provider-agnostic surface a caller can rely on. Anything beyond
 * `sendText` is provider-specific — narrow on `provider` /
 * `supportsTemplates` before reaching for it.
 */
export interface WhatsAppChannel {
  readonly id: string
  readonly provider: Provider
  /** Inbound routing key (Cloud: phone_number_id; Evolution: instance). */
  readonly identifier: string
  readonly supportsTemplates: boolean
  sendText(input: SendTextInput): Promise<SendResult>
}
