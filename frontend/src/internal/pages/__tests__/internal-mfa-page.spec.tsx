// @vitest-environment happy-dom
import { StrictMode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"

const {
  listInternalMfaFactors,
  enrollInternalTotp,
  unenrollUnverifiedInternalTotpFactors,
  challengeInternalMfa,
  verifyInternalMfa,
  consumeRecoveryCode,
  recoveryCodesService,
} = vi.hoisted(() => ({
  listInternalMfaFactors: vi.fn(),
  enrollInternalTotp: vi.fn(),
  unenrollUnverifiedInternalTotpFactors: vi.fn(),
  challengeInternalMfa: vi.fn(),
  verifyInternalMfa: vi.fn(),
  consumeRecoveryCode: vi.fn(),
  recoveryCodesService: {
    generate: vi.fn(),
    status: vi.fn(),
    regenerate: vi.fn(),
  },
}))

vi.mock("@/internal/data/internal-client", () => ({
  listInternalMfaFactors,
  enrollInternalTotp,
  unenrollUnverifiedInternalTotpFactors,
  challengeInternalMfa,
  verifyInternalMfa,
  consumeRecoveryCode,
}))

vi.mock("@/internal/data/mfa-recovery-codes.service", () => ({ recoveryCodesService }))

const RECOVERY_CODES = Array.from(
  { length: 10 },
  (_, row) =>
    Array.from({ length: 24 }, (_, column) =>
      "abcdefghijklmnopqrstuvwxyz"[(row + column) % 26],
    ).join(""),
)

import i18n from "@/i18n"
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
  unenrollUnverifiedInternalTotpFactors.mockReset()
  challengeInternalMfa.mockReset()
  verifyInternalMfa.mockReset()
  consumeRecoveryCode.mockReset()
  recoveryCodesService.generate.mockReset()
  recoveryCodesService.status.mockReset()
  recoveryCodesService.regenerate.mockReset()

  recoveryCodesService.generate.mockResolvedValue({
    ok: true,
    data: { set_id: "00000000-0000-4000-8000-000000000001", codes: RECOVERY_CODES },
  })

  listInternalMfaFactors.mockResolvedValue([])
  enrollInternalTotp.mockResolvedValue({ factorId: "f-1", secret: "ABC123SECRET", uri: "otpauth://x" })
  unenrollUnverifiedInternalTotpFactors.mockResolvedValue(undefined)
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

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage("pt-BR")
})

