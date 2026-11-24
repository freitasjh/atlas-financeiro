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
      unenroll: vi.fn(),
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
  INTERNAL_TOTP_FRIENDLY_NAME,
  InternalMfaEnrollConflictError,
  listInternalMfaFactors,
  readAalFromAccessToken,
  readInternalSession,
  signInInternalOperator,
  signOutInternalOperator,
  unenrollInternalMfaFactor,
  unenrollUnverifiedInternalTotpFactors,
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
  auth.mfa.unenroll.mockReset()
  auth.mfa.challenge.mockReset()
  auth.mfa.verify.mockReset()

  auth.mfa.listFactors.mockResolvedValue({ data: { totp: [] }, error: null })
  auth.mfa.enroll.mockResolvedValue({
    data: { id: "f-2", totp: { secret: "S3CR3T", uri: "otpauth://totp/x" } },
    error: null,
  })
  auth.mfa.unenroll.mockResolvedValue({ error: null })
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

describe("whenInternalTotpEnrollmentIsRetried_thenItStaysIdempotent", () => {
  const conflict = () => ({
    code: "mfa_factor_name_conflict",
    message: 'A factor with the friendly name "" for this user already exists',
  })
  const enrolled = () => ({
    data: { id: "f-2", totp: { secret: "S3CR3T", uri: "otpauth://totp/x" } },
    error: null,
  })

  it("enroll usa friendlyName determinístico, nunca nome vazio", async () => {
    await enrollInternalTotp()

    expect(INTERNAL_TOTP_FRIENDLY_NAME).toBe("Atlas Internal")
    expect(auth.mfa.enroll).toHaveBeenCalledWith({
      factorType: "totp",
      friendlyName: INTERNAL_TOTP_FRIENDLY_NAME,
    })
  })

  it("limpa só fatores totp unverified; verified nunca é tocado", async () => {
    auth.mfa.listFactors.mockResolvedValue({
      data: {
        totp: [
          { id: "stale-empty", status: "unverified", friendly_name: "" },
          { id: "stale-named", status: "unverified", friendly_name: INTERNAL_TOTP_FRIENDLY_NAME },
          { id: "kept", status: "verified", friendly_name: "Celular" },
        ],
      },
      error: null,
    })

    await unenrollUnverifiedInternalTotpFactors(await listInternalMfaFactors())

    expect(auth.mfa.unenroll.mock.calls.map((call) => call[0])).toEqual([
      { factorId: "stale-empty" },
      { factorId: "stale-named" },
    ])
  })

  it("falha de unenroll é best-effort e não impede o enroll", async () => {
    auth.mfa.unenroll.mockRejectedValue(new Error("unenroll-boom"))
    const factors = await listInternalMfaFactors()

    await expect(unenrollUnverifiedInternalTotpFactors(factors)).resolves.toBeUndefined()
  })

  it("erro de unenroll do GoTrue vira rótulo fixo", async () => {
    auth.mfa.unenroll.mockResolvedValue({ error: { message: "denied" } })
    await expect(unenrollInternalMfaFactor("f-1")).rejects.toThrow("internal-mfa-unenroll-failed")
    expect(auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: "f-1" })
  })

  it("conflito residual limpa pendência e repete enroll exatamente uma vez", async () => {
    auth.mfa.listFactors.mockResolvedValue({
      data: { totp: [{ id: "race", status: "unverified", friendly_name: "" }] },
      error: null,
    })
    auth.mfa.enroll.mockRejectedValueOnce(conflict()).mockResolvedValueOnce(enrolled())

    expect(await enrollInternalTotp()).toEqual({
      factorId: "f-2",
      secret: "S3CR3T",
      uri: "otpauth://totp/x",
    })
    expect(auth.mfa.enroll).toHaveBeenCalledTimes(2)
    expect(auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: "race" })
  })

  it("conflito persistente falha com erro tipado, sem loop", async () => {
    auth.mfa.enroll.mockRejectedValue(conflict())

    await expect(enrollInternalTotp()).rejects.toBeInstanceOf(InternalMfaEnrollConflictError)
    expect(auth.mfa.enroll).toHaveBeenCalledTimes(2)
  })

  it("erro que não é conflito não dispara retry", async () => {
    auth.mfa.enroll.mockRejectedValueOnce(new Error("rede-fora"))

    await expect(enrollInternalTotp()).rejects.toThrow("rede-fora")
    expect(auth.mfa.enroll).toHaveBeenCalledTimes(1)
  })

  it("chamadas concorrentes compartilham um único POST /factors", async () => {
    let resolveEnroll!: (value: unknown) => void
    auth.mfa.enroll.mockReturnValue(
      new Promise((resolve) => {
        resolveEnroll = resolve
      }),
    )

    const first = enrollInternalTotp()
    const second = enrollInternalTotp()
    expect(auth.mfa.enroll).toHaveBeenCalledTimes(1)

    resolveEnroll(enrolled())
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(a.factorId).toBe("f-2")
  })
})
