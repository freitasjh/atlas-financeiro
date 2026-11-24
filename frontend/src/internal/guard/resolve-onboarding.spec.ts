import { describe, expect, it } from "vitest"

import type { OperatorGateState } from "./operator-gate"
import {
  INTERNAL_DENIED_PATH,
  INTERNAL_HOME_PATH,
  INTERNAL_LOGIN_PATH,
  INTERNAL_MFA_PATH,
  isOnboardingTerminal,
  resolveOnboardingHref,
  resolveOnboardingRoute,
  sanitizeReturnTo,
} from "./resolve-onboarding"

const SURFACES = ["internal", "tenant"] as const
const DECISION_STATES: readonly OperatorGateState[] = [
  "checking",
  "operator",
  "first-access",
  "mfa-required",
  "unauthenticated",
  "denied",
  "error",
]

describe("whenResolverRuns_thenItIsIdempotent", () => {
  it.each(
    SURFACES.flatMap((surface) =>
      DECISION_STATES.map((gateState) => [surface, gateState] as const),
    ),
  )("surface=%s state=%s ⇒ resolve(resolve(x)) === resolve(x)", (surface, gateState) => {
    const input = {
      surface,
      hasSession: gateState !== "unauthenticated",
      gateState,
    } as const
    const first = resolveOnboardingRoute(input)
    const second = resolveOnboardingRoute({
      ...input,
      requestedPath: `${first.path}${first.search}`,
    })
    expect(second).toEqual(first)
  })

  it("unknown não redireciona (sentinela pré-mount)", () => {
    const target = resolveOnboardingRoute({
      surface: "internal",
      hasSession: true,
      gateState: "unknown",
    })
    expect(target).toMatchObject({ path: INTERNAL_HOME_PATH, terminal: false })
  })
})

describe("whenGateStateDecides_thenDestinationsAreTerminal", () => {
  it("first-access ⇒ /definir-senha com retorno allowlisted", () => {
    const target = resolveOnboardingRoute({
      surface: "internal",
      hasSession: true,
      gateState: "first-access",
    })
    expect(target).toMatchObject({
      path: "/definir-senha",
      search: "?origem=convite&retorno=/internal",
      guard: "none",
      terminal: true,
    })
  })

  it("mfa-required ⇒ /internal/mfa (guard mfa)", () => {
    expect(
      resolveOnboardingRoute({ surface: "internal", hasSession: true, gateState: "mfa-required" }),
    ).toMatchObject({ path: INTERNAL_MFA_PATH, guard: "mfa-required", terminal: true })
  })

  it("unauthenticated/sem sessão ⇒ login da superfície", () => {
    expect(
      resolveOnboardingRoute({ surface: "internal", hasSession: false, gateState: "checking" }),
    ).toMatchObject({ path: INTERNAL_LOGIN_PATH, terminal: true })
    expect(
      resolveOnboardingRoute({ surface: "tenant", hasSession: false, gateState: "checking" }),
    ).toMatchObject({ path: "/login", terminal: true })
  })

  it("denied ⇒ acesso-negado e error ⇒ acesso-negado?motivo=indisponivel", () => {
    expect(
      resolveOnboardingRoute({ surface: "internal", hasSession: true, gateState: "denied" }),
    ).toMatchObject({ path: INTERNAL_DENIED_PATH, terminal: true })
    expect(
      resolveOnboardingRoute({ surface: "internal", hasSession: true, gateState: "error" }),
    ).toMatchObject({
      path: INTERNAL_DENIED_PATH,
      search: "?motivo=indisponivel",
      terminal: true,
    })
  })

  it("operator ⇒ rota pedida, sem guard de redirecionamento", () => {
    expect(
      resolveOnboardingRoute({
        surface: "internal",
        hasSession: true,
        gateState: "operator",
        requestedPath: "/internal/tenants",
      }),
    ).toMatchObject({ path: "/internal/tenants", guard: "operator", terminal: false })
  })

  it("cookie pendente vence o veredito (onboarding único)", () => {
    expect(
      resolveOnboardingRoute({
        surface: "internal",
        hasSession: true,
        gateState: "operator",
        pendingPasswordSetup: true,
      }),
    ).toMatchObject({ path: "/definir-senha", terminal: true })
  })
})

describe("whenRouteIsTerminal_thenItIsDeclared", () => {
  it("terminais e não-terminais", () => {
    expect(isOnboardingTerminal({ path: "/definir-senha", search: "", guard: "none", terminal: true })).toBe(true)
    expect(isOnboardingTerminal({ path: INTERNAL_MFA_PATH, search: "", guard: "mfa-required", terminal: true })).toBe(true)
    expect(isOnboardingTerminal({ path: INTERNAL_HOME_PATH, search: "", guard: "operator", terminal: false })).toBe(false)
  })

  it("href concatena path e search", () => {
    expect(
      resolveOnboardingHref({ surface: "internal", hasSession: true, gateState: "error" }),
    ).toBe(`${INTERNAL_DENIED_PATH}?motivo=indisponivel`)
  })
})

describe("whenRetornoIsHostile_thenAllowlistRejects", () => {
  it("aceita apenas caminhos conhecidos", () => {
    expect(sanitizeReturnTo("/")).toBe("/")
    expect(sanitizeReturnTo("/internal")).toBe("/internal")
    expect(sanitizeReturnTo("/internal/tenants")).toBe("/internal/tenants")
    expect(sanitizeReturnTo("/internal/auditoria")).toBe("/internal/auditoria")
  })

  it.each([
    "//evil.com",
    "https://evil.com",
    "/\\evil",
    "/internal/../admin",
    "/internal/tenants/abc",
    "javascript:alert(1)",
    "/internal?x=1",
    "",
  ])("rejeita %s e cai no fallback", (raw) => {
    expect(sanitizeReturnTo(raw)).toBe(INTERNAL_HOME_PATH)
  })

  it("valor não-string cai no fallback", () => {
    expect(sanitizeReturnTo(null)).toBe(INTERNAL_HOME_PATH)
    expect(sanitizeReturnTo(undefined)).toBe(INTERNAL_HOME_PATH)
  })
})
