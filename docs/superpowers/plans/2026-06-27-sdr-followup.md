# SDR Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a lead goes silent mid-qualification, the in-app SDR sends up to 2 context-aware reminders (~3h, ~24h) and then closes the thread as cold (tag + `sdr_status='off'`).

**Architecture:** Reuse the existing BullMQ worker and queue. The same `sdr` queue carries a second job kind, `followup`, with an `attempt` number. A successful SDR reply schedules follow-up #1; each follow-up job re-checks silence, has the LLM write a reminder, sends it, and either schedules the next attempt or closes cold. Decision logic is a pure module (`followup.ts`), mirroring `core.ts`; I/O lives in the worker and `execute.ts`.

**Tech Stack:** Next.js 16, Supabase (project `raqfuattunokpbozdhkc`), BullMQ + ioredis worker (`tsx`), Vitest.

**Deviation from spec (intentional, YAGNI):** The spec listed a `conversations.sdr_followups_sent` column and a process-inbound reset. Dropped — the `attempt` rides in the job, history is in `sdr_runs`, and "lead came back" is handled by the stable-jobId reschedule + the stale-check. No correctness loss.

---

## File Structure

- `supabase/migrations/030_sdr_followup.sql` — **new.** 3 columns on `sdr_configs`; widen `sdr_runs.action` CHECK.
- `src/lib/queue/sdr-queue.ts` — **modify.** `SdrJobData` gains `kind`/`attempt`; add `followUpJobId` + `enqueueFollowUp`.
- `src/lib/sdr/types.ts` — **modify.** `SdrContext['config']` gains the 3 follow-up fields; add `FollowUpDecision`.
- `src/lib/sdr/core.ts` — **modify.** Export `toLlmMessages`; widen the `loadSdrContext` config select.
- `src/lib/sdr/followup.ts` — **new.** Pure `decideFollowUp` + the reminder instruction.
- `src/lib/sdr/execute.ts` — **modify.** Export `CHANNEL_COLUMNS`; add `executeFollowUp` + `coldClose` + tag helper.
- `src/worker/sdr-worker.ts` — **modify.** Branch on `kind`; schedule follow-up #1 after a reply; `handleFollowUp`.
- `src/app/api/sdr/config/route.ts` — **modify.** GET select + PUT accept/clamp the 3 new fields.
- `src/components/broadcasts/sdr-config-card.tsx` — **modify.** Follow-up toggle + delays input.

---

## Task 1: Migration — config fields + sdr_runs action values

**Files:**
- Create: `supabase/migrations/030_sdr_followup.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ============================================================
-- 030_sdr_followup.sql — SDR follow-up (re-engagement) support.
--
-- Adds the per-campaign follow-up knobs and two new sdr_runs.action
-- values ('followup', 'cold'). No conversation-level counter: the
-- attempt rides in the BullMQ job and history is in sdr_runs.
-- ============================================================

ALTER TABLE sdr_configs
  ADD COLUMN IF NOT EXISTS follow_up_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE sdr_configs
  ADD COLUMN IF NOT EXISTS follow_up_delays INTEGER[] NOT NULL DEFAULT '{180,1440}';
ALTER TABLE sdr_configs
  ADD COLUMN IF NOT EXISTS cold_tag TEXT NOT NULL DEFAULT 'lead-frio';

-- Widen the run action enum to cover the follow-up + cold-close runs.
ALTER TABLE sdr_runs DROP CONSTRAINT IF EXISTS sdr_runs_action_check;
ALTER TABLE sdr_runs
  ADD CONSTRAINT sdr_runs_action_check
  CHECK (action IN ('reply', 'handoff', 'noop', 'error', 'followup', 'cold'));
```

- [ ] **Step 2: Apply via the Supabase MCP (`apply_migration`, name `sdr_followup`) to project `raqfuattunokpbozdhkc`.**

- [ ] **Step 3: Verify the columns + constraint exist**

Run this SQL (MCP `execute_sql`):

```sql
select column_name, data_type, column_default
from information_schema.columns
where table_name='sdr_configs' and column_name in ('follow_up_enabled','follow_up_delays','cold_tag')
order by column_name;
select pg_get_constraintdef(oid) from pg_constraint where conname='sdr_runs_action_check';
```

Expected: 3 rows (boolean/ARRAY/text) and a CHECK definition listing `followup` and `cold`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/030_sdr_followup.sql
git commit -m "feat(sdr): migration for follow-up config + run actions"
```

---

## Task 2: Queue — follow-up job kind + enqueue

**Files:**
- Modify: `src/lib/queue/sdr-queue.ts`
- Test: `src/lib/queue/sdr-queue.test.ts`

- [ ] **Step 1: Write failing tests** (append inside the existing file, after the `enqueueSdr` describe block)

```ts
import { enqueueFollowUp, followUpJobId } from './sdr-queue'

