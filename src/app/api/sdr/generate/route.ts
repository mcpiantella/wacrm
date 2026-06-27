import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { generateSdrConfig } from '@/lib/ai/generate-sdr-config'

/**
 * POST /api/sdr/generate — draft an SDR config from a plain-language
 * briefing. Admins+ only (it spends an LLM call and writes nothing — the
 * caller reviews and saves via PUT /api/sdr/config). Returns
 * { system_prompt, qualification_criteria, handoff_keywords }.
 */
export async function POST(request: Request) {
  // Auth first — a role failure is a clean 401/403 via toErrorResponse.
  try {
    await requireRole('admin')
  } catch (err) {
    return toErrorResponse(err)
  }

  // Generation — LLM failures (bad key, model access, …) become a 502 with
  // the message so the UI can show something actionable.
  try {
    const body = (await request.json().catch(() => ({}))) as { briefing?: unknown }
    const briefing = typeof body.briefing === 'string' ? body.briefing.trim() : ''
    if (briefing.length < 10) {
      return NextResponse.json(
        { error: 'Descreva a campanha com pelo menos 10 caracteres.' },
        { status: 400 },
      )
    }
    if (briefing.length > 2000) {
      return NextResponse.json(
        { error: 'Briefing muito longo (máx. 2000 caracteres).' },
        { status: 400 },
      )
    }

    const config = await generateSdrConfig(briefing)
    return NextResponse.json({ config })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[sdr/generate]', message)
    return NextResponse.json(
      { error: `Falha ao gerar com IA: ${message}` },
      { status: 502 },
    )
  }
}
