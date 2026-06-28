# AI Contact Import — Design (Phase 1)

**Status:** approved (design) · **Date:** 2026-06-27

## Problem

Today's contact import is rigid. `parseContactCsv` requires a CSV whose header
row contains the exact lowercase columns `phone` (required), `name`, `email`,
`company`, `tags`. If there is no literal `phone` column it returns zero rows.
It is CSV-only (no `.xlsx`), does no column mapping, and does no data cleaning.
Users with a real-world spreadsheet (columns like "Telefone"/"Nome Completo"/
"WhatsApp", arbitrary order/language, phones in mixed formats) cannot import
without manually reformatting the file.

## Goal (Phase 1)

Let a user upload **any** `.xlsx` or `.csv`. AI infers the column mapping from a
small sample; deterministic code then cleans/normalizes every row; the user
reviews an **editable** mapping + preview; the existing dedupe/tag/insert
pipeline imports unchanged.

**Out of scope (Phase 2):** AI enrichment/categorization (per-row tags/segment),
multi-sheet picker.

## Decisions (from brainstorming)

1. **Scope:** Phase 1 = mapping + cleaning + `.xlsx`. Enrichment is Phase 2.
2. **Architecture:** AI sees only a **sample** (headers + ≤20 rows) and returns a column mapping — one cheap LLM call per import. Per-row work (normalization) is deterministic code. (Rejected: per-row AI — costly, slow.)
3. **Review:** the user sees the AI's mapping as **editable** dropdowns + a cleaned preview, and can correct any column before importing.
4. **Default country:** the AI detects the most likely default country code from the sample; the user can override it in the review step (folded into the mapping UI).

## Flow

```
upload .xlsx/.csv
  → parse to { headers: string[], rows: string[][] }   (client, SheetJS)
  → POST /api/contacts/import/map  { headers, sample(≤20) }  (server)
  → AI returns mapping { phone, name, email, company, tags, defaultCountry, nameStrategy }
  → normalizeImportedRows(rows, mapping) → ParsedContactRow[]  (client, deterministic)
  → editable preview (mapping dropdowns + cleaned rows + invalid count)
      └─ edits re-run normalize locally (no LLM)
  → confirm → existing pipeline: dedupeByPhone → resolveImportTagIds → batch insert
```

## Components

### `src/lib/contacts/parse-sheet.ts` (new)

`parseSheet(file: File): Promise<{ headers: string[]; rows: string[][] }>`.
Uses **SheetJS (`xlsx`)** to read `.xlsx` and `.csv` uniformly. Returns the
header row (strings) and the data rows as a `string[][]` (every cell coerced to
a trimmed string). Multi-sheet files use the first sheet. Empty/headerless
files return `{ headers: [], rows: [] }`.

### `src/lib/contacts/ai-column-mapping.ts` (new)

Types + the LLM call (pure; takes an injected `chat` or imports `chatCompleteJson`).

```ts
export interface ColumnMapping {
  phone: number | null      // column index, or null if undetected
  name: number | null
  email: number | null
  company: number | null
  tags: number | null
  defaultCountry: string    // ISO-2, e.g. "BR"
}
export async function inferColumnMapping(
  headers: string[], sample: string[][],
): Promise<ColumnMapping>
```

Prompt (gpt-4o-mini via `chatCompleteJson`): given the headers + sample rows,
return the JSON mapping above. The function clamps every index into
`[0, headers.length)` or null and defaults `defaultCountry` to `"BR"` when the
model omits or returns an unknown value. (No name-splitting: the `contacts`
schema has a single `name` field.)

### `src/app/api/contacts/import/map/route.ts` (new)

`POST` — gated to any authenticated account member via `getCurrentAccount()`
(contact creation isn't admin-only; the import modal already inserts via the
RLS-governed client). The route writes nothing — it only spends one LLM call.
Body `{ headers: string[], sample: string[][] }`, validated (headers non-empty,
sample ≤ 20 rows; the route trims to 20 if more are sent). Calls
`inferColumnMapping`, returns `{ mapping }`. LLM errors → 502 with the message
(the client falls back; see Error handling).

