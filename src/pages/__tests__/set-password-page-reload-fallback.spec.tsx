// @vitest-environment happy-dom
/**
 * Se o chunk do guard não puder ser carregado, nada pode impedir a saída do
 * primeiro acesso: um hard reload descarta o veredito em memória e o guard
 * re-verifica no hard-load.
 */
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

vi.mock("sonner", () => ({ toast: { success: toastSuccess } }))

vi.mock("@/internal/guard/use-internal-operator", () => {
  throw new Error("chunk do guard indisponível")
})

import i18n from "@/i18n"
import { SetPasswordPage } from "@/pages/SetPasswordPage"

function renderAt(path: string) {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/definir-senha" element={<SetPasswordPage />} />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  )
}

beforeEach(() => {
  getSession.mockReset().mockResolvedValue({
    data: { session: { user: { id: "u-1", email: "a@b.com" } } },
    error: null,
  })
  updateUser.mockReset().mockResolvedValue({ data: { user: { id: "u-1" } }, error: null })
  toastSuccess.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe("SetPasswordPage — fallback do reset", () => {
  it("whenChunkDoResetFalha_thenHardReloadLevaAoRetorno", async () => {
    const replace = vi.spyOn(window.location, "replace").mockImplementation(() => {})
    const user = userEvent.setup()
    renderAt("/definir-senha?origem=convite&retorno=/internal")

    const input = await screen.findByLabelText(/nova senha/i)
    await user.type(input, "senha-segura-1")
    await user.click(screen.getByRole("button", { name: /salvar senha/i }))

    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1))
    expect(String(replace.mock.calls[0][0])).toContain("#/internal")
  })
})
