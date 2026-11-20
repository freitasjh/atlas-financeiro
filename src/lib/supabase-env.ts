export interface SupabaseEnvInput {
  url?: string | null
  anonKey?: string | null
  prod: boolean
}

export interface SupabaseConfig {
  url: string
  anonKey: string
}

/**
 * Fallback de desenvolvimento. O literal de host local só existe no bundle de
 * dev (`import.meta.env.DEV`); em produção o Vite dobra o ternário para `""` e
 * o artefato não carrega `http://localhost` (END-05 / `check-dist`).
 */
const DEV_FALLBACK_URL = import.meta.env.DEV ? "http://localhost:55321" : ""

export const DEV_SUPABASE_FALLBACK: SupabaseConfig = {
  url: DEV_FALLBACK_URL,
  anonKey: "placeholder-anon-key",
}

const PLACEHOLDER_PREFIX = "REPLACE_WITH_"

const isPlaceholder = (value: string | undefined): boolean =>
  value?.includes(PLACEHOLDER_PREFIX) === true

function placeholderVars(
  url: string | undefined,
  anonKey: string | undefined,
): string[] {
  const names: string[] = []
  if (isPlaceholder(url)) names.push("VITE_SUPABASE_URL")
  if (isPlaceholder(anonKey)) names.push("VITE_SUPABASE_ANON_KEY")
  return names
}

export function resolveSupabaseConfig(input: SupabaseEnvInput): SupabaseConfig {
  const url = input.url?.trim()
  const anonKey = input.anonKey?.trim()
  if (input.prod) {
    const placeholders = placeholderVars(url, anonKey)
    if (placeholders.length > 0) {
      throw new Error(
        `[supabase] ${placeholders.join(" / ")} ainda contém placeholder (REPLACE_WITH_*) em produção — defina os valores reais do projeto no build (Cloudflare Pages).`,
      )
    }
  }
  if (url && anonKey) return { url, anonKey }
  if (input.prod) {
    const missing = [!url ? "VITE_SUPABASE_URL" : null, !anonKey ? "VITE_SUPABASE_ANON_KEY" : null]
      .filter(Boolean)
      .join(" / ")
    throw new Error(
      `[supabase] ${missing} ausente(s) em produção — defina as variáveis no build (Cloudflare Pages).`,
    )
  }
  return {
    url: url ?? DEV_SUPABASE_FALLBACK.url,
    anonKey: anonKey ?? DEV_SUPABASE_FALLBACK.anonKey,
  }
}