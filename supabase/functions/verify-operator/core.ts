// Núcleo puro de `verify-operator` v2 — SEC-DEBT-49 (Edge de gate de operador).
// Sem import remoto: testável offline (`deno test` importa só este arquivo).
// A borda (index.ts) injeta deps reais (supabase-js + service_role);
// este módulo nunca conhece service_role nem Deno.env.
//
// Ordem canônica — espelha `public.is_super_admin()` do 0051 (linhas 86-124):
//   sem JWT / JWT inválido            → 401 { is_operator: false }
//   profile ausente / erro / timeout  → 403 { is_operator: false } (fail-closed)
//   must_change_password !== false    → 403 { is_operator: false, error: 'first-access' }
//   role <> 'super_admin'             → 403 { is_operator: false } (genérico;
//                                       'not-super-admin' fica só no código)
//   aal <> 'aal2'                     → 403 { is_operator: false, error: 'mfa-required' }
//   sem linha active em internal_operators
//                                     → 403 { is_operator: false, error: 'operator-inactive' }
//   tudo OK                           → 200 { is_operator: true, aal: 'aal2', user_id }
//
// `operator-inactive` é rótulo fixo do banco (0051:118-119) e já chega ao
// próprio usuário em toda RPC admin negada — escondê-lo na borda só criaria
// a mesma cegueira do Ef1 (`first-access` invisível: cliente sem saber o que
// fazer), sem ganho de sigilo. Já `not-super-admin` continua interno: revelar
// a role de quem chamou é informação de outro dono (profiles), não do gate.
//
// Deadline é TOTAL (default 5000 ms, somando todas as etapas) — não por
// operação: três etapas de 2 s não podem compor 6 s. Estourou = 403, nunca 200.
// Origin desconhecida → 403 sem ACAO (fail-closed, nunca `*`). Origens
// confiáveis = APP_URL + APP_URL_ALIASES (cada uma aceita lista separada por
// vírgula); comparação exata, sem normalização e sem curinga.
// Sem PII: nenhum e-mail, nenhuma role, nenhum tenant — só is_operator/aal/
// error e, no 200, `user_id` (contrato herdado do ADR-004: é o id da própria
// sessão do chamador, usado como chave do cache client-side).

export interface VerifyDeps {
  /** Validação server-side do JWT (borda: auth.getUser). Nunca claim de client. */
  getUser: (jwt: string) => Promise<{ user: { id: string } | null; error: unknown | null }>
  /** `profiles(role, must_change_password)` do usuário do JWT (borda: service_role). */
  getProfile: (userId: string) => Promise<{ role?: unknown; must_change_password?: unknown } | null>
  /** Linha em internal_operators com active=true (borda: service_role). */
  isActiveOperator: (userId: string) => Promise<boolean>
  /** Origem principal permitida p/ CORS (borda: APP_URL). '' = nenhum CORS (fail-closed). */
  appUrl: string
  /** Origens extras separadas por vírgula (borda: APP_URL_ALIASES). Opcional. */
  appUrlAliases?: string
  /** Orçamento TOTAL da checagem em ms. Default 5000. Estourou = nega. */
  deadlineMs?: number
  /** @deprecated alias legado de `deadlineMs` (contrato v1); prefira `deadlineMs`. */
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
 * Espelha `private.is_aal2()` (0037): aal2 OU claim role='service_role'.
 * aal null/ausente = null = nega (nunca fail-open da UI `guards.tsx:37`).
 */
export function resolveAal(payload: JwtPayload | null): 'aal1' | 'aal2' | null {
  if (payload === null) return null
  if (payload.aal === 'aal2') return 'aal2'
  if (payload.role === 'service_role') return 'aal2'
  if (payload.aal === 'aal1') return 'aal1'
  return null
}

/**
 * Lista explícita de origens confiáveis. APP_URL (principal) e
 * APP_URL_ALIASES (extras) podem conter valores separados por vírgula.
 * Tokens vazios, `*` e `null` são descartados: nenhum curinga, nenhuma
 * normalização — a comparação posterior é exata (fail-closed).
 */
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

/** Devolve a própria Origin quando ela pertence à lista; senão null (sem ACAO). */
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

export async function handleVerifyOperator(req: Request, deps: VerifyDeps): Promise<Response> {
  const origin = req.headers.get('Origin')
  if (origin !== null && allowedOrigin(req, deps.appUrl, deps.appUrlAliases) === null) {
    return new Response(JSON.stringify({ is_operator: false }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', Vary: 'Origin' },
    })
  }
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(req, deps.appUrl, deps.appUrlAliases),
    })
  }
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: corsHeaders(req, deps.appUrl, deps.appUrlAliases),
    })
  const deny = (error?: 'first-access' | 'mfa-required' | 'operator-inactive'): Response =>
    json(403, error === undefined ? { is_operator: false } : { is_operator: false, error })

  if (req.method !== 'GET' && req.method !== 'POST') {
    return json(405, { is_operator: false })
  }

  const jwt = extractBearer(req)
  if (jwt === null) return json(401, { is_operator: false })

  // Orçamento total: cada etapa consome o que sobrou, nunca ganha um novo.
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
    if (res.error !== null || res.user === null) return json(401, { is_operator: false })
    user = res.user
  } catch {
    return deny()
  }

  // 1) first-access — a flag vem antes de role/aal/operador (0051:110-112).
  let profile: { role?: unknown; must_change_password?: unknown } | null
  try {
    profile = await step(deps.getProfile(user.id))
  } catch {
    return deny()
  }
  if (profile === null) return deny()
  if (profile.must_change_password !== false) return deny('first-access')

  // 2) role — 'not-super-admin' fica interno (não vaza role ao cliente).
  if (profile.role !== 'super_admin') return deny()

  // 3) aal2 — claim do JWT já validado por auth.getUser.
  if (resolveAal(decodeJwtPayload(jwt)) !== 'aal2') return deny('mfa-required')

  // 4) operador ativo — `internal_operators` nunca sozinho (Ef2).
  let active: boolean
  try {
    active = await step(deps.isActiveOperator(user.id))
  } catch {
    return deny()
  }
  if (!active) return deny('operator-inactive')

  return json(200, { is_operator: true, aal: 'aal2', user_id: user.id })
}