### `src/lib/contacts/normalize-imported-rows.ts` (new)

`normalizeImportedRows(rows: string[][], mapping: ColumnMapping): { rows: ParsedContactRow[]; invalid: number }`. Pure. Per row:

- **phone:** explicit, deterministic rule. Strip to digits. Let `cc` = the
  calling code for `mapping.defaultCountry` from a small `COUNTRY_CALLING_CODES`
  map (e.g. `BR→55`, `US→1`, `PT→351`, `AR→54`…; fallback `BR/55`). If the
  digits already start with `cc` **and** total length is 11–15 → keep as-is.
  Otherwise prepend `cc`. The row is **valid** iff the final length is 11–15
  digits; otherwise it is **dropped** and counted in `invalid`. (`normalizePhone`
  from `phone-utils` does the digit-strip.)
- **name:** trim + collapse internal whitespace. Title-casing is **not** applied
  (avoids mangling names like "de Souza"). The schema has a single `name` field;
  no first/last split.
- **email / company:** trimmed (null when the column is unmapped/empty).
- **tags:** `parseTagCell` on the tags column (reuses existing helper).

### `src/components/contacts/import-modal.tsx` (modify)

After `parseSheet`, call the map route, then render an **editable mapping**
panel: one dropdown per target field (`phone`, `name`, `email`, `company`,
`tags`) listing the file's columns (+ "none"), plus a default-country selector,
pre-filled from the AI mapping. Below it, the existing preview table shows the
**normalized** rows (first `PREVIEW_LIMIT`) and an invalid-row count. Editing any
dropdown re-runs `normalizeImportedRows` locally (instant, no LLM). Confirm runs
the existing dedupe/tag/insert path against the normalized `ParsedContactRow[]`.

## Reuse (unchanged)

`dedupeByPhone`, `resolveImportTagIds`, `assignImportedContactTags`, and the
batch-insert loop are untouched. The new code only produces the
`ParsedContactRow[]` and the editable mapping.

## Error handling & degradation

- **AI map call fails** (bad key, model access, network): fall back to the
  legacy header-name matching (`parseContactCsv` semantics applied to the parsed
  headers) and show a toast "mapeamento automático indisponível — usando os
  nomes das colunas". Import still works for well-formed files.
- **No `phone` column detected and none chosen:** block the import with a clear
  message (a contact needs a phone). The editable mapping lets the user pick one.
- **Empty / unreadable file:** clear error, no crash.
- **Large files:** cap at 10 000 data rows with a warning toast; import the cap.

## Testing

- `normalizeImportedRows` (pure): phone with/without country code (prepend vs
  keep), invalid/short phones (dropped + counted), whitespace-y names, tags
  column parsing, unmapped optional columns.
- `inferColumnMapping`: mock `chat`; assert index clamping (out-of-range → null),
  default for an omitted/unknown `defaultCountry`.
- `parseSheet`: tiny `.csv` and `.xlsx` fixtures → expected headers + rows.
- The map route: mock `inferColumnMapping`; assert validation (empty headers →
  400, >20 sample rows trimmed) and the 502-on-LLM-error path.

## Files

- `src/lib/contacts/parse-sheet.ts` (new)
- `src/lib/contacts/ai-column-mapping.ts` (new)
- `src/app/api/contacts/import/map/route.ts` (new)
- `src/lib/contacts/normalize-imported-rows.ts` (new)
- `src/components/contacts/import-modal.tsx` (modify)
- dependency: `xlsx` (SheetJS)

## Dependencies / risk

- **SheetJS (`xlsx`)** adds client bundle weight; acceptable for an
  admin-only import modal (code-split with the modal). Pin a current version.
- The LLM sees only a 20-row **sample** — not the whole sheet — so no large-data
  cost or privacy exposure beyond the sample.
