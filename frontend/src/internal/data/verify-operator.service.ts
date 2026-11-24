/**
 * Cliente da Edge `verify-operator` v2 (SPEC §4, REQ-09).
 *
 * Timeout do cliente (8 s) é maior que o deadline total (5 s) da Edge: a borda
 * responde primeiro; o abort local é a última barreira. `apikey` é a chave
 * pública anon — nenhum segredo privilegiado passa por aqui.
 */

import { VERIFY_CLIENT_TIMEOUT_MS, type GateFailure } from "@/internal/guard/operator-gate"

export const VERIFY_OPERATOR_FUNCTION_PATH = "/functions/v1/verify-operator"

export interface VerifyOperatorWireResult {
  status: number | null
  body: unknown
  failure: GateFailure | null
}

export interface VerifyOperatorServiceOptions {
  baseUrl: string
  anonKey: string
  getAccessToken: () => Promise<string | null>
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export interface VerifyOperatorService {
  verify: () => Promise<VerifyOperatorWireResult>
}

function endpointFor(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${VERIFY_OPERATOR_FUNCTION_PATH}`
}

function parseBody(text: string): unknown {
  if (text.length === 0) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export function createVerifyOperatorService(
  options: VerifyOperatorServiceOptions,
): VerifyOperatorService {
  const timeoutMs = options.timeoutMs ?? VERIFY_CLIENT_TIMEOUT_MS
  const fetchImpl = options.fetchImpl ?? fetch

  return {
    verify: async () => {
      const token = await options.getAccessToken()
      if (token === null || token.length === 0) {
        // Sem sessão: 401 lógico, sem tocar a rede.
        return { status: 401, body: { is_operator: false }, failure: null }
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetchImpl(endpointFor(options.baseUrl), {
          method: "POST",
          headers: {
            apikey: options.anonKey,
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          signal: controller.signal,
        })
        const text = await response.text()
        return { status: response.status, body: parseBody(text), failure: null }
      } catch {
        return {
          status: null,
          body: null,
          failure: controller.signal.aborted ? "timeout" : "network",
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
