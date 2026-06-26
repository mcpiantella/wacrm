import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getChannelRouting } from '@/lib/whatsapp/channel/resolve'
import {
  parseEvolutionInbound,
} from '@/lib/whatsapp/inbound/evolution-parse'
import { processInboundMessage } from '@/lib/whatsapp/inbound/process-inbound'

/**
 * Evolution API inbound webhook.
 *
 * Configure the Evolution instance to POST `messages.upsert` events here.
 * Routes by `(provider='evolution', identifier=body.instance)` to exactly
 * one channel, then feeds the shared inbound pipeline — the same one the
 * Meta webhook uses.
 *
 * Auth: if `EVOLUTION_WEBHOOK_TOKEN` is set, the request must present it
 * (header `apikey` or `?token=`); otherwise it's rejected. Unset disables
 * the check (dev only).
 *
 * Always answers 200 for well-formed-but-ignored events so Evolution does
 * not retry-storm; only auth failures return non-2xx.
 */
export async function POST(request: Request) {
  // 1. Optional shared-secret auth.
  const expected = process.env.EVOLUTION_WEBHOOK_TOKEN
  if (expected) {
    const url = new URL(request.url)
    const presented =
      request.headers.get('apikey') ??
      request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
      url.searchParams.get('token')
    if (presented !== expected) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  // 2. Parse body.
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = parseEvolutionInbound(body as Record<string, unknown>)
  if (!parsed) {
    // Not a processable inbound (group, our echo, non-text, malformed).
    return NextResponse.json({ ignored: true }, { status: 200 })
  }

  // 3. Route instance → channel/account.
  const { data: routing, error: routingError } = await getChannelRouting(
    supabaseAdmin(),
    'evolution',
    parsed.instance,
  )
  if (routingError) {
    console.error('[evolution-webhook] routing lookup failed:', routingError)
    return NextResponse.json({ ignored: true }, { status: 200 })
  }
  if (!routing) {
    console.error('[evolution-webhook] no channel for instance:', parsed.instance)
    return NextResponse.json({ ignored: true }, { status: 200 })
  }
  if (!routing.user_id) {
    console.error(
      '[evolution-webhook] channel has no owner user_id for instance:',
      parsed.instance,
      '— inbound dropped. Re-save the channel.',
    )
    return NextResponse.json({ ignored: true }, { status: 200 })
  }

  // 4. Shared pipeline.
  try {
    await processInboundMessage({
      accountId: routing.account_id,
      ownerUserId: routing.user_id,
      channelId: routing.id,
      senderPhone: parsed.senderPhone,
      senderName: parsed.senderName,
      providerMessageId: parsed.providerMessageId,
      timestamp: parsed.timestamp,
      contentType: 'text',
      contentText: parsed.text,
    })
  } catch (err) {
    console.error('[evolution-webhook] processInboundMessage threw:', err)
  }

  return NextResponse.json({ ok: true }, { status: 200 })
}
