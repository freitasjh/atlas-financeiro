import { describe, expect, it } from "vitest"

import {
  INITIAL_MFA_LOCKOUT,
  MFA_LOCKOUT_MS,
  MFA_LOCKOUT_THRESHOLD,
  OPERATOR_CACHE_TTL_MS,
  OPERATOR_GATE_STATES,
  VERIFY_CLIENT_TIMEOUT_MS,
  gateStateFromLabel,
  isFresh,
  isMfaLockedOut,
  mfaLockoutRemainingMs,
  registerMfaFailure,
  registerMfaSuccess,
  verdictFromEdge,
} from "./operator-gate"

const OPERATOR_BODY = { is_operator: true, aal: "aal2", user_id: "u-1" } as const

describe("whenEdgeResponds_thenVerdictMapsToGateState", () => {
  it("200 com is_operator/aal2/user_id ⇒ operator", () => {
    expect(verdictFromEdge(200, OPERATOR_BODY)).toEqual({
      state: "operator",
      failure: null,
      userId: "u-1",
    })
  })

  it("401 ⇒ unauthenticated", () => {
    expect(verdictFromEdge(401, { is_operator: false }).state).toBe("unauthenticated")
  })

  it("403 first-access ⇒ first-access", () => {
    expect(verdictFromEdge(403, { is_operator: false, error: "first-access" }).state).toBe(
      "first-access",
    )
  })

  it("403 mfa-required ⇒ mfa-required", () => {
    expect(verdictFromEdge(403, { is_operator: false, error: "mfa-required" }).state).toBe(
      "mfa-required",
    )
  })

  it("403 operator-inactive colapsa em denied", () => {
    expect(verdictFromEdge(403, { is_operator: false, error: "operator-inactive" }).state).toBe(
      "denied",
    )
  })

  it("403 genérico ⇒ denied", () => {
    expect(verdictFromEdge(403, { is_operator: false }).state).toBe("denied")
  })
})

describe("whenBodyIsHostile_thenNeverBecomesOperator", () => {
  it("corpo inválido (JSON nulo) com 200 ⇒ error", () => {
    expect(verdictFromEdge(200, null).state).toBe("error")
  })

  it("campo user_id faltando com 200 ⇒ error", () => {
    expect(verdictFromEdge(200, { is_operator: true, aal: "aal2" }).state).toBe("error")
  })

  it("aal errado com 200 ⇒ error", () => {
    expect(verdictFromEdge(200, { is_operator: true, aal: "aal1", user_id: "u-1" }).state).toBe(
      "error",
    )
  })

  it("is_operator não-boolean ⇒ error (200 e 403)", () => {
    expect(verdictFromEdge(200, { is_operator: "true", aal: "aal2", user_id: "u-1" }).state).toBe(
      "error",
    )
    expect(verdictFromEdge(403, { is_operator: "false" }).state).toBe("error")
  })

  it("403 sem is_operator=false ⇒ error", () => {
    expect(verdictFromEdge(403, {}).state).toBe("error")
    expect(verdictFromEdge(403, { is_operator: true }).state).toBe("error")
  })

  it("rótulo desconhecido ⇒ error", () => {
    expect(verdictFromEdge(403, { is_operator: false, error: "banido" }).state).toBe("error")
  })

  it("status inesperado e 5xx ⇒ error (failure server)", () => {
    expect(verdictFromEdge(429, {})).toMatchObject({ state: "error", failure: "server" })
    expect(verdictFromEdge(500, {})).toMatchObject({ state: "error", failure: "server" })
  })

  it("timeout/rede declarados ⇒ error com a falha", () => {
    expect(verdictFromEdge(null, null, "timeout")).toMatchObject({
      state: "error",
      failure: "timeout",
    })
    expect(verdictFromEdge(null, null, "network")).toMatchObject({
      state: "error",
      failure: "network",
    })
  })
})