describe("whenEnrolling_thenManualKeyAndSixDigitInputAreShown", () => {
  it("enroll sem fator verificado exibe chave manual e 6 caixas", async () => {
    renderPage()

    expect(await screen.findByLabelText(/chave manual/i)).toBeTruthy()
    expect(otpInputs()).toHaveLength(6)
    expect((screen.getByLabelText(/chave manual/i) as HTMLInputElement).value).toBe("ABC123SECRET")
    expect(challengeInternalMfa).toHaveBeenCalledWith("f-1")
  })

  it("oferece contingência de código de recuperação no desafio", async () => {
    renderPage()
    await screen.findByLabelText(/chave manual/i)
    expect(screen.getByRole("button", { name: /usar código de recuperação/i })).toBeTruthy()
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

  it("duplo mount não duplica list/unenroll/enroll/challenge", async () => {
    renderPageInStrictMode()

    await screen.findByLabelText(/chave manual/i)

    expect(listInternalMfaFactors).toHaveBeenCalledTimes(1)
    expect(unenrollUnverifiedInternalTotpFactors).toHaveBeenCalledTimes(1)
    expect(enrollInternalTotp).toHaveBeenCalledTimes(1)
    expect(challengeInternalMfa).toHaveBeenCalledTimes(1)
  })
})

describe("whenAnUnverifiedFactorExists_thenBootstrapCleansBeforeEnrolling", () => {
  it("unenroll de totp unverified acontece antes do enroll", async () => {
    const factors = [{ id: "stale", status: "unverified", friendlyName: "" }]
    listInternalMfaFactors.mockResolvedValue(factors)
    renderPage()

    await screen.findByLabelText(/chave manual/i)

    expect(unenrollUnverifiedInternalTotpFactors).toHaveBeenCalledWith(factors)
    expect(unenrollUnverifiedInternalTotpFactors.mock.invocationCallOrder[0]).toBeLessThan(
      enrollInternalTotp.mock.invocationCallOrder[0],
    )
  })

  it("fator verificado é reaproveitado, sem unenroll nem enroll", async () => {
    listInternalMfaFactors.mockResolvedValue([{ id: "ok", status: "verified", friendlyName: "Atlas Internal" }])
    renderPage()

    expect(await screen.findByText(/código de 6 dígitos/i)).toBeTruthy()
    expect(challengeInternalMfa).toHaveBeenCalledWith("ok")
    expect(unenrollUnverifiedInternalTotpFactors).not.toHaveBeenCalled()
    expect(enrollInternalTotp).not.toHaveBeenCalled()
  })
})

describe("whenCodeIsCorrect_thenSessionResetsAndEntersHome", () => {
  it("enrollment exige a etapa 3 antes de navegar", async () => {
    verifyInternalMfa.mockResolvedValue({ ok: true })
    renderPage()
    await screen.findByLabelText(/chave manual/i)

    fillCode("654321")

    expect(await screen.findByRole("dialog")).toBeTruthy()
    expect(recoveryCodesService.generate).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("home")).toBeNull()

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /confirmo que copiei ou baixei meus 10 códigos de recuperação/i,
      }),
    )
    fireEvent.click(screen.getByRole("button", { name: /concluir/i }))

    expect(await screen.findByTestId("home")).toBeTruthy()
  })

  it("fator verificado navega direto, sem lista nova", async () => {
    listInternalMfaFactors.mockResolvedValue([
      { id: "ok", status: "verified", friendlyName: "Atlas Internal" },
    ])
    verifyInternalMfa.mockResolvedValue({ ok: true })
    renderPage()
    await screen.findByText(/código de 6 dígitos/i)

    fillCode("654321")

    expect(await screen.findByTestId("home")).toBeTruthy()
    expect(recoveryCodesService.generate).not.toHaveBeenCalled()
  })

  it("falha na geração não libera /internal", async () => {
    verifyInternalMfa.mockResolvedValue({ ok: true })
    recoveryCodesService.generate.mockResolvedValue({
      ok: false,
      error: "mfa-recovery-active-set-conflict",
      status: 409,
    })
    renderPage()
    await screen.findByLabelText(/chave manual/i)

    fillCode("654321")

    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(screen.queryByTestId("home")).toBeNull()
  })
})

