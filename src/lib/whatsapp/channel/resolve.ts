import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Channel resolution + legacy-shape compatibility (S5→S6 cutover).
 *
 * The app historically read one `whatsapp_config` row per account. The
 * channels table (migration 028) generalises that to N rows across two
 * providers. To cut the readers over without rewriting each one's field
 * access, this module:
 *
 *   - reads `channels` (provider='cloud') and FLATTENS a row back into
 *     the old `whatsapp_config` shape (`phone_number_id`,
 *     `access_token`, `waba_id`, …) — `CloudConfig` below; and
 *   - builds the inverse mapping (`buildCloudChannelRow`) so the config
 *     write path persists into `channels` columns + JSONB.
 *
 * "The account's Cloud channel" preserves the previous one-per-account
 * behaviour during the cutover; per-channel selection is S7 (the
 * channels UI). `access_token` stays CIPHERTEXT end to end — callers
 * decrypt exactly as they did with whatsapp_config.
 */

// Loosely-typed client: route handlers pass either the SSR client or a
// service-role admin client; both expose the same query builder here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = SupabaseClient<any, any, any>

/** The legacy `whatsapp_config` row shape, reconstructed from a channel. */
export interface CloudConfig {
  id: string
  account_id: string
  user_id: string | null
  phone_number_id: string
  access_token: string
  waba_id: string | null
  verify_token: string | null
  status: string
  registered_at: string | null
  subscribed_apps_at: string | null
  last_registration_error: string | null
  connected_at: string | null
}

const CHANNEL_COLUMNS =
  'id, account_id, user_id, identifier, status, connected_at, created_at, config, credentials'

/** Flatten a channels row (provider='cloud') into the legacy shape. */
export function flattenCloudChannel(row: {
  id: string
  account_id: string
  user_id: string | null
  identifier: string
  status: string
  connected_at: string | null
  config: Record<string, unknown> | null
  credentials: Record<string, unknown> | null
}): CloudConfig {
  const config = (row.config ?? {}) as Record<string, unknown>
  const credentials = (row.credentials ?? {}) as Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  return {
    id: row.id,
    account_id: row.account_id,
    user_id: row.user_id ?? null,
    phone_number_id: row.identifier,
    access_token: str(credentials.access_token) ?? '',
    waba_id: str(config.waba_id),
    verify_token: str(config.verify_token),
    status: row.status,
    registered_at: str(config.registered_at),
    subscribed_apps_at: str(config.subscribed_apps_at),
    last_registration_error: str(config.last_registration_error),
    connected_at: row.connected_at ?? null,
  }
}

/**
 * The account's Cloud channel as a legacy `whatsapp_config` row, or
 * `{ data: null }` if none. Mirrors the old
 * `.from('whatsapp_config').eq('account_id', …).maybeSingle()` contract
 * so call sites swap in with a one-line change.
 */
export async function getAccountCloudConfig(
  supabase: AnyClient,
  accountId: string,
): Promise<{ data: CloudConfig | null; error: unknown }> {
  const { data, error } = await supabase
    .from('channels')
    .select(CHANNEL_COLUMNS)
    .eq('account_id', accountId)
    .eq('provider', 'cloud')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) return { data: null, error }
  if (!data) return { data: null, error: null }
  return { data: flattenCloudChannel(data), error: null }
}

/**
 * The Cloud channel that owns `phoneNumberId` (= identifier), globally.
 * Used by the inbound webhook. `UNIQUE(provider, identifier)` guarantees
 * at most one, so no `.single()` multi-row hazard.
 */
export async function getCloudConfigByPhoneNumberId(
  supabase: AnyClient,
  phoneNumberId: string,
): Promise<{ data: CloudConfig | null; error: unknown }> {
  const { data, error } = await supabase
    .from('channels')
    .select(CHANNEL_COLUMNS)
    .eq('provider', 'cloud')
    .eq('identifier', phoneNumberId)
    .maybeSingle()
  if (error) return { data: null, error }
  if (!data) return { data: null, error: null }
  return { data: flattenCloudChannel(data), error: null }
}

/** Fields the config write path persists, in legacy naming. */
export interface CloudChannelWrite {
  phone_number_id: string
  waba_id: string | null
  encrypted_access_token: string
  encrypted_verify_token: string | null
  status: string
  connected_at: string | null
  registered_at: string | null
  subscribed_apps_at: string | null
  last_registration_error: string | null
}

/**
 * Map legacy write fields onto channels columns + JSONB. Returned shape
 * is ready to `.update()` or to spread into an `.insert()` (which adds
 * account_id / user_id / provider / identifier).
 */
export function buildCloudChannelRow(w: CloudChannelWrite): {
  identifier: string
  status: string
  connected_at: string | null
  config: Record<string, unknown>
  credentials: Record<string, unknown>
  updated_at: string
} {
  return {
    identifier: w.phone_number_id,
    status: w.status,
    connected_at: w.connected_at,
    config: {
      waba_id: w.waba_id,
      verify_token: w.encrypted_verify_token,
      registered_at: w.registered_at,
      subscribed_apps_at: w.subscribed_apps_at,
      last_registration_error: w.last_registration_error,
    },
    credentials: { access_token: w.encrypted_access_token },
    updated_at: new Date().toISOString(),
  }
}
