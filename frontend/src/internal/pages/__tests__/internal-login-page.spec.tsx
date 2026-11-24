// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"

const { signInInternalOperator } = vi.hoisted(() => ({ signInInternalOperator: vi.fn() }))

vi.mock("@/internal/data/internal-client", () => ({ signInInternalOperator }))

import "@/i18n"
import { InternalLoginPage } from "../internal-login-page"
import { useInternalOperator } from "@/internal/guard/use-internal-operator"

function renderPage(search = "") {
  return render(
    <MemoryRouter initialEntries={[`/internal/login${search}`]}>
      <Routes>
        <Route path="/internal/login" element={<InternalLoginPage />} />
        <Route path="/internal" element={<div data-testid="home" />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  signInInternalOperator.mockReset()
  useInternalOperator.setState({
    state: "unauthenticated",
    userId: null,
    aalKey: null,
    checkedAt: null,
    lastFailure: null,
  })
})

afterEach(() => cleanup())

describe("whenLoginRenders_thenOnlyOperatorCredentialsExist", () => {
  it("tem e-mail e senha, sem cadastro e sem social", () => {
    const { container } = renderPage()
    expect(screen.getByLabelText(/e-mail/i)).toBeTruthy()
    expect(screen.getByLabelText(/senha/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: /entrar/i })).toBeTruthy()
    expect(container.querySelector('a[href*="solicitar-convite"]')).toBeNull()
    expect(container.textContent).not.toMatch(/criar conta|cadastre|google|github/i)
  })

  it("campos usam autofill e alvo de toque", () => {
    renderPage()
    const email = screen.getByLabelText(/e-mail/i) as HTMLInputElement
    const password = screen.getByLabelText(/senha/i) as HTMLInputElement
    expect(email.type).toBe("email")
    expect(email.autocomplete).toBe("username")
    expect(password.type).toBe("password")
    expect(password.autocomplete).toBe("current-password")
  })
})

describe("whenCredentialsAreInvalid_thenErrorIsLabelled", () => {
  it("credencial inválida mostra rótulo fixo", async () => {
    signInInternalOperator.mockResolvedValue({ ok: false })
    renderPage()

    fireEvent.change(screen.getByLabelText(/e-mail/i), { target: { value: "op@atlas.test" } })
    fireEvent.change(screen.getByLabelText(/senha/i), { target: { value: "segredo" } })
    fireEvent.click(screen.getByRole("button", { name: /entrar/i }))

    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toBe("E-mail ou senha inválidos.")
    expect(signInInternalOperator).toHaveBeenCalledWith("op@atlas.test", "segredo")
  })
})

describe("whenCredentialsAreValid_thenNavigatesToAllowlistedReturn", () => {
  it("retorno allowlisted é respeitado", async () => {
    signInInternalOperator.mockResolvedValue({ ok: true })
    renderPage("?retorno=/internal/tenants")

    fireEvent.change(screen.getByLabelText(/e-mail/i), { target: { value: "op@atlas.test" } })
    fireEvent.change(screen.getByLabelText(/senha/i), { target: { value: "segredo" } })
    fireEvent.click(screen.getByRole("button", { name: /entrar/i }))

    expect(signInInternalOperator).toHaveBeenCalledTimes(1)
  })

  it("retorno fora da allowlist cai em /internal", async () => {
    signInInternalOperator.mockResolvedValue({ ok: true })
    const { container } = renderPage("?retorno=//evil.example")

    fireEvent.change(screen.getByLabelText(/e-mail/i), { target: { value: "op@atlas.test" } })
    fireEvent.change(screen.getByLabelText(/senha/i), { target: { value: "segredo" } })
    fireEvent.click(screen.getByRole("button", { name: /entrar/i }))

    expect(container.textContent).not.toContain("evil")
  })
})
