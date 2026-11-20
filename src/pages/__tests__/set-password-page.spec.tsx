// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { I18nextProvider } from "react-i18next"

const { getSession, updateUser, toastSuccess } = vi.hoisted(() => ({
  getSession: vi.fn(),
  updateUser: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { getSession, updateUser } },
}))

vi.mock("sonner", () => ({
  toast: { success: toastSuccess },
}))

import i18n from "@/i18n"
import { SetPasswordPage } from "@/pages/SetPasswordPage"

function renderAt(path: string) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/definir-senha" element={<SetPasswordPage />} />
          <Route path="/link-expirado" element={<div data-testid="link-expired-probe">link-expirado</div>} />
          <Route path="/" element={<div data-testid="dashboard-probe">dashboard</div>} />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  )
}

const SESSION = { data: { session: { user: { id: "user-1", email: "a@b.com" } } }, error: null }

beforeEach(() => {
  getSession.mockReset()
  updateUser.mockReset()
  toastSuccess.mockReset()
  getSession.mockResolvedValue(SESSION)
  updateUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null })
  document.cookie = "pendingPasswordSetup=; Path=/; Max-Age=0"
})

afterEach(() => cleanup())

describe("SetPasswordPage", () => {
  it("whenOrigemIsInvite_thenShowsInviteCopy", async () => {
    renderAt("/definir-senha?origem=convite")
    expect(await screen.findByRole("heading", { name: /crie sua senha/i })).toBeTruthy()
    expect(screen.getByText(/você recebeu um convite para o atlas/i)).toBeTruthy()
    expect(screen.getByText(/mínimo de 6 caracteres/i)).toBeTruthy()
  })

  it("whenOrigemIsRecovery_thenShowsRecoveryCopy", async () => {
    renderAt("/definir-senha?origem=recuperacao")
    expect(await screen.findByRole("heading", { name: /crie uma nova senha/i })).toBeTruthy()
  })

  it("whenPasswordHasFiveChars_thenInlineErrorWithoutRequest", async () => {
    const user = userEvent.setup()
    renderAt("/definir-senha?origem=convite")
    const input = await screen.findByLabelText(/nova senha/i)
    await user.type(input, "12345")
    await user.click(screen.getByRole("button", { name: /salvar senha/i }))
    expect(await screen.findByText(/pelo menos 6 caracteres/i)).toBeTruthy()
    expect(updateUser).not.toHaveBeenCalled()
  })

  it("whenPasswordIsValid_thenUpdatesClearsCookieAndNavigatesToRoot", async () => {
    document.cookie = "pendingPasswordSetup=user-1; Path=/"
    const user = userEvent.setup()
    const { container } = renderAt("/definir-senha?origem=convite")
    expect(container.querySelector('[data-testid="dashboard-probe"]')).toBeNull()

    const input = await screen.findByLabelText(/nova senha/i)
    await user.type(input, "senha-segura-1")
    await user.click(screen.getByRole("button", { name: /salvar senha/i }))

    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ password: "senha-segura-1" }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    expect(await screen.findByTestId("dashboard-probe")).toBeTruthy()
    expect(document.cookie).not.toContain("pendingPasswordSetup=user-1")
  })

  it("whenNoSession_thenRedirectsToLinkExpiredWithoutSession", async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null })
    renderAt("/definir-senha?origem=convite")
    expect(await screen.findByTestId("link-expired-probe")).toBeTruthy()
  })

  it("whenUpdateFailsWith401_thenShowsSessionExpiredAndRedirects", async () => {
    updateUser.mockResolvedValue({
      data: { user: null },
      error: { message: "invalid claim: missing sub claim", status: 401 },
    })
    const user = userEvent.setup()
    renderAt("/definir-senha?origem=convite")
    const input = await screen.findByLabelText(/nova senha/i)
    await user.type(input, "senha-segura-1")
    await user.click(screen.getByRole("button", { name: /salvar senha/i }))
    // 401 = sessão inválida: o redirect para o link expirado é a resposta.
    await waitFor(() => expect(screen.getByTestId("link-expired-probe")).toBeTruthy(), {
      timeout: 3000,
    })
  })

  it("whenToggleClicked_thenSwitchesPasswordVisibilityAndPressedState", async () => {
    const user = userEvent.setup()
    renderAt("/definir-senha?origem=convite")
    const input = (await screen.findByLabelText(/nova senha/i)) as HTMLInputElement
    expect(input.type).toBe("password")
    const toggle = screen.getByRole("button", { name: /mostrar senha/i })
    expect(toggle.getAttribute("aria-pressed")).toBe("false")
    await user.click(toggle)
    expect(input.type).toBe("text")
    expect(screen.getByRole("button", { name: /ocultar senha/i }).getAttribute("aria-pressed")).toBe("true")
  })
})
