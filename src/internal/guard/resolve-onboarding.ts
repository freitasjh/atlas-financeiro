/**
 * Onboarding do control plane — resolução pura, total e idempotente (REQ-22..25).
 *
 * Destinos terminais: `/definir-senha`, `/internal/login`, `/internal/mfa` e
 * `/internal/acesso-negado`. `?retorno=` é allowlist fechada, nunca URL livre.
 */

import type { OperatorGateState } from "./operator-gate"

export type OnboardingSurface = "internal" | "tenant"
export type OnboardingGuard = "none" | "mfa-required" | "operator"

export const INTERNAL_HOME_PATH = "/internal"
export const INTERNAL_LOGIN_PATH = "/internal/login"
export const INTERNAL_MFA_PATH = "/internal/mfa"
export const INTERNAL_DENIED_PATH = "/internal/acesso-negado"
export const TENANT_LOGIN_PATH = "/login"
export const SET_PASSWORD_PATH = "/definir-senha"
export const ONBOARDING_ERROR_SEARCH = "?motivo=indisponivel"

export interface OnboardingInput {
  surface: OnboardingSurface
  hasSession: boolean
  gateState: OperatorGateState
  pendingPasswordSetup?: boolean
  requestedPath?: string
}

export interface OnboardingTarget {
  path: string
  search: string
  guard: OnboardingGuard
  terminal: boolean
}

const KNOWN_INTERNAL_SEGMENTS = new Set([
  "login",
  "mfa",
  "acesso-negado",
  "tenants",
  "auditoria",
  "telemetria",
])

const TERMINAL_PATHS = new Set([
  SET_PASSWORD_PATH,
  INTERNAL_LOGIN_PATH,
  TENANT_LOGIN_PATH,
  INTERNAL_MFA_PATH,
  INTERNAL_DENIED_PATH,
])

/** Allowlist de `?retorno=`: `/`, `/internal` e `/internal/<segmento conhecido>`. */
export function sanitizeReturnTo(raw: unknown, fallback: string = INTERNAL_HOME_PATH): string {
  if (typeof raw !== "string") return fallback
  if (!raw.startsWith("/")) return fallback
  if (raw.startsWith("//") || raw.includes("\\")) return fallback
  if (raw.includes("?") || raw.includes("#")) return fallback
  if (raw === "/" || raw === INTERNAL_HOME_PATH) return raw
  const match = /^\/internal\/([a-z0-9-]+)$/.exec(raw)
  if (match !== null && KNOWN_INTERNAL_SEGMENTS.has(match[1])) return raw
  return fallback
}

function sanitizeRequestedPath(raw: unknown, fallback: string): string {
  if (typeof raw !== "string" || !raw.startsWith("/")) return fallback
  if (raw.startsWith("//") || raw.includes("\\")) return fallback
  const path = raw.split(/[?#]/)[0]
  return path.length > 0 ? path : fallback
}

function target(
  path: string,
  options: { search?: string; guard?: OnboardingGuard } = {},
): OnboardingTarget {
  return {
    path,
    search: options.search ?? "",
    guard: options.guard ?? "none",
    terminal: TERMINAL_PATHS.has(path),
  }
}

export function firstAccessPath(retorno: string): string {
  return `${SET_PASSWORD_PATH}?origem=convite&retorno=${sanitizeReturnTo(retorno)}`
}

export function resolveOnboardingRoute(input: OnboardingInput): OnboardingTarget {
  const { surface, hasSession, gateState, pendingPasswordSetup = false } = input
  const surfaceFallback = surface === "internal" ? INTERNAL_HOME_PATH : "/"
  const requested = sanitizeRequestedPath(input.requestedPath, surfaceFallback)

  if (pendingPasswordSetup || gateState === "first-access") {
    const retorno = sanitizeReturnTo(input.requestedPath, surfaceFallback)
    const [path, search] = firstAccessPath(retorno).split("?")
    return target(path, { search: `?${search}` })
  }

  if (gateState === "mfa-required") {
    return target(INTERNAL_MFA_PATH, { guard: "mfa-required" })
  }

  if (!hasSession || gateState === "unauthenticated") {
    return target(surface === "internal" ? INTERNAL_LOGIN_PATH : TENANT_LOGIN_PATH)
  }

  if (gateState === "denied") return target(INTERNAL_DENIED_PATH)

  if (gateState === "error") {
    return target(INTERNAL_DENIED_PATH, { search: ONBOARDING_ERROR_SEARCH })
  }

  if (gateState === "operator") {
    return target(requested, { guard: "operator" })
  }

  return target(requested)
}

export function resolveOnboardingHref(input: OnboardingInput): string {
  const resolved = resolveOnboardingRoute(input)
  return `${resolved.path}${resolved.search}`
}

export function isOnboardingTerminal(target: OnboardingTarget): boolean {
  return target.terminal && TERMINAL_PATHS.has(target.path)
}
