// Pipeline puro da Edge `signup-public` — ADR-001 / SIGN-02..04, SIGN-12..13.
// Sem import remoto, sem env, sem I/O: index.ts injeta os clientes e este
// módulo só decide. Ordem congelada:
//   throttle → validar body → resolver convite → signUp(anon) → RPC
//   (service_role) → compensação → resposta genérica.
// O gate CORS vive em index.ts (antes do pipeline); `allowedOrigin` aqui é
// puro para teste offline.

export const CONTRACT_VERSION = 'termos-2026-11-v1'
export const IN_SIGNUP_WINDOW_MS = 60_000
export const IN_SIGNUP_MAX_PER_IP = 10
export const PASSWORD_MIN_BYTES = 8
export const PASSWORD_MAX_BYTES = 72

export const AUDIT_THROTTLED = 'signup-public-throttled'
export const AUDIT_COMPENSATED = 'signup-public-compensated'

// Chave i18n genérica: a MESMA para conta nova, e-mail duplicado e colisão
// de documento (D8/🟡-1 — nenhum oráculo de estado, CWE-204).
export const OK_BODY = { ok: true, message: 'auth.signup.success' } as const
export const INVALID_BODY = { error: 'cadastro-invalido' } as const
export const RATE_BODY = { error: 'muitas-tentativas' } as const
export const FAILURE_BODY = { error: 'cadastro-falhou' } as const

export type SignupAuditEvent = typeof AUDIT_THROTTLED | typeof AUDIT_COMPENSATED
export type HeaderReader = (name: string) => string | null

export interface SignupContext {
  requestId: string
  route: string
  header: HeaderReader
  appUrl: string
}

export interface SignupInput {
  email: string
  password: string
  redirectTo: string
}

export interface SignupPayload {
  email: string
  password: string
  kind: 'pf' | 'pj'
  document: string
  razaoSocial: string
  nomeFantasia: string | null
  phone: string | null
  cep: string | null
  logradouro: string | null
  numero: string | null
  complemento: string | null
  bairro: string | null
  cidade: string | null
  uf: string | null
  plano: string | null
}

export interface ProvisionArgs {
  requestId: string
  ownerUserId: string
  kind: 'pf' | 'pj'
  document: string
  razaoSocial: string
  nomeFantasia: string | null
  phone: string | null
  cep: string | null
  logradouro: string | null
  numero: string | null
  complemento: string | null
  bairro: string | null
  cidade: string | null
  uf: string | null
  contractVersion: string
}

export interface SignupDeps {
  now: () => number
  throttleState: Map<string, number[]>
  resolveInvitedUser: (email: string) => Promise<{ userId: string | null; error?: unknown }>
  signUp: (input: SignupInput) => Promise<{ userId: string | null; error?: unknown }>
  provision: (args: ProvisionArgs) => Promise<{ tenantId?: string | null; error?: unknown }>
  recordAudit: (event: SignupAuditEvent, userId?: string | null) => Promise<{ error?: unknown }>
  deleteUser: (userId: string) => Promise<{ error?: unknown }>
  orphanAlert: (requestId: string) => void
}

export interface EdgeResult {
  status: number
  body: unknown
  headers?: Record<string, string>
}

// ============================================================================
// CORS fail-closed / IP / chaves / log (puros)
// ============================================================================

export function parseAllowedOrigins(appUrl: string, aliasesRaw: string): string[] {
  const out: string[] = []
  const push = (value: string): void => {
    const v = value.trim()
    if (v === '' || v === '*' || v.toLowerCase() === 'null' || out.includes(v)) return
    out.push(v)
  }
  push(appUrl)
  for (const alias of aliasesRaw.split(',')) push(alias)
  return out
}

export function allowedOrigin(
  origin: string | null,
  appUrl: string,
  aliasesRaw: string,
): string | null {
  if (origin === null || origin === '') return null
  const allow = parseAllowedOrigins(appUrl, aliasesRaw)
  return allow.includes(origin) ? origin : null
}

export function clientIp(header: HeaderReader): string {
  const forwarded = header('x-forwarded-for')
  const first = forwarded?.split(',')[0]?.trim()
  if (first) return first
  return header('x-real-ip')?.trim() || 'unknown'
}

export function clientKeys(env: { anonKey: string; serviceKey: string }): {
  signupKey: string
  privilegedKey: string
} {
  return { signupKey: env.anonKey, privilegedKey: env.serviceKey }
}

