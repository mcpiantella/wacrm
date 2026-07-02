import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * /api/sdr/conversation/[id] — control the SDR on one conversation.
 *
 * PATCH { sdr_status, broadcast_id? } — agents+ flip the SDR:
 *   'active'  → turn the SDR on (requires broadcast_id: which campaign's
 *               config drives it).
 *   'handoff' → take over (the worker stops replying on this thread).
 *   'off'     → disable the SDR here.
 *
 * Account-scoped (RLS + explicit account filter) so an id guess can't
 * touch another account's conversation.
 */
const VALID = new Set(['off', 'active', 'handoff'])

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id } = await ctx.params
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const status = body.sdr_status
    if (typeof status !== 'string' || !VALID.has(status)) {
      return NextResponse.json(
        { error: "sdr_status deve ser um dos seguintes: 'off', 'active', 'handoff'" },
        { status: 400 },
      )
    }

    const update: Record<string, unknown> = {
      sdr_status: status,
      updated_at: new Date().toISOString(),
    }

    // Activating needs a campaign link so the worker can find the config.
    if (status === 'active') {
      const broadcastId = typeof body.broadcast_id === 'string' ? body.broadcast_id : null
      if (!broadcastId) {
        return NextResponse.json(
          { error: 'broadcast_id é obrigatório para ativar o SDR' },
          { status: 400 },
        )
      }
      update.broadcast_id = broadcastId
    }

    const { data, error } = await supabase
      .from('conversations')
      .update(update)
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id, sdr_status, broadcast_id')
      .maybeSingle()

    if (error) {
      console.error('[sdr/conversation PATCH]', error)
      return NextResponse.json({ error: 'Falha ao atualizar conversa' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'Conversa não encontrada' }, { status: 404 })
    }
    return NextResponse.json({ conversation: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}
