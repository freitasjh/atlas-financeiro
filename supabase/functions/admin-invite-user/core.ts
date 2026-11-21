// Gate de operador para `admin-invite-user` — internal-admin L1 / T03.
// Núcleo puro (sem import remoto): testável offline (`deno test`).
// Corrige o stale pós-0035: `profiles.role='admin'` nunca casa (CHECK só
// aceita user/super_admin), então o gate antigo negava todo convite.
// Gate novo: JWT válido via auth.getUser + linha internal_operators(active=true)
// + aal2 (espelho de private.is_aal2()). Qualquer erro/timeout = nega.
// A borda (index.ts) injeta deps reais (supabase-js + service_role).

export interface OperatorDeps {
  getUser: (jwt: string) => Promise<{ user: { id: string } | null; error: unknown | null }>
  isActiveOperator: (userId: string) => Promise<boolean>
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
 * Mesmo contrato de `verify-operator/core.ts` (SEC-DEBT-49).
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

export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('operation-timeout')), ms)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function isCallerOperator(req: Request, deps: OperatorDeps): Promise<boolean> {
  const jwt = extractBearer(req)
  if (jwt === null) return false
  const timeoutMs = deps.timeoutMs ?? 5000
  let user: { id: string }
  try {
    const res = await withTimeout(deps.getUser(jwt), timeoutMs)
    if (res.error !== null || res.user === null) return false
    user = res.user
  } catch {
    return false
  }
  const payload = decodeJwtPayload(jwt)
  let active: boolean
  try {
    active = await withTimeout(deps.isActiveOperator(user.id), timeoutMs)
  } catch {
    return false
  }
  if (!active) return false
  return resolveAal(payload) === 'aal2'
}

// ============================================================================
// Contrato v3 da borda (SPEC §4.1, PLAN §3 P9) — pipeline puro, sem rede.
// `index.ts` injeta os clientes reais (`service_role` para Auth/resolução,
// JWT do chamador para cota/trilha/cancelamento); aqui só a ordem obrigatória.
// ============================================================================

export interface EdgeResult {
  status: number
  body: Record<string, unknown>
  headers?: Record<string, string>
}

export interface InviteEdgeDeps {
  resolveInvitedUser: (email: string) => Promise<{ userId: string | null; error: unknown | null }>
  inviteQuota: () => Promise<{ remaining: number | null; error: unknown | null }>
  inviteUser: (email: string) => Promise<{ userId: string | null; error: unknown | null }>
  recordInvite: (userId: string) => Promise<{ error: unknown | null }>
  cancelInvite: (userId: string) => Promise<{ canceled: boolean | null; error: unknown | null }>
  deleteUser: (userId: string) => Promise<{ error: unknown | null }>
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const FAILURE = { error: 'invite-failed' } as const
const RATE_LIMITED = { error: 'invite-rate-limited' } as const

// Piso conservador: a janela de cota (1 h) vive no banco e a borda não sabe
// o instante exato de liberação — anunciar 60 s nunca mente sobre a janela.
export const INVITE_RETRY_AFTER_SECONDS = 60

export function isValidInviteEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && EMAIL_PATTERN.test(value)
}

export function isValidUserId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

// `auth.admin.deleteUser` de usuário ausente ⇒ 200 idempotente (REQ-10).
export function isUserNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown }
  if (candidate.status === 404) return true
  if (candidate.code === 'user_not_found') return true
  return typeof candidate.message === 'string' && /not\s*found/i.test(candidate.message)
}

function fail(status: number): EdgeResult {
  return { status, body: { ...FAILURE } }
}

export async function handleInvite(email: unknown, deps: InviteEdgeDeps): Promise<EdgeResult> {
  // Passo 4 — valida e-mail (o id nunca vem do cliente: payload só tem email).
  if (!isValidInviteEmail(email)) return fail(400)

  // Passo 5 — resolução server-side (service_role). Falha ⇒ 500, sem detalhe.
  let existingUserId: string | null
  try {
    const resolved = await deps.resolveInvitedUser(email)
    if (resolved.error !== null) return fail(500)
    existingUserId = resolved.userId
  } catch {
    return fail(500)
  }

  // Passos 6/7 — cota do operador (JWT do chamador): esgotada ⇒ 429.
  try {
    const quota = await deps.inviteQuota()
    if (quota.error !== null || quota.remaining === null) return fail(500)
    if (quota.remaining <= 0) {
      return {
        status: 429,
        body: { ...RATE_LIMITED },
        headers: { 'Retry-After': String(INVITE_RETRY_AFTER_SECONDS) },
      }
    }
  } catch {
    return fail(500)
  }

  // Passo 8 — só convida quando o e-mail ainda não resolve; falha do
  // provedor de Auth ⇒ 502 (rótulo distinto de erro interno).
  let userId: string
  let created: boolean
  if (existingUserId !== null) {
    userId = existingUserId
    created = false
  } else {
    created = true
    try {
      const invited = await deps.inviteUser(email)
      if (invited.error !== null || invited.userId === null) return fail(502)
      userId = invited.userId
    } catch {
      return fail(502)
    }
  }

  // Passo 9 — trilha do convite (idempotente 60 min no banco). Falhou com
  // usuário recém-criado ⇒ compensa o órfão (nunca apaga usuário pré-existente).
  try {
    const recorded = await deps.recordInvite(userId)
    if (recorded.error !== null) {
      if (created) {
        try {
          await deps.deleteUser(userId)
        } catch {
          // Compensação best-effort: a resposta já é fail-closed.
        }
      }
      return fail(500)
    }
  } catch {
    if (created) {
      try {
        await deps.deleteUser(userId)
      } catch {
        // idem
      }
    }
    return fail(500)
  }

  // Passo 10 — `state` distingue convite novo de retry idempotente.
  return { status: 200, body: { user_id: userId, state: created ? 'invited' : 'existing' } }
}

export async function handleDelete(userId: unknown, deps: InviteEdgeDeps): Promise<EdgeResult> {
  if (!isValidUserId(userId)) return fail(400)

  // RPC primeiro (REQ-10): sem cancelamento AUTORIZADO o DELETE nunca chega ao
  // Auth. `admin_cancel_invite` recusa com `invite-not-pending` quando o alvo
  // tem qualquer vínculo (`tenants.owner_user_id` ou qualquer `tenant_members`,
  // 0081) e devolve `false` quando não há convite pendente. Nos dois casos a
  // borda falha fechada: apagar a conta de um membro apagaria o vínculo por
  // cascade (`profiles -> tenant_members`) sem trilha.
  let canceled: boolean
  try {
    const result = await deps.cancelInvite(userId)
    if (result.error !== null) return fail(500)
    canceled = result.canceled === true
  } catch {
    return fail(500)
  }
  if (!canceled) return fail(500)

  // `auth.admin.deleteUser` de usuário ausente ⇒ 200 idempotente (REQ-10).
  try {
    const removed = await deps.deleteUser(userId)
    if (removed.error !== null && !isUserNotFoundError(removed.error)) return fail(500)
  } catch {
    return fail(500)
  }

  return { status: 200, body: { ok: true } }
}
