/**
 * Global WebSocket polyfill for the worker process.
 *
 * `@supabase/supabase-js` builds a Realtime client in its constructor, which
 * requires a global `WebSocket`. That global only ships unflagged from Node
 * 22; on Node 20 (and the Easypanel build runs Node 20) the worker would
 * crash at boot with "Node.js 20 detected without native WebSocket support".
 *
 * The web app dodges this via Next's runtime polyfill, but the worker runs
 * raw via `tsx`, so we install the polyfill ourselves. This module MUST be
 * imported FIRST in the worker entrypoint, before anything that constructs a
 * Supabase client — ESM evaluates imported modules in source order, so the
 * first import line runs to completion before the rest load.
 *
 * The worker never opens a Realtime subscription, so `ws` is only here to
 * satisfy the constructor's capability check; no socket is ever opened.
 */
import ws from 'ws'

const g = globalThis as unknown as { WebSocket?: unknown }
if (typeof g.WebSocket === 'undefined') {
  g.WebSocket = ws
}
