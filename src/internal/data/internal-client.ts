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

export interface InternalTotpEnrollment {
  factorId: string
  secret: string
  uri: string
}

export async function enrollInternalTotp(): Promise<InternalTotpEnrollment> {
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" })
  if (error !== null || data === null) throw new Error("internal-mfa-enroll-failed")
  return { factorId: data.id, secret: data.totp.secret, uri: data.totp.uri }
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
