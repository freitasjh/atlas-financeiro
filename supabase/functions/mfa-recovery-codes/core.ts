// Núcleo puro de `mfa-recovery-codes` — ADR-001 / EDGE-01.
// Sem import remoto: testável offline (`deno test --allow-env --no-remote`
// e `npm run test:edge`). A borda (index.ts) injeta deps reais; aqui não há
// Deno.env, service_role nem cliente Supabase.
//
// Rotas (ADR §3.2 — consumo NÃO passa pela Edge):
//   POST /generate            → 200 { set_id, codes:[10] }
//   GET  /status              → 200 { total, remaining, low, codes:[{id,used_at}] }
//   POST /regenerate          → 200 { set_id, codes:[10] }
//   (prefixo do gateway /functions/v1/mfa-recovery-codes/... é aceito)
//
// Gate (R2 🔴): ordem canônica do 0051, espelhando verify-operator/core.ts —
// A identidade vem de `getUser(jwt)` com o JWT DO CHAMADOR; service_role só lê
// profiles/internal_operators e chama as RPCs. NUNCA usar service_role como
// prova de operador. Erro/timeout = nega (fail-closed), 0 chamada RPC.
//   sem JWT / inválido → 401 · perfil/gate inválido → 403
//   (first-access → role → mfa-required → operator-inactive)
//   conflito/confirmação → 409 · erro técnico → 500
//
// CORS: APP_URL + APP_URL_ALIASES, comparação exata, sem curinga. Origin
// desconhecida ⇒ 403 sem ACAO (fail-closed); sem Origin (curl/gateway)
// segue para o gate. Deadline é TOTAL (default 5000 ms), nunca por etapa.
//
// Plaintext de códigos SÓ no 200 de generate/regenerate. Nenhum log,
// nenhum campo extra (code_hash/message) atravessa esta borda.

export const CONFIRMATION_TOKEN = 'REVOGAR_CODIGOS_ATUAIS'

const GENERIC_DENY = 'mfa-recovery-forbidden'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE_PATTERN = /^[a-z2-7]{24}$/

export type Route = 'generate' | 'status' | 'regenerate'
export type RpcResult = unknown

export interface GateDeps {
  /** auth.getUser(jwt) no servidor, com o JWT do chamador (nunca claim de client). */
  getUser: (jwt: string) => Promise<{ user: { id: string } | null; error: unknown | null }>
  /** profiles(role, must_change_password) do id DEVOLVIDO por getUser. */
  getProfile: (userId: string) => Promise<{ role?: unknown; must_change_password?: unknown } | null>
  /** internal_operators(active) do id DEVOLVIDO por getUser. */
  isActiveOperator: (userId: string) => Promise<boolean>
}

export interface RpcDeps {
  generate: (userId: string) => Promise<RpcResult>
  status: (userId: string) => Promise<RpcResult>
  regenerate: (userId: string, confirmation: string) => Promise<RpcResult>
}

export interface RecoveryDeps extends GateDeps, RpcDeps {
  appUrl: string
  appUrlAliases?: string
  deadlineMs?: number
  /** @deprecated alias legado de deadlineMs; prefira deadlineMs. */
  timeoutMs?: number
}

export interface JwtPayload {
  aal?: unknown
  role?: unknown
  sub?: unknown
}

export function extractBearer(req: Request): string | null {
  const authorization = req.headers.get('Authorization')
  if (authorization === null) return null
  if (!authorization.startsWith('Bearer ')) return null
  const jwt = authorization.slice(7).trim()
  return jwt === '' ? null : jwt
}

export function decodeJwtPayload(jwt: string): JwtPayload | null {
  const parts = jwt.split('.')
  if (parts.length !== 3) return null
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4
    if (pad > 0) b64 += '='.repeat(4 - pad)
    const parsed = JSON.parse(atob(b64)) as unknown
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as JwtPayload
  } catch {
    return null
  }
}

