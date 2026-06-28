# AI Contact Import (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user upload any `.xlsx`/`.csv`; AI infers the column mapping from a sample; deterministic code cleans every row; the user reviews an editable mapping + preview; the existing import pipeline imports.

**Architecture:** A pure sheet parser (SheetJS) turns a file into `{ headers, rows }`. A server route sends headers + a ≤20-row sample to the LLM (one cheap call) and gets back a column mapping. A pure normalizer applies that mapping to **all** rows deterministically. The import modal shows an editable mapping + cleaned preview, then runs the existing dedupe/tag/insert pipeline.

**Tech Stack:** Next.js 16, Supabase, Vitest, `chat.ts` (`chatCompleteJson`, gpt-4o-mini→Anthropic fallback), new dep `xlsx` (SheetJS).

---

## File Structure

- `src/lib/contacts/parse-sheet.ts` — **new.** `parseSheet(ArrayBuffer) → { headers, rows }` (xlsx + csv via SheetJS). One job: bytes → strings grid.
- `src/lib/contacts/ai-column-mapping.ts` — **new.** `ColumnMapping` type + `inferColumnMapping(headers, sample)` (prompt + clamp; calls `chatCompleteJson`).
- `src/lib/contacts/normalize-imported-rows.ts` — **new.** `normalizeImportedRows(rows, mapping) → { rows: ParsedContactRow[]; invalid }` (pure, deterministic).
- `src/app/api/contacts/import/map/route.ts` — **new.** `POST` → validates, calls `inferColumnMapping`, returns `{ mapping }`.
- `src/components/contacts/import-modal.tsx` — **modify.** Parse via `parseSheet`, call the map route, normalize, editable mapping UI, fallback.
- `package.json` — **modify.** add `xlsx`.

---

## Task 1: Sheet parser (xlsx + csv)

**Files:**
- Modify: `package.json` (add dep)
- Create: `src/lib/contacts/parse-sheet.ts`
- Test: `src/lib/contacts/parse-sheet.test.ts`

- [ ] **Step 1: Install SheetJS**

Run: `npm install xlsx@0.18.5 --save-exact`
Expected: `xlsx` appears in `dependencies`.

- [ ] **Step 2: Write the failing test** — `src/lib/contacts/parse-sheet.test.ts`

```ts
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
```

- [ ] **Step 3: Run, expect FAIL** — `npx vitest run src/lib/contacts/parse-sheet.test.ts` → cannot find `./parse-sheet`.

- [ ] **Step 4: Implement `src/lib/contacts/parse-sheet.ts`**

```ts
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
```

- [ ] **Step 5: Run, expect PASS** — `npx vitest run src/lib/contacts/parse-sheet.test.ts`.

- [ ] **Step 6: Verify** — `npx tsc --noEmit` (clean) and `npx eslint src/lib/contacts/parse-sheet.ts src/lib/contacts/parse-sheet.test.ts` (clean).

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/lib/contacts/parse-sheet.ts src/lib/contacts/parse-sheet.test.ts
git commit -m "feat(import): sheet parser (xlsx + csv) via SheetJS"
```

---

## Task 2: AI column mapping

**Files:**
- Create: `src/lib/contacts/ai-column-mapping.ts`
- Test: `src/lib/contacts/ai-column-mapping.test.ts`

- [ ] **Step 1: Write the failing test** — `src/lib/contacts/ai-column-mapping.test.ts`

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { chatCompleteJson } = vi.hoisted(() => ({ chatCompleteJson: vi.fn() }))
vi.mock('@/lib/ai/chat', () => ({ chatCompleteJson }))

import { inferColumnMapping } from './ai-column-mapping'

describe('inferColumnMapping', () => {
  beforeEach(() => chatCompleteJson.mockReset())

  it('returns the model mapping, clamped to valid indices', async () => {
    chatCompleteJson.mockResolvedValue({
      phone: 0, name: 1, email: null, company: 2, tags: null, defaultCountry: 'BR',
    })
    const out = await inferColumnMapping(['Telefone', 'Nome', 'Empresa'], [['11999', 'Ana', 'Acme']])
    expect(out).toEqual({ phone: 0, name: 1, email: null, company: 2, tags: null, defaultCountry: 'BR' })
    expect(chatCompleteJson).toHaveBeenCalledOnce()
    const arg = chatCompleteJson.mock.calls[0][0]
    expect(arg.system.toLowerCase()).toContain('json')
  })

  it('clamps out-of-range / non-number indices to null and defaults country', async () => {
    chatCompleteJson.mockResolvedValue({
      phone: 9, name: -1, email: 'x', company: 1.5, tags: 0,
    })
    const out = await inferColumnMapping(['a', 'b'], [['1', '2']])
    expect(out.phone).toBeNull()   // 9 out of range (len 2)
    expect(out.name).toBeNull()    // -1 invalid
    expect(out.email).toBeNull()   // 'x' not a number
    expect(out.company).toBeNull() // 1.5 not an integer
    expect(out.tags).toBe(0)
    expect(out.defaultCountry).toBe('BR') // omitted → default
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run src/lib/contacts/ai-column-mapping.test.ts`.

