// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"

import {
  isCacheExpired,
  shouldRevalidateOnFocus,
  useOperatorRevalidation,
} from "./use-operator-revalidation"
import {
  configureOperatorRuntime,
  setOperatorClock,
  useInternalOperator,
  type OperatorRuntime,
  type OperatorWireResult,
} from "./use-internal-operator"
import { FOCUS_REVALIDATE_MIN_INTERVAL_MS, OPERATOR_CACHE_TTL_MS } from "./operator-gate"

const OPERATOR_WIRE: OperatorWireResult = {
  status: 200,
  body: { is_operator: true, aal: "aal2", user_id: "u-1" },
  failure: null,
}

const SESSION = { userId: "u-1", aalKey: "aal2" } as const

let nowValue = 100_000
let nowSpy: ReturnType<typeof vi.spyOn>

function Probe() {
  useOperatorRevalidation()
  return <div data-testid="probe" />
}

function renderProbe(path = "/internal") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Probe />
    </MemoryRouter>,
  )
}

function setWarmOperator(checkedAt: number) {
  useInternalOperator.setState({
    state: "operator",
    userId: "u-1",
    aalKey: "aal2",
    checkedAt,
    lastFailure: null,
  })
}

function configure(overrides: Partial<OperatorRuntime> = {}) {
  const runtime: OperatorRuntime = {
    sessionKey: async () => SESSION,
    verify: async () => OPERATOR_WIRE,
    ...overrides,
  }
  configureOperatorRuntime(runtime)
  return runtime
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  cleanup()
  useInternalOperator.getState().reset()
  configureOperatorRuntime(null)
  nowValue = 100_000
  nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowValue)
  setOperatorClock(() => nowValue)
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  })
})

afterEach(() => {
  cleanup()
  configureOperatorRuntime(null)
  nowSpy.mockRestore()
  useInternalOperator.getState().reset()
})

describe("whenFocusIsConsidered_thenTheAntiThrashIntervalGoverns", () => {
  it("estado operator recente não revalida no foco", async () => {
    const verify = vi.fn(async () => OPERATOR_WIRE)
    configure({ verify })
    setWarmOperator(nowValue - 1_000)
    renderProbe()

    await act(async () => {
      window.dispatchEvent(new Event("focus"))
    })
    await flush()

    expect(verify).not.toHaveBeenCalled()
  })

  it("estado operator com intervalo anti-thrash vencido revalida no foco", async () => {
    const verify = vi.fn(async () => OPERATOR_WIRE)
    configure({ verify })
    setWarmOperator(nowValue - (FOCUS_REVALIDATE_MIN_INTERVAL_MS + 1))
    renderProbe()

    await act(async () => {
      window.dispatchEvent(new Event("focus"))
    })
    await flush()

    expect(verify).toHaveBeenCalledTimes(1)
  })

  it("estado não-operator revalida no foco mesmo recente", async () => {
    const verify = vi.fn(async () => OPERATOR_WIRE)
    configure({ verify })
    useInternalOperator.setState({
      state: "denied",
      userId: null,
      aalKey: null,
      checkedAt: nowValue,
      lastFailure: null,
    })
    renderProbe()

    await act(async () => {
      window.dispatchEvent(new Event("focus"))
    })
    await flush()

    expect(verify).toHaveBeenCalledTimes(1)
  })
})

describe("whenTheTabBecomesVisible_thenTheGuardRevalidates", () => {
  it("visibilitychange → visible com cache vencido revalida", async () => {
    const verify = vi.fn(async () => OPERATOR_WIRE)
    configure({ verify })
    setWarmOperator(nowValue - (FOCUS_REVALIDATE_MIN_INTERVAL_MS + 1))
    renderProbe()

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await flush()

    expect(verify).toHaveBeenCalledTimes(1)
  })
})

describe("whenTheCacheExpiresOnMount_thenTheTreeRevalidates", () => {
  it("nova montagem com TTL expirado revalida sem foco", async () => {
    const verify = vi.fn(async () => OPERATOR_WIRE)
    configure({ verify })
    setWarmOperator(nowValue - (OPERATOR_CACHE_TTL_MS + 1))

    renderProbe()
    await flush()

    expect(verify).toHaveBeenCalledTimes(1)
    expect(useInternalOperator.getState().state).toBe("operator")
  })

  it("nova montagem com cache quente não chama a Edge", async () => {
    const verify = vi.fn(async () => OPERATOR_WIRE)
    configure({ verify })
    setWarmOperator(nowValue - 1_000)

    renderProbe()
    await flush()

    expect(verify).not.toHaveBeenCalled()
  })
})

describe("whenAuthStateChanges_thenTheStoreResetsAndVerifies", () => {
  it("SIGNED_IN/SIGNED_OUT/TOKEN_REFRESHED/USER_UPDATED ⇒ reset + verify", async () => {
    let onChange: (() => void) | null = null
    const verify = vi.fn(async () => OPERATOR_WIRE)
    const subscribeAuth = vi.fn((callback: () => void) => {
      onChange = callback
      return () => {}
    })
    configure({ verify, subscribeAuth })

    useInternalOperator.setState({
      state: "denied",
      userId: "u-1",
      aalKey: "aal2",
      checkedAt: nowValue,
      lastFailure: null,
    })
    renderProbe()
    await flush()

    expect(subscribeAuth).toHaveBeenCalledTimes(1)
    expect(onChange).not.toBeNull()

    await act(async () => {
      onChange?.()
    })
    await flush()

    // `reset()` zera o veredito; `verify()` aplica o novo. A prova de que o
    // reset aconteceu é a verificação ter rodado mesmo com `denied` quente.
    expect(verify).toHaveBeenCalledTimes(1)
    expect(useInternalOperator.getState().state).toBe("operator")
  })

  it("sem subscribeAuth o hook não lança", () => {
    configure()
    expect(() => renderProbe()).not.toThrow()
    expect(screen.getByTestId("probe")).toBeTruthy()
  })
})

describe("whenFocusPolicyIsEvaluated_thenItIsPure", () => {
  it("operator só revalida após o intervalo; os demais estados sempre", () => {
    const now = 10_000
    expect(shouldRevalidateOnFocus("operator", now - 1_000, now)).toBe(false)
    expect(shouldRevalidateOnFocus("operator", now - (FOCUS_REVALIDATE_MIN_INTERVAL_MS + 1), now)).toBe(
      true,
    )
    expect(shouldRevalidateOnFocus("operator", null, now)).toBe(true)
    expect(shouldRevalidateOnFocus("denied", now, now)).toBe(true)
    expect(shouldRevalidateOnFocus("error", now, now)).toBe(true)
    // relógio para trás ⇒ fail-closed
    expect(shouldRevalidateOnFocus("operator", now + 1, now)).toBe(true)
  })

  it("isCacheExpired segue o TTL de 60 s", () => {
    const now = 10_000
    expect(isCacheExpired(now - 1_000, now)).toBe(false)
    expect(isCacheExpired(now - OPERATOR_CACHE_TTL_MS, now)).toBe(true)
    expect(isCacheExpired(null, now)).toBe(true)
    expect(isCacheExpired(now + 1, now)).toBe(true)
  })
})
