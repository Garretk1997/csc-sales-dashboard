// worker/src/db.ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export type Env = {
  GHL_PIT: string
  GHL_LOCATION_ID: string
  SUPABASE_URL: string
  SUPABASE_SERVICE_KEY: string
}

export function createDb(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  })
}
