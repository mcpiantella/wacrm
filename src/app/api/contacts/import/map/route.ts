import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { inferColumnMapping } from '@/lib/contacts/ai-column-mapping'

/**
 * POST /api/contacts/import/map — infer a column mapping for a contact import
 * from the sheet's headers + a small sample. Any authenticated account member
 * (the import modal already inserts contacts via the RLS-governed client). The
 * route writes nothing; it only spends one LLM call. LLM failures → 502 so the
 * client can fall back to header-name matching.
 */
export async function POST(request: Request) {
  try {
    await getCurrentAccount()
  } catch (err) {
    return toErrorResponse(err)
  }

  try {
    const body = (await request.json().catch(() => ({}))) as {
      headers?: unknown
      sample?: unknown
    }
    const headers = Array.isArray(body.headers)
      ? body.headers.filter((h): h is string => typeof h === 'string')
      : []
    if (headers.length === 0) {
      return NextResponse.json({ error: 'headers is required' }, { status: 400 })
    }
    const sample = Array.isArray(body.sample)
      ? body.sample
          .slice(0, 20)
          .map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : []))
      : []

    const mapping = await inferColumnMapping(headers, sample)
    return NextResponse.json({ mapping })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[contacts/import/map]', message)
    return NextResponse.json(
      { error: `Falha ao mapear com IA: ${message}` },
      { status: 502 },
    )
  }
}
