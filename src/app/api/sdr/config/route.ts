import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'

/**
 * /api/sdr/config — the per-campaign SDR configuration.
 *
 * GET ?broadcast_id=…  — member reads the config (or null).
 * PUT                  — admins+ upsert it (keyed by broadcast_id).
 *
 * The config drives the worker: enabled flag, system prompt, criteria,
 * handoff keywords, turn/debounce limits.
 */

const SELECT =
  'id, broadcast_id, enabled, system_prompt, qualification_criteria, model, handoff_keywords, max_turns, debounce_seconds'

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const broadcastId = new URL(request.url).searchParams.get('broadcast_id')
    if (!broadcastId) {
      return NextResponse.json({ error: 'broadcast_id is required' }, { status: 400 })
    }
    const { data, error } = await supabase
      .from('sdr_configs')
      .select(SELECT)
      .eq('broadcast_id', broadcastId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (error) {
      console.error('[sdr/config GET]', error)
      return NextResponse.json({ error: 'Failed to load SDR config' }, { status: 500 })
    }
    return NextResponse.json({ config: data ?? null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid body' }, { status: 400 })
    }
    const b = body as Record<string, unknown>
    const broadcastId = typeof b.broadcast_id === 'string' ? b.broadcast_id : null
    if (!broadcastId) {
      return NextResponse.json({ error: 'broadcast_id is required' }, { status: 400 })
    }

    // The broadcast must belong to the caller's account.
    const { data: bc } = await supabase
      .from('broadcasts')
      .select('id')
      .eq('id', broadcastId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!bc) {
      return NextResponse.json({ error: 'Broadcast not found' }, { status: 404 })
    }

    const debounce = clampInt(b.debounce_seconds, 12, 5, 60)
    const maxTurns = clampInt(b.max_turns, 20, 1, 200)
    const row = {
      account_id: accountId,
      broadcast_id: broadcastId,
      enabled: Boolean(b.enabled),
      system_prompt: typeof b.system_prompt === 'string' ? b.system_prompt : null,
      qualification_criteria: Array.isArray(b.qualification_criteria)
        ? b.qualification_criteria
        : [],
      model: typeof b.model === 'string' && b.model.trim() ? b.model.trim() : null,
      handoff_keywords: Array.isArray(b.handoff_keywords)
        ? b.handoff_keywords.filter((k): k is string => typeof k === 'string')
        : [],
      max_turns: maxTurns,
      debounce_seconds: debounce,
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('sdr_configs')
      .upsert(row, { onConflict: 'broadcast_id' })
      .select(SELECT)
      .single()
    if (error) {
      console.error('[sdr/config PUT]', error)
      return NextResponse.json({ error: 'Failed to save SDR config' }, { status: 500 })
    }
    return NextResponse.json({ config: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
