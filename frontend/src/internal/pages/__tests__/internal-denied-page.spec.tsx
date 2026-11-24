// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"

import "@/i18n"
import { InternalDeniedPage } from "../internal-denied-page"
import {
  configureOperatorRuntime,
  useInternalOperator,
} from "@/internal/guard/use-internal-operator"

function renderPage(search = "") {
  return render(
    <MemoryRouter initialEntries={[`/internal/acesso-negado${search}`]}>
      <Routes>
        <Route path="/internal/acesso-negado" element={<InternalDeniedPage />} />
        <Route path="/internal" element={<div data-testid="internal-home" />} />
        <Route path="/internal/tenants" element={<div data-testid="internal-tenants" />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useInternalOperator.setState({
    state: "denied",
    userId: "11111111-2222-3333-4444-555566667777",
    aalKey: "aal2",
    checkedAt: 1,
    lastFailure: null,
  })
})

afterEach(() => {
  cleanup()
  configureOperatorRuntime(null)
})

describe("whenAccessIsDenied_thenDomHasNoIdentityData", () => {
  it("copy fixa de acesso restrito", () => {
    const { container } = renderPage()
    expect(screen.getByRole("heading", { name: "Acesso restrito" })).toBeTruthy()
    expect(container.textContent).toContain(
      "Sua sessão não tem permissão para acessar esta área.",
    )
    expect(container.textContent).not.toContain("11111111-2222-3333-4444-555566667777")
    expect(container.textContent).not.toMatch(/super_admin|super admin|@/)
    expect(container.querySelector("nav")).toBeNull()
  })

  it("oferece verificar novamente e voltar ao aplicativo", () => {
    renderPage()
    expect(screen.getByRole("button", { name: /verificar novamente/i })).toBeTruthy()
    const back = screen.getByRole("link", { name: /voltar ao aplicativo/i })
    expect(back.getAttribute("href")).toBe("/")
  })
})

describe("whenVerificationFailed_thenErrorCopyIsUsed", () => {
  it("motivo=indisponivel troca a copy e vira alert", () => {
    renderPage("?motivo=indisponivel")
    const alert = screen.getByRole("alert")
    expect(alert.textContent).toContain("Verificação indisponível")
    expect(alert.textContent).toContain("Não foi possível confirmar o acesso agora")
  })
})

describe("whenRetryIsClicked_thenVerificationRunsExplicitly", () => {
  it("um clique = uma verificação", async () => {
    const verify = vi.fn(async () => ({
      status: 403,
      body: { is_operator: false },
      failure: null,
    }))
    configureOperatorRuntime({
      sessionKey: async () => ({ userId: "u-1", aalKey: "aal2" }),
      verify,
    })

    renderPage()
    fireEvent.click(screen.getByRole("button", { name: /verificar novamente/i }))

    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1))
  })

  it("retry com sucesso navega para /internal (não fica preso no acesso-negado)", async () => {
    configureOperatorRuntime({
      sessionKey: async () => ({ userId: "u-1", aalKey: "aal2" }),
      verify: async () => ({
        status: 200,
        body: { is_operator: true, aal: "aal2", user_id: "u-1" },
        failure: null,
      }),
    })

    renderPage()
    fireEvent.click(screen.getByRole("button", { name: /verificar novamente/i }))

    expect(await screen.findByTestId("internal-home")).toBeTruthy()
  })

  it("retry com sucesso respeita o ?retorno= da allowlist", async () => {
    configureOperatorRuntime({
      sessionKey: async () => ({ userId: "u-1", aalKey: "aal2" }),
      verify: async () => ({
        status: 200,
        body: { is_operator: true, aal: "aal2", user_id: "u-1" },
        failure: null,
      }),
    })

    renderPage("?retorno=/internal/tenants")
    fireEvent.click(screen.getByRole("button", { name: /verificar novamente/i }))

    expect(await screen.findByTestId("internal-tenants")).toBeTruthy()
  })
})
