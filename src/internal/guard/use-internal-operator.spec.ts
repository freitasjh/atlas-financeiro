import { beforeEach, describe, expect, it, vi } from "vitest"

import { OPERATOR_CACHE_TTL_MS, OPERATOR_GATE_STATES, type OperatorGateState, type SessionKey } from "./operator-gate"
import {
  configureOperatorRuntime,
  setOperatorClock,
  useInternalOperator,
  type OperatorWireResult,
} from "./use-internal-operator"

const OPERATOR_WIRE: OperatorWireResult = {
  status: 200,
  body: { is_operator: true, aal: "aal2", user_id: "u-1" },
  failure: null,
}

const SESSION = { userId: "u-1", aalKey: "aal2" } as const

function resetStore(): void {
  useInternalOperator.getState().reset()
}

describe("whenStoreIsCreated_thenItIsMemoryOnly", () => {
  it("expõe os 8 literais e nasce em unknown", () => {
    expect(OPERATOR_GATE_STATES).toHaveLength(8)
    expect(useInternalOperator.getState().state).toBe("unknown")
  })

  it("não registra middleware persist (sem storage)", () => {
    expect(Object.prototype.hasOwnProperty.call(useInternalOperator, "persist")).toBe(false)
  })
})

describe("whenVerificationRuns_thenStateFollowsTheEdge", () => {
  beforeEach(() => {
    resetStore()
    setOperatorClock(() => 1_000)
    configureOperatorRuntime(null)
  })

  it("200 ⇒ operator com userId/checkedAt", async () => {
    configureOperatorRuntime({
      sessionKey: async () => SESSION,
      verify: async () => OPERATOR_WIRE,
    })
    const state = await useInternalOperator.getState().verify({ force: true })
    expect(state).toBe("operator")
    expect(useInternalOperator.getState()).toMatchObject({
      state: "operator",
      userId: "u-1",
      aalKey: "aal2",
      checkedAt: 1_000,
      lastFailure: null,
    })
  })

  it.each<[string, OperatorWireResult, OperatorGateState]>([
    ["401", { status: 401, body: { is_operator: false }, failure: null }, "unauthenticated"],
    [
      "403 first-access",
      { status: 403, body: { is_operator: false, error: "first-access" }, failure: null },
      "first-access",
    ],
    [
      "403 mfa-required",
      { status: 403, body: { is_operator: false, error: "mfa-required" }, failure: null },
      "mfa-required",
    ],
    [
      "403 operator-inactive",
      { status: 403, body: { is_operator: false, error: "operator-inactive" }, failure: null },
      "denied",
    ],
    ["403 genérico", { status: 403, body: { is_operator: false }, failure: null }, "denied"],
    ["timeout", { status: null, body: null, failure: "timeout" }, "error"],
  ])("desfecho %s ⇒ %s", async (_label, wire, expected) => {
    configureOperatorRuntime({ sessionKey: async () => SESSION, verify: async () => wire })
    const state = await useInternalOperator.getState().verify({ force: true })
    expect(state).toBe(expected)
    expect(useInternalOperator.getState().state).toBe(expected)
  })

  it("sem runtime configurado ⇒ error (fail-closed)", async () => {
    const state = await useInternalOperator.getState().verify({ force: true })
    expect(state).toBe("error")
    expect(useInternalOperator.getState().lastFailure).toBe("server")
  })
})

