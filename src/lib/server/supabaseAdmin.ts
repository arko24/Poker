// Service-role Supabase client. SERVER-ONLY: this module reads the
// service-role key from process.env and must never be imported by any
// client-bundled module (nothing under src/lib/client or src/components).
//
// The service-role key bypasses RLS, which is exactly why every read/write of
// game state goes through here inside server route handlers. The browser only
// ever uses the anon client (src/lib/client) to subscribe to Realtime.

import { createClient, SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

/**
 * Lazily construct (and cache) the service-role client. Throws if the required
 * env vars are missing so a misconfigured deploy fails loudly server-side
 * rather than silently using an unauthenticated client.
 */
export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "supabaseAdmin: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set",
    );
  }

  cached = createClient(url, serviceRoleKey, {
    auth: {
      // No session persistence/refresh on the server; the service-role key is
      // the credential and is presented on every request.
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return cached;
}
