/**
 * Guard do control plane `/internal/*` — decisão pura (SPEC §3–§4).
 *
 * A Edge `verify-operator` é a única fonte do veredito: nenhuma função deste
 * arquivo faz I/O, lê `profiles.role` ou decide por claim. `aalKey` participa
 * apenas da chave de cache, nunca de autorização.
 */

export const OPERATOR_GATE_STATES = [
  "unknown",
  "checking",
  "operator",
  "first-access",
  "mfa-required",
  "unauthenticated",
  "denied",
  "error",
] as const

export type OperatorGateState = (typeof OPERATOR_GATE_STATES)[number]
export type OperatorGateDecision = Exclude<OperatorGateState, "unknown" | "checking">
export type GateFailure = "timeout" | "network" | "server"

export const OPERATOR_CACHE_TTL_MS = 60_000
export const VERIFY_CLIENT_TIMEOUT_MS = 8_000
export const FOCUS_REVALIDATE_MIN_INTERVAL_MS = 5_000
export const MFA_LOCKOUT_THRESHOLD = 5
export const MFA_LOCKOUT_MS = 30_000

export interface EdgeVerdict {
  state: OperatorGateDecision
  failure: GateFailure | null
  userId: string | null
}

export interface SessionKey {
  userId: string | null
  aalKey: "aal1" | "aal2" | null
}

export interface FreshnessEntry {
  state: OperatorGateState
  userId: string | null
  aalKey: SessionKey["aalKey"]
  checkedAt: number | null
}

const GATE_LABELS: Readonly<Record<string, OperatorGateDecision>> = {
  "first-access": "first-access",
  "first-access-password-change-required": "first-access",
  "mfa-required": "mfa-required",
  "operator-inactive": "denied",
  "not-admin": "denied",
  "not-super-admin": "denied",
  "42501": "denied",
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function errorVerdict(failure: GateFailure = "server"): EdgeVerdict {
  return { state: "error", failure, userId: null }
}

/**
 * Mapeia os desfechos de fio da Edge para o estado do guard (REQ-07).
 * Corpo inesperado nunca vira `operator` — sempre `error`.
 */
export function verdictFromEdge(
  status: number | null,
  body: unknown,
  failure: GateFailure | null = null,
): EdgeVerdict {
  if (failure !== null) return errorVerdict(failure)
  if (status === null) return errorVerdict("network")
  if (status === 401) return { state: "unauthenticated", failure: null, userId: null }

  if (status === 200) {
    const record = asRecord(body)
    if (record === null) return errorVerdict()
    if (record.is_operator !== true) return errorVerdict()
    if (record.aal !== "aal2") return errorVerdict()
    if (typeof record.user_id !== "string" || record.user_id.length === 0) return errorVerdict()
    return { state: "operator", failure: null, userId: record.user_id }
  }

  if (status === 403) {
    const record = asRecord(body)
    if (record === null || record.is_operator !== false) return errorVerdict()
    const label = record.error
    if (label === undefined || label === null) {
      return { state: "denied", failure: null, userId: null }
    }
    if (typeof label !== "string") return errorVerdict()
    if (label === "first-access") return { state: "first-access", failure: null, userId: null }
    if (label === "mfa-required") return { state: "mfa-required", failure: null, userId: null }
    if (label === "operator-inactive") return { state: "denied", failure: null, userId: null }
    return errorVerdict()
  }

  return errorVerdict()
}

export function isGateState(value: string): value is OperatorGateState {
  return (OPERATOR_GATE_STATES as readonly string[]).includes(value)
}

export function gateStateFromLabel(label: string): OperatorGateDecision | null {
  return Object.prototype.hasOwnProperty.call(GATE_LABELS, label) ? GATE_LABELS[label] : null
}

/**
 * `isFresh` = só `operator` é servido do cache, para a **mesma chave de sessão**
 * (`userId:aalKey`) e dentro do TTL. O `session` vem da sessão **viva** — nunca
 * do próprio store, senão uma troca de conta passaria despercebida. Relógio para
 * trás conta como expirado (fail-closed).
 */
export function isFresh(entry: FreshnessEntry, session: SessionKey, now: number): boolean {
  if (entry.state !== "operator" || entry.userId === null || entry.checkedAt === null) return false
  if (session.userId === null || entry.userId !== session.userId) return false
  // `aalKey` entra na chave: concluir o enroll muda `aal` sem mudar `userId`.
  if (entry.aalKey !== session.aalKey) return false
  const age = now - entry.checkedAt
  return age >= 0 && age < OPERATOR_CACHE_TTL_MS
}

export interface MfaLockoutState {
  failures: number
  lockedUntil: number | null
}

export const INITIAL_MFA_LOCKOUT: MfaLockoutState = Object.freeze({
  failures: 0,
  lockedUntil: null,
})

export function registerMfaFailure(state: MfaLockoutState, now: number): MfaLockoutState {
  const failures = state.failures + 1
  if (failures >= MFA_LOCKOUT_THRESHOLD) {
    return { failures: MFA_LOCKOUT_THRESHOLD, lockedUntil: now + MFA_LOCKOUT_MS }
  }
  return { failures, lockedUntil: state.lockedUntil }
}

export function registerMfaSuccess(): MfaLockoutState {
  return { failures: 0, lockedUntil: null }
}

export function mfaLockoutRemainingMs(state: MfaLockoutState, now: number): number {
  if (state.lockedUntil === null) return 0
  return Math.max(0, state.lockedUntil - now)
}

export function isMfaLockedOut(state: MfaLockoutState, now: number): boolean {
  return mfaLockoutRemainingMs(state, now) > 0
}

export function canAttemptMfa(state: MfaLockoutState, now: number): boolean {
  return !isMfaLockedOut(state, now)
}
