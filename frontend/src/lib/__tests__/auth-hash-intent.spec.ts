import { describe, it, expect } from "vitest"

import {
  authHashDestination,
  readAuthHashIntent,
} from "@/lib/auth-hash-intent"

describe("readAuthHashIntent", () => {
  it("whenHashIsRouterRoute_thenIntentIsNone", () => {
    expect(readAuthHashIntent("#/definir-senha?origem=convite")).toEqual({ kind: "none" })
    expect(readAuthHashIntent("#/")).toEqual({ kind: "none" })
    expect(readAuthHashIntent("")).toEqual({ kind: "none" })
    expect(readAuthHashIntent("#")).toEqual({ kind: "none" })
  })

  it("whenHashHasInviteSession_thenReturnsInviteSessionIntent", () => {
    const intent = readAuthHashIntent(
      "#access_token=at-123&refresh_token=rt-456&expires_in=3600&token_type=bearer&type=invite",
    )
    expect(intent).toEqual({
      kind: "session",
      flow: "invite",
      accessToken: "at-123",
      refreshToken: "rt-456",
    })
  })

  it("whenHashHasRecoverySession_thenReturnsRecoveryIntent", () => {
    const intent = readAuthHashIntent(
      "#access_token=at&refresh_token=rt&type=recovery",
    )
    expect(intent).toMatchObject({ kind: "session", flow: "recovery" })
  })

  it("whenTypeIsMissing_thenFlowDefaultsToInvite", () => {
    const intent = readAuthHashIntent("#access_token=at&refresh_token=rt")
    expect(intent).toMatchObject({ kind: "session", flow: "invite" })
  })

  it("whenHashHasOtpExpiredError_thenReasonIsExpirado", () => {
    const intent = readAuthHashIntent(
      "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    )
    expect(intent).toEqual({ kind: "error", reason: "expirado", errorCode: "otp_expired" })
  })

  it("whenHashHasOtherAuthError_thenReasonIsInvalido", () => {
    expect(
      readAuthHashIntent("#error=access_denied&error_code=otp_disabled"),
    ).toEqual({ kind: "error", reason: "invalido", errorCode: "otp_disabled" })
    expect(
      readAuthHashIntent("#error=invalid_request&error_code=unknown_code"),
    ).toEqual({ kind: "error", reason: "invalido", errorCode: "unknown_code" })
  })

  it("whenAccessTokenHasNoRefreshToken_thenReturnsInvalidoError", () => {
    expect(readAuthHashIntent("#access_token=at&type=invite")).toEqual({
      kind: "error",
      reason: "invalido",
      errorCode: null,
    })
  })

  it("whenHashOnlyHasUnrelatedParams_thenIntentIsNone", () => {
    expect(readAuthHashIntent("#foo=bar&baz=1")).toEqual({ kind: "none" })
  })

  it("whenTokensAreUrlEncoded_thenDecodesThem", () => {
    const intent = readAuthHashIntent(
      "#access_token=a%2Bb%3Dc&refresh_token=r%2Ft&type=invite",
    )
    expect(intent).toMatchObject({
      kind: "session",
      accessToken: "a+b=c",
      refreshToken: "r/t",
    })
  })
})

describe("authHashDestination", () => {
  it("whenInviteSession_thenDestinesToSetPasswordInvite", () => {
    expect(
      authHashDestination({
        kind: "session",
        flow: "invite",
        accessToken: "a",
        refreshToken: "r",
      }),
    ).toBe("/definir-senha?origem=convite")
  })

  it("whenRecoverySession_thenDestinesToSetPasswordRecovery", () => {
    expect(
      authHashDestination({
        kind: "session",
        flow: "recovery",
        accessToken: "a",
        refreshToken: "r",
      }),
    ).toBe("/definir-senha?origem=recuperacao")
  })

  it("whenOtherSessionFlow_thenDestinesToRoot", () => {
    expect(
      authHashDestination({
        kind: "session",
        flow: "magiclink",
        accessToken: "a",
        refreshToken: "r",
      }),
    ).toBe("/")
  })

  it("whenErrorIntent_thenDestinesToLinkExpiredWithReason", () => {
    expect(
      authHashDestination({ kind: "error", reason: "expirado", errorCode: "otp_expired" }),
    ).toBe("/link-expirado?motivo=expirado")
    expect(
      authHashDestination({ kind: "error", reason: "invalido", errorCode: null }),
    ).toBe("/link-expirado?motivo=invalido")
  })

  it("whenNoneIntent_thenNoDestination", () => {
    expect(authHashDestination({ kind: "none" })).toBeNull()
  })
})
