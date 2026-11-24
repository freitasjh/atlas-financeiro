/**
 * Data client do control plane — porta única para o banco (SPEC §9, REQ-26..29).
 *
 * É o **único** importador de `@/lib/supabase` em `src/internal/**` (gate G-02).
 * Leituras e escritas passam por allowlist fechada; toda escrita revalida o
 * veredito de operador antes de tocar a RPC.
 */

import { supabase } from "@/lib/supabase"
import { gateStateFromLabel, type OperatorGateDecision } from "@/internal/guard/operator-gate"
import { useInternalOperator } from "@/internal/guard/use-internal-operator"
import { normalizeRecoveryCode, type RecoveryConsumeOutcome } from "./mfa-recovery-codes"

export { normalizeRecoveryCode }

export const INTERNAL_READ_RPCS = [
  "admin_list_tenants",
  "admin_count_tenants",
  "admin_get_tenant",
  "admin_list_members",
  "list_admin_audit_page",
  "admin_get_tenant_billing",
  "get_tenant_usage",
  "admin_list_tenant_switches",
  "admin_usage_series",
  "admin_mrr_summary",
  "admin_list_pending_invites",
  "admin_tenant_onboarding_state",
  "admin_invite_quota",
] as const

export const INTERNAL_WRITE_RPCS = [
  "admin_override_subscription",
  "admin_register_override",
  "admin_cancel_invite",
  "admin_repair_tenant_onboarding",
] as const

export type InternalReadRpc = (typeof INTERNAL_READ_RPCS)[number]
export type InternalWriteRpc = (typeof INTERNAL_WRITE_RPCS)[number]

export class InternalRpcNotAllowedError extends Error {
  readonly code = "internal-rpc-not-allowed"

  constructor(readonly rpcName: string) {
    super(`internal-rpc-not-allowed: ${rpcName}`)
    this.name = "InternalRpcNotAllowedError"
  }
}

export class InternalGateDeniedError extends Error {
  readonly code = "internal-gate-denied"

  constructor(readonly state: string) {
    super(`internal-gate-denied: ${state}`)
    this.name = "InternalGateDeniedError"
  }
}

interface RpcErrorLike {
  message?: unknown
  details?: unknown
  hint?: unknown
  code?: unknown
}

/**
 * Traduz rótulos de gate do banco (`0051`/`0037`/`0042`) para estados do guard.
 * Erro de negócio (ex.: `tenant-sort-invalid`) devolve `null` e mantém o estado.
 */
export function mapInternalGateError(error: unknown): OperatorGateDecision | null {
  if (typeof error === "string") return gateStateFromLabel(error)
  if (typeof error !== "object" || error === null) return null
  const record = error as RpcErrorLike
  for (const key of ["message", "details", "hint", "code"] as const) {
    const value = record[key]
    if (typeof value === "string") {
      const mapped = gateStateFromLabel(value)
      if (mapped !== null) return mapped
    }
  }
  return null
}

function assertAllowed(name: string, allowlist: readonly string[]): void {
  if (!allowlist.includes(name)) throw new InternalRpcNotAllowedError(name)
}

type RpcCaller = (
  fn: string,
  params?: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>

/** Só a superfície `rpc` é usada; o objeto existe para preservar o `this`. */
interface RpcClient {
  rpc: RpcCaller
}

async function callRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  // Chamada **no objeto**: destacar o método (`const rpc = supabase.rpc`) perde
  // o `this` e o cliente lança `TypeError` antes de qualquer fetch (H3 P0).
  const client = supabase as unknown as RpcClient
  const { data, error } = await client.rpc(name, args)
  if (error !== null && error !== undefined) {
    const mapped = mapInternalGateError(error)
    if (mapped !== null) {
      useInternalOperator.getState().invalidate(mapped)
      throw new InternalGateDeniedError(mapped)
    }
    throw error instanceof Error ? error : new Error("internal-rpc-failed")
  }
  return data
}