describe("whenSessionIsConsidered_thenFreshnessFollowsTtl", () => {
  const session = { userId: "u-1", aalKey: "aal2" } as const

  it("operator dentro de 60 s ⇒ fresco", () => {
    expect(
      isFresh(
        { state: "operator", userId: "u-1", aalKey: "aal2", checkedAt: 1_000 },
        session,
        1_000 + OPERATOR_CACHE_TTL_MS - 1,
      ),
    ).toBe(true)
  })

  it("TTL esgotado ⇒ revalidar", () => {
    expect(
      isFresh(
        { state: "operator", userId: "u-1", aalKey: "aal2", checkedAt: 1_000 },
        session,
        1_000 + OPERATOR_CACHE_TTL_MS,
      ),
    ).toBe(false)
  })

  it("usuário diferente, estado não-operator ou relógio para trás ⇒ não fresco", () => {
    expect(
      isFresh(
        { state: "operator", userId: "u-2", aalKey: "aal2", checkedAt: 1_000 },
        session,
        1_001,
      ),
    ).toBe(false)
    expect(
      isFresh(
        { state: "denied", userId: "u-1", aalKey: "aal2", checkedAt: 1_000 },
        session,
        1_001,
      ),
    ).toBe(false)
    expect(
      isFresh(
        { state: "operator", userId: "u-1", aalKey: "aal2", checkedAt: 1_000 },
        session,
        999,
      ),
    ).toBe(false)
  })

  it("troca de sessão (userId) e mudança de aal ⇒ não fresco", () => {
    const entry = { state: "operator" as const, userId: "u-1", aalKey: "aal2" as const, checkedAt: 1_000 }
    // Sessão viva de outra conta: o cache do store não pode ser servido.
    expect(isFresh(entry, { userId: "u-2", aalKey: "aal2" }, 1_001)).toBe(false)
    // Enroll concluído: `aal1` → `aal2` muda a chave sem mudar `userId`.
    expect(isFresh(entry, { userId: "u-1", aalKey: "aal1" }, 1_001)).toBe(false)
    expect(isFresh(entry, { userId: null, aalKey: null }, 1_001)).toBe(false)
  })

  it("timeout do cliente é maior que o deadline de 5 s da Edge", () => {
    expect(VERIFY_CLIENT_TIMEOUT_MS).toBeGreaterThan(5_000)
    expect(OPERATOR_CACHE_TTL_MS).toBe(60_000)
  })
})

describe("whenMfaFails_thenLockoutIsApplied", () => {
  it("5 falhas consecutivas ⇒ 30 s de bloqueio com relógio injetado", () => {
    let lockout = INITIAL_MFA_LOCKOUT
    for (let attempt = 1; attempt < MFA_LOCKOUT_THRESHOLD; attempt += 1) {
      lockout = registerMfaFailure(lockout, 1_000)
      expect(isMfaLockedOut(lockout, 1_000)).toBe(false)
    }
    lockout = registerMfaFailure(lockout, 1_000)
    expect(isMfaLockedOut(lockout, 1_000)).toBe(true)
    expect(mfaLockoutRemainingMs(lockout, 1_000)).toBe(MFA_LOCKOUT_MS)
    expect(isMfaLockedOut(lockout, 1_000 + MFA_LOCKOUT_MS - 1)).toBe(true)
    expect(isMfaLockedOut(lockout, 1_000 + MFA_LOCKOUT_MS)).toBe(false)
  })

  it("sucesso limpa o lockout", () => {
    expect(registerMfaSuccess()).toEqual({ failures: 0, lockedUntil: null })
  })
})

describe("whenGateLabelArrives_thenItMapsToState", () => {
  it("rótulos conhecidos e desconhecidos", () => {
    expect(gateStateFromLabel("first-access-password-change-required")).toBe("first-access")
    expect(gateStateFromLabel("mfa-required")).toBe("mfa-required")
    expect(gateStateFromLabel("operator-inactive")).toBe("denied")
    expect(gateStateFromLabel("not-admin")).toBe("denied")
    expect(gateStateFromLabel("42501")).toBe("denied")
    expect(gateStateFromLabel("qualquer-outro")).toBeNull()
  })

  it("os 8 literais do store estão congelados", () => {
    expect(OPERATOR_GATE_STATES).toEqual([
      "unknown",
      "checking",
      "operator",
      "first-access",
      "mfa-required",
      "unauthenticated",
      "denied",
      "error",
    ])
  })
})