- [ ] **Step 3: Implement `src/lib/contacts/ai-column-mapping.ts`**

```ts
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
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run src/lib/contacts/ai-column-mapping.test.ts`.

- [ ] **Step 5: Verify** — `npx tsc --noEmit` + `npx eslint src/lib/contacts/ai-column-mapping.ts src/lib/contacts/ai-column-mapping.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/contacts/ai-column-mapping.ts src/lib/contacts/ai-column-mapping.test.ts
git commit -m "feat(import): AI column mapping from a sample"
```

---

## Task 3: Deterministic row normalizer

**Files:**
- Create: `src/lib/contacts/normalize-imported-rows.ts`
- Test: `src/lib/contacts/normalize-imported-rows.test.ts`

- [ ] **Step 1: Write the failing test** — `src/lib/contacts/normalize-imported-rows.test.ts`

```ts
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
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run src/lib/contacts/normalize-imported-rows.test.ts`.

- [ ] **Step 3: Implement `src/lib/contacts/normalize-imported-rows.ts`**

```ts
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
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run src/lib/contacts/normalize-imported-rows.test.ts`.

- [ ] **Step 5: Verify** — `npx tsc --noEmit` + `npx eslint src/lib/contacts/normalize-imported-rows.ts src/lib/contacts/normalize-imported-rows.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/contacts/normalize-imported-rows.ts src/lib/contacts/normalize-imported-rows.test.ts
git commit -m "feat(import): deterministic row normalizer"
```

---

## Task 4: Map API route

**Files:**
- Create: `src/app/api/contacts/import/map/route.ts`

This route is thin glue over the unit-tested `inferColumnMapping`; verified by tsc + build (no new unit test, matching `/api/sdr/generate`).

- [ ] **Step 1: Implement `src/app/api/contacts/import/map/route.ts`**

```ts
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
```

- [ ] **Step 2: Verify** — `npx tsc --noEmit` (clean) and `npx eslint "src/app/api/contacts/import/map/route.ts"` (clean).

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/contacts/import/map/route.ts"
git commit -m "feat(import): /api/contacts/import/map route"
```

---

## Task 5: Wire the modal (parse → map → normalize → editable preview)

**Files:**
- Modify: `src/components/contacts/import-modal.tsx`

Integration task; verified by tsc + eslint + build (no new unit test — the modal is UI glue over tested units).

- [ ] **Step 1: Add imports + state** — at the top of `import-modal.tsx`, add imports next to the existing ones:

```ts
import { parseSheet } from '@/lib/contacts/parse-sheet';
import { normalizeImportedRows } from '@/lib/contacts/normalize-imported-rows';
import type { ColumnMapping } from '@/lib/contacts/ai-column-mapping';
```

Inside the component, after the existing `useState` declarations, add:

```ts
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [invalidCount, setInvalidCount] = useState(0);
  const [mappingLoading, setMappingLoading] = useState(false);
```

Add these to `reset()` (alongside the existing resets):

```ts
    setHeaders([]);
    setRawRows([]);
    setMapping(null);
    setInvalidCount(0);
```

- [ ] **Step 2: Replace `handleFileChange`** with the AI flow (keep the function name + signature):

```ts
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setResult(null);
    setMappingLoading(true);

    try {
      const buf = await selected.arrayBuffer();
      const { headers: hdrs, rows } = parseSheet(buf);
      if (hdrs.length === 0 || rows.length === 0) {
        toast.error('Planilha vazia ou ilegível.');
        return;
      }
      const capped = rows.slice(0, 10000);
      if (rows.length > 10000) {
        toast.warning('Planilha grande — importando as primeiras 10.000 linhas.');
      }
      setHeaders(hdrs);
      setRawRows(capped);

      // Ask the AI for a column mapping (one call); fall back on failure.
      let map: ColumnMapping;
      try {
        const res = await fetch('/api/contacts/import/map', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ headers: hdrs, sample: capped.slice(0, 20) }),
        });
        if (!res.ok) throw new Error(String(res.status));
        map = (await res.json()).mapping as ColumnMapping;
      } catch {
        toast.warning('Mapeamento automático indisponível — usando os nomes das colunas.');
        map = fallbackMapping(hdrs);
      }
      applyMapping(map, capped);
      await loadTagColors();
    } finally {
      setMappingLoading(false);
    }
  }

  // Header-name fallback (legacy behaviour) when the AI call fails.
  function fallbackMapping(hdrs: string[]): ColumnMapping {
    const idx = (name: string) =>
      hdrs.findIndex((h) => h.trim().toLowerCase() === name);
    const orNull = (i: number) => (i === -1 ? null : i);
    return {
      phone: orNull(idx('phone')),
      name: orNull(idx('name')),
      email: orNull(idx('email')),
      company: orNull(idx('company')),
      tags: orNull(idx('tags')),
      defaultCountry: 'BR',
    };
  }

  // Run the deterministic normalizer for the current mapping + rows.
  function applyMapping(map: ColumnMapping, rows: string[][]) {
    setMapping(map);
    const { rows: normalized, invalid } = normalizeImportedRows(rows, map);
    setParsedRows(normalized);
    setHasTagsColumn(map.tags !== null);
    setHasCompanyColumn(map.company !== null);
    setInvalidCount(invalid);
  }

  async function loadTagColors() {
    if (!accountId) return;
    const { data: tags } = await supabase
      .from('tags')
      .select('name, color')
      .eq('account_id', accountId);
    const colors = new Map<string, string>();
    for (const tag of tags ?? []) {
      const key = tag.name.trim().toLowerCase();
      if (!colors.has(key)) colors.set(key, tag.color);
    }
    setTagColorByKey(colors);
  }
