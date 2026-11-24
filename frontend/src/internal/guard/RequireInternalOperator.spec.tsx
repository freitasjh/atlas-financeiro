// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom"

import "@/i18n"
import { RequireInternalOperator } from "./RequireInternalOperator"
import {
  configureOperatorRuntime,
  useInternalOperator,
  type OperatorWireResult,
} from "./use-internal-operator"
import type { OperatorGateState } from "./operator-gate"

function DeniedProbe() {
  const location = useLocation()
  return <div data-testid="denied" data-search={location.search} />
}

function renderGuard(state: OperatorGateState) {
  useInternalOperator.setState({
    state,
    userId: null,
    aalKey: null,
    checkedAt: null,
    lastFailure: null,
  })
  return render(
    <MemoryRouter initialEntries={["/internal"]}>
      <Routes>
        <Route
          path="/internal"
          element={
            <RequireInternalOperator>
              <div data-testid="guard-child" />
            </RequireInternalOperator>
          }
        />
        <Route path="/definir-senha" element={<div data-testid="set-password" />} />
        <Route path="/internal/mfa" element={<div data-testid="mfa" />} />
        <Route path="/internal/login" element={<div data-testid="login" />} />
        <Route path="/internal/acesso-negado" element={<DeniedProbe />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe("whenStateIsNotOperator_thenChildrenAreNeverMounted", () => {
  beforeEach(() => {
    cleanup()
  })

  it("checking ⇒ skeleton sem children", () => {
    renderGuard("checking")
    expect(screen.queryByTestId("guard-child")).toBeNull()
    expect(screen.getByText(/verificando acesso/i)).toBeTruthy()
  })

  it("first-access ⇒ redireciona para /definir-senha sem children", () => {
    renderGuard("first-access")
    expect(screen.queryByTestId("guard-child")).toBeNull()
    expect(screen.getByTestId("set-password")).toBeTruthy()
  })

  it("mfa-required ⇒ redireciona para /internal/mfa sem children", () => {
    renderGuard("mfa-required")
    expect(screen.queryByTestId("guard-child")).toBeNull()
    expect(screen.getByTestId("mfa")).toBeTruthy()
  })

  it("denied ⇒ navega para /internal/acesso-negado sem children (REQ-14)", async () => {
    renderGuard("denied")
    expect(screen.queryByTestId("guard-child")).toBeNull()
    const denied = await screen.findByTestId("denied")
    expect(denied.getAttribute("data-search")).toBe("")
  })

  it("error ⇒ navega para /internal/acesso-negado?motivo=indisponivel (SPEC §3.3)", async () => {
    renderGuard("error")
    expect(screen.queryByTestId("guard-child")).toBeNull()
    const denied = await screen.findByTestId("denied")
    expect(denied.getAttribute("data-search")).toBe("?motivo=indisponivel")
  })
})

describe("whenStateIsOperator_thenChildrenAreMounted", () => {
  beforeEach(() => {
    cleanup()
  })

  it("operator ⇒ children renderizados", () => {
    renderGuard("operator")
    expect(screen.getByTestId("guard-child")).toBeTruthy()
  })

  it("revalidação em background mantém children (skeleton só sem veredito)", async () => {
    const wire: OperatorWireResult = {
      status: 200,
      body: { is_operator: true, aal: "aal2", user_id: "u-1" },
      failure: null,
    }
    let release: ((value: OperatorWireResult) => void) | null = null
    configureOperatorRuntime({
      sessionKey: async () => ({ userId: "u-1", aalKey: "aal2" }),
      verify: () =>
        new Promise<OperatorWireResult>((resolve) => {
          release = resolve
        }),
    })

    renderGuard("operator")
    expect(screen.getByTestId("guard-child")).toBeTruthy()

    let pending: Promise<OperatorGateState> = Promise.resolve("operator")
    await act(async () => {
      pending = useInternalOperator.getState().verify({ force: true })
      // Deixa a sessão resolver e a chamada de rede (deferida) começar.
      await Promise.resolve()
    })
    expect(release).not.toBeNull()

    // Veredito já aplicado: o store não volta para `checking` e o guard não
    // desmonta o conteúdo durante a revalidação forçada.
    expect(screen.queryByText(/verificando acesso/i)).toBeNull()
    expect(screen.getByTestId("guard-child")).toBeTruthy()

    await act(async () => {
      release?.(wire)
      await pending
    })

    expect(screen.getByTestId("guard-child")).toBeTruthy()
    configureOperatorRuntime(null)
  })
})
