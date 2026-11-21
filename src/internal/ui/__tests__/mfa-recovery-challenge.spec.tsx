// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import "@/i18n"
import i18n from "@/i18n"
import { MfaRecoveryChallenge, type RecoveryConsumeOutcome } from "../mfa-recovery-challenge"

const SUCCESS: RecoveryConsumeOutcome = { ok: true, remaining: 9 }

function renderChallenge(
  onConsume: (code: string) => Promise<RecoveryConsumeOutcome> = async () => SUCCESS,
  onSuccess = vi.fn(),
) {
  const result = render(
    <MfaRecoveryChallenge onConsume={onConsume} onSuccess={onSuccess} />,
  )
  return { ...result, onSuccess }
}

async function openAndFill(value: string) {
  fireEvent.click(screen.getByRole("button", { name: /usar código de recuperação/i }))
  const input = await screen.findByLabelText(/código de recuperação/i)
  fireEvent.change(input, { target: { value } })
  return input
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage("pt-BR")
})

describe("whenFallbackIsOffered_thenRecoveryInputIsAccessible", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("link de contingência abre o campo sem exigir o autenticador", async () => {
    renderChallenge()
    expect(screen.queryByLabelText(/código de recuperação/i)).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: /usar código de recuperação/i }))

    expect(await screen.findByLabelText(/código de recuperação/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: /verificar código/i })).toBeTruthy()
  })

  it("cola com hífens/maiúsculas é normalizada antes do consumo", async () => {
    const onConsume = vi.fn(async () => SUCCESS)
    renderChallenge(onConsume)

    const input = await openAndFill("ABCD-EFGH-IJKL-MNOP-QRST-UVWX")
    fireEvent.click(screen.getByRole("button", { name: /verificar código/i }))

    await vi.waitFor(() => expect(onConsume).toHaveBeenCalledWith("abcdefghijklmnopqrstuvwx"))
    expect(input.getAttribute("inputmode")).toBe("text")
  })

  it("sucesso chama onSuccess exatamente uma vez", async () => {
    const { onSuccess } = renderChallenge()
    await openAndFill("abcdefghijklmnopqrstuvwx")
    fireEvent.click(screen.getByRole("button", { name: /verificar código/i }))

    await vi.waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
  })
})

describe("whenConsumeFails_thenFeedbackIsNonBlockingAndFocusReturnsToInput", () => {
  it("attempts_remaining aparece e foco permanece no campo", async () => {
    const onConsume = vi.fn(async () => ({
      ok: false as const,
      error: "mfa-recovery-code-invalid",
      attempts_remaining: 1,
    }))
    const { onSuccess } = renderChallenge(onConsume)

    const input = await openAndFill("xxxxxxxxxxxxxxxxxxxxxxxx")
    fireEvent.click(screen.getByRole("button", { name: /verificar código/i }))

    expect(await screen.findByText(/tentativas restantes: 1/i)).toBeTruthy()
    expect(document.activeElement).toBe(input)
    expect(onSuccess).not.toHaveBeenCalled()
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("invalid e used compartilham exatamente o mesmo texto de UI", async () => {
    for (const error of ["mfa-recovery-code-invalid", "mfa-recovery-code-used"] as const) {
      cleanup()
      renderChallenge(async () => ({ ok: false, error }))
      await openAndFill("xxxxxxxxxxxxxxxxxxxxxxxx")
      fireEvent.click(screen.getByRole("button", { name: /verificar código/i }))
      const alert = await screen.findByRole("alert")
      expect(alert.textContent).toMatch(/código inválido ou já utilizado/i)
    }
  })

  it("lockout mostra retry_after_seconds sem bloquear a tela", async () => {
    renderChallenge(async () => ({
      ok: false,
      error: "mfa-recovery-locked",
      retry_after_seconds: 900,
    }))

    await openAndFill("xxxxxxxxxxxxxxxxxxxxxxxx")
    fireEvent.click(screen.getByRole("button", { name: /verificar código/i }))

    expect(await screen.findByText(/tente novamente em 15 min/i)).toBeTruthy()
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("promoção AAL2 falha com rótulo específico e sem navegação", async () => {
    const { onSuccess } = renderChallenge(async () => ({
      ok: false,
      error: "mfa-recovery-aal-promotion-failed",
    }))

    await openAndFill("abcdefghijklmnopqrstuvwx")
    fireEvent.click(screen.getByRole("button", { name: /verificar código/i }))

    expect(await screen.findByText(/não foi possível elevar a sessão/i)).toBeTruthy()
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it("rótulos e mensagens acompanham en-US", async () => {
    await i18n.changeLanguage("en-US")
    renderChallenge()
    fireEvent.click(screen.getByRole("button", { name: /use a recovery code/i }))
    expect(await screen.findByLabelText(/recovery code/i)).toBeTruthy()
  })
})
