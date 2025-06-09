// src/lib/supabaseClient.ts
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  console.error(
    "Error: NEXT_PUBLIC_SUPABASE_URL is not defined in environment variables."
  );
}
if (!supabaseAnonKey) {
  console.error(
    "Error: NEXT_PUBLIC_SUPABASE_ANON_KEY is not defined in environment variables."
  );
}

// Ensure createClient is only called if variables are defined
let supabaseInstance: SupabaseClient | null = null;
if (supabaseUrl && supabaseAnonKey) {
  supabaseInstance = createClient(supabaseUrl, supabaseAnonKey);
} else {
  console.error(
    "Supabase client (public) could not be initialized due to missing environment variables."
  );
}

export const supabase = supabaseInstance; // Exported instance might be null if env vars are missing