export async function readInternalRpc<T = unknown>(
  name: InternalReadRpc,
  args: Record<string, unknown> = {},
): Promise<T> {
  assertAllowed(name, INTERNAL_READ_RPCS)
  return (await callRpc(name, args)) as T
}

export async function writeInternalRpc<T = unknown>(
  name: InternalWriteRpc,
  args: Record<string, unknown> = {},
): Promise<T> {
  assertAllowed(name, INTERNAL_WRITE_RPCS)
  const allowed = await useInternalOperator.getState().requireOperator({ force: true })
  if (!allowed) {
    throw new InternalGateDeniedError(useInternalOperator.getState().state)
  }
  return (await callRpc(name, args)) as T
}

// ============ 2. Sessão e auth do operador (GoTrue) ============
// Fica neste arquivo porque ele é o **único** importador de `@/lib/supabase`
// em `src/internal/**` (REQ-26). Nenhuma leitura de tabela acontece aqui.

export interface InternalSessionSnapshot {
  userId: string | null
  aalKey: "aal1" | "aal2" | null
}

/** `aal` vem do payload do JWT de sessão — só compõe a chave de cache (REQ-10). */
export function readAalFromAccessToken(token: string): "aal1" | "aal2" | null {
  const payload = token.split(".")[1]
  if (payload === undefined || payload.length === 0) return null
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/")
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
    const decoded = JSON.parse(atob(padded)) as { aal?: unknown }
    if (decoded.aal === "aal2") return "aal2"
    if (decoded.aal === "aal1") return "aal1"
    return null
  } catch {
    return null
  }
}

export async function readInternalSession(): Promise<InternalSessionSnapshot> {
  const { data } = await supabase.auth.getSession()
  const session = data.session
  if (session === null) return { userId: null, aalKey: null }
  return {
    userId: session.user.id,
    aalKey: readAalFromAccessToken(session.access_token),
  }
}

export async function getInternalAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

export async function signInInternalOperator(
  email: string,
  password: string,
): Promise<{ ok: boolean }> {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  return { ok: error === null }
}

export async function signOutInternalOperator(): Promise<void> {
  await supabase.auth.signOut()
}

/** Eventos de auth que mudam a chave de sessão e exigem novo veredito. */
const INTERNAL_AUTH_EVENTS: ReadonlySet<string> = new Set([
  "SIGNED_IN",
  "SIGNED_OUT",
  "TOKEN_REFRESHED",
  "USER_UPDATED",
])

/**
 * Assina `onAuthStateChange` e chama `onChange` nos eventos que mudam a sessão.
 * O chamador deve deferir o trabalho (fora do callback do Supabase) para não
 * disputar o lock interno do GoTrue.
 */
export function subscribeInternalAuthState(onChange: () => void): () => void {
  const { data } = supabase.auth.onAuthStateChange((event) => {
    if (INTERNAL_AUTH_EVENTS.has(event)) onChange()
  })
  return () => data.subscription.unsubscribe()
}

export interface InternalMfaFactor {
  id: string
  status: string
  friendlyName: string | null
}

export async function listInternalMfaFactors(): Promise<InternalMfaFactor[]> {
  const { data, error } = await supabase.auth.mfa.listFactors()
  if (error !== null) throw new Error("internal-mfa-list-failed")
  const totp = data?.totp ?? []
  return totp.map((factor) => ({
    id: factor.id,
    status: factor.status,
    friendlyName: factor.friendly_name ?? null,
  }))
}

/**
 * Nome determinístico do fator TOTP do control plane. GoTrue recusa enroll com
 * `friendly_name` vazio (422 `mfa_factor_name_conflict`), então o nome nunca é
 * omitido — ver regra `regras/projetos/mfa-enroll-idempotente`.
 */
export const INTERNAL_TOTP_FRIENDLY_NAME = "Atlas Internal" as const

