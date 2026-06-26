import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

/**
 * /api/channels/[id] — delete a channel (admins+).
 *
 * Account-scoped: the WHERE on account_id (plus RLS) makes it impossible
 * to delete another account's channel by guessing an id. Deleting a
 * channel sets conversations.channel_id / broadcasts.channel_id to NULL
 * (ON DELETE SET NULL, migration 028) — history is preserved.
 */
export async function DELETE(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await ctx.params

    const { data, error } = await supabase
      .from('channels')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[channels DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete channel' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
