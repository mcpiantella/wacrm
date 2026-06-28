import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { parseTagCell, type ParsedContactRow } from './parse-contact-csv'
import type { ColumnMapping } from './ai-column-mapping'

/** A few common ISO-2 → calling code; falls back to BR/55. */
const COUNTRY_CALLING_CODES: Record<string, string> = {
  BR: '55', US: '1', PT: '351', AR: '54', MX: '52', CL: '56', CO: '57', PY: '595', UY: '598',
}

export interface NormalizeResult {
  rows: ParsedContactRow[]
  /** Rows dropped for lacking a valid phone. */
  invalid: number
}

function at(row: string[], idx: number | null): string {
  return idx === null ? '' : (row[idx] ?? '').trim()
}

/** Digits only; prefix the country calling code if absent. Valid = 11–15 digits. */
function normalizePhoneWithCountry(raw: string, country: string): string | null {
  const digits = normalizePhone(raw)
  if (!digits) return null
  const cc = COUNTRY_CALLING_CODES[country] ?? '55'
  const full = digits.startsWith(cc) && digits.length >= 11 ? digits : `${cc}${digits}`
  return full.length >= 11 && full.length <= 15 ? full : null
}

/**
 * Apply a column mapping to every parsed row, deterministically (no LLM).
 * Phones are normalized to digits with a country prefix; rows without a valid
 * phone are dropped and counted. Names are trimmed/space-collapsed.
 */
export function normalizeImportedRows(
  rows: string[][],
  mapping: ColumnMapping,
): NormalizeResult {
  const out: ParsedContactRow[] = []
  let invalid = 0

  for (const row of rows) {
    const phone = normalizePhoneWithCountry(at(row, mapping.phone), mapping.defaultCountry)
    if (!phone) {
      invalid++
      continue
    }
    const name = at(row, mapping.name).replace(/\s+/g, ' ').trim()
    const email = at(row, mapping.email)
    const company = at(row, mapping.company)
    out.push({
      phone,
      name: name || undefined,
      email: email || undefined,
      company: company || undefined,
      tagNames: parseTagCell(at(row, mapping.tags)),
    })
  }

  return { rows: out, invalid }
}
