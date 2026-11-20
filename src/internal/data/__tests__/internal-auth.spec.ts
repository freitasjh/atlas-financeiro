// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"

const { auth } = vi.hoisted(() => ({
  auth: {
    getSession: vi.fn(),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
    mfa: {
      listFactors: vi.fn(),
      enroll: vi.fn(),
      challenge: vi.fn(),
      verify: vi.fn(),
    },
  },
}))

vi.mock("@/lib/supabase", () => ({ supabase: { rpc: vi.fn(), auth } }))

import {
  challengeInternalMfa,
  enrollInternalTotp,
  getInternalAccessToken,
  listInternalMfaFactors,
  readAalFromAccessToken,
  readInternalSession,
  signInInternalOperator,
  signOutInternalOperator,
  verifyInternalMfa,
} from "../internal-client"

function tokenWith(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `${encode({ alg: "HS256" })}.${encode(payload)}.sig`
}

beforeEach(() => {
  auth.getSession.mockReset()
  auth.signInWithPassword.mockReset()
  auth.signOut.mockReset()
  auth.mfa.listFactors.mockReset()
  auth.mfa.enroll.mockReset()
  auth.mfa.challenge.mockReset()
  auth.mfa.verify.mockReset()
})

describe("whenAccessTokenIsDecoded_thenOnlyAalIsRead", () => {
  it("lê aal1/aal2 do payload", () => {
    expect(readAalFromAccessToken(tokenWith({ aal: "aal2" }))).toBe("aal2")
    expect(readAalFromAccessToken(tokenWith({ aal: "aal1" }))).toBe("aal1")
    expect(readAalFromAccessToken(tokenWith({ sub: "u" }))).toBeNull()
    expect(readAalFromAccessToken("not-a-jwt")).toBeNull()
  })
})

describe("whenSessionIsRead_thenSnapshotFeedsTheGuardCacheKey", () => {
  it("sem sessão devolve nulos", async () => {
    auth.getSession.mockResolvedValue({ data: { session: null } })
    expect(await readInternalSession()).toEqual({ userId: null, aalKey: null })
    expect(await getInternalAccessToken()).toBeNull()
  })

  it("com sessão devolve userId e aal", async () => {
    const token = tokenWith({ aal: "aal2" })
    auth.getSession.mockResolvedValue({ data: { session: { access_token: token, user: { id: "u-1" } } } })
    expect(await readInternalSession()).toEqual({ userId: "u-1", aalKey: "aal2" })
    expect(await getInternalAccessToken()).toBe(token)
  })
})

describe("whenOperatorSignsIn_thenGoTrueDecides", () => {
  it("erro do GoTrue vira ok=false", async () => {
    auth.signInWithPassword.mockResolvedValue({ error: { message: "invalid" } })
    expect(await signInInternalOperator("op@atlas.test", "x")).toEqual({ ok: false })
  })

  it("sucesso vira ok=true e signOut é delegado", async () => {
    auth.signInWithPassword.mockResolvedValue({ error: null })
    auth.signOut.mockResolvedValue({ error: null })
    expect(await signInInternalOperator("op@atlas.test", "x")).toEqual({ ok: true })
    await signOutInternalOperator()
    expect(auth.signOut).toHaveBeenCalledTimes(1)
  })
})

describe("whenMfaIsUsed_thenFactorsAreMappedWithoutSecretsLeaking", () => {
  it("lista só id/status/friendlyName", async () => {
    auth.mfa.listFactors.mockResolvedValue({
      data: { totp: [{ id: "f-1", status: "verified", friendly_name: "Celular" }] },
      error: null,
    })
    expect(await listInternalMfaFactors()).toEqual([
      { id: "f-1", status: "verified", friendlyName: "Celular" },
    ])
  })

  it("erro de listagem vira rótulo fixo", async () => {
    auth.mfa.listFactors.mockResolvedValue({ data: null, error: { message: "x" } })
    await expect(listInternalMfaFactors()).rejects.toThrow("internal-mfa-list-failed")
  })

  it("enroll devolve fator, segredo e uri", async () => {
    auth.mfa.enroll.mockResolvedValue({
      data: { id: "f-2", totp: { secret: "S3CR3T", uri: "otpauth://totp/x" } },
      error: null,
    })
    expect(await enrollInternalTotp()).toEqual({
      factorId: "f-2",
      secret: "S3CR3T",
      uri: "otpauth://totp/x",
    })
  })

  it("challenge devolve o id e verify devolve ok", async () => {
    auth.mfa.challenge.mockResolvedValue({ data: { id: "ch-1" }, error: null })
    auth.mfa.verify.mockResolvedValue({ data: {}, error: null })

    expect(await challengeInternalMfa("f-2")).toBe("ch-1")
    expect(await verifyInternalMfa({ factorId: "f-2", challengeId: "ch-1", code: "123456" })).toEqual({
      ok: true,
    })
    expect(auth.mfa.verify).toHaveBeenCalledWith({
      factorId: "f-2",
      challengeId: "ch-1",
      code: "123456",
    })
  })

  it("código recusado vira ok=false", async () => {
    auth.mfa.verify.mockResolvedValue({ data: null, error: { message: "invalid" } })
    expect(await verifyInternalMfa({ factorId: "f", challengeId: "c", code: "000000" })).toEqual({
      ok: false,
    })
  })
})