describe('enqueueFollowUp', () => {
  it('adds a delayed followup job keyed by conversation', async () => {
    const q = fakeQueue()
    q.getJob.mockResolvedValue(null)

    await enqueueFollowUp('conv-1', 'acc-1', 2, 21 * 60, q)

    expect(q.add).toHaveBeenCalledWith(
      'followup',
      { kind: 'followup', conversationId: 'conv-1', accountId: 'acc-1', attempt: 2 },
      expect.objectContaining({ jobId: 'sdrfu-conv-1', delay: 21 * 60 * 60_000 }),
    )
  })

  it('removes a pending followup before re-adding (reschedule)', async () => {
    const q = fakeQueue()
    const remove = vi.fn().mockResolvedValue(undefined)
    q.getJob.mockResolvedValue({ remove })
    await enqueueFollowUp('conv-1', 'acc-1', 1, 180, q)
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('derives a hyphen-separated job id (no colon)', () => {
    expect(followUpJobId('abc')).toBe('sdrfu-abc')
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run src/lib/queue/sdr-queue.test.ts` → "enqueueFollowUp is not a function".

- [ ] **Step 3: Implement** — in `src/lib/queue/sdr-queue.ts`, replace the `SdrJobData` interface and append the new functions:

```ts
export interface SdrJobData {
  conversationId: string
  accountId: string
  /** Job kind; absent means the original debounce-qualify job. */
  kind?: 'qualify' | 'followup'
  /** 1-based reminder number, for followup jobs. */
  attempt?: number
}
```

```ts
/** Stable per-conversation follow-up job id (hyphen, not ':' — BullMQ bans ':'). */
export function followUpJobId(conversationId: string): string {
  return `sdrfu-${conversationId}`
}

/**
 * Schedule (or reschedule) a follow-up reminder for a conversation.
 * One pending follow-up per conversation: a stable jobId means re-adding
 * replaces the previous one. `delayMinutes` is the gap from now.
 */
export async function enqueueFollowUp(
  conversationId: string,
  accountId: string,
  attempt: number,
  delayMinutes: number,
  queueOverride?: Pick<Queue<SdrJobData>, 'getJob' | 'add'>,
): Promise<void> {
  const q = queueOverride ?? getSdrQueue()
  const jobId = followUpJobId(conversationId)

  const existing = await q.getJob(jobId)
  if (existing) await existing.remove().catch(() => undefined)

  await q.add(
    'followup',
    { kind: 'followup', conversationId, accountId, attempt },
    {
      jobId,
      delay: Math.max(0, delayMinutes) * 60_000,
      removeOnComplete: true,
      removeOnFail: 100,
    },
  )
}
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run src/lib/queue/sdr-queue.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queue/sdr-queue.ts src/lib/queue/sdr-queue.test.ts
git commit -m "feat(sdr): followup job kind + enqueueFollowUp"
```

---

## Task 3: Types + context loading

**Files:**
- Modify: `src/lib/sdr/types.ts`
- Modify: `src/lib/sdr/core.ts`

- [ ] **Step 0: Add `user_id` to the conversation context** — in `src/lib/sdr/types.ts`, inside `SdrContext['conversation']`, add after `sdr_status: ...`:

```ts
    user_id: string
```

This is needed because the cold-close tag insert (`tags`) has a NOT NULL `user_id`. In `src/lib/sdr/core.ts`, `loadSdrContext`, change the conversation select from:

```ts
    .select('id, account_id, contact_id, channel_id, broadcast_id, sdr_status')
```
to:
```ts
    .select('id, account_id, contact_id, channel_id, broadcast_id, sdr_status, user_id')
```

- [ ] **Step 0b: Fix the existing fixtures the new required fields will break** — tsc will fail until these are updated.

In `src/lib/sdr/core.test.ts`, in the `ctx()` helper (around line 35), add `user_id` to the conversation and the 3 fields to the config:

```ts
    conversation: {
      id: 'conv-1',
      account_id: 'acc-1',
      contact_id: 'c-1',
      channel_id: 'ch-1',
      broadcast_id: 'b-1',
      sdr_status: 'active',
      user_id: 'u-1',
      ...(over.conversation ?? {}),
    },
    config: over.config !== undefined ? over.config : {
      enabled: true,
      system_prompt: 'Você é um SDR.',
      qualification_criteria: [],
      model: null,
      handoff_keywords: ['falar com humano'],
      max_turns: 20,
      follow_up_enabled: true,
      follow_up_delays: [180, 1440],
      cold_tag: 'lead-frio',
    },
```

In `src/lib/sdr/execute.test.ts`, in the `ctx()` helper (around line 56), add `user_id` to the conversation (its `config` is `null`, so no config change needed):

```ts
    conversation: {
      id: 'conv-1',
      account_id: 'acc-1',
      contact_id: 'c-1',
      channel_id: 'ch-1',
      broadcast_id: 'b-1',
      sdr_status: 'active',
      user_id: 'u-1',
      ...over,
    },
```

- [ ] **Step 1: Extend the config type** — in `src/lib/sdr/types.ts`, inside `SdrContext['config']` add the three fields after `max_turns: number`:

```ts
    max_turns: number
    follow_up_enabled: boolean
    /** Reminder offsets in minutes from the bot's awaiting message. */
    follow_up_delays: number[]
    cold_tag: string
  } | null
```

- [ ] **Step 2: Add the FollowUpDecision type** — append to `src/lib/sdr/types.ts`:

```ts
export type FollowUpDecision =
  | { action: 'noop'; reason: string }
  | { action: 'cold'; reason: string }
  | { action: 'send'; text: string; final: boolean }
```

- [ ] **Step 3: Export `toLlmMessages` and widen the config select** — in `src/lib/sdr/core.ts`:

Change `function toLlmMessages(` to `export function toLlmMessages(`.

In `loadSdrContext`, change the `sdr_configs` select string from:

```ts
              'enabled, system_prompt, qualification_criteria, model, handoff_keywords, max_turns',
```

to:

```ts
              'enabled, system_prompt, qualification_criteria, model, handoff_keywords, max_turns, follow_up_enabled, follow_up_delays, cold_tag',
```

- [ ] **Step 4: Typecheck** — `npx tsc --noEmit`. Expected: clean (existing `core.test.ts` config fixtures may now be missing the 3 fields — if tsc flags the test, that's Task 4's fixture update; if tsc passes because fixtures are loosely typed, fine).

- [ ] **Step 5: Commit**

```bash
git add src/lib/sdr/types.ts src/lib/sdr/core.ts
git commit -m "feat(sdr): follow-up config in context + export toLlmMessages"
```

---

## Task 4: Pure follow-up decision

**Files:**
- Create: `src/lib/sdr/followup.ts`
- Test: `src/lib/sdr/followup.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi } from 'vitest'
import { decideFollowUp } from './followup'
import type { SdrContext, SdrDeps } from './types'

function ctx(over: Partial<SdrContext> = {}): SdrContext {
  return {
    conversation: { id: 'c1', account_id: 'a1', contact_id: 'ct1', channel_id: 'ch1', broadcast_id: 'b1', sdr_status: 'active', user_id: 'u1' },
    config: {
      enabled: true, system_prompt: 'Você é um SDR', qualification_criteria: [], model: null,
      handoff_keywords: [], max_turns: 20, follow_up_enabled: true, follow_up_delays: [180, 1440], cold_tag: 'lead-frio',
    },
    contact: { id: 'ct1', name: 'Lead', phone: '5511999' },
    messages: [
      { id: 'm1', sender_type: 'customer', content_type: 'text', content_text: 'oi', media_url: null, created_at: '2026-06-27T00:00:00Z' },
      { id: 'm2', sender_type: 'bot', content_type: 'text', content_text: 'Qual seu orçamento?', media_url: null, created_at: '2026-06-27T00:01:00Z' },
    ],
    ...over,
  }
}
const deps = (text = 'Oi! Ainda tem interesse?'): SdrDeps => ({
  transcribe: vi.fn(),
  chat: vi.fn().mockResolvedValue({ text, provider: 'openai', model: 'gpt-4o-mini' }),
})

describe('decideFollowUp', () => {
  it('sends a reminder when the lead is silent (last msg = bot)', async () => {
    const d = deps()
    const out = await decideFollowUp(ctx(), 1, 'evolution', d)
    expect(out).toEqual({ action: 'send', text: 'Oi! Ainda tem interesse?', final: false })
    expect(d.chat).toHaveBeenCalledOnce()
  })

  it('marks final on the last attempt', async () => {
    const out = await decideFollowUp(ctx(), 2, 'evolution', deps())
    expect(out).toMatchObject({ action: 'send', final: true })
  })

  it('no-ops if the customer already replied (last msg = customer)', async () => {
    const c = ctx()
    c.messages.push({ id: 'm3', sender_type: 'customer', content_type: 'text', content_text: 'voltei', media_url: null, created_at: '2026-06-27T02:00:00Z' })
    const d = deps()
    const out = await decideFollowUp(c, 1, 'evolution', d)
    expect(out.action).toBe('noop')
    expect(d.chat).not.toHaveBeenCalled()
  })

  it('no-ops when sdr_status is not active', async () => {
    const out = await decideFollowUp(ctx({ conversation: { ...ctx().conversation, sdr_status: 'handoff' } }), 1, 'evolution', deps())
    expect(out.action).toBe('noop')
  })

  it('no-ops when follow_up disabled', async () => {
    const c = ctx(); c.config!.follow_up_enabled = false
    const out = await decideFollowUp(c, 1, 'evolution', deps())
    expect(out.action).toBe('noop')
  })

  it('closes cold without an LLM call on cloud outside the 24h window', async () => {
    const d = deps()
    // last customer msg is at 00:00; now is +25h
    const now = new Date('2026-06-27T01:01:00Z').getTime() + 25 * 60 * 60_000
    const out = await decideFollowUp(ctx(), 1, 'cloud', d, now)
    expect(out.action).toBe('cold')
    expect(d.chat).not.toHaveBeenCalled()
  })

  it('still sends on cloud INSIDE the 24h window', async () => {
    const now = new Date('2026-06-27T03:00:00Z').getTime() // 3h after last customer
    const out = await decideFollowUp(ctx(), 1, 'cloud', deps(), now)
    expect(out.action).toBe('send')
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run src/lib/sdr/followup.test.ts` → cannot find `./followup`.

- [ ] **Step 3: Implement `src/lib/sdr/followup.ts`**

```ts
import { toLlmMessages } from './core'
import type { SdrContext, SdrDeps, FollowUpDecision, SdrMessage } from './types'

const WINDOW_MS = 24 * 60 * 60 * 1000

const FOLLOWUP_INSTRUCTION = `

# Follow-up
O lead parou de responder. Escreva UMA mensagem curta e gentil reengajando,
retomando o contexto da conversa. Não repita a última pergunta literalmente.
Responda apenas com a mensagem, sem JSON e sem aspas.`

function lastCustomerMs(messages: SdrMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].sender_type === 'customer') {
      return new Date(messages[i].created_at).getTime()
    }
  }
  return 0
}

/**
 * Pure follow-up decision. The worker supplies `channelProvider` (and may
 * inject `nowMs` for tests). No DB/side effects — it only reads ctx and may
 * call the injected `chat` to draft the reminder.
 */
export async function decideFollowUp(
  ctx: SdrContext,
  attempt: number,
  channelProvider: string,
  deps: SdrDeps,
  nowMs: number = Date.now(),
): Promise<FollowUpDecision> {
  const { conversation, config, messages } = ctx

  if (conversation.sdr_status !== 'active') {
    return { action: 'noop', reason: `sdr_status=${conversation.sdr_status}` }
  }
  if (!config || !config.enabled || !config.follow_up_enabled) {
    return { action: 'noop', reason: 'follow-up disabled' }
  }
  const delays = config.follow_up_delays ?? []
  if (attempt < 1 || attempt > delays.length) {
    return { action: 'noop', reason: `attempt ${attempt} out of range` }
  }
  if (messages.length === 0) return { action: 'noop', reason: 'no messages' }

  // Still awaiting only if the LAST message is ours (not the customer's).
  const last = messages[messages.length - 1]
  if (last.sender_type === 'customer') {
    return { action: 'noop', reason: 'customer already replied' }
  }

  // Cloud API: free-form is blocked outside the 24h customer-service window.
  // Skip the send (and the LLM call) and let the worker close cold.
  if (channelProvider === 'cloud' && nowMs - lastCustomerMs(messages) > WINDOW_MS) {
    return { action: 'cold', reason: 'cloud 24h window closed' }
  }

  const llmMessages = toLlmMessages(messages, new Map())
  const result = await deps.chat({
    system: `${config.system_prompt ?? ''}${FOLLOWUP_INSTRUCTION}`,
    messages: llmMessages,
    model: config.model ?? undefined,
    maxTokens: 300,
  })
  const text = result.text.trim()
  if (!text) return { action: 'noop', reason: 'empty reminder' }

  return { action: 'send', text, final: attempt >= delays.length }
}
```

- [ ] **Step 4: Run, expect PASS** — `npx vitest run src/lib/sdr/followup.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sdr/followup.ts src/lib/sdr/followup.test.ts
git commit -m "feat(sdr): pure follow-up decision (decideFollowUp)"
```

---

## Task 5: Execute follow-up + cold close

**Files:**
- Modify: `src/lib/sdr/execute.ts`
- Test: `src/lib/sdr/execute.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `src/lib/sdr/execute.test.ts`)

```ts
import { executeFollowUp } from './execute'
import type { FollowUpDecision } from './types'

function fakeSupabase() {
  const calls: Record<string, unknown[]> = { update: [], insert: [], upsert: [], select: [] }
  // chainable stub: every terminal returns { data, error }
  const make = (table: string): any => {
    const chain: any = {}
    chain.update = (v: unknown) => { calls.update.push({ table, v }); return chain }
    chain.insert = (v: unknown) => { calls.insert.push({ table, v }); return chain }
    chain.upsert = (v: unknown, o: unknown) => { calls.upsert.push({ table, v, o }); return chain }
    chain.select = () => chain
    chain.eq = () => chain
    chain.maybeSingle = async () => ({ data: table === 'tags' ? { id: 'tag1' } : null, error: null })
    chain.single = async () => ({ data: { id: 'msg1' }, error: null })
    chain.then = undefined
    return chain
  }
  return { from: (t: string) => make(t), _calls: calls }
}

const ctxFU = {
  conversation: { id: 'c1', account_id: 'a1', contact_id: 'ct1', channel_id: 'ch1', broadcast_id: 'b1', sdr_status: 'active' as const, user_id: 'u1' },
  config: { enabled: true, system_prompt: '', qualification_criteria: [], model: null, handoff_keywords: [], max_turns: 20, follow_up_enabled: true, follow_up_delays: [180, 1440], cold_tag: 'lead-frio' },
  contact: { id: 'ct1', name: 'Lead', phone: '5511999' },
  messages: [],
}
const channel = { id: 'ch1', account_id: 'a1', user_id: 'u1', provider: 'evolution', identifier: 'inst', display_name: 'x', phone_e164: null, status: 'connected', config: {}, credentials: {} }

describe('executeFollowUp', () => {
  it('sends a non-final reminder and logs a followup run', async () => {
    const sup = fakeSupabase()
    const send = vi.fn().mockResolvedValue({ messageId: 'wamid' })
    const deps = { supabase: sup, sendOnChannel: send } as unknown as Parameters<typeof executeFollowUp>[0]
    const decision: FollowUpDecision = { action: 'send', text: 'oi de novo', final: false }

    await executeFollowUp(deps, decision, ctxFU as never, channel as never, 1)

    expect(send).toHaveBeenCalledWith(channel, '5511999', 'oi de novo')
    const actions = sup._calls.insert.map((c: any) => (c.v as any).action ?? (c.v as any).sender_type)
    expect(actions).toContain('bot')      // the reminder message
    expect(actions).toContain('followup') // the run
    // not final → no cold-close update to sdr_status='off'
    const offUpdate = sup._calls.update.find((c: any) => (c.v as any).sdr_status === 'off')
    expect(offUpdate).toBeUndefined()
  })

  it('on the final reminder also closes cold (sdr_status off + tag)', async () => {
    const sup = fakeSupabase()
    const send = vi.fn().mockResolvedValue({ messageId: 'wamid' })
    const deps = { supabase: sup, sendOnChannel: send } as unknown as Parameters<typeof executeFollowUp>[0]

    await executeFollowUp(deps, { action: 'send', text: 'última', final: true }, ctxFU as never, channel as never, 2)

    const offUpdate = sup._calls.update.find((c: any) => (c.v as any).sdr_status === 'off')
    expect(offUpdate).toBeDefined()
    expect(sup._calls.upsert.some((c: any) => c.table === 'contact_tags')).toBe(true)
  })

  it('cold decision closes without sending', async () => {
    const sup = fakeSupabase()
    const send = vi.fn()
    const deps = { supabase: sup, sendOnChannel: send } as unknown as Parameters<typeof executeFollowUp>[0]

    await executeFollowUp(deps, { action: 'cold', reason: 'window' }, ctxFU as never, channel as never, 1)

    expect(send).not.toHaveBeenCalled()
    expect(sup._calls.update.find((c: any) => (c.v as any).sdr_status === 'off')).toBeDefined()
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run src/lib/sdr/execute.test.ts` → `executeFollowUp` not exported.

- [ ] **Step 3: Implement** — in `src/lib/sdr/execute.ts`:

(a) Export the channel columns constant (change `const CHANNEL_COLUMNS` to `export const CHANNEL_COLUMNS`).

(b) Add imports at the top alongside the existing ones:

```ts
import type { ChannelRow } from '@/lib/whatsapp/channel/types'
import type { SdrContext, SdrDecision, FollowUpDecision } from './types'
```
(The file already imports `ChannelRow`, `SdrContext`, `SdrDecision`; add `FollowUpDecision` to the existing `./types` import.)

(c) Append the follow-up executor + helpers:

```ts
/**
 * Execute a follow-up decision (separate from executeDecision so the
 * qualify path stays untouched). The worker passes the already-loaded
 * channel — no second fetch. `send` persists a bot reminder + a 'followup'
 * run; a `final` send (or a `cold` decision) then closes the thread cold.
 */
export async function executeFollowUp(
  deps: ExecuteDeps,
  decision: FollowUpDecision,
  ctx: SdrContext,
  channel: ChannelRow | null,
  attempt: number,
): Promise<void> {
  const { supabase } = deps
  const { conversation, contact } = ctx

  try {
    if (decision.action === 'noop') return

    if (decision.action === 'cold') {
      await closeCold(deps, ctx)
      return
    }

    // action === 'send'
    if (!channel || !contact.phone) {
      await logFollowUpRun(deps, ctx, 'error', `missing ${!channel ? 'channel' : 'phone'}`)
      return
    }

    const { messageId } = await deps.sendOnChannel(channel, contact.phone, decision.text)
    const { data: inserted } = await supabase
      .from('messages')
      .insert({
        conversation_id: conversation.id,
        sender_type: 'bot',
        content_type: 'text',
        content_text: decision.text,
        message_id: messageId,
        status: 'sent',
      })
      .select('id')
      .single()
    await supabase
      .from('conversations')
      .update({
        last_message_text: decision.text,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation.id)
    await logFollowUpRun(deps, ctx, 'followup', null, inserted?.id ?? null)

    if (decision.final) await closeCold(deps, ctx)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logFollowUpRun(deps, ctx, 'error', `followup attempt ${attempt}: ${message}`).catch(() => undefined)
  }
}

/** Flip sdr_status off and tag the contact cold. Logs a 'cold' run. */
async function closeCold(deps: ExecuteDeps, ctx: SdrContext): Promise<void> {
  const { supabase } = deps
  const { conversation, contact, config } = ctx
  await supabase
    .from('conversations')
    .update({ sdr_status: 'off', updated_at: new Date().toISOString() })
    .eq('id', conversation.id)

  const tagName = config?.cold_tag?.trim()
  if (tagName && contact.id) {
    const tagId = await findOrCreateTag(deps, conversation.account_id, conversation.user_id, tagName)
    if (tagId) {
      await supabase
        .from('contact_tags')
        .upsert(
          { contact_id: contact.id, tag_id: tagId },
          { onConflict: 'contact_id,tag_id', ignoreDuplicates: true },
        )
    }
  }
  await logFollowUpRun(deps, ctx, 'cold', null)
}

/** Find-or-create a tag by name for an account; returns its id or null. */
async function findOrCreateTag(
  deps: ExecuteDeps,
  accountId: string,
  userId: string,
  name: string,
): Promise<string | null> {
  const { supabase } = deps
  const { data: existing } = await supabase
    .from('tags')
    .select('id')
    .eq('account_id', accountId)
    .ilike('name', name)
    .maybeSingle()
  if (existing?.id) return existing.id as string

  // `tags` has NOT NULL user_id + account_id; color defaults in the DB.
  const { data: created } = await supabase
    .from('tags')
    .insert({ account_id: accountId, user_id: userId, name, color: '#64748b' })
    .select('id')
    .single()
  return (created?.id as string) ?? null
}

async function logFollowUpRun(
  deps: ExecuteDeps,
  ctx: SdrContext,
  action: 'followup' | 'cold' | 'error',
  error: string | null,
  replyMessageId: string | null = null,
): Promise<void> {
  await deps.supabase.from('sdr_runs').insert({
    account_id: ctx.conversation.account_id,
    conversation_id: ctx.conversation.id,
    broadcast_id: ctx.conversation.broadcast_id,
    inbound_message_ids: [],
    action,
    reply_message_id: replyMessageId,
    error,
  })
}
```

Note: the `tags` insert includes `user_id` (NOT NULL) — supplied from `ctx.conversation.user_id`, which Task 3 Step 0 added to the context.

- [ ] **Step 4: Run, expect PASS** — `npx vitest run src/lib/sdr/execute.test.ts`. Then `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sdr/execute.ts src/lib/sdr/execute.test.ts
git commit -m "feat(sdr): execute follow-up reminders + cold close"
```

---

## Task 6: Worker wiring

**Files:**
- Modify: `src/worker/sdr-worker.ts`

This is integration glue over already-tested units; verified by typecheck/build + the later live test. No new unit test.

- [ ] **Step 1: Add imports** — alongside the existing imports in `src/worker/sdr-worker.ts`:

```ts
import { SDR_QUEUE_NAME, type SdrJobData, enqueueFollowUp } from '@/lib/queue/sdr-queue'
import { loadSdrContext, decideFromContext } from '@/lib/sdr/core'
import { decideFollowUp } from '@/lib/sdr/followup'
import { executeDecision, executeFollowUp, CHANNEL_COLUMNS, type ExecuteDeps } from '@/lib/sdr/execute'
```
(Replace the existing `sdr-queue` and `execute` import lines with these; keep the others.)

- [ ] **Step 2: Schedule follow-up #1 after a reply** — in `handleJob`, after `await executeDecision(execDeps, decision, ctx)` and before/after the existing `console.log`, add:

```ts
    if (
      decision.action === 'reply' &&
      ctx.config?.follow_up_enabled &&
      (ctx.config.follow_up_delays?.length ?? 0) > 0
    ) {
      await enqueueFollowUp(
        conversationId,
        ctx.conversation.account_id,
        1,
        ctx.config.follow_up_delays[0],
      ).catch((e) => console.error('[sdr-worker] schedule follow-up failed:', e))
    }
```

- [ ] **Step 3: Add `handleFollowUp`** — add this function next to `handleJob`:

```ts
async function handleFollowUp(
  conversationId: string,
  accountId: string,
  attempt: number,
): Promise<void> {
  const supabase = supabaseAdmin()
  const ctx = await loadSdrContext(supabase, conversationId)
  if (!ctx) return

  let channel = null
  let provider = ''
  if (ctx.conversation.channel_id) {
    const { data } = await supabase
      .from('channels')
      .select(CHANNEL_COLUMNS)
      .eq('id', ctx.conversation.channel_id)
      .maybeSingle()
    channel = data
    provider = (data?.provider as string) ?? ''
  }

  const decision = await decideFollowUp(ctx, attempt, provider, sdrDeps)
  if (decision.action === 'noop') {
    console.log(`[sdr-worker] followup ${conversationId} #${attempt} → noop (${decision.reason})`)
    return
  }

  await executeFollowUp(execDeps, decision, ctx, channel as never, attempt)
  console.log(`[sdr-worker] followup ${conversationId} #${attempt} → ${decision.action}`)

  // Schedule the next reminder when this one was sent and isn't the last.
  if (decision.action === 'send' && !decision.final) {
    const delays = ctx.config?.follow_up_delays ?? []
    const gap = (delays[attempt] ?? 0) - (delays[attempt - 1] ?? 0)
    if (gap > 0) {
      await enqueueFollowUp(conversationId, accountId, attempt + 1, gap).catch((e) =>
        console.error('[sdr-worker] schedule next follow-up failed:', e),
      )
    }
  }
}
```

- [ ] **Step 4: Branch the processor on `kind`** — change the Worker processor body from `await handleJob(job.data.conversationId)` to:

```ts
  async (job) => {
    if (job.data.kind === 'followup') {
      await handleFollowUp(job.data.conversationId, job.data.accountId, job.data.attempt ?? 1)
    } else {
      await handleJob(job.data.conversationId)
    }
  },
```

- [ ] **Step 5: Verify** — `npx tsc --noEmit` (clean) and `npx eslint src/worker/sdr-worker.ts` (clean). Optionally boot-check: `NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co SUPABASE_SERVICE_ROLE_KEY=fake REDIS_URL=redis://localhost:6399 npx tsx src/worker/sdr-worker.ts` in the background for ~5s — expect the import graph to load (Redis ECONNREFUSED errors are fine), then kill.

- [ ] **Step 6: Commit**

```bash
git add src/worker/sdr-worker.ts
git commit -m "feat(sdr): worker handles followup jobs + schedules reminders"
```

---

## Task 7: Config API + card UI

**Files:**
- Modify: `src/app/api/sdr/config/route.ts`
- Modify: `src/components/broadcasts/sdr-config-card.tsx`

- [ ] **Step 1: GET select** — in `src/app/api/sdr/config/route.ts`, change the `SELECT` constant to include the new fields:

```ts
const SELECT =
  'id, broadcast_id, enabled, system_prompt, qualification_criteria, model, handoff_keywords, max_turns, debounce_seconds, follow_up_enabled, follow_up_delays, cold_tag'
```

- [ ] **Step 2: PUT accepts + clamps** — in the PUT handler, after the `maxTurns` line, add parsing, and include the fields in `row`:

```ts
    const followUpDelays = Array.isArray(b.follow_up_delays)
      ? b.follow_up_delays
          .map((n) => (typeof n === 'number' ? Math.round(n) : Number(n)))
          .filter((n) => Number.isFinite(n) && n > 0 && n <= 43200) // ≤ 30 days
          .slice(0, 5)
      : [180, 1440]
```

Add to the `row` object (after `debounce_seconds: debounce,`):

```ts
      follow_up_enabled: b.follow_up_enabled === undefined ? true : Boolean(b.follow_up_enabled),
      follow_up_delays: followUpDelays.length ? followUpDelays : [180, 1440],
      cold_tag: typeof b.cold_tag === 'string' && b.cold_tag.trim() ? b.cold_tag.trim() : 'lead-frio',
```

- [ ] **Step 3: Card state + UI** — in `src/components/broadcasts/sdr-config-card.tsx`:

Extend the `SdrConfig` interface and `EMPTY`:

```ts
interface SdrConfig {
  enabled: boolean;
  system_prompt: string | null;
  qualification_criteria: string[];
  model: string | null;
  handoff_keywords: string[];
  max_turns: number;
  debounce_seconds: number;
  follow_up_enabled: boolean;
  follow_up_delays: number[];
  cold_tag: string;
}
```
```ts
const EMPTY: SdrConfig = {
  enabled: false,
  system_prompt: '',
  qualification_criteria: [],
  model: null,
  handoff_keywords: [],
  max_turns: 20,
  debounce_seconds: 12,
  follow_up_enabled: true,
  follow_up_delays: [180, 1440],
  cold_tag: 'lead-frio',
};
```

Add a follow-up section just before the closing `<RequireRole min="admin">` Save block. Delays are shown in hours (minutes/60) and parsed back to minutes:

```tsx
        <div className="border-border space-y-2 rounded-lg border p-3">
          <div className="flex items-center justify-between">
            <Label htmlFor="sdr-followup" className="text-xs font-medium">
              Follow-up automático
            </Label>
            <Switch
              id="sdr-followup"
              checked={config.follow_up_enabled}
              onCheckedChange={(v) => setConfig((c) => ({ ...c, follow_up_enabled: v }))}
            />
          </div>
          <p className="text-muted-foreground text-[11px]">
            Se o lead parar de responder, o SDR manda lembretes nestes intervalos
            (horas após a última pergunta) e encerra como frio depois do último.
          </p>
          <Input
            id="sdr-followup-delays"
            placeholder="3, 24"
            value={config.follow_up_delays.map((m) => +(m / 60).toFixed(2)).join(', ')}
            onChange={(e) =>
              setConfig((c) => ({
                ...c,
                follow_up_delays: e.target.value
                  .split(',')
                  .map((s) => Math.round(parseFloat(s.trim()) * 60))
                  .filter((n) => Number.isFinite(n) && n > 0),
              }))
            }
          />
        </div>
```

The existing `save()` already sends `...config`, so the new fields flow to PUT with no change.

- [ ] **Step 4: Verify** — `npx tsc --noEmit` and `npx eslint src/app/api/sdr/config/route.ts "src/components/broadcasts/sdr-config-card.tsx"`. Both clean.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/sdr/config/route.ts src/components/broadcasts/sdr-config-card.tsx
git commit -m "feat(sdr): follow-up config in API + card UI"
```

---

## Task 8: Full verification

- [ ] **Step 1: Full test suite** — `npx vitest run`. Expected: all pass except the 2 known pre-existing `date-utils` (`mondayIndex`) timezone failures.
- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` → clean.
- [ ] **Step 3: Lint** — `npx eslint src/lib/sdr src/lib/queue src/worker "src/app/api/sdr" "src/components/broadcasts/sdr-config-card.tsx"` → clean (pre-existing warnings in untouched files OK).
- [ ] **Step 4: Build compiles** — `npm run build` compiles + passes TypeScript (a local prerender failure on `/forgot-password` from missing `NEXT_PUBLIC_SUPABASE_URL` is environmental, not a code error).
- [ ] **Step 5: Push** — `git push origin main`.

---

## Post-merge (manual, owner)

- Redeploy **both** services (web picks up the config UI/API; worker picks up the follow-up logic). Worker needs no new env.
- Live test: with the SDR active on a real conversation, let it ask a question and **don't reply**. With short test delays (e.g. set `follow_up_delays` to `1, 2` minutes via the card), confirm a reminder arrives, then a second, then `sdr_status` flips off and the `lead-frio` tag appears. Verify `sdr_runs` shows `followup`, `followup`, `cold`.
