import { chatCompleteJson } from '@/lib/ai/chat'

export interface ColumnMapping {
  phone: number | null
  name: number | null
  email: number | null
  company: number | null
  tags: number | null
  /** ISO-2 country whose calling code seeds phones missing a prefix. */
  defaultCountry: string
}

const FIELDS = ['phone', 'name', 'email', 'company', 'tags'] as const

const SYSTEM = `Você mapeia colunas de uma planilha de contatos para os campos de um CRM.
Recebe os CABEÇALHOS e algumas LINHAS de amostra. Responda SOMENTE com um objeto JSON:
{"phone": <índice da coluna 0-based ou null>, "name": <índice ou null>, "email": <índice ou null>, "company": <índice ou null>, "tags": <índice ou null>, "defaultCountry": "<ISO-2, ex. BR>"}
- Use o índice (0-based) da coluna que melhor corresponde a cada campo; null se não houver.
- "phone": telefone/celular/whatsapp. "tags": etiquetas/segmento, se houver.
- "defaultCountry": o país mais provável dos telefones pela formatação (ex.: "BR"). Se não der pra inferir, "BR".`

function clampIndex(v: unknown, len: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < len ? v : null
}

/**
 * Ask the LLM which column maps to each contact field, from the headers and a
 * small sample. One cheap call; the heavy per-row work is done deterministically
 * downstream. Indices are clamped into range (else null) and country defaults
 * to BR. Throws if the LLM call itself fails (caller decides the fallback).
 */
export async function inferColumnMapping(
  headers: string[],
  sample: string[][],
): Promise<ColumnMapping> {
  const raw = await chatCompleteJson<Record<string, unknown>>({
    system: SYSTEM,
    messages: [
      { role: 'user', content: JSON.stringify({ headers, sample }) },
    ],
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    json: true,
    maxTokens: 300,
  })

  const len = headers.length
  const out = {} as ColumnMapping
  for (const f of FIELDS) out[f] = clampIndex(raw[f], len)
  out.defaultCountry =
    typeof raw.defaultCountry === 'string' && raw.defaultCountry.trim()
      ? raw.defaultCountry.trim().toUpperCase().slice(0, 2)
      : 'BR'
  return out
}
