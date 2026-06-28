import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { parseTagCell, type ParsedContactRow } from './parse-contact-csv'
import type { ColumnMapping } from './ai-column-mapping'

/**
 * ISO-2 → { calling code, national-number length range }. The national range
 * lets us classify a bare number by length BEFORE trusting a prefix match —
 * critical because some national numbers legitimately start with the country's
 * own calling-code digits (e.g. BR area code 55: `55988887777` is a national
 * mobile, NOT an already-prefixed E.164). Falls back to BR.
 */
interface CountryPhone {
  cc: string
  national: [number, number]
}
const COUNTRY_PHONE: Record<string, CountryPhone> = {
  BR: { cc: '55', national: [10, 11] },
  US: { cc: '1', national: [10, 10] },
  PT: { cc: '351', national: [9, 9] },
  AR: { cc: '54', national: [10, 11] },
  MX: { cc: '52', national: [10, 10] },
  CL: { cc: '56', national: [9, 9] },
  CO: { cc: '57', national: [10, 10] },
  PY: { cc: '595', national: [9, 9] },
  UY: { cc: '598', national: [8, 9] },
}

export interface NormalizeResult {
  rows: ParsedContactRow[]
  /** Rows dropped for lacking a valid phone. */
  invalid: number
}

function at(row: string[], idx: number | null): string {
  return idx === null ? '' : (row[idx] ?? '').trim()
}

/**
 * Digits only, classified by national length FIRST, then E.164:
 *  - length in the country's national range → it's a national number → prepend cc.
 *  - else starts with cc AND (length − cc) in the national range → already E.164 → keep.
 *  - else → unrecognized shape → invalid.
 * Final value must be 11–15 digits.
 */
function normalizePhoneWithCountry(raw: string, country: string): string | null {
  const digits = normalizePhone(raw)
  if (!digits) return null
  const info = COUNTRY_PHONE[country] ?? COUNTRY_PHONE.BR
  const [nmin, nmax] = info.national
  const cc = info.cc

  let full: string
  if (digits.length >= nmin && digits.length <= nmax) {
    full = `${cc}${digits}` // national → add the country code
  } else if (
    digits.startsWith(cc) &&
    digits.length - cc.length >= nmin &&
    digits.length - cc.length <= nmax
  ) {
    full = digits // already in E.164 (country code + national)
  } else {
    return null
  }
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
