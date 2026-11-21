/**
 * Cliente da Edge `mfa-recovery-codes` (ADR-001 / EDGE-01).
 *
 * Mesmo desenho fail-closed de `verify-operator.service`: `apikey` é a chave
 * pública anon, `Bearer` é o JWT do chamador e nenhuma chave privilegiada entra
 * no bundle. Consumo NÃO passa por aqui — a browser chama a RPC com token aal1.
 */

import { resolveSupabaseConfig } from "@/lib/supabase-env"
import { getInternalAccessToken } from "./internal-client"
import type { RecoveryCodesList, RecoveryStatus } from "./mfa-recovery-codes"

export const RECOVERY_CODES_FUNCTION_PATH = "/functions/v1/mfa-recovery-codes"
const RECOVERY_CLIENT_TIMEOUT_MS = 8_000
const CODE_PATTERN = /^[a-z2-7]{24}$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type RecoveryServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number | null }

export interface RecoveryCodesServiceOptions {
  baseUrl: string
  anonKey: string
  getAccessToken: () => Promise<string | null>
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export interface RecoveryCodesService {
  generate: () => Promise<RecoveryServiceResult<RecoveryCodesList>>
  status: () => Promise<RecoveryServiceResult<RecoveryStatus>>
  regenerate: (confirmation: string) => Promise<RecoveryServiceResult<RecoveryCodesList>>
}

function endpointFor(baseUrl: string, route: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${RECOVERY_CODES_FUNCTION_PATH}/${route}`
}

function parseBody(text: string): Record<string, unknown> | null {
  if (text.length === 0) return null
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value)
}

function parseCodes(body: Record<string, unknown> | null): RecoveryCodesList | null {
  if (body === null || !isUuid(body.set_id)) return null
  if (!Array.isArray(body.codes) || body.codes.length !== 10) return null
  if (!body.codes.every((code) => typeof code === "string" && CODE_PATTERN.test(code))) return null
  return { set_id: body.set_id, codes: [...body.codes] as string[] }
}

function parseStatus(body: Record<string, unknown> | null): RecoveryStatus | null {
  if (body === null || body.total !== 10) return null
  if (typeof body.remaining !== "number" || !Number.isInteger(body.remaining)) return null
  if (body.remaining < 0 || body.remaining > 10) return null
  if (!Array.isArray(body.codes) || body.codes.length !== 10) return null
  const codes: { id: string; used_at: string | null }[] = []
  for (const raw of body.codes) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null
    const entry = raw as Record<string, unknown>
    if (!isUuid(entry.id)) return null
    if (entry.used_at !== null && typeof entry.used_at !== "string") return null
    codes.push({ id: entry.id, used_at: entry.used_at as string | null })
  }
  return { total: 10, remaining: body.remaining, low: body.remaining <= 2, codes }
}

function failure(status: number | null, body: Record<string, unknown> | null): RecoveryServiceResult<never> {
  const label = typeof body?.error === "string" && body.error.length > 0 ? body.error : null
  if (label !== null) return { ok: false, error: label, status }
  if (status === 409) return { ok: false, error: "mfa-recovery-confirmation-required", status }
  return { ok: false, error: "mfa-recovery-forbidden", status }
}

type Parse<T> = (body: Record<string, unknown> | null) => T | null

export function createRecoveryCodesService(
  options: RecoveryCodesServiceOptions,
): RecoveryCodesService {
  const timeoutMs = options.timeoutMs ?? RECOVERY_CLIENT_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? fetch

  const call = async <T>(
    route: "generate" | "status" | "regenerate",
    method: "GET" | "POST",
    parse: Parse<T>,
    body?: Record<string, unknown>,
  ): Promise<RecoveryServiceResult<T>> => {
    const token = await options.getAccessToken()
    if (token === null || token.length === 0) {
      return { ok: false, error: "mfa-recovery-forbidden", status: 401 }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(endpointFor(options.baseUrl, route), {
        method,
        headers: {
          apikey: options.anonKey,
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      })
      const parsed = parseBody(await response.text())
      if (response.status < 200 || response.status >= 300) return failure(response.status, parsed)
      const data = parse(parsed)
      return data === null
        ? { ok: false, error: "mfa-recovery-forbidden", status: response.status }
        : { ok: true, data }
    } catch {
      return { ok: false, error: "mfa-recovery-forbidden", status: null }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    generate: () => call("generate", "POST", parseCodes),
    status: () => call("status", "GET", parseStatus),
    regenerate: (confirmation: string) =>
      call("regenerate", "POST", parseCodes, { confirmation }),
  }
}

/** Instância de produção: injeta apenas a chave pública e o token do chamador. */
const RECOVERY_CONFIG = resolveSupabaseConfig({
  url: import.meta.env.VITE_SUPABASE_URL as string | undefined,
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
  prod: import.meta.env.PROD,
})

export const recoveryCodesService: RecoveryCodesService = createRecoveryCodesService({
  baseUrl: RECOVERY_CONFIG.url,
  anonKey: RECOVERY_CONFIG.anonKey,
  getAccessToken: getInternalAccessToken,
})
