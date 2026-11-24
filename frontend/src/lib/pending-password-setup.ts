// Guard de onboarding: convite/recovery abre `/definir-senha`; enquanto o
// usuário não salvar a senha, este cookie (por `user.id` + origem, TTL 8 h)
// mantém o redirecionamento mesmo que ele tente navegar para o dashboard. Não
// é token: só o id do usuário e a origem, para o `RequireSession` comparar com
// a sessão atual e escolher o texto certo (`convite` | `recuperacao`).

import type { CookieDocumentLike } from "@/lib/supabase-cookie-storage"

export const PENDING_PASSWORD_SETUP_COOKIE = "pendingPasswordSetup"
export const PENDING_PASSWORD_SETUP_TTL_SECONDS = 8 * 60 * 60

export type PasswordSetupOrigin = "convite" | "recuperacao"

const ORIGIN_SEPARATOR = ":"

export interface PendingPasswordSetupOptions {
  doc?: CookieDocumentLike | null
  secure?: boolean
  origem?: PasswordSetupOrigin
}

interface ParsedPendingPasswordSetup {
  userId: string
  origem: PasswordSetupOrigin
}

function defaultDoc(): CookieDocumentLike | null {
  return typeof document === "undefined" ? null : (document as unknown as CookieDocumentLike)
}

function defaultSecure(): boolean {
  return typeof window !== "undefined" && window.location.protocol === "https:"
}

function parseCookieValue(value: string): ParsedPendingPasswordSetup | null {
  const separator = value.indexOf(ORIGIN_SEPARATOR)
  if (separator === -1) return { userId: value, origem: "convite" }
  const userId = value.slice(0, separator)
  if (!userId) return null
  const origem = value.slice(separator + 1) === "recuperacao" ? "recuperacao" : "convite"
  return { userId, origem }
}

function cookieValueFor(userId: string, origem?: PasswordSetupOrigin): string {
  return encodeURIComponent(origem ? `${userId}${ORIGIN_SEPARATOR}${origem}` : userId)
}

export function buildPendingPasswordSetupCookie(
  userId: string,
  secure: boolean,
  origem?: PasswordSetupOrigin,
): string {
  return `${PENDING_PASSWORD_SETUP_COOKIE}=${cookieValueFor(userId, origem)}; Path=/; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=${PENDING_PASSWORD_SETUP_TTL_SECONDS}`
}

function buildExpiredCookie(secure: boolean): string {
  return `${PENDING_PASSWORD_SETUP_COOKIE}=; Path=/; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=0`
}

function readRawCookie(raw: string | null | undefined): string | null {
  if (!raw) return null
  const match = raw.match(new RegExp(`(?:^|;\\s*)${PENDING_PASSWORD_SETUP_COOKIE}=([^;]*)`))
  if (!match) return null
  try {
    const value = decodeURIComponent(match[1] ?? "")
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

/** Id do usuário pendente (sem a origem). Cookie legado sem origem segue válido. */
export function readPendingPasswordSetup(raw: string | null | undefined): string | null {
  const value = readRawCookie(raw)
  return value ? (parseCookieValue(value)?.userId ?? null) : null
}

/** Origem gravada no cookie; cookie legado (sem sufixo) equivale a `convite`. */
export function readPendingPasswordSetupOrigin(
  raw: string | null | undefined,
): PasswordSetupOrigin | null {
  const value = readRawCookie(raw)
  return value ? (parseCookieValue(value)?.origem ?? null) : null
}

export function hasPendingPasswordSetupFor(
  raw: string | null | undefined,
  userId: string | null | undefined,
): boolean {
  if (!userId) return false
  return readPendingPasswordSetup(raw) === userId
}

export function writePendingPasswordSetup(
  userId: string,
  options: PendingPasswordSetupOptions = {},
): void {
  const doc = options.doc ?? defaultDoc()
  if (!doc) return
  const secure = options.secure ?? defaultSecure()
  doc.cookie = buildPendingPasswordSetupCookie(userId, secure, options.origem)
}

export function clearPendingPasswordSetup(options: PendingPasswordSetupOptions = {}): void {
  const doc = options.doc ?? defaultDoc()
  if (!doc) return
  const secure = options.secure ?? defaultSecure()
  doc.cookie = buildExpiredCookie(secure)
}
