import { readFileSync } from "node:fs"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  VERIFY_OPERATOR_FUNCTION_PATH,
  createVerifyOperatorService,
  type VerifyOperatorServiceOptions,
} from "./verify-operator.service"
import { VERIFY_CLIENT_TIMEOUT_MS } from "@/internal/guard/operator-gate"

const BASE_OPTIONS = {
  baseUrl: "https://projeto.supabase.co",
  anonKey: "anon-public-key",
  getAccessToken: async () => "jwt-de-sessao",
} satisfies Omit<VerifyOperatorServiceOptions, "fetchImpl">

function response(status: number, body: unknown): Response {
  return {
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

function serviceWith(fetchImpl: typeof fetch, overrides: Partial<VerifyOperatorServiceOptions> = {}) {
  return createVerifyOperatorService({ ...BASE_OPTIONS, fetchImpl, ...overrides })
}

describe("whenEdgeAnswers_thenWireResultIsPreserved", () => {
  it("200 devolve status e corpo parseado", async () => {
    const fetchImpl = vi.fn(async () => response(200, { is_operator: true, aal: "aal2", user_id: "u-1" }))
    const result = await serviceWith(fetchImpl as unknown as typeof fetch).verify()
    expect(result).toEqual({
      status: 200,
      body: { is_operator: true, aal: "aal2", user_id: "u-1" },
      failure: null,
    })
  })

  it("401 e 403 rotulado passam intactos", async () => {
    const unauthorized = await serviceWith(
      vi.fn(async () => response(401, { is_operator: false })) as unknown as typeof fetch,
    ).verify()
    expect(unauthorized).toMatchObject({ status: 401, failure: null })

    const labeled = await serviceWith(
      vi.fn(async () => response(403, { is_operator: false, error: "mfa-required" })) as unknown as typeof fetch,
    ).verify()
    expect(labeled).toMatchObject({ status: 403, failure: null })
  })

  it("5xx vira status com falha nula (o gate mapeia para error)", async () => {
    const result = await serviceWith(
      vi.fn(async () => response(503, { is_operator: false })) as unknown as typeof fetch,
    ).verify()
    expect(result).toMatchObject({ status: 503, failure: null })
  })

  it("JSON inválido ⇒ corpo nulo com status (gate decide)", async () => {
    const result = await serviceWith(
      vi.fn(async () => ({ status: 200, text: async () => "nao-json" }) as unknown as Response) as unknown as typeof fetch,
    ).verify()
    expect(result).toEqual({ status: 200, body: null, failure: null })
  })
})

describe("whenSessionOrTransportFails_thenItFailsClosed", () => {
  it("sem token ⇒ 401 sem chamar a rede", async () => {
    const fetchImpl = vi.fn()
    const service = serviceWith(fetchImpl as unknown as typeof fetch, {
      getAccessToken: async () => null,
    })
    const result = await service.verify()
    expect(result).toEqual({ status: 401, body: { is_operator: false }, failure: null })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("rede indisponível ⇒ failure network", async () => {
    const result = await serviceWith(
      vi.fn(async () => {
        throw new TypeError("fetch failed")
      }) as unknown as typeof fetch,
    ).verify()
    expect(result).toEqual({ status: null, body: null, failure: "network" })
  })

  it("abort por timeout (8 s) ⇒ failure timeout", async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
          }),
      )
      const service = serviceWith(fetchImpl as unknown as typeof fetch)
      const pending = service.verify()
      await vi.advanceTimersByTimeAsync(VERIFY_CLIENT_TIMEOUT_MS)
      await expect(pending).resolves.toEqual({ status: null, body: null, failure: "timeout" })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("whenRequestIsBuilt_thenItUsesThePublicAnonKey", () => {
  it("envia apikey anon + Bearer e aponta para a Edge", async () => {
    const fetchImpl = vi.fn(async () => response(200, { is_operator: true, aal: "aal2", user_id: "u-1" }))
    await serviceWith(fetchImpl as unknown as typeof fetch).verify()

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://projeto.supabase.co${VERIFY_OPERATOR_FUNCTION_PATH}`)
    const headers = init.headers as Record<string, string>
    expect(headers.apikey).toBe("anon-public-key")
    expect(headers.Authorization).toBe("Bearer jwt-de-sessao")
  })

  it("nenhum segredo privilegiado no serviço", () => {
    const source = readFileSync("src/internal/data/verify-operator.service.ts", "utf8")
    expect(source).not.toMatch(/service_role/i)
    expect(source).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/)
  })
})

afterEach(() => {
  vi.useRealTimers()
})
