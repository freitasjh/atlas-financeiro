// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { I18nextProvider } from "react-i18next"

const { resetPasswordForEmail } = vi.hoisted(() => ({
  resetPasswordForEmail: vi.fn(),
}))

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { resetPasswordForEmail } },
}))

import i18n from "@/i18n"
import { ForgotPasswordForm } from "@/components/shadcn/auth/forgot-password-form"

function renderForm() {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <ForgotPasswordForm />
      </MemoryRouter>
    </I18nextProvider>,
  )
}

beforeEach(() => {
  resetPasswordForEmail.mockReset()
  resetPasswordForEmail.mockResolvedValue({ data: {}, error: null })
})

afterEach(() => cleanup())

describe("ForgotPasswordForm", () => {
  it("whenRendered_thenShowsRecoveryCopyAndPersistentContactBlock", () => {
    const { container } = renderForm()
    expect(screen.getByRole("heading", { name: /recuperar senha/i })).toBeTruthy()
    expect(container.textContent).toContain("Informe o e-mail da sua conta")
    expect(container.textContent).toContain("Ainda não definiu sua senha?")
    expect(screen.getByRole("link", { name: /voltar para o login/i })).toBeTruthy()
  })

  it("whenEmailIsEmpty_thenInlineErrorWithoutRequest", async () => {
    const user = userEvent.setup()
    renderForm()
    await user.click(screen.getByRole("button", { name: /enviar link/i }))
    expect(await screen.findByText(/informe seu e-mail/i)).toBeTruthy()
    expect(resetPasswordForEmail).not.toHaveBeenCalled()
  })

  it("whenSubmitSucceeds_thenSendsLinkAndShowsNeutralConfirmation", async () => {
    const user = userEvent.setup()
    renderForm()
    await user.type(screen.getByLabelText(/e-mail/i), "pessoa@atlas.test")
    await user.click(screen.getByRole("button", { name: /enviar link/i }))

    await waitFor(() =>
      expect(resetPasswordForEmail).toHaveBeenCalledWith("pessoa@atlas.test", {
        redirectTo: `${window.location.origin}/`,
      }),
    )
    expect(await screen.findByRole("heading", { name: /confira seu e-mail/i })).toBeTruthy()
    expect(screen.getByText(/se este e-mail estiver cadastrado/i)).toBeTruthy()
  })

  it("whenEmailDoesNotExist_thenMessageIsIdentical", async () => {
    // Supabase responde sucesso sem revelar existência; a UI não muda.
    resetPasswordForEmail.mockResolvedValue({ data: {}, error: null })
    const user = userEvent.setup()
    renderForm()
    await user.type(screen.getByLabelText(/e-mail/i), "nao-existe@atlas.test")
    await user.click(screen.getByRole("button", { name: /enviar link/i }))
    expect(await screen.findByText(/se este e-mail estiver cadastrado/i)).toBeTruthy()
  })

  it("whenNetworkFails_thenShowsConnectiveErrorAndKeepsForm", async () => {
    resetPasswordForEmail.mockResolvedValue({
      data: {},
      error: { message: "Failed to fetch", status: 0 },
    })
    const user = userEvent.setup()
    renderForm()
    await user.type(screen.getByLabelText(/e-mail/i), "pessoa@atlas.test")
    await user.click(screen.getByRole("button", { name: /enviar link/i }))
    expect(await screen.findByText(/não foi possível conectar/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: /enviar link/i })).toBeTruthy()
  })
})
