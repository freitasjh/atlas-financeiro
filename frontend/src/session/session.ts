import {
  checkResponse,
  loginRequest,
  loginResponse,
} from "@/contract/v1"

export const JWT_ALGORITHM = 'ES256' as const

export const APP_CONTEXTS = {
  cliente: 'cliente',
  controlPlane: 'control-plane',
} as const

export type AppContext = (typeof APP_CONTEXTS)[keyof typeof APP_CONTEXTS]

export interface AppIdentity {
  context: AppContext
  issuer: string
  audience: string
}

/** Identidade pública esperada no access token; valores vêm do ambiente. */
export const CLIENTE_APP_IDENTITY: AppIdentity = {
  context: APP_CONTEXTS.cliente,
  issuer: (import.meta.env.VITE_CLIENTE_JWT_ISSUER as string | undefined) ?? 'atlas-cliente',
  audience: (import.meta.env.VITE_CLIENTE_JWT_AUDIENCE as string | undefined) ?? 'atlas-cliente-api',
}

const API_BASE =
  (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ??
  (import.meta.env.DEV ? 'http://localhost:3001' : '')

/** Únicas rotas de auth do contrato v1 (ADR-001 §3). */
export const AUTH_ROUTES = {
  login: `${API_BASE}/auth/login`,
  refresh: `${API_BASE}/auth/refresh`,
  check: `${API_BASE}/auth/check`,
} as const

interface MemorySession {
  access: string
  refresh: string | null
}

// Estado de módulo: volta vazio a cada reload. Nenhuma persistência.
let memory: MemorySession | null = null

export function setSession(access: string, refresh: string | null = null): void {
  memory = { access, refresh }
}

export function currentSession(): Readonly<MemorySession> | null {
  return memory
}

export function authorizationHeader(): string | null {
  return memory ? `Bearer ${memory.access}` : null
}

export function clearSession(): void {
  memory = null
}

export type UnauthorizedResult = 'login-required'

// 401 do mesmo app: sem persistência → limpar memória e exigir login.
export function onUnauthorized(): UnauthorizedResult {
  clearSession()
  return 'login-required'
}

// 403 = RBAC negado: nenhuma tentativa de renovação.
export function onForbidden(): void {
  return
}

export type LoginResult =
  | { ok: true }
  | {
      ok: false
      status: number | null
      reason: 'invalid-credentials' | 'too-many-attempts' | 'network-error'
    }

export type CheckResult =
  | { ok: true; role: string }
  | { ok: false; reason: 'login-required' | 'network-error' }

/** Login no contrato v1: tokens voltam e ficam só na variável de módulo. */
export async function login(email: string, password: string): Promise<LoginResult> {
  const request = loginRequest.safeParse({ email, password })
  if (!request.success) return { ok: false, status: 400, reason: 'invalid-credentials' }

  try {
    const response = await fetch(AUTH_ROUTES.login, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      body: JSON.stringify(request.data),
    })

    if (response.status === 429) return { ok: false, status: 429, reason: 'too-many-attempts' }
    if (response.status === 400 || response.status === 401) {
      onUnauthorized()
      return { ok: false, status: response.status, reason: 'invalid-credentials' }
    }
    if (!response.ok) return { ok: false, status: response.status, reason: 'network-error' }

    const parsed = loginResponse.safeParse(await response.json())
    if (
      !parsed.success ||
      !tokenMatchesApp(parsed.data.data.accessToken, CLIENTE_APP_IDENTITY)
    ) {
      clearSession()
      return { ok: false, status: response.status, reason: 'invalid-credentials' }
    }
    setSession(parsed.data.data.accessToken, parsed.data.data.refreshToken)
    return { ok: true }
  } catch {
    return { ok: false, status: null, reason: 'network-error' }
  }
}

/**
 * `GET /auth/check` com o access em memória. 401 limpa tudo; 403 significa
 * AuthGuard aprovado e RolesGuard negado nesta rota — sem refresh e sem logout.
 */
export async function refreshCheck(): Promise<CheckResult> {
  const session = memory
  if (!session) return { ok: false, reason: 'login-required' }

  try {
    const response = await fetch(AUTH_ROUTES.check, {
      method: 'GET',
      headers: { Authorization: `Bearer ${session.access}` },
      credentials: 'omit',
    })

    if (response.status === 401) {
      onUnauthorized()
      return { ok: false, reason: 'login-required' }
    }
    if (response.status === 403) {
      onForbidden()
      if (!tokenMatchesApp(session.access, CLIENTE_APP_IDENTITY)) {
        onUnauthorized()
        return { ok: false, reason: 'login-required' }
      }
      const role = decodeClaims(session.access)?.role
      return { ok: true, role: typeof role === 'string' ? role : '' }
    }
    if (!response.ok) return { ok: false, reason: 'network-error' }

    const parsed = checkResponse.safeParse(await response.json())
    if (!parsed.success || !tokenMatchesApp(session.access, CLIENTE_APP_IDENTITY)) {
      onUnauthorized()
      return { ok: false, reason: 'login-required' }
    }
    return { ok: true, role: parsed.data.role }
  } catch {
    return { ok: false, reason: 'network-error' }
  }
}

function decodePart(part: string): unknown {
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (part.length % 4)) % 4)
    return JSON.parse(atob(padded)) as unknown
  } catch {
    return null
  }
}

export function decodeClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  const claims = decodePart(parts[1]!)
  return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null
}

function tokenAlgorithm(token: string): unknown {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[0]) return null
  const header = decodePart(parts[0]!)
  return header && typeof header === 'object' ? (header as Record<string, unknown>).alg : null
}

// Compara iss/aud/context com a identidade do app da tela. A verificação
// criptográfica permanece no app Nest que emitiu o token.
export function tokenMatchesApp(token: string, expected: AppIdentity): boolean {
  if (tokenAlgorithm(token) !== JWT_ALGORITHM) return false
  const claims = decodeClaims(token)
  if (!claims) return false
  return (
    claims.iss === expected.issuer &&
    claims.aud === expected.audience &&
    claims.context === expected.context
  )
}
