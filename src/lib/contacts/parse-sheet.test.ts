import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseSheet } from './parse-sheet'

function xlsxBuffer(aoa: unknown[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'S1')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}
function csvBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer
}

describe('parseSheet', () => {
  it('reads an xlsx into headers + string rows', () => {
    const buf = xlsxBuffer([
      ['Telefone', 'Nome', 'Empresa'],
      [11999990000, 'Ana', 'Acme'],
      ['+55 21 98888-7777', 'Bruno', ''],
    ])
    const { headers, rows } = parseSheet(buf)
    expect(headers).toEqual(['Telefone', 'Nome', 'Empresa'])
    expect(rows[0]).toEqual(['11999990000', 'Ana', 'Acme'])
    expect(rows[1][0]).toBe('+55 21 98888-7777')
  })

  it('reads a csv the same way', () => {
    const { headers, rows } = parseSheet(csvBuffer('phone,name\n5511999,Ana\n'))
    expect(headers).toEqual(['phone', 'name'])
    expect(rows).toEqual([['5511999', 'Ana']])
  })

  it('returns empty for a blank file', () => {
    expect(parseSheet(csvBuffer(''))).toEqual({ headers: [], rows: [] })
  })
})
