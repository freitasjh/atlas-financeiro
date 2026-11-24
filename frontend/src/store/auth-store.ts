import { create } from "zustand"

import { supabase } from "@/lib/supabase"
import { clearAllSessionCookies } from "@/lib/supabase-cookie-storage"

export type AuthStatus = "idle" | "loading" | "authenticated" | "unauthenticated" | "error"

export interface AuthUser {
  id: string
  email: string | null
  /** Papel em `public.profiles` (ex.: `user` | `super_admin`). Opcional: preenchido quando disponível. */
  role?: string | null
}

/** Piso de tempo máximo do boot de sessão: pendurar nunca deixa a tela branca. */
export const SESSION_INIT_TIMEOUT_MS = 10_000

/** Mensagem amigável para timeout técnico do boot de sessão (nunca vaza pro UI cru). */
export const SESSION_TIMEOUT_MESSAGE = "A verificação da sessão demorou mais que o esperado."

const SESSION_INIT_TIMEOUT_RAW = "session-init-timeout"

interface AuthState {
  status: AuthStatus
  user: AuthUser | null
  error: string | null
  initialized: boolean
  init: () => Promise<void>
  retryInit: () => Promise<void>
  signOut: () => Promise<void>
}

interface SessionUser {
  id: string
  email: string | null
}

interface AuthSubscription {
  unsubscribe: () => void
}

/** Última subscription ativa de onAuthStateChange — evita listeners duplicados entre init/retryInit. */
let activeSubscription: AuthSubscription | null = null

function friendlyAuthError(err: unknown): string {
  if (err instanceof Error && err.message === SESSION_INIT_TIMEOUT_RAW) {
    return SESSION_TIMEOUT_MESSAGE
  }
  return "Falha ao carregar sessão"
}

function toAuthUser(raw: { id: string; email?: string | null } | null | undefined): AuthUser | null {
  if (!raw?.id) return null
  return { id: raw.id, email: raw.email ?? null }
}

/**
 * Resolve a sessão com teto de tempo. `null` = sem sessão.
 * Lança em falha de rede/timeout; erro de auth (ex.: refresh 400 com cookie
 * stale) é tratado pelo chamador antes de chegar aqui.
 */
async function fetchSessionWithTimeout(): Promise<{ user: SessionUser | null; failed: boolean }> {
  let timerId: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      supabase.auth.getSession(),
      new Promise<never>((_, reject) => {
        timerId = setTimeout(
          () => reject(new Error(SESSION_INIT_TIMEOUT_RAW)),
          SESSION_INIT_TIMEOUT_MS,
        )
      }),
    ])
    const { data, error } = result
    if (error) return { user: null, failed: true }
    const user = toAuthUser(data?.session?.user ?? null)
    return { user, failed: false }
  } finally {
    if (timerId !== undefined) clearTimeout(timerId)
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: "idle",
  user: null,
  error: null,
  initialized: false,

  async init() {
    if (get().initialized) return
    set({ status: "loading" })
    try {
      const { user, failed } = await fetchSessionWithTimeout()
      if (failed) {
        // Cookie stale / refresh 400: sessão definitivamente inválida —
        // limpa cookies sb-* para quebrar loop de redirect e re-login limpo.
        clearAllSessionCookies()
        set({ status: "unauthenticated", user: null, error: null, initialized: true })
        return
      }
      if (user) {
        set({ status: "authenticated", user, error: null, initialized: true })
      } else {
        set({ status: "unauthenticated", user: null, error: null, initialized: true })
      }
    } catch (err) {
      // Timeout / falha de rede: estado de erro retryable — guard exibe UI
      // de erro com retry, nunca página branca infinita. Cookies NÃO são
      // limpos aqui: podem estar válidos (falha transitória) e limpá-los
      // forçaria re-login desnecessário. Limpeza só no erro de auth
      // explícito (refresh 400 / failed) — caminho acima.
      set({ status: "error", user: null, error: friendlyAuthError(err), initialized: true })
    }

    // Guard de subscription: desinscreve a anterior antes de registrar nova
    // (init pós retryInit não acumula listeners duplicados).
    activeSubscription?.unsubscribe()
    activeSubscription = null
    try {
      const result = supabase.auth.onAuthStateChange?.((_event, session) => {
        if (session?.user) {
          set({
            status: "authenticated",
            user: { id: session.user.id, email: session.user.email ?? null },
          })
        } else {
          set({ status: "unauthenticated", user: null })
        }
      })
      activeSubscription = result?.data?.subscription ?? null
    } catch {
      // ignore
    }
  },

  async retryInit() {
    set({ initialized: false, status: "idle", error: null })
    await get().init()
  },

  async signOut() {
    try {
      await supabase.auth.signOut()
    } catch {
      // ignore
    }
    clearAllSessionCookies()
    set({ status: "unauthenticated", user: null })
  },
}))
