// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { setSession } = vi.hoisted(() => ({ setSession: vi.fn() }))

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { setSession } },
}))

import { bootstrapAuthFromHash } from "@/boot/auth-hash-bootstrap"

beforeEach(() => {
  setSession.mockReset()
  setSession.mockResolvedValue({
    data: { session: { user: { id: "user-1", email: "a@b.com" } } },
    error: null,
  })
  document.cookie = "pendingPasswordSetup=; Path=/; Max-Age=0"
  window.location.hash = ""
})

afterEach(() => {
  window.location.hash = ""
})

describe("bootstrapAuthFromHash", () => {
  it("whenHashHasNoAuthPayload_thenLeavesUrlUntouched", async () => {
    window.location.hash = "#/login"
    await bootstrapAuthFromHash(window.location.hash)
    expect(window.location.hash).toBe("#/login")
    expect(setSession).not.toHaveBeenCalled()
  })

  it("whenInvitePayload_thenStripsTokensSetsSessionAndMarksOnboarding", async () => {
    await bootstrapAuthFromHash(
      "#access_token=at-1&refresh_token=rt-1&expires_in=3600&type=invite",
    )
    expect(window.location.hash).toBe("#/definir-senha?origem=convite")
    expect(window.location.hash).not.toContain("access_token")
    expect(setSession).toHaveBeenCalledWith({ access_token: "at-1", refresh_token: "rt-1" })
    expect(document.cookie).toContain("pendingPasswordSetup=user-1")
  })

  it("whenRecoveryPayload_thenRoutesToRecoveryCopy", async () => {
    await bootstrapAuthFromHash("#access_token=at-2&refresh_token=rt-2&type=recovery")
    expect(window.location.hash).toBe("#/definir-senha?origem=recuperacao")
  })

  it("whenOtpExpiredPayload_thenRoutesToExpiredWithoutSetSession", async () => {
    await bootstrapAuthFromHash(
      "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    )
    expect(window.location.hash).toBe("#/link-expirado?motivo=expirado")
    expect(window.location.hash).not.toContain("error_description")
    expect(setSession).not.toHaveBeenCalled()
  })

  it("whenSetSessionFails_thenFallsBackToInvalidLink", async () => {
    setSession.mockResolvedValue({ data: { session: null }, error: { message: "bad token" } })
    await bootstrapAuthFromHash("#access_token=at&refresh_token=rt&type=invite")
    expect(window.location.hash).toBe("#/link-expirado?motivo=invalido")
    expect(document.cookie).not.toContain("pendingPasswordSetup=user-1")
  })
})
