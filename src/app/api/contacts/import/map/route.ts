import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { inferColumnMapping } from '@/lib/contacts/ai-column-mapping'

/** Bounds on what we forward to the LLM (cost control). */
const MAX_HEADERS = 50
const MAX_SAMPLE_ROWS = 20
const MAX_CELL_CHARS = 200

/**
 * POST /api/contacts/import/map — infer a column mapping for a contact import
 * from the sheet's headers + a small sample. Any authenticated account member
 * (the import modal already inserts contacts via the RLS-governed client). The
 * route writes nothing; it only spends one LLM call — rate-limited and
 * size-capped so it can't be looped to run up cost. LLM failures → 502 so the
 * client can fall back to header-name matching.
 */
export async function POST(request: Request) {
  let userId: string
  try {
    ;({ userId } = await getCurrentAccount())
  } catch (err) {
    return toErrorResponse(err)
  }

  const limit = checkRateLimit(`ai-import:${userId}`, RATE_LIMITS.aiImport)
  if (!limit.success) return rateLimitResponse(limit)

  try {
    const body = (await request.json().catch(() => ({}))) as {
      headers?: unknown
      sample?: unknown
    }
    const headers = Array.isArray(body.headers)
      ? body.headers
          .filter((h): h is string => typeof h === 'string')
          .slice(0, MAX_HEADERS)
          .map((h) => h.slice(0, MAX_CELL_CHARS))
      : []
    if (headers.length === 0) {
      return NextResponse.json({ error: 'headers is required' }, { status: 400 })
    }
    const sample = Array.isArray(body.sample)
      ? body.sample
          .slice(0, MAX_SAMPLE_ROWS)
          .map((r) =>
            Array.isArray(r)
              ? r.slice(0, MAX_HEADERS).map((c) => String(c ?? '').slice(0, MAX_CELL_CHARS))
              : [],
          )
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
