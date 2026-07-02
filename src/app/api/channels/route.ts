import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import { channelCapabilities } from '@/lib/whatsapp/channel/capabilities'
import type { Provider } from '@/lib/whatsapp/channel/types'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getAccountEntitlements } from '@/lib/billing/load-entitlements'
import { billingErrorResponse } from '@/lib/billing/errors'
import { recordBillingEvent } from '@/lib/billing/events'

/**
 * /api/channels — list + create WhatsApp channels (the S7 channels UI
 * backend).
 *
 * GET  — every member sees the account's channels (no secrets).
 * POST — admins+ add an Evolution channel (api_key encrypted server-side).
 *
 * Cloud channels are created/registered through the dedicated WhatsApp
 * settings flow (/api/whatsapp/config), which also handles Meta's
 * /register + subscribed_apps dance; this endpoint manages Evolution.
 */

interface ChannelDTO {
  id: string
  provider: Provider
  identifier: string
  display_name: string | null
  phone_e164: string | null
  status: string
  connected_at: string | null
  capabilities: ReturnType<typeof channelCapabilities>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDTO(row: any): ChannelDTO {
  return {
    id: row.id,
    provider: row.provider,
    identifier: row.identifier,
    display_name: row.display_name ?? null,
    phone_e164: row.phone_e164 ?? null,
    status: row.status,
    connected_at: row.connected_at ?? null,
    capabilities: channelCapabilities(row.provider),
  }
}

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { data, error } = await supabase
      .from('channels')
      .select('id, provider, identifier, display_name, phone_e164, status, connected_at, created_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('[channels GET] query error:', error)
      return NextResponse.json({ error: 'Falha ao carregar canais' }, { status: 500 })
    }
    return NextResponse.json({ channels: (data ?? []).map(toDTO) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    // Adding/changing a number is a settings-class write → admins+.
    const { supabase, accountId, userId } = await requireRole('admin')

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Corpo da requisição inválido' }, { status: 400 })
    }

    const provider = (body as { provider?: unknown }).provider
    if (provider !== 'evolution') {
      return NextResponse.json(
        {
          error:
            "Only 'evolution' channels can be added here. Cloud API numbers are set up in the WhatsApp settings tab.",
        },
        { status: 400 },
      )
    }

    const instance = str((body as Record<string, unknown>).instance)
    const baseUrlRaw = str((body as Record<string, unknown>).base_url)
    const apiKey = str((body as Record<string, unknown>).api_key)
    const displayName = str((body as Record<string, unknown>).display_name)
    const phoneE164 = str((body as Record<string, unknown>).phone_e164)

    if (!instance) {
      return NextResponse.json({ error: 'Nome da instância é obrigatório.' }, { status: 400 })
    }
    if (!baseUrlRaw || !/^https?:\/\//i.test(baseUrlRaw)) {
      return NextResponse.json(
        { error: 'Uma URL base válida (http/https) é obrigatória.' },
        { status: 400 },
      )
    }
    if (!apiKey) {
      return NextResponse.json({ error: 'Chave de API é obrigatória.' }, { status: 400 })
    }

    const baseUrl = baseUrlRaw.replace(/\/+$/, '')

    // Reject if another account already claims this instance — the same
    // single-tenant-per-number invariant the webhook routing relies on.
    const { data: claimed, error: claimedErr } = await supabase
      .from('channels')
      .select('id, account_id')
      .eq('provider', 'evolution')
      .eq('identifier', instance)
      .maybeSingle()
    if (claimedErr) {
      console.error('[channels POST] claim check error:', claimedErr)
      return NextResponse.json({ error: 'Falha ao validar canal' }, { status: 500 })
    }
    if (claimed && claimed.account_id !== accountId) {
      return NextResponse.json(
        { error: 'Esta instância Evolution já está vinculada a outra conta.' },
        { status: 409 },
      )
    }

    const config = { base_url: baseUrl }
    const credentials = { api_key: encrypt(apiKey) }

    let saved
    if (claimed) {
      // Same account re-saving (e.g. replacing the API key) → update.
      const { data, error } = await supabase
        .from('channels')
        .update({
          display_name: displayName,
          phone_e164: phoneE164,
          status: 'connected',
          config,
          credentials,
          updated_at: new Date().toISOString(),
        })
        .eq('id', claimed.id)
        .select('id, provider, identifier, display_name, phone_e164, status, connected_at')
        .single()
      if (error) {
        console.error('[channels POST] update error:', error)
        return NextResponse.json({ error: 'Falha ao salvar canal' }, { status: 500 })
      }
      saved = data
    } else {
      // Billing: a NEW number counts against the plan's max_numbers.
      const ent = await getAccountEntitlements(supabase, accountId)
      if (!ent.canDispatch) return billingErrorResponse('billing_blocked')
      const { count } = await supabase
        .from('channels')
        .select('id', { count: 'exact', head: true })
      if ((count ?? 0) >= ent.limits.max_numbers) {
        await recordBillingEvent(supabaseAdmin(), accountId, 'channel_limit_reached', {
          limit: ent.limits.max_numbers,
        })
        return billingErrorResponse('channel_limit_reached')
      }

      const { data, error } = await supabase
        .from('channels')
        .insert({
          account_id: accountId,
          user_id: userId,
          provider: 'evolution',
          identifier: instance,
          display_name: displayName,
          phone_e164: phoneE164,
          status: 'connected',
          config,
          credentials,
        })
        .select('id, provider, identifier, display_name, phone_e164, status, connected_at')
        .single()
      if (error) {
        console.error('[channels POST] insert error:', error)
        return NextResponse.json({ error: 'Falha ao salvar canal' }, { status: 500 })
      }
      saved = data
    }

    return NextResponse.json({ channel: toDTO(saved) }, { status: claimed ? 200 : 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** Trim a value to a non-empty string, or null. */
function str(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}
