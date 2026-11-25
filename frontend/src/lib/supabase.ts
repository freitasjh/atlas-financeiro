import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { resolveSupabaseConfig } from "./supabase-env"

const config = resolveSupabaseConfig({
  url: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
  prod: import.meta.env.PROD,
})

// AUTH-10: sessão de auth NÃO é persistida (nem cookie, nem storage de browser).
// Supabase continua apenas como dívida localizada para dados e recuperação de senha.
export const supabase: SupabaseClient = createClient(config.url, config.anonKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    // A app consome o fragmento explicitamente (src/boot/auth-hash-bootstrap.ts)
    // antes do router. A lib limpava o hash de forma assíncrona e o
    // createHashRouter lia lixo (convite caía no dashboard/404).
    detectSessionInUrl: false,
  },
})
