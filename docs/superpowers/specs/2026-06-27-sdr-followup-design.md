# SDR Follow-up — Design

**Status:** approved (design) · **Date:** 2026-06-27

## Problem

The in-app SDR is purely reactive: it replies to inbound messages but never
re-engages a lead who goes silent mid-qualification. We want the SDR to send a
small number of automated, context-aware reminders when a lead stops replying,
and to close the thread as "cold" if the lead never comes back.

## Decisions (from brainstorming)

1. **Cadence:** 2 reminders — ~3h and ~24h after the bot's last (awaiting) message. Default, configurable per campaign.
2. **Terminal:** after the last reminder with no reply, close as cold — `sdr_status='off'` + add a `lead-frio` tag to the contact.
3. **Content:** the LLM writes each reminder, aware of the conversation context (reuses the SDR brain).
4. **24h window:** Evolution sends reminders anytime (no enforced window). Cloud API skips a reminder that falls outside the 24h customer-service window (free-form would fail) and closes the thread cold. Templates are a future enhancement.
5. **Activation:** a dedicated "Follow-up automático" toggle on the SDR config card, **on by default** when the SDR is enabled.

## Flow

```
SDR replies (executeDecision reply) ──> schedule follow-up #1 (+3h)
        │
   +3h ─┤─ customer replied? → no-op (normal SDR flow handled it)
        └─ still silent → LLM writes reminder → send → schedule #2 (+21h ⇒ ~24h total)
                │
          +24h ─┤─ replied? → no-op
                └─ still silent → LLM writes reminder → send → CLOSE COLD
                                  (sdr_status='off' + tag 'lead-frio')
```

The delays are **absolute offsets from the bot's awaiting message** (`{180, 1440}` minutes ⇒ 3h, 24h). The job scheduled after reminder #1 uses the *relative* gap (1440−180 = 1260 min) so reminder #2 lands at ~24h total.

## Scheduling (BullMQ)

- Extend `SdrJobData` with `kind: 'qualify' | 'followup'` and `attempt: number`. The **same worker** processes both, branching on `kind`.
- Follow-up jobs use a stable jobId `sdrfu-<conversationId>` (distinct from the debounce `sdr-<conversationId>`), so re-scheduling **replaces** — at most one pending follow-up per conversation.
- A reply (`executeDecision` reply success) schedules follow-up attempt 1 at `delays[0]`.
- A follow-up job for attempt N: re-checks silence; if a customer replied since, it's a stale no-op. If still silent: send the reminder, set `sdr_followups_sent=N`, then either schedule attempt N+1 (relative gap) or, if N was the last, close cold.
- New `enqueueFollowUp(conversationId, accountId, attempt, delayMinutes)` in `src/lib/queue/sdr-queue.ts`.

## Data model

`supabase/migrations/030_sdr_followup.sql`:

- `sdr_configs.follow_up_enabled boolean NOT NULL DEFAULT true`
- `sdr_configs.follow_up_delays integer[] NOT NULL DEFAULT '{180,1440}'` (minutes; array length = max reminders)
- `sdr_configs.cold_tag text NOT NULL DEFAULT 'lead-frio'`
- `conversations.sdr_followups_sent integer NOT NULL DEFAULT 0`

No new RLS classes — these extend existing tables (settings-class for `sdr_configs`, member-scoped for `conversations`).

## Follow-up decision + content

New pure module `src/lib/sdr/followup.ts`:

- `decideFollowUp(ctx, attempt, deps)` — guards first (sdr_status active, config + follow_up_enabled, last message is **not** from the customer = still awaiting, attempt within `delays` length). No side effects. Returns one of:
  - `noop` — a guard failed (lead replied, handoff, sdr off, attempt past the end).
  - `cold` (no reminder) — Cloud channel **and** now − lastCustomerMessageAt > 24h: skip the send entirely and close cold.
  - `send` — still silent and sendable; carries the LLM reminder `text` and a `final: boolean` (true when this is the last attempt). The executor sends the reminder; **if `final`, it then closes cold after sending.**