describe("whenRecoveryFallbackIsUsed_thenOnlyAal2PromotionEntersHome", () => {
  it("código válido consome, renova e navega", async () => {
    listInternalMfaFactors.mockResolvedValue([
      { id: "ok", status: "verified", friendlyName: "Atlas Internal" },
    ])
    consumeRecoveryCode.mockResolvedValue({ ok: true, remaining: 9 })
    renderPage()
    await screen.findByText(/código de 6 dígitos/i)

    fireEvent.click(screen.getByRole("button", { name: /usar código de recuperação/i }))
    fireEvent.change(await screen.findByLabelText(/código de recuperação/i), {
      target: { value: "abcdefghijklmnopqrstuvwx" },
    })
    fireEvent.click(screen.getByRole("button", { name: /verificar código/i }))

    expect(await screen.findByTestId("home")).toBeTruthy()
    expect(consumeRecoveryCode).toHaveBeenCalledWith("abcdefghijklmnopqrstuvwx")
  })

  it("promoção falha mantém o operador no desafio", async () => {
    listInternalMfaFactors.mockResolvedValue([
      { id: "ok", status: "verified", friendlyName: "Atlas Internal" },
    ])
    consumeRecoveryCode.mockResolvedValue({ ok: false, error: "mfa-recovery-aal-promotion-failed" })
    renderPage()
    await screen.findByText(/código de 6 dígitos/i)

    fireEvent.click(screen.getByRole("button", { name: /usar código de recuperação/i }))
    fireEvent.change(await screen.findByLabelText(/código de recuperação/i), {
      target: { value: "abcdefghijklmnopqrstuvwx" },
    })
    fireEvent.click(screen.getByRole("button", { name: /verificar código/i }))

    expect(await screen.findByText(/não foi possível elevar a sessão/i)).toBeTruthy()
    expect(screen.queryByTestId("home")).toBeNull()
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

  it("retry explícito roda um novo bootstrap completo", async () => {
    listInternalMfaFactors
      .mockRejectedValueOnce(new Error("422 Unprocessable Entity"))
      .mockResolvedValueOnce([])
    renderPage()

    const retry = await screen.findByRole("button", { name: /recarregar e tentar novamente/i })
    fireEvent.click(retry)

    expect(await screen.findByLabelText(/chave manual/i)).toBeTruthy()
    expect(listInternalMfaFactors).toHaveBeenCalledTimes(2)
    expect(enrollInternalTotp).toHaveBeenCalledTimes(1)
    expect(challengeInternalMfa).toHaveBeenCalledTimes(1)
  })
})

describe("whenEnrolling_thenQrCodeIsAccessibleAndDerivedFromUri", () => {
  it("exibe QR com role img, título acessível e 2 paths, preservando a chave manual", async () => {
    renderPage()

    const qr = await screen.findByRole("img", { name: /qr code para configurar o segundo fator/i })
    expect(qr.tagName.toLowerCase()).toBe("svg")
    expect(qr.getAttribute("viewBox")).toBeTruthy()
    expect(qr.querySelectorAll("path")).toHaveLength(2)
    expect(qr.querySelector("title")?.textContent).toMatch(/qr code/i)
    expect(screen.getByLabelText(/chave manual/i)).toBeTruthy()
  })

  it("o desenho do QR muda quando enrollment.uri muda", async () => {
    enrollInternalTotp.mockResolvedValue({
      factorId: "f-1",
      secret: "ABC123SECRET",
      uri: "otpauth://totp/Atlas:A?secret=ABC123SECRET",
    })
    const first = renderPage()
    const firstQr = await first.findByRole("img", { name: /qr code/i })
    const firstPath = firstQr.querySelectorAll("path")[1]?.getAttribute("d")
    cleanup()

    enrollInternalTotp.mockResolvedValue({
      factorId: "f-2",
      secret: "ABC123SECRET",
      uri: "otpauth://totp/Atlas:B?secret=ABC123SECRET",
    })
    const second = renderPage()
    const secondQr = await second.findByRole("img", { name: /qr code/i })
    const secondPath = secondQr.querySelectorAll("path")[1]?.getAttribute("d")

    expect(firstPath).toBeTruthy()
    expect(secondPath).toBeTruthy()
    expect(secondPath).not.toBe(firstPath)
  })

  it("nome acessível do QR acompanha en-US", async () => {
    await i18n.changeLanguage("en-US")
    renderPage()

    expect(
      await screen.findByRole("img", { name: /qr code to set up the second factor/i }),
    ).toBeTruthy()
  })

  it("não grava secret/uri em log nem na URL", async () => {
    const methods = ["log", "info", "warn", "error"] as const
    const spies = methods.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined))
    try {
      renderPage()
      await screen.findByRole("img", { name: /qr code/i })

      for (const spy of spies) {
        for (const args of spy.mock.calls) {
          const rendered = args.map((arg) => (typeof arg === "string" ? arg : "")).join(" ")
          expect(rendered).not.toMatch(/ABC123SECRET|otpauth:\/\//)
        }
      }
      expect(window.location.href).not.toMatch(/ABC123SECRET|otpauth:/)
    } finally {
      spies.forEach((spy) => spy.mockRestore())
    }
  })

  it("fator já verificado reaproveita a sessão e não exibe QR de enroll", async () => {
    listInternalMfaFactors.mockResolvedValue([
      { id: "ok", status: "verified", friendlyName: "Atlas Internal" },
    ])
    renderPage()

    await screen.findByText(/código de 6 dígitos/i)
    expect(screen.queryByRole("img", { name: /qr code/i })).toBeNull()
  })
})