// GoTrue devolve um usuário SANITIZADO (fake) para e-mail já confirmado/
// duplicado: `data.user` existe, mas `identities` é []. Esse id pertence a
// terceiro e NUNCA deve provisionar nem sofrer deleteUser. Fonte:
// https://supabase.com/docs/reference/javascript/auth-signup (2026-11-21) e
// https://github.com/supabase/auth-js/issues/513 (2026-11-21).
export function realSignUpUserId(data: { user?: unknown } | null | undefined): string | null {
  const user = data?.user
  if (user === null || typeof user !== 'object') return null
  const candidate = user as { id?: unknown; identities?: unknown }
  if (typeof candidate.id !== 'string' || candidate.id === '') return null
  if (!Array.isArray(candidate.identities) || candidate.identities.length === 0) return null
  return candidate.id
}

export function tracePayload(requestId: string, route: string, ok: boolean): {
  request_id: string
  route: string
  ok: boolean
} {
  return { request_id: requestId, route, ok }
}

// ============================================================================
// Throttle in-memory por isolate (10/min por IP)
// ============================================================================

export function throttleSlot(
  state: Map<string, number[]>,
  ip: string,
  nowMs: number,
  windowMs: number = IN_SIGNUP_WINDOW_MS,
  maxHits: number = IN_SIGNUP_MAX_PER_IP,
): number {
  const windowStart = nowMs - windowMs
  const hits = (state.get(ip) ?? []).filter((t) => t > windowStart)
  if (hits.length >= maxHits) {
    return Math.max(Math.ceil((hits[0] + windowMs - nowMs) / 1000), 1)
  }
  hits.push(nowMs)
  state.set(ip, hits)
  return 0
}

// ============================================================================
// Validação de entrada (server-side; nenhum id do cliente)
// ============================================================================

function optString(
  raw: Record<string, unknown>,
  key: string,
  maxLen: number,
): string | null {
  if (!(key in raw) || raw[key] === null || raw[key] === undefined) return null
  const value = raw[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > maxLen) return null
  return trimmed
}

function buildRedirect(appUrl: string, plano: string | null): string {
  const base = `${appUrl.replace(/\/$/, '')}/auth/confirm`
  return plano === null ? base : `${base}?plano=${encodeURIComponent(plano)}`
}

export function validateSignupPayload(payload: unknown): SignupPayload | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const raw = payload as Record<string, unknown>

  // Identidade nunca vem do cliente.
  if ('user_id' in raw || 'tenant_id' in raw) return null

  const email = typeof raw.email === 'string' ? raw.email.trim() : ''
  if (email.length === 0 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null

  if (typeof raw.password !== 'string') return null
  const passwordBytes = new TextEncoder().encode(raw.password).length
  if (passwordBytes < PASSWORD_MIN_BYTES || passwordBytes > PASSWORD_MAX_BYTES) return null

  if (raw.kind !== 'pf' && raw.kind !== 'pj') return null
  const document = typeof raw.document === 'string' ? raw.document.trim() : ''
  const digits = raw.kind === 'pf' ? 11 : 14
  if (document.length !== digits || !/^[0-9]+$/.test(document)) return null

  const razaoSocial = typeof raw.razaoSocial === 'string' ? raw.razaoSocial.trim() : ''
  if (razaoSocial.length < 1 || razaoSocial.length > 200) return null

  const phone = optString(raw, 'phone', 13)
  if (phone !== null && !/^[0-9]{10,13}$/.test(phone)) return null
  const cep = optString(raw, 'cep', 8)
  if (cep !== null && !/^[0-9]{8}$/.test(cep)) return null
  const uf = optString(raw, 'uf', 2)
  if (uf !== null && !/^[A-Z]{2}$/.test(uf.toUpperCase())) return null

  const plano = optString(raw, 'plano', 32)

  return {
    email,
    password: raw.password,
    kind: raw.kind,
    document,
    razaoSocial,
    nomeFantasia: optString(raw, 'nomeFantasia', 200),
    phone,
    cep,
    logradouro: optString(raw, 'logradouro', 120),
    numero: optString(raw, 'numero', 120),
    complemento: optString(raw, 'complemento', 120),
    bairro: optString(raw, 'bairro', 120),
    cidade: optString(raw, 'cidade', 120),
    uf: uf === null ? null : uf.toUpperCase(),
    plano,
  }
}

// ============================================================================
// Rótulos de banco (internos) — nunca vazam ao cliente
// ============================================================================

const KNOWN_DB_LABELS = [
  'tenant-document-duplicate',
  'signup-request-invalid',
  'signup-owner-invalid',
  'tenant-kind-invalid',
  'tenant-document-invalid',
  'tenant-data-invalid',
  'acceptance-version-invalid',
  'acceptance-duplicate',
  'signup-audit-event-invalid',
] as const

const CLIENT_INPUT_LABELS = new Set<string>([
  'signup-request-invalid', 'signup-owner-invalid', 'tenant-kind-invalid',
  'tenant-document-invalid', 'tenant-data-invalid',
  'acceptance-version-invalid', 'acceptance-duplicate',
])

