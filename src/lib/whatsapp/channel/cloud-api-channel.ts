import {
  sendTextMessage,
  sendTemplateMessage,
  sendMediaMessage,
  type SendTemplateMessageArgs,
  type SendMediaMessageArgs,
} from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import type {
  ChannelRow,
  SendResult,
  SendTextInput,
  WhatsAppChannel,
} from './types'

/**
 * Cloud API channel — wraps Meta's Graph API send helpers behind the
 * provider-agnostic `WhatsAppChannel` surface.
 *
 * The `identifier` IS the Meta `phone_number_id` (that's how migration
 * 028 backfills it). The access token lives encrypted in
 * `credentials.access_token`; we decrypt it once at construction.
 *
 * Cloud-only capabilities (`sendTemplate`, `sendMedia`) are exposed as
 * concrete methods, not on the base interface — callers narrow on
 * `provider === 'cloud'` (or `supportsTemplates`) before using them.
 *
 * The legacy-CBC → GCM self-heal that the old `send` route did inline
 * is intentionally NOT here: this class performs no DB writes. `decrypt`
 * still reads legacy ciphertext transparently, so nothing breaks; the
 * re-encryption is a persistence concern for the cutover step.
 */
export class CloudApiChannel implements WhatsAppChannel {
  readonly provider = 'cloud' as const
  readonly supportsTemplates = true
  readonly id: string
  readonly identifier: string
  private readonly accessToken: string

  constructor(row: ChannelRow) {
    if (row.provider !== 'cloud') {
      throw new Error(
        `CloudApiChannel received a '${row.provider}' row (expected 'cloud').`,
      )
    }
    const encrypted = row.credentials?.access_token
    if (typeof encrypted !== 'string' || encrypted.length === 0) {
      throw new Error(
        `Cloud channel ${row.id} is missing credentials.access_token.`,
      )
    }
    if (!row.identifier) {
      throw new Error(`Cloud channel ${row.id} is missing identifier (phone_number_id).`)
    }
    this.id = row.id
    this.identifier = row.identifier
    this.accessToken = decrypt(encrypted)
  }

  async sendText({ to, text, contextMessageId }: SendTextInput): Promise<SendResult> {
    const { messageId } = await sendTextMessage({
      phoneNumberId: this.identifier,
      accessToken: this.accessToken,
      to,
      text,
      contextMessageId,
    })
    return { messageId }
  }

  /** Cloud-only: send a Meta-approved template (first-touch / outside 24h). */
  async sendTemplate(
    args: Omit<SendTemplateMessageArgs, 'phoneNumberId' | 'accessToken'>,
  ): Promise<SendResult> {
    const { messageId } = await sendTemplateMessage({
      phoneNumberId: this.identifier,
      accessToken: this.accessToken,
      ...args,
    })
    return { messageId }
  }

  /** Cloud-only: send image/video/document/audio via a public URL. */
  async sendMedia(
    args: Omit<SendMediaMessageArgs, 'phoneNumberId' | 'accessToken'>,
  ): Promise<SendResult> {
    const { messageId } = await sendMediaMessage({
      phoneNumberId: this.identifier,
      accessToken: this.accessToken,
      ...args,
    })
    return { messageId }
  }
}
