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

// 401 do mesmo app: sem endpoint nesta fatia → limpar memória e exigir login.
export function onUnauthorized(): UnauthorizedResult {
  clearSession()
  return 'login-required'
}

// 403 = RBAC negado: nenhuma tentativa de renovação.
export function onForbidden(): void {
  return
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
