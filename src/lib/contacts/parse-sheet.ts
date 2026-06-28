import * as XLSX from 'xlsx'

export interface ParsedSheet {
  headers: string[]
  rows: string[][]
}

/** Coerce any cell to a trimmed string. */
function cell(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v).trim()
}

/**
 * Parse an uploaded spreadsheet (xlsx or csv) into a header row + data rows,
 * every cell a trimmed string. Uses the first sheet. SheetJS sniffs the
 * format from the bytes, so the same path handles .xlsx and .csv.
 */
export function parseSheet(data: ArrayBuffer): ParsedSheet {
  const wb = XLSX.read(new Uint8Array(data), { type: 'array' })
  const first = wb.SheetNames[0]
  if (!first) return { headers: [], rows: [] }

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[first], {
    header: 1,
    blankrows: false,
    defval: '',
  })
  if (aoa.length === 0) return { headers: [], rows: [] }

  const headers = (aoa[0] as unknown[]).map(cell)
  const rows = aoa.slice(1).map((r) => (r as unknown[]).map(cell))
  return { headers, rows }
}
