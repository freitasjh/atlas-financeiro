// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { rpc, getSession, refreshSession } = vi.hoisted(() => ({
  rpc: vi.fn(),
  getSession: vi.fn(),
  refreshSession: vi.fn(),
}))

vi.mock("@/lib/supabase", () => ({
  supabase: { rpc, auth: { getSession, refreshSession } },
}))

import {
  consumeRecoveryCode,
  normalizeRecoveryCode,
  readSessionIdFromAccessToken,
} from "../internal-client"

function token(sessionId: string, aal: "aal1" | "aal2"): string {
  const payload = btoa(JSON.stringify({ sub: "u-1", session_id: sessionId, aal }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return `header.${payload}.signature`
}

function session(sessionId: string, aal: "aal1" | "aal2") {
  return { data: { session: { access_token: token(sessionId, aal), user: { id: "u-1" } } } }
}

beforeEach(() => {
  rpc.mockReset()
  getSession.mockReset()
  refreshSession.mockReset()
  getSession.mockResolvedValue(session("session-1", "aal1"))
  refreshSession.mockResolvedValue(session("session-1", "aal2"))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("whenConsumeRuns_thenSessionIdComesFromJwtAndPromotionIsVerified", () => {
  it("normaliza o código antes da RPC", () => {
    expect(normalizeRecoveryCode(" ABCD-EFGH IJKL ")).toBe("abcdefghijkl")
    expect(readSessionIdFromAccessToken(token("session-9", "aal1"))).toBe("session-9")
    expect(readSessionIdFromAccessToken("not-a-jwt")).toBeNull()
  })

  it("consome com o session_id do token e eleva somente após refreshSession", async () => {
    rpc.mockResolvedValue({ data: { ok: true, remaining: 9 }, error: null })

    const outcome = await consumeRecoveryCode("ABCD-EFGH-IJKL-MNOP-QRST-UVWX")

    expect(rpc).toHaveBeenCalledWith("mfa_recovery_consume", {
      p_code: "abcdefghijklmnopqrstuvwx",
      p_session_id: "session-1",
    })
    expect(refreshSession).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({ ok: true, remaining: 9 })
  })

  it("ok:false preserva attempts_remaining/retry_after_seconds sem refresh", async () => {
    rpc.mockResolvedValue({
      data: { ok: false, error: "mfa-recovery-locked", retry_after_seconds: 900 },
      error: null,
    })

    const outcome = await consumeRecoveryCode("abcdefghijklmnopqrstuvwx")

    expect(outcome).toEqual({
      ok: false,
      error: "mfa-recovery-locked",
      retry_after_seconds: 900,
    })
    expect(refreshSession).not.toHaveBeenCalled()
  })

  it("ok:true sem elevação no refresh ⇒ mfa-recovery-aal-promotion-failed", async () => {
    rpc.mockResolvedValue({ data: { ok: true, remaining: 9 }, error: null })
    refreshSession.mockResolvedValue(session("session-1", "aal1"))

    const outcome = await consumeRecoveryCode("abcdefghijklmnopqrstuvwx")

    expect(outcome).toEqual({ ok: false, error: "mfa-recovery-aal-promotion-failed" })
  })

  it("erro de transporte no refresh também falha fechado", async () => {
    rpc.mockResolvedValue({ data: { ok: true, remaining: 9 }, error: null })
    refreshSession.mockRejectedValue(new Error("refresh-failed"))

    await expect(consumeRecoveryCode("abcdefghijklmnopqrstuvwx")).resolves.toEqual({
      ok: false,
      error: "mfa-recovery-aal-promotion-failed",
    })
  })

  it("sem session_id no JWT não chama a RPC", async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: "invalid", user: { id: "u-1" } } } })

    const outcome = await consumeRecoveryCode("abcdefghijklmnopqrstuvwx")

    expect(outcome).toEqual({ ok: false, error: "mfa-recovery-session-mismatch" })
    expect(rpc).not.toHaveBeenCalled()
  })

  it("nenhum código/token é gravado no console", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    )
    rpc.mockResolvedValue({ data: { ok: true, remaining: 9 }, error: null })
    try {
      await consumeRecoveryCode("abcdefghijklmnopqrstuvwx")
      for (const spy of spies) {
        for (const args of spy.mock.calls) {
          const text = args.map(String).join(" ")
          expect(text).not.toMatch(/abcdefghijklmnopqrstuvwx|session-1|header\./)
        }
      }
    } finally {
      spies.forEach((spy) => spy.mockRestore())
    }
  })
})
