import { sendEvolutionText } from '@/lib/whatsapp/evolution-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import type {
  ChannelRow,
  SendResult,
  SendTextInput,
  WhatsAppChannel,
} from './types'

/**
 * Evolution API channel (unofficial provider).
 *
 * Freeform text only — `supportsTemplates` is false, and there is no
 * Meta 24h-window concept. The channel row carries:
 *   - identifier        → the Evolution instance name
 *   - config.base_url   → the Evolution server URL (non-secret)
 *   - credentials.api_key → the instance API key (encrypted)
 *
 * Like CloudApiChannel, this performs no DB writes; the api_key is
 * decrypted once at construction.
 */
export class EvolutionChannel implements WhatsAppChannel {
  readonly provider = 'evolution' as const
  readonly supportsTemplates = false
  readonly id: string
  readonly identifier: string
  private readonly baseUrl: string
  private readonly apiKey: string

  constructor(row: ChannelRow) {
    if (row.provider !== 'evolution') {
      throw new Error(
        `EvolutionChannel received a '${row.provider}' row (expected 'evolution').`,
      )
    }
    if (!row.identifier) {
      throw new Error(`Evolution channel ${row.id} is missing identifier (instance).`)
    }
    const baseUrl = row.config?.base_url
    if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
      throw new Error(`Evolution channel ${row.id} is missing config.base_url.`)
    }
    const encryptedKey = row.credentials?.api_key
    if (typeof encryptedKey !== 'string' || encryptedKey.length === 0) {
      throw new Error(`Evolution channel ${row.id} is missing credentials.api_key.`)
    }
    this.id = row.id
    this.identifier = row.identifier
    this.baseUrl = baseUrl
    this.apiKey = decrypt(encryptedKey)
  }

  async sendText({ to, text }: SendTextInput): Promise<SendResult> {
    // Evolution has no reply-context primitive equivalent to Meta's
    // context.message_id, so contextMessageId is intentionally ignored.
    const { messageId } = await sendEvolutionText({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      instance: this.identifier,
      to,
      text,
    })
    return { messageId }
  }
}