```

(Remove the old `parseContactCsv` import if it is now unused; `eslint` will flag it.)

- [ ] **Step 3: Add the editable-mapping UI** — render this block above the existing preview table (only when `mapping` is set). It lets the user re-pick any column; changing one re-runs `applyMapping`:

```tsx
{mapping && (
  <div className="border-border space-y-2 rounded-lg border p-3 text-xs">
    <p className="text-muted-foreground">
      Confira o mapeamento das colunas (a IA preencheu). Telefone é obrigatório.
    </p>
    <div className="grid gap-2 sm:grid-cols-2">
      {(['phone', 'name', 'email', 'company', 'tags'] as const).map((field) => (
        <label key={field} className="flex items-center justify-between gap-2">
          <span className="capitalize">{field}</span>
          <select
            className="border-border bg-background rounded-md border px-2 py-1"
            value={mapping[field] ?? ''}
            onChange={(ev) => {
              const v = ev.target.value === '' ? null : Number(ev.target.value);
              applyMapping({ ...mapping, [field]: v }, rawRows);
            }}
          >
            <option value="">— nenhuma —</option>
            {headers.map((h, i) => (
              <option key={i} value={i}>{h || `Coluna ${i + 1}`}</option>
            ))}
          </select>
        </label>
      ))}
    </div>
    {invalidCount > 0 && (
      <p className="text-amber-500">
        {invalidCount} linha(s) sem telefone válido serão ignoradas.
      </p>
    )}
  </div>
)}
```

Also update the file input's `accept` attribute to allow xlsx — find the `<input type="file" ... accept=...>` and set:

```tsx
accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
```

Optionally guard the import button with `disabled={importing || mappingLoading || mapping?.phone == null}` so a phone column must be mapped.

- [ ] **Step 4: Verify** — `npx tsc --noEmit` (clean), `npx eslint src/components/contacts/import-modal.tsx` (clean — remove any now-unused imports), and `npm run build` compiles + typechecks (a local `/forgot-password` prerender error from a missing `NEXT_PUBLIC_SUPABASE_URL` is environmental, not a code error).

- [ ] **Step 5: Commit**

```bash
git add src/components/contacts/import-modal.tsx
git commit -m "feat(import): AI mapping + editable preview in the import modal"
```

---

## Task 6: Full verification

- [ ] **Step 1: Full suite** — `npx vitest run`. Expected: all pass except the 2 known pre-existing `date-utils` `mondayIndex` timezone failures.
- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` → clean.
- [ ] **Step 3: Lint** — `npx eslint src/lib/contacts "src/app/api/contacts" src/components/contacts/import-modal.tsx` → clean.
- [ ] **Step 4: Build** — `npm run build` compiles + passes TypeScript (ignore the environmental `/forgot-password` prerender error).
- [ ] **Step 5: Push** — `git push origin main`.

---

## Post-merge (manual, owner)

- Redeploy the **web** (`zenith-sender`). Ensure it has `OPENAI_API_KEY` + `OPENAI_MODEL=gpt-4o-mini` (already set for the SDR generator — the same model powers this).
- Live test: open Contacts → Import, upload a messy `.xlsx` (Portuguese headers, phones without `+55`); confirm the AI maps the columns, the preview shows cleaned phones, editing a dropdown re-maps instantly, and the import inserts the contacts.

## Out of scope (Phase 2)

- AI enrichment/categorization (per-row tags/segment).
- Multi-sheet picker (uses the first sheet).
