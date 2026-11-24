import { describe, it, expect } from "vitest"

import {
  PENDING_PASSWORD_SETUP_COOKIE,
  PENDING_PASSWORD_SETUP_TTL_SECONDS,
  buildPendingPasswordSetupCookie,
  clearPendingPasswordSetup,
  hasPendingPasswordSetupFor,
  readPendingPasswordSetup,
  readPendingPasswordSetupOrigin,
  writePendingPasswordSetup,
} from "@/lib/pending-password-setup"

function fakeDoc(initial = "") {
  return {
    cookie: initial,
    /** Simula o browser: cada atribuição substitui apenas aquele cookie. */
    last: "",
  }
}

describe("pendingPasswordSetup cookie", () => {
  it("whenBuilding_thenCarriesPathSameSiteAndEightHourTtl", () => {
    const cookie = buildPendingPasswordSetupCookie("user-1", false)
    expect(cookie).toContain(`${PENDING_PASSWORD_SETUP_COOKIE}=user-1`)
    expect(cookie).toContain("Path=/")
    expect(cookie).toContain("SameSite=Lax")
    expect(cookie).toContain(`Max-Age=${PENDING_PASSWORD_SETUP_TTL_SECONDS}`)
    expect(PENDING_PASSWORD_SETUP_TTL_SECONDS).toBe(8 * 60 * 60)
    expect(cookie).not.toContain("Secure")
  })

  it("whenHttps_thenCookieIsSecure", () => {
    expect(buildPendingPasswordSetupCookie("user-1", true)).toContain("; Secure")
  })

  it("whenReading_thenDecodesValueAndIgnoresOtherCookies", () => {
    expect(
      readPendingPasswordSetup(`sb-token=abc; ${PENDING_PASSWORD_SETUP_COOKIE}=user%2D1; theme=dark`),
    ).toBe("user-1")
    expect(readPendingPasswordSetup("theme=dark")).toBeNull()
    expect(readPendingPasswordSetup(null)).toBeNull()
  })

  it("whenOriginPersisted_thenReaderReturnsItAndSameUserStillMatches", () => {
    const raw = `${PENDING_PASSWORD_SETUP_COOKIE}=${encodeURIComponent("user-1:recuperacao")}`
    expect(readPendingPasswordSetup(raw)).toBe("user-1")
    expect(readPendingPasswordSetupOrigin(raw)).toBe("recuperacao")
    expect(hasPendingPasswordSetupFor(raw, "user-1")).toBe(true)
    expect(hasPendingPasswordSetupFor(raw, "user-2")).toBe(false)
  })

  it("whenLegacyCookieWithoutOrigin_thenDefaultsToInvite", () => {
    const raw = `${PENDING_PASSWORD_SETUP_COOKIE}=user-1`
    expect(readPendingPasswordSetupOrigin(raw)).toBe("convite")
    expect(readPendingPasswordSetupOrigin(null)).toBeNull()
  })

  it("whenWrittenWithOrigin_thenCookieCarriesUserAndOrigin", () => {
    const doc = fakeDoc()
    writePendingPasswordSetup("user-1", { doc, secure: false, origem: "recuperacao" })
    const raw = doc.cookie
    expect(raw).toContain(encodeURIComponent("user-1:recuperacao"))
    expect(readPendingPasswordSetup(raw)).toBe("user-1")
    expect(readPendingPasswordSetupOrigin(raw)).toBe("recuperacao")
  })

  it("whenComparing_thenOnlyTheSameUserCounts", () => {
    const raw = `${PENDING_PASSWORD_SETUP_COOKIE}=user-1`
    expect(hasPendingPasswordSetupFor(raw, "user-1")).toBe(true)
    expect(hasPendingPasswordSetupFor(raw, "user-2")).toBe(false)
    expect(hasPendingPasswordSetupFor(raw, "")).toBe(false)
    expect(hasPendingPasswordSetupFor(null, "user-1")).toBe(false)
  })

  it("whenWriting_thenSetsCookieOnDocument", () => {
    const doc = fakeDoc()
    writePendingPasswordSetup("user-1", { doc, secure: false })
    expect(doc.cookie).toContain(`${PENDING_PASSWORD_SETUP_COOKIE}=user-1`)
    expect(doc.cookie).toContain("Max-Age=28800")
  })

  it("whenClearing_thenExpiresCookieImmediately", () => {
    const doc = fakeDoc(`${PENDING_PASSWORD_SETUP_COOKIE}=user-1`)
    clearPendingPasswordSetup({ doc, secure: false })
    expect(doc.cookie).toContain(`${PENDING_PASSWORD_SETUP_COOKIE}=`)
    expect(doc.cookie).toContain("Max-Age=0")
  })
})