- Reminder generation reuses `chat.ts` in **plain-text mode (no JSON)**: system = campaign `system_prompt` + a follow-up instruction ("o lead parou de responder; escreva UMA mensagem curta e gentil retomando o contexto, sem repetir a última pergunta literal"). History = the conversation so far.

The executor (`src/lib/sdr/execute.ts`) gains follow-up paths:
- `send`: send the reminder, persist it as a `bot` message, log `sdr_runs` `action='followup'`. If `final`, immediately run the cold close (below). If not final, the worker schedules the next attempt.
- `cold` (skip): close cold without sending.

The cold close (shared by both): flips `sdr_status='off'`, adds the tag, logs `sdr_runs` `action='cold'`.

`sdr_runs.action` gains two values: `'followup'`, `'cold'` (CHECK constraint updated in the migration).

## Cold close + tag

Find-or-create the `cold_tag` in `tags` for the account (mirror `resolve-import-tags.ts`), then upsert into `contact_tags` (`onConflict: 'contact_id,tag_id', ignoreDuplicates`) — the same path the automation `add_tag` step uses.

## 24h window / channel

When a follow-up fires: load the channel; if `provider='evolution'` → send. If `provider='cloud'` and `now - lastCustomerMessageAt > 24h` → skip and close cold (don't attempt a free-form send that would fail). Template-based re-engagement is out of scope.

## Reset

In `process-inbound`, when a customer message lands on an SDR-active conversation, reset `sdr_followups_sent = 0`. The subsequent SDR reply reschedules follow-up attempt 1 from scratch.

## Config UI

`SdrConfigCard`: a "Follow-up automático" switch (default on) and an editable delays field (e.g. "3h, 24h" parsed to minutes). Persisted via the existing `PUT /api/sdr/config` (route extended to accept the three new fields). Members read-only; admins edit.

## Edge cases

- `handoff` / `off` → no follow-up fires (job is a no-op).
- Customer replies between reminders → follow-up job is stale → no-op (check "is the last message still from the bot?").
- Conversation without `channel_id` or contact phone → no-op + log.
- Reminders do **not** count toward `max_turns` (separate flow); they are inserted as `bot` messages but the follow-up path never checks/enforces `max_turns`.
- `follow_up_delays` empty → follow-up disabled in effect (nothing scheduled).

## Testing

- `decideFollowUp`: send vs no-op vs cold across — customer replied, handoff, sdr off, attempt past end, Cloud-channel-outside-window.
- Reminder generation (mock `chat`).
- Scheduler: reply schedules attempt 1; attempt N schedules N+1 or closes cold (fake queue, as in existing `sdr-queue.test.ts`).
- `process-inbound` resets `sdr_followups_sent`.
- Reuse existing fake-queue / fake-supabase / injected-chat patterns.

## Files

- `supabase/migrations/030_sdr_followup.sql` (new columns + `sdr_runs.action` CHECK)
- `src/lib/queue/sdr-queue.ts` (kind/attempt, `enqueueFollowUp`)
- `src/lib/sdr/followup.ts` (new — decision + reminder generation, pure)
- `src/lib/sdr/types.ts` (config + decision types for follow-up)
- `src/lib/sdr/execute.ts` (follow-up + cold execution paths)
- `src/worker/sdr-worker.ts` (branch on `kind`; schedule on reply)
- `src/lib/whatsapp/inbound/process-inbound.ts` (reset counter)
- `src/components/broadcasts/sdr-config-card.tsx` + `src/app/api/sdr/config/route.ts` (toggle + delays)

## Out of scope (future)

- Cloud API template-based re-engagement beyond the 24h window.
- Per-reminder custom copy (we generate via LLM; fixed templates not needed now).
- Analytics/reporting on cold leads beyond the tag.