function errorLabel(err: unknown): string {
  if (typeof err === 'string') return err
  if (err !== null && typeof err === 'object') {
    const obj = err as Record<string, unknown>
    const code = typeof obj.code === 'string' ? obj.code : ''
    const message = typeof obj.message === 'string' ? obj.message : ''
    for (const label of KNOWN_DB_LABELS) {
      if (message.includes(label) || code.includes(label)) return label
    }
    return code || message
  }
  return ''
}

// ============================================================================
// Pipeline
// ============================================================================

export async function handleSignup(
  payload: unknown,
  ctx: SignupContext,
  deps: SignupDeps,
): Promise<EdgeResult> {
  // 1) Throttle ANTES de qualquer leitura/escrita de identidade.
  const retryAfter = throttleSlot(deps.throttleState, clientIp(ctx.header), deps.now())
  if (retryAfter > 0) {
    // A auditoria é a única escrita permitida no caminho bloqueado.
    try { await deps.recordAudit(AUDIT_THROTTLED) } catch { /* falha fechada: 429 permanece */ }
    return {
      status: 429,
      body: RATE_BODY,
      headers: { 'Retry-After': String(retryAfter) },
    }
  }

  // 2) Validação server-side (400 é sempre o mesmo texto).
  const input = validateSignupPayload(payload)
  if (input === null) return { status: 400, body: INVALID_BODY }

  // 3) Convite pendente / e-mail já existente ⇒ 201 genérico, sem novo usuário.
  // `admin_resolve_invited_user` (service_role, 0080) corre AQUI, antes do
  // signUp: convite 0077–0080 segue paralelo e idempotente. Nunca 409 —
  // isso enumeraria e-mail (CWE-204). Se o convite já tem tenant com o mesmo
  // (owner, documento), a RPC de reuso (0104) devolve o tenant existente sem
  // duplicar membro owner; a borda nem chega a provisionar nesse caminho.
  let resolved: { userId: string | null; error?: unknown }
  try {
    resolved = await deps.resolveInvitedUser(input.email)
  } catch {
    return { status: 500, body: FAILURE_BODY }
  }
  if (resolved.error && !resolved.userId) {
    return { status: 500, body: FAILURE_BODY }
  }
  if (resolved.userId) return { status: 201, body: OK_BODY }

  // 4) Identidade na borda, com chave publicável; sem email_confirm.
  let created: { userId: string | null; error?: unknown }
  try {
    created = await deps.signUp({
      email: input.email,
      password: input.password,
      redirectTo: buildRedirect(ctx.appUrl, input.plano),
    })
  } catch {
    // Erro do GoTrue não vira 500 com detalhe nem delete de conta de terceiro:
    // sem userId confiável não há compensação segura.
    return { status: 201, body: OK_BODY }
  }
  if (created.error || !created.userId) return { status: 201, body: OK_BODY }
  const userId = created.userId

  // 5) Negócio em RPC única (service_role).
  let provisioned: { tenantId?: string | null; error?: unknown }
  try {
    provisioned = await deps.provision({
      requestId: ctx.requestId,
      ownerUserId: userId,
      kind: input.kind,
      document: input.document,
      razaoSocial: input.razaoSocial,
      nomeFantasia: input.nomeFantasia,
      phone: input.phone,
      cep: input.cep,
      logradouro: input.logradouro,
      numero: input.numero,
      complemento: input.complemento,
      bairro: input.bairro,
      cidade: input.cidade,
      uf: input.uf,
      contractVersion: CONTRACT_VERSION,
    })
  } catch (err) {
    provisioned = { error: err }
  }
  if (!provisioned.error && provisioned.tenantId) return { status: 201, body: OK_BODY }

  // 6) Compensação (fora da transação da RPC).
  const label = errorLabel(provisioned.error)
  let deleteError: unknown = null
  try {
    const del = await deps.deleteUser(userId)
    deleteError = del.error ?? null
  } catch (err) {
    deleteError = err
  }
  try {
    await deps.recordAudit(AUDIT_COMPENSATED, userId)
  } catch { /* a resposta permanece genérica */ }
  if (deleteError !== null) deps.orphanAlert(ctx.requestId)

  if (label === 'tenant-document-duplicate') {
    // 🟡-1: colisão entre donos diferentes é 201 GENÉRICO, byte-idêntico ao
    // sucesso; nenhum rótulo interno vaza.
    return { status: 201, body: OK_BODY }
  }
  if (CLIENT_INPUT_LABELS.has(label)) {
    return { status: 400, body: INVALID_BODY }
  }
  return { status: 500, body: FAILURE_BODY }
}