export class InternalMfaEnrollConflictError extends Error {
  readonly code = "internal-mfa-enroll-conflict"

  constructor() {
    super("internal-mfa-enroll-conflict")
    this.name = "InternalMfaEnrollConflictError"
  }
}

export async function unenrollInternalMfaFactor(factorId: string): Promise<void> {
  const { error } = await supabase.auth.mfa.unenroll({ factorId })
  if (error !== null && error !== undefined) throw new Error("internal-mfa-unenroll-failed")
}

/**
 * Descarta apenas fatores TOTP `unverified`. Fator `verified` exige aal2 no
 * GoTrue e nunca deve ser removido por limpeza de bootstrap.
 */
export async function unenrollUnverifiedInternalTotpFactors(
  factors?: readonly InternalMfaFactor[],
): Promise<void> {
  const source = factors ?? (await listInternalMfaFactors())
  const pending = source.filter((factor) => factor.status === "unverified")
  // Best-effort: um DELETE recusado não impede tentar o enroll; conflito
  // residual é tratado com exatamente 1 retry em `enrollInternalTotp`.
  await Promise.all(
    pending.map(async (factor) => {
      try {
        await unenrollInternalMfaFactor(factor.id)
      } catch {
        // intencional: o enroll seguinte é a prova de que a limpeza bastou.
      }
    }),
  )
}

export interface InternalTotpEnrollment {
  factorId: string
  secret: string
  uri: string
}

interface FactorNameConflictLike {
  code?: unknown
  message?: unknown
}

function isFactorNameConflict(error: unknown): boolean {
  if (error instanceof InternalMfaEnrollConflictError) return true
  if (typeof error !== "object" || error === null) return false
  const record = error as FactorNameConflictLike
  if (record.code === "mfa_factor_name_conflict") return true
  return typeof record.message === "string" && record.message.includes("mfa_factor_name_conflict")
}

async function requestInternalTotpEnrollment(): Promise<InternalTotpEnrollment> {
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: INTERNAL_TOTP_FRIENDLY_NAME,
  })
  if (error !== null && error !== undefined) {
    if (isFactorNameConflict(error)) throw new InternalMfaEnrollConflictError()
    throw error instanceof Error ? error : new Error("internal-mfa-enroll-failed")
  }
  if (data === null || data === undefined) throw new Error("internal-mfa-enroll-failed")
  return { factorId: data.id, secret: data.totp.secret, uri: data.totp.uri }
}

async function runInternalTotpEnrollment(): Promise<InternalTotpEnrollment> {
  // GoTrue devolve `{ error }`; mocks/transport podem rejeitar. Ambos os
  // formatos passam pelo mesmo detector, com no máximo 2 tentativas.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt === 1) {
      // Fator criado entre o list do bootstrap e o POST: limpa e repete 1x.
      await unenrollUnverifiedInternalTotpFactors()
    }
    try {
      return await requestInternalTotpEnrollment()
    } catch (error) {
      if (!isFactorNameConflict(error)) throw error
    }
  }
  throw new InternalMfaEnrollConflictError()
}

let pendingInternalTotpEnrollment: Promise<InternalTotpEnrollment> | null = null

/**
 * Singleflight: StrictMode (e qualquer chamador concorrente) compartilha o
 * mesmo POST /factors. Promessa é liberada no settle, antes do `.catch` do
 * chamador, de modo que o retry explícito sempre cria uma nova tentativa.
 */
export function enrollInternalTotp(): Promise<InternalTotpEnrollment> {
  if (pendingInternalTotpEnrollment !== null) return pendingInternalTotpEnrollment
  const run = runInternalTotpEnrollment()
  pendingInternalTotpEnrollment = run
  const release = () => {
    if (pendingInternalTotpEnrollment === run) pendingInternalTotpEnrollment = null
  }
  run.then(release, release)
  return run
}

