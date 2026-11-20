// @vitest-environment happy-dom
import { StrictMode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"

const { listInternalMfaFactors, enrollInternalTotp, challengeInternalMfa, verifyInternalMfa } =
  vi.hoisted(() => ({
    listInternalMfaFactors: vi.fn(),
    enrollInternalTotp: vi.fn(),
    challengeInternalMfa: vi.fn(),
    verifyInternalMfa: vi.fn(),
  }))

vi.mock("@/internal/data/internal-client", () => ({
  listInternalMfaFactors,
  enrollInternalTotp,
  challengeInternalMfa,
  verifyInternalMfa,
}))

import "@/i18n"
import { InternalMfaPage } from "../internal-mfa-page"
import { useInternalOperator } from "@/internal/guard/use-internal-operator"

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/internal/mfa"]}>
      <Routes>
        <Route path="/internal/mfa" element={<InternalMfaPage />} />
        <Route path="/internal" element={<div data-testid="home" />} />
      </Routes>
    </MemoryRouter>,
  )
}

/** StrictMode replaya mount → cleanup → mount: o desafio precisa reiniciar. */
function renderPageInStrictMode() {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={["/internal/mfa"]}>
        <Routes>
          <Route path="/internal/mfa" element={<InternalMfaPage />} />
          <Route path="/internal" element={<div data-testid="home" />} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  )
}

function otpInputs() {
  return screen.getAllByLabelText(/dígito \d de 6/i)
}

function fillCode(code: string) {
  const inputs = otpInputs()
  for (let index = 0; index < code.length; index += 1) {
    fireEvent.change(inputs[index], { target: { value: code[index] } })
  }
}

beforeEach(() => {
  listInternalMfaFactors.mockReset()
  enrollInternalTotp.mockReset()
  challengeInternalMfa.mockReset()
  verifyInternalMfa.mockReset()

  listInternalMfaFactors.mockResolvedValue([])
  enrollInternalTotp.mockResolvedValue({ factorId: "f-1", secret: "ABC123SECRET", uri: "otpauth://x" })
  challengeInternalMfa.mockResolvedValue("ch-1")
  verifyInternalMfa.mockResolvedValue({ ok: false })

  useInternalOperator.setState({
    state: "mfa-required",
    userId: null,
    aalKey: "aal1",
    checkedAt: null,
    lastFailure: null,
  })
})

afterEach(() => cleanup())

describe("whenEnrolling_thenManualKeyAndSixDigitInputAreShown", () => {
  it("enroll sem fator verificado exibe chave manual e 6 caixas", async () => {
    renderPage()

    expect(await screen.findByLabelText(/chave manual/i)).toBeTruthy()
    expect(otpInputs()).toHaveLength(6)
    expect((screen.getByLabelText(/chave manual/i) as HTMLInputElement).value).toBe("ABC123SECRET")
    expect(challengeInternalMfa).toHaveBeenCalledWith("f-1")
  })

  it("não promete códigos de recuperação (O6 não implementado)", async () => {
    const { container } = renderPage()
    await screen.findByLabelText(/chave manual/i)
    expect(container.textContent).not.toMatch(/códigos de recuperação|backup codes/i)
  })

  it("confirmar fica bloqueado antes dos 6 dígitos", async () => {
    renderPage()
    await screen.findByLabelText(/chave manual/i)
    const confirm = screen.getByRole("button", { name: /confirmar código/i }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
  })

  it("cada caixa tem id e name estáveis, sem perder o aria-label", async () => {
    renderPage()
    await screen.findByLabelText(/chave manual/i)

    const inputs = otpInputs()
    expect(inputs.map((input) => input.id)).toEqual([
      "internal-mfa-code-1",
      "internal-mfa-code-2",
      "internal-mfa-code-3",
      "internal-mfa-code-4",
      "internal-mfa-code-5",
      "internal-mfa-code-6",
    ])
    expect(inputs.map((input) => input.getAttribute("name"))).toEqual([
      "internal-mfa-code-1",
      "internal-mfa-code-2",
      "internal-mfa-code-3",
      "internal-mfa-code-4",
      "internal-mfa-code-5",
      "internal-mfa-code-6",
    ])
    expect(inputs[0].getAttribute("aria-label")).toBe("Dígito 1 de 6")
  })
})

describe("whenCodeIsWrong_thenAttemptsAreVisibleAndLockoutApplies", () => {
  it("código inválido mostra tentativas restantes", async () => {
    renderPage()
    await screen.findByLabelText(/chave manual/i)

    fillCode("123456")

    expect(await screen.findByText(/tentativas restantes: 4/i)).toBeTruthy()
    expect(verifyInternalMfa).toHaveBeenCalledWith({
      factorId: "f-1",
      challengeId: "ch-1",
      code: "123456",
    })
  })

  it("5 falhas bloqueiam o input com contagem regressiva", async () => {
    renderPage()
    await screen.findByLabelText(/chave manual/i)

    for (let attempt = 0; attempt < 5; attempt += 1) {
      fillCode("123456")
      await screen.findByText(/tentativas restantes|bloqueado/i)
    }

    expect(await screen.findByText(/bloqueado\. tente novamente em \d+s/i)).toBeTruthy()
    expect(otpInputs()[0].hasAttribute("disabled")).toBe(true)
  })
})

describe("whenStrictModeReplaysTheEffect_thenTheChallengeStillStarts", () => {
  it("duplo mount não trava em 'Preparando o desafio…'", async () => {
    renderPageInStrictMode()

    expect(await screen.findByLabelText(/chave manual/i)).toBeTruthy()
    expect(screen.queryByText(/preparando o desafio/i)).toBeNull()
    expect(otpInputs()).toHaveLength(6)
  })
})

describe("whenCodeIsCorrect_thenSessionResetsAndEntersHome", () => {
  it("verificação ok navega para /internal", async () => {
    verifyInternalMfa.mockResolvedValue({ ok: true })
    renderPage()
    await screen.findByLabelText(/chave manual/i)

    fillCode("654321")

    expect(await screen.findByTestId("home")).toBeTruthy()
  })
})

describe("whenPreparationFails_thenTheCopyIsHonestAndRetryIsExplicit", () => {
  it("falha de preparo não mascara o erro e oferece recarregar", async () => {
    listInternalMfaFactors.mockRejectedValue(new Error("422 Unprocessable Entity"))
    renderPage()

    const alert = await screen.findByRole("alert")
    expect(alert.textContent ?? "").toMatch(/não foi possível iniciar a verificação/i)
    expect(alert.textContent ?? "").toMatch(/recarregue e tente novamente/i)

    const retry = screen.getByRole("button", { name: /recarregar e tentar novamente/i })
    expect(retry.className).toMatch(/min-h-11/)
    expect(screen.queryByLabelText(/chave manual/i)).toBeNull()
  })
})