describe("whenCacheIsWarm_thenTtlGovernsRevalidation", () => {
  beforeEach(() => {
    resetStore()
    configureOperatorRuntime(null)
  })

  it("dentro de 60 s não revalida; após TTL revalida", async () => {
    let now = 1_000
    setOperatorClock(() => now)
    const verify = vi.fn(async () => OPERATOR_WIRE)
    configureOperatorRuntime({ sessionKey: async () => SESSION, verify })

    await useInternalOperator.getState().verify({ force: true })
    now += OPERATOR_CACHE_TTL_MS - 1
    await useInternalOperator.getState().verify()
    expect(verify).toHaveBeenCalledTimes(1)

    now += 1
    await useInternalOperator.getState().verify()
    expect(verify).toHaveBeenCalledTimes(2)
  })

  it("troca de sessão com userId diferente ⇒ não serve o cache e revalida", async () => {
    let now = 1_000
    setOperatorClock(() => now)
    const verify = vi.fn(async () => OPERATOR_WIRE)
    const sessionKey = vi.fn<() => Promise<SessionKey>>(async () => SESSION)
    configureOperatorRuntime({ sessionKey, verify })

    await useInternalOperator.getState().verify({ force: true })
    expect(useInternalOperator.getState().state).toBe("operator")

    // Sessão viva de outra conta: o cache do store não pode ser servido.
    sessionKey.mockResolvedValue({ userId: "u-2", aalKey: "aal2" })
    now += 1_000
    const state = await useInternalOperator.getState().verify()

    expect(verify).toHaveBeenCalledTimes(2)
    expect(state).toBe("operator")
  })

  it("revalidação que falha nunca serve o valor anterior", async () => {
    let now = 1_000
    setOperatorClock(() => now)
    const verify = vi
      .fn<() => Promise<OperatorWireResult>>()
      .mockResolvedValueOnce(OPERATOR_WIRE)
      .mockResolvedValueOnce({ status: null, body: null, failure: "timeout" })
    configureOperatorRuntime({ sessionKey: async () => SESSION, verify })

    await useInternalOperator.getState().verify({ force: true })
    expect(useInternalOperator.getState().state).toBe("operator")

    now += OPERATOR_CACHE_TTL_MS + 1
    const next = await useInternalOperator.getState().verify()
    expect(next).toBe("error")
    expect(useInternalOperator.getState().state).toBe("error")
    expect(useInternalOperator.getState().userId).toBeNull()
  })
})

describe("whenAGenerationIsStale_thenTheOldResponseIsDiscarded", () => {
  beforeEach(() => {
    resetStore()
    setOperatorClock(() => 1_000)
    configureOperatorRuntime(null)
  })

  it("reset durante a verificação impede o veredito antigo", async () => {
    const deferred: { release: ((wire: OperatorWireResult) => void) | null } = { release: null }
    configureOperatorRuntime({
      sessionKey: async () => SESSION,
      verify: () =>
        new Promise<OperatorWireResult>((resolve) => {
          deferred.release = resolve
        }),
    })

    const pending = useInternalOperator.getState().verify({ force: true })
    await Promise.resolve()
    useInternalOperator.getState().reset()
    deferred.release?.(OPERATOR_WIRE)
    await pending

    expect(useInternalOperator.getState().state).toBe("unknown")
  })

  it("veredito de outro userId é descartado", async () => {
    configureOperatorRuntime({
      sessionKey: async () => SESSION,
      verify: async () => ({
        status: 200,
        body: { is_operator: true, aal: "aal2", user_id: "u-2" },
        failure: null,
      }),
    })
    await useInternalOperator.getState().verify({ force: true })
    expect(useInternalOperator.getState().state).not.toBe("operator")
  })
})

describe("whenInvalidated_thenOneRevalidationRuns", () => {
  beforeEach(() => {
    resetStore()
    setOperatorClock(() => 1_000)
    configureOperatorRuntime(null)
  })

  it("rótulo de gate mapeia o estado e dispara uma única revalidação", async () => {
    const verify = vi.fn(async () => ({
      status: 403,
      body: { is_operator: false, error: "mfa-required" },
      failure: null,
    }))
    configureOperatorRuntime({ sessionKey: async () => SESSION, verify })

    const mapped = useInternalOperator.getState().invalidate("operator-inactive")
    expect(mapped).toBe("denied")
    await Promise.resolve()
    await Promise.resolve()
    expect(verify).toHaveBeenCalledTimes(1)
  })

  it("reset devolve o estado inicial", () => {
    useInternalOperator.setState({ state: "denied", userId: "u-1" })
    useInternalOperator.getState().reset()
    expect(useInternalOperator.getState()).toMatchObject({
      state: "unknown",
      userId: null,
      checkedAt: null,
    })
  })
})
