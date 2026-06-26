/**
 * Evolution API client (unofficial WhatsApp provider).
 *
 * Thin wrappers over the Evolution REST API, mirroring the shape of
 * `meta-api.ts` so the channel layer can treat both providers uniformly.
 * Evolution is freeform-only — no Meta templates, no 24h window.
 *
 * Auth: every request carries the instance's API key in the `apikey`
 * header. The base URL + instance name identify the server and the
 * connected number; both come from the channel row.
 */

export interface EvolutionSendResult {
  messageId: string
}

interface EvolutionSendArgs {
  /** Evolution server base URL, e.g. https://evo.example.com (no trailing slash). */
  baseUrl: string
  /** Instance API key (decrypted). */
  apiKey: string
  /** Instance name — the connected number's Evolution instance. */
  instance: string
  /** Recipient in E.164 (with or without '+'; Evolution accepts digits). */
  to: string
  text: string
}

/** Strip a single trailing slash so `${baseUrl}/path` never doubles up. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

async function throwEvolutionError(
  response: Response,
  fallback: string,
): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as {
      message?: unknown
      error?: unknown
      response?: { message?: unknown }
    }
    // Evolution surfaces errors in a few shapes across versions; try the
    // common ones before falling back to the HTTP status text.
    const candidate =
      data?.response?.message ?? data?.message ?? data?.error
    if (typeof candidate === 'string') message = candidate
    else if (Array.isArray(candidate) && candidate.length > 0) {
      message = candidate.map((c) => String(c)).join('; ')
    }
  } catch {
    // body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

/**
 * Send a freeform text message via Evolution.
 * POST {baseUrl}/message/sendText/{instance}
 * Returns the provider message id (`key.id`).
 */
export async function sendEvolutionText(
  args: EvolutionSendArgs,
): Promise<EvolutionSendResult> {
  const { baseUrl, apiKey, instance, to, text } = args
  if (!baseUrl) throw new Error('sendEvolutionText requires a baseUrl.')
  if (!instance) throw new Error('sendEvolutionText requires an instance.')

  const url = `${normalizeBaseUrl(baseUrl)}/message/sendText/${encodeURIComponent(instance)}`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: apiKey,
    },
    body: JSON.stringify({ number: to, text }),
  })

  if (!response.ok) {
    await throwEvolutionError(
      response,
      `Evolution API returned ${response.status}`,
    )
  }

  const data = (await response.json()) as { key?: { id?: string } }
  const messageId = data?.key?.id
  if (!messageId) {
    throw new Error('Evolution API response missing key.id')
  }
  return { messageId }
}
