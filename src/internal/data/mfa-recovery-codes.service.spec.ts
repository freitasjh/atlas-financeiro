import { describe, expect, it, vi } from "vitest"

import {
  RECOVERY_CODES_FUNCTION_PATH,
  createRecoveryCodesService,
  type RecoveryCodesServiceOptions,
} from "./mfa-recovery-codes.service"

const ALPHABET = "abcdefghijklmnopqrstuvwxyz"
const CODES = Array.from(
  { length: 10 },
  (_, row) => Array.from({ length: 24 }, (_, column) => ALPHABET[(row + column) % 26]).join(""),
)
const STATUS = {
  total: 10,
  remaining: 8,
  low: false,
  codes: Array.from({ length: 10 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    used_at: null,
  })),
}

function response(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body) } as unknown as Response
}

function service(
  fetchImpl: typeof fetch,
  overrides: Partial<RecoveryCodesServiceOptions> = {},
) {
  return createRecoveryCodesService({
    baseUrl: "https://projeto.supabase.co/",
    anonKey: "anon-public-key",
    getAccessToken: async () => "jwt-aal2",
    fetchImpl,
    ...overrides,
  })
}

describe("whenEdgeIsCalled_thenOnlyPublicHeadersAndCallerJwtCrossTheWire", () => {
  it("POST /generate devolve a lista validada", async () => {
    const fetchImpl = vi.fn(async () =>
      response(200, { set_id: "00000000-0000-4000-8000-000000000001", codes: CODES }),
    ) as unknown as typeof fetch
    const result = await service(fetchImpl).generate()

    expect(result.ok).toBe(true)
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`https://projeto.supabase.co${RECOVERY_CODES_FUNCTION_PATH}/generate`)
    expect(init.method).toBe("POST")
    const headers = init.headers as Record<string, string>
    expect(headers.apikey).toBe("anon-public-key")
    expect(headers.Authorization).toBe("Bearer jwt-aal2")
  })

  it("GET /status devolve total/remaining/low/codes", async () => {
    const fetchImpl = vi.fn(async () => response(200, STATUS)) as unknown as typeof fetch
    const result = await service(fetchImpl).status()

    expect(result.ok).toBe(true)
    const [, init] = vi.mocked(fetchImpl).mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe("GET")
  })

  it("POST /regenerate envia exatamente a confirmação textual", async () => {
    const fetchImpl = vi.fn(async () =>
      response(200, { set_id: "00000000-0000-4000-8000-000000000002", codes: CODES }),
    ) as unknown as typeof fetch
    const result = await service(fetchImpl).regenerate("REVOGAR_CODIGOS_ATUAIS")

    expect(result.ok).toBe(true)
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(/\/regenerate$/)
    expect(JSON.parse(init.body as string)).toEqual({ confirmation: "REVOGAR_CODIGOS_ATUAIS" })
  })

  it("rótulos congelados da Edge sobrevivem ao cliente", async () => {
    const conflict = await service(
      vi.fn(async () => response(409, { error: "mfa-recovery-confirmation-required" })) as unknown as typeof fetch,
    ).regenerate("ERRADO")
    expect(conflict).toMatchObject({ ok: false, error: "mfa-recovery-confirmation-required" })

    const denied = await service(
      vi.fn(async () => response(403, { error: "mfa-required" })) as unknown as typeof fetch,
    ).generate()
    expect(denied).toMatchObject({ ok: false, status: 403 })
  })

  it("sem token não toca a rede e falha fechado", async () => {
    const fetchImpl = vi.fn()
    const result = await service(fetchImpl as unknown as typeof fetch, {
      getAccessToken: async () => null,
    }).status()

    expect(result.ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("payload inesperado não vaza campo extra", async () => {
    const result = await service(
      vi.fn(async () =>
        response(200, {
          set_id: "00000000-0000-4000-8000-000000000003",
          codes: CODES,
          code_hash: "hash-secreto",
        }),
      ) as unknown as typeof fetch,
    ).generate()

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).not.toHaveProperty("code_hash")
  })
})
