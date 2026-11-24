import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { resolveSupabaseConfig } from "./supabase-env"
import { createSessionCookieStorage } from "./supabase-cookie-storage"

const cookieStorage = createSessionCookieStorage({
  secure: () =>
    typeof window !== "undefined" && window.location.protocol === "https:",
})

const config = resolveSupabaseConfig({
  url: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
  prod: import.meta.env.PROD,
})

export const supabase: SupabaseClient = createClient(config.url, config.anonKey, {
  auth: {
    storage: cookieStorage,
    autoRefreshToken: true,
    persistSession: true,
    // A app consome o fragmento explicitamente (src/boot/auth-hash-bootstrap.ts)
    // antes do router. A lib limpava o hash de forma assíncrona e o
    // createHashRouter lia lixo (convite caía no dashboard/404).
    detectSessionInUrl: false,
  },
})