/**
 * AAL vem SÓ do claim `aal` do JWT do chamador (gate R2 🔴). Sem atalho
 * `role='service_role'`: service_role é credencial de servidor usada nas RPCs,
 * nunca prova de MFA do usuário. Qualquer outro valor (ou ausência) = null.
 */
export function resolveAal(payload: JwtPayload | null): 'aal1' | 'aal2' | null {
  if (payload === null) return null
  if (payload.aal === 'aal2') return 'aal2'
  if (payload.aal === 'aal1') return 'aal1'
  return null
}

/** Último segmento do path: aceita `/generate` e `/functions/v1/<fn>/generate`. */
export function parseRoute(pathname: string): Route | null {
  const segments = pathname.split('/').filter((s) => s !== '')
  const last = segments[segments.length - 1]
  if (last === 'generate' || last === 'status' || last === 'regenerate') return last
  return null
}

/** Origens explícitas. APP_URL + APP_URL_ALIASES, split ',', sem curinga. */
export function parseAllowedOrigins(appUrl: string, aliases = ''): string[] {
  const allowed: string[] = []
  for (const raw of [appUrl, aliases]) {
    for (const token of raw.split(',')) {
      const value = token.trim()
      if (value === '' || value === '*' || value.toLowerCase() === 'null') continue
      if (!allowed.includes(value)) allowed.push(value)
    }
  }
  return allowed
}

export function allowedOrigin(req: Request, appUrl: string, aliases = ''): string | null {
  const allowed = parseAllowedOrigins(appUrl, aliases)
  if (allowed.length === 0) return null
  const origin = req.headers.get('Origin')
  if (origin === null) return null
  return allowed.includes(origin) ? origin : null
}

export function corsHeaders(req: Request, appUrl: string, aliases = ''): HeadersInit {
  const allow = allowedOrigin(req, appUrl, aliases)
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json',
    Vary: 'Origin',
  }
  if (allow !== null) headers['Access-Control-Allow-Origin'] = allow
  return headers
}

export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('operation-timeout')), Math.max(0, ms))
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isCode(value: unknown): value is string {
  return typeof value === 'string' && CODE_PATTERN.test(value)
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const payload: unknown = await req.json()
    return isRecord(payload) ? payload : null
  } catch {
    return null
  }
}

/** Rótulos congelados da ADR §3.5 que esta borda pode traduzir em HTTP. */
function mapRpcError(error: unknown): { status: number; error: string } | null {
  if (typeof error !== 'string') return null
  switch (error) {
    case 'mfa-recovery-active-set-conflict':
    case 'mfa-recovery-confirmation-required':
    case 'mfa-recovery-no-active-set':
      return { status: 409, error }
    case 'mfa-recovery-forbidden':
    case 'mfa-recovery-not-enrolled':
      return { status: 403, error }
    default:
      return null
  }
}

/** Whitelist do retorno de status: jamais deixa code_hash/campo extra sair. */
function parseStatus(result: Record<string, unknown>): Record<string, unknown> | null {
  if (result.total !== 10) return null
  const remaining = result.remaining
  if (
    typeof remaining !== 'number' || !Number.isInteger(remaining) ||
    remaining < 0 || remaining > 10
  ) return null
  if (!Array.isArray(result.codes) || result.codes.length !== 10) return null
  const codes: { id: string; used_at: string | null }[] = []
  for (const raw of result.codes) {
    if (!isRecord(raw) || !isUuid(raw.id)) return null
    if (raw.used_at !== null && typeof raw.used_at !== 'string') return null
    codes.push({ id: raw.id, used_at: raw.used_at as string | null })
  }
  return { total: 10, remaining, low: remaining <= 2, codes }
}

/** Whitelist de generate/regenerate: 10 códigos base32/24 + set_id uuid. */
function parseCodes(result: Record<string, unknown>): Record<string, unknown> | null {
  if (!isUuid(result.set_id)) return null
  if (!Array.isArray(result.codes) || result.codes.length !== 10) return null
  for (const code of result.codes) if (!isCode(code)) return null
  return { set_id: result.set_id, codes: [...result.codes] as string[] }
}

