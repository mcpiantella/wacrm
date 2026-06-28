import { describe, it, expect } from 'vitest'
import { normalizeImportedRows } from './normalize-imported-rows'
import type { ColumnMapping } from './ai-column-mapping'

const map = (over: Partial<ColumnMapping> = {}): ColumnMapping => ({
  phone: 0, name: 1, email: null, company: null, tags: null, defaultCountry: 'BR', ...over,
})

describe('normalizeImportedRows', () => {
  it('prepends the country code when missing and keeps it when present', () => {
    const { rows } = normalizeImportedRows(
      [['11999990000', 'Ana'], ['5521988887777', 'Bruno']],
      map(),
    )
    expect(rows[0].phone).toBe('5511999990000') // prepended 55
    expect(rows[1].phone).toBe('5521988887777') // already had 55
    expect(rows[0].name).toBe('Ana')
  })

  it('drops and counts rows with an invalid phone', () => {
    const { rows, invalid } = normalizeImportedRows(
      [['', 'NoPhone'], ['123', 'TooShort'], ['11999990000', 'Ok']],
      map(),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('Ok')
    expect(invalid).toBe(2)
  })

  it('trims names, reads email/company/tags from mapped columns', () => {
    const { rows } = normalizeImportedRows(
      [['11999990000', '  Ana   Maria ', 'a@x.com', 'Acme', 'vip; lead']],
      map({ email: 2, company: 3, tags: 4 }),
    )
    expect(rows[0].name).toBe('Ana Maria')
    expect(rows[0].email).toBe('a@x.com')
    expect(rows[0].company).toBe('Acme')
    expect(rows[0].tagNames).toEqual(['vip', 'lead'])
  })

  it('leaves optional fields undefined/empty when unmapped', () => {
    const { rows } = normalizeImportedRows([['11999990000', 'Ana']], map())
    expect(rows[0].email).toBeUndefined()
    expect(rows[0].company).toBeUndefined()
    expect(rows[0].tagNames).toEqual([])
  })
})
