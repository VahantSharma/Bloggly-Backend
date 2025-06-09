// src/lib/supabaseAdmin.ts
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl) {
  throw new Error(
    "CRITICAL: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) is not defined for admin client."
  );
}
if (!supabaseServiceKey) {
  throw new Error(
    "CRITICAL: SUPABASE_SERVICE_KEY is not defined for admin client."
  );
}

export const supabaseAdmin: SupabaseClient = createClient(
  supabaseUrl,
  supabaseServiceKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  }
);
