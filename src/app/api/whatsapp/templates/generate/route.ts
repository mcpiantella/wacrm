import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { generateTemplate } from '@/lib/ai/generate-template'

/**
 * POST /api/whatsapp/templates/generate — draft a WhatsApp message template
 * (name + category + body) from a plain-language briefing. Admins+ (template
 * management is an admin surface). Writes nothing — it spends one rate-limited
 * LLM call; the caller reviews/edits and submits for Meta approval. LLM
 * failures → 502 with the message.
 */
export async function POST(request: Request) {
  let userId: string
  try {
    ;({ userId } = await requireRole('admin'))
  } catch (err) {
    return toErrorResponse(err)
  }

  const limit = checkRateLimit(`ai-template:${userId}`, RATE_LIMITS.aiGenerate)
  if (!limit.success) return rateLimitResponse(limit)

  try {
    const body = (await request.json().catch(() => ({}))) as { briefing?: unknown }
    const briefing = typeof body.briefing === 'string' ? body.briefing.trim() : ''
    if (briefing.length < 10) {
      return NextResponse.json(
        { error: 'Descreva o objetivo da mensagem com pelo menos 10 caracteres.' },
        { status: 400 },
      )
    }
    if (briefing.length > 2000) {
      return NextResponse.json({ error: 'Briefing muito longo (máx. 2000 caracteres).' }, { status: 400 })
    }

    const template = await generateTemplate(briefing)
    return NextResponse.json({ template })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[templates/generate]', message)
    return NextResponse.json({ error: `Falha ao gerar com IA: ${message}` }, { status: 502 })
  }
}
