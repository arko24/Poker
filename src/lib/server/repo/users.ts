// Typed wrappers over the users table and claim_topup RPC. All reads/writes use
// the service-role client (bypasses RLS).

import { supabaseAdmin } from "../supabaseAdmin";

export interface UserRow {
  id: string;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  coin_balance: number;
  last_topup_at: string | null;
  created_at: string;
}

/**
 * Upsert a user by telegram_id after initData validation. On conflict we refresh
 * the display fields but never touch coin_balance / last_topup_at (those are
 * owned by the economy RPCs). Returns the stored row.
 */
export async function upsertUser(input: {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
}): Promise<UserRow> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("users")
    .upsert(
      {
        telegram_id: input.telegram_id,
        username: input.username,
        first_name: input.first_name,
      },
      { onConflict: "telegram_id" },
    )
    .select("*")
    .single();
  if (error) throw new Error(`upsertUser failed: ${error.message}`);
  return data as UserRow;
}

export async function getUserById(userId: string): Promise<UserRow | null> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("users")
    .select("*")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error(`getUserById failed: ${error.message}`);
  return (data as UserRow) ?? null;
}

/**
 * Atomic daily top-up via the claim_topup RPC. Resolves to the new balance, or
 * throws an error whose message is the RPC's short code (e.g. 'topup_not_eligible')
 * so the route handler maps it to 409.
 */
export async function claimTopup(userId: string): Promise<number> {
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("claim_topup", { p_user_id: userId });
  if (error) throw new Error(error.message);
  return Number(data);
}
