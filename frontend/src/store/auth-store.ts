import { create } from "zustand"

import { clearSession, currentSession, decodeClaims, refreshCheck } from "@/session/session"

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
  /** Sinal para a UI avisar que o reload não manteve a sessão. */
  reLoginRequired: boolean
  init: () => Promise<void>
  retryInit: () => Promise<void>
  signOut: () => Promise<void>
}

function friendlyAuthError(err: unknown): string {
  if (err instanceof Error && err.message === SESSION_INIT_TIMEOUT_RAW) {
    return SESSION_TIMEOUT_MESSAGE
  }
  return "Falha ao carregar sessão"
}

function userFromMemory(role?: string): AuthUser | null {
  const session = currentSession()
  if (!session) return null
  const claims = decodeClaims(session.access)
  const id = claims?.sub
  if (typeof id !== "string" || !id) return null
  const effectiveRole = role ?? (typeof claims?.role === "string" ? claims.role : null)
  return { id, email: null, role: effectiveRole }
}

/** Checagem com teto de tempo: pendurar nunca deixa a tela branca. */
async function checkSessionWithTimeout(): Promise<Awaited<ReturnType<typeof refreshCheck>>> {
  let timerId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      refreshCheck(),
      new Promise<never>((_, reject) => {
        timerId = setTimeout(
          () => reject(new Error(SESSION_INIT_TIMEOUT_RAW)),
          SESSION_INIT_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timerId !== undefined) clearTimeout(timerId)
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: "idle",
  user: null,
  error: null,
  initialized: false,
  reLoginRequired: false,

  async init() {
    if (get().initialized) return
    set({ status: "loading" })
    try {
      const result = await checkSessionWithTimeout()
      if (result.ok) {
        set({
          status: "authenticated",
          user: userFromMemory(result.role),
          error: null,
          reLoginRequired: false,
          initialized: true,
        })
      } else if (result.reason === "login-required") {
        set({ status: "unauthenticated", user: null, error: null, reLoginRequired: true, initialized: true })
      } else {
        // Falha transitória: memória é preservada; guard oferece retry.
        set({ status: "error", user: null, error: friendlyAuthError(new Error("network")), initialized: true })
      }
    } catch (err) {
      set({
        status: "error",
        user: null,
        error: friendlyAuthError(err),
        initialized: true,
      })
    }
  },

  async retryInit() {
    set({ initialized: false, status: "idle", error: null, reLoginRequired: false })
    await get().init()
  },

  async signOut() {
    // Não existe rota de logout no contrato v1: limpa só a memória local.
    clearSession()
    set({ status: "unauthenticated", user: null, error: null })
  },
}))