export async function handleRecoveryCodes(req: Request, deps: RecoveryDeps): Promise<Response> {
  // 1) CORS fail-closed antes de qualquer gate/RPC.
  const origin = req.headers.get('Origin')
  if (origin !== null && allowedOrigin(req, deps.appUrl, deps.appUrlAliases) === null) {
    return new Response(JSON.stringify({ error: GENERIC_DENY }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', Vary: 'Origin' },
    })
  }
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req, deps.appUrl, deps.appUrlAliases) })
  }

  const json = (status: number, body: Record<string, unknown>): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: corsHeaders(req, deps.appUrl, deps.appUrlAliases),
    })
  const fail = (status: number, error: string = GENERIC_DENY): Response => json(status, { error })

  // 2) Rota × método — `/consume` NÃO existe aqui (browser chama a RPC).
  const route = parseRoute(new URL(req.url).pathname)
  if (route === null) return fail(404)
  if (req.method !== (route === 'status' ? 'GET' : 'POST')) return fail(405)

  // 3) Sessão — JWT do chamador é a única prova de identidade.
  const jwt = extractBearer(req)
  if (jwt === null) return fail(401)

  const startedAt = Date.now()
  const deadlineMs = deps.deadlineMs ?? deps.timeoutMs ?? 5000
  const remaining = (): number => deadlineMs - (Date.now() - startedAt)
  const step = <T>(p: Promise<T>): Promise<T> => {
    const left = remaining()
    if (left <= 0) return Promise.reject(new Error('deadline-exceeded'))
    return withTimeout(p, left)
  }

  let user: { id: string }
  try {
    const res = await step(deps.getUser(jwt))
    if (res.error !== null || res.user === null) return fail(401)
    user = res.user
  } catch {
    return fail(403)
  }

  // 4) Gate — ordem canônica 0051 (first-access → role → aal2 → operador).
  let profile: { role?: unknown; must_change_password?: unknown } | null
  try {
    profile = await step(deps.getProfile(user.id))
  } catch {
    return fail(403)
  }
  if (profile === null) return fail(403)
  if (profile.must_change_password !== false) return fail(403, 'first-access')
  if (profile.role !== 'super_admin') return fail(403)
  if (resolveAal(decodeJwtPayload(jwt)) !== 'aal2') return fail(403, 'mfa-required')
  let active: boolean
  try {
    active = await step(deps.isActiveOperator(user.id))
  } catch {
    return fail(403)
  }
  if (!active) return fail(403, 'operator-inactive')

  // 5) Confirmação textual ANTES da RPC — divergência ⇒ 0 escrita no banco.
  let confirmation: string | null = null
  if (route === 'regenerate') {
    const payload = await readJson(req)
    if (payload === null || payload.confirmation !== CONFIRMATION_TOKEN) {
      return fail(409, 'mfa-recovery-confirmation-required')
    }
    confirmation = CONFIRMATION_TOKEN
  }

  // 6) RPCs com service_role — p_user_id SEMPRE do JWT validado (R2).
  let result: RpcResult
  try {
    if (route === 'generate') result = await step(deps.generate(user.id))
    else if (route === 'status') result = await step(deps.status(user.id))
    else result = await step(deps.regenerate(user.id, confirmation as string))
  } catch {
    return fail(500)
  }

  // 7) Tradução de rótulos congelados + whitelist de payload. Nenhum campo
  //    extra da RPC (message, code_hash, code) atravessa a borda.
  const record: Record<string, unknown> | null = isRecord(result) ? result : null
  if (record === null) return fail(500)
  if (record.ok === false || typeof record.error === 'string') {
    const mapped = mapRpcError(record.error)
    return mapped === null ? fail(500) : fail(mapped.status, mapped.error)
  }
  const parsed = route === 'status' ? parseStatus(record) : parseCodes(record)
  return parsed === null ? fail(500) : json(200, parsed)
}