export async function challengeInternalMfa(factorId: string): Promise<string> {
  const { data, error } = await supabase.auth.mfa.challenge({ factorId })
  if (error !== null || data === null) throw new Error("internal-mfa-challenge-failed")
  return data.id
}

export async function verifyInternalMfa(input: {
  factorId: string
  challengeId: string
  code: string
}): Promise<{ ok: boolean }> {
  const { error } = await supabase.auth.mfa.verify({
    factorId: input.factorId,
    challengeId: input.challengeId,
    code: input.code,
  })
  return { ok: error === null }
}

// ============ 3. Códigos de recuperação (ADR-001, fallback aal1) ============
// Único importador de `@/lib/supabase` da árvore (gate G-02). O consumo usa o
// JWT aal1 corrente; a promoção a aal2 é confirmada SOMENTE depois do refresh.

/** `session_id` do JWT — chave do grant one-shot (ADR §3.3, risco R1). */
export function readSessionIdFromAccessToken(token: string): string | null {
  const payload = token.split(".")[1]
  if (payload === undefined || payload.length === 0) return null
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/")
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
    const decoded = JSON.parse(atob(padded)) as { session_id?: unknown }
    return typeof decoded.session_id === "string" && decoded.session_id.length > 0
      ? decoded.session_id
      : null
  } catch {
    return null
  }
}

interface ConsumeRpcRecord {
  ok?: unknown
  remaining?: unknown
  error?: unknown
  attempts_remaining?: unknown
  retry_after_seconds?: unknown
}

function consumeFailure(record: ConsumeRpcRecord): RecoveryConsumeOutcome {
  const label = typeof record.error === "string" && record.error.length > 0
    ? record.error
    : "mfa-recovery-code-invalid"
  const outcome: {
    ok: false
    error: string
    attempts_remaining?: number
    retry_after_seconds?: number
  } = { ok: false, error: label }
  if (typeof record.attempts_remaining === "number") {
    outcome.attempts_remaining = record.attempts_remaining
  }
  if (typeof record.retry_after_seconds === "number") {
    outcome.retry_after_seconds = record.retry_after_seconds
  }
  return outcome
}

/**
 * Consome um código e renova a sessão. `ok:true` exige `aal==='aal2'` no token
 * renovado — sem isso, rótulo `mfa-recovery-aal-promotion-failed` e nenhuma
 * liberação de `/internal` (ADR §3.2, RF-05/RF-13).
 */
export async function consumeRecoveryCode(code: string): Promise<RecoveryConsumeOutcome> {
  const token = await getInternalAccessToken()
  const sessionId = token === null ? null : readSessionIdFromAccessToken(token)
  if (sessionId === null) return { ok: false, error: "mfa-recovery-session-mismatch" }

  const { data, error } = await supabase.rpc("mfa_recovery_consume", {
    p_code: normalizeRecoveryCode(code),
    p_session_id: sessionId,
  })
  if (error !== null && error !== undefined) {
    const message = (error as { message?: unknown }).message
    return {
      ok: false,
      error: typeof message === "string" && message.length > 0
        ? message
        : "mfa-recovery-code-invalid",
    }
  }
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "mfa-recovery-code-invalid" }
  }
  const record = data as ConsumeRpcRecord
  if (record.ok !== true || typeof record.remaining !== "number") return consumeFailure(record)

  try {
    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession()
    if (refreshError !== null && refreshError !== undefined) {
      return { ok: false, error: "mfa-recovery-aal-promotion-failed" }
    }
    const accessToken = refreshed?.session?.access_token ?? null
    if (accessToken === null || readAalFromAccessToken(accessToken) !== "aal2") {
      return { ok: false, error: "mfa-recovery-aal-promotion-failed" }
    }
    return { ok: true, remaining: record.remaining }
  } catch {
    return { ok: false, error: "mfa-recovery-aal-promotion-failed" }
  }
}
