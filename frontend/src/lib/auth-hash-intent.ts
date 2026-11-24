// Ponte síncrona do fragmento de auth (convite/recovery).
//
// `createHashRouter` + `detectSessionInUrl: true` perdia o payload: o supabase-js
// limpava o hash de forma assíncrona enquanto o router já o havia lido. A app
// passou a ser dona do fragmento: `detectSessionInUrl: false` e este módulo
// puro classifica o hash ANTES do router (ver `src/boot/auth-hash-bootstrap.ts`).
// Nenhum token sai daqui para persistência: o boot entrega ao
// `supabase.auth.setSession` e o Supabase grava a sessão no storage de cookie.

export type AuthFlowKind = "invite" | "recovery" | "signup" | "magiclink"

export type AuthHashIntent =
  | {
      kind: "session"
      flow: AuthFlowKind
      accessToken: string
      refreshToken: string
    }
  | { kind: "error"; reason: "expirado" | "invalido" | "consumido"; errorCode: string | null }
  | { kind: "none" }

const KNOWN_FLOWS: readonly AuthFlowKind[] = [
  "invite",
  "recovery",
  "signup",
  "magiclink",
]

function asFlow(value: string | null): AuthFlowKind {
  const normalized = (value ?? "").toLowerCase()
  return (KNOWN_FLOWS as readonly string[]).includes(normalized)
    ? (normalized as AuthFlowKind)
    : "invite"
}

/**
 * Classifica um fragmento (`window.location.hash` ou equivalente).
 * - hash de rota (`#/...`), vazio ou sem payload de auth ⇒ `none`;
 * - `error`/`error_code` ⇒ `error` (`otp_expired` ⇒ `expirado`, resto ⇒ `invalido`);
 * - `access_token` + `refresh_token` ⇒ `session` (fluxo por `type`);
 * - `access_token` sem `refresh_token` ⇒ `error/invalido`.
 */
export function readAuthHashIntent(hash: string): AuthHashIntent {
  const raw = (hash ?? "").replace(/^#/, "")
  if (!raw || raw.startsWith("/") || raw.startsWith("?")) return { kind: "none" }

  const params = new URLSearchParams(raw)
  const accessToken = params.get("access_token")
  const refreshToken = params.get("refresh_token")
  const error = params.get("error")
  const errorCode = params.get("error_code")

  if (error || errorCode) {
    const code = (errorCode ?? error ?? "").toLowerCase()
    return {
      kind: "error",
      reason: code === "otp_expired" ? "expirado" : "invalido",
      errorCode: errorCode ?? error ?? null,
    }
  }

  if (!accessToken) return { kind: "none" }
  if (!refreshToken) return { kind: "error", reason: "invalido", errorCode: null }

  return {
    kind: "session",
    flow: asFlow(params.get("type")),
    accessToken,
    refreshToken,
  }
}

/**
 * Rota canônica (hash router, sem `#`) em que o boot deve reescrever a URL
 * imediatamente após ler o payload — os tokens saem da barra de endereço.
 */
export function authHashDestination(intent: AuthHashIntent): string | null {
  if (intent.kind === "error") return `/link-expirado?motivo=${intent.reason}`
  if (intent.kind === "none") return null
  if (intent.flow === "invite") return "/definir-senha?origem=convite"
  if (intent.flow === "recovery") return "/definir-senha?origem=recuperacao"
  return "/"
}